// ============================================================================
// Noctis Zone — one turn of the conductor
// ============================================================================
// The pieces exist separately and are each testable on their own: the planner
// works out what a launch is owed, the gate keeps two submissions from one
// funding wallet apart, the classifier says what a rejection deserves. This is
// the turn that puts them together, and it is deliberately the ONLY place they
// are composed — two runners written to the same shape is how a hardened one
// and an unhardened one ended up side by side, with the unhardened one holding
// a live window.
//
// A TICK IS A WHOLE DECISION AND AT MOST ONE ACTION. It reads, plans, acts
// once, and reports. It does not loop, sleep, or chase a launch through several
// steps: each step changes what the next read says, so a tick that pressed on
// would be acting against state it had already invalidated. The caller ticks
// again — and because the planner is pure over a chain read, the second tick
// re-derives everything and cannot disagree with the first about anything but
// the chain having moved.
//
// A DRY RUN IS NOT A SEPARATE PATH. It runs the read and the plan for real and
// stops before submitting. That matters because the failure it has to catch is
// in the read and the plan — the last time a driver broke a live window, a dry
// run would have caught it, and the reason it did not was that no dry run had
// ever been performed. A dry mode that skipped the read would have missed it
// too.
//
// NOTHING HERE DECIDES WHETHER AN ACTION SUCCEEDED. The chain does, on the next
// tick. A submission that lands and a submission whose result is lost look the
// same from here, and asking the chain next time is both simpler and correct —
// every circuit either refuses a second submission or is deliberately
// idempotent, which is what makes that safe.
// ============================================================================

import { type ConductorAction, type ConductorVerdict, nextAction } from './launch-conductor.js';
import type { DarkVeilSnapshot } from './midnight-public-state.js';
import type { SubmissionGate } from './submission-gate.js';
import {
  type BankedJobResult,
  classifySubmission,
  isAutomaticallyRecoverable,
  retryDelayMs,
  type SubmissionOutcome,
} from './submission-outcome.js';

export interface ConductorTickInput {
  /** Identifies the launch in every reported line. */
  launchId: string;
  /**
   * Reads the gate's public state. Wallet-free by construction — a read needs
   * no wallet, and a second wallet process beside a running one is the exact
   * shape that tears a snapshot.
   */
  readSnapshot: () => Promise<DarkVeilSnapshot>;
  /** Seconds since the epoch. Midnight's unit. */
  now: () => bigint;
  /**
   * Performs the action, returning the banked CLI result.
   *
   * Returns rather than throws, because the node's own error code survives
   * only in the subprocess's stderr and a thrown error has already lost it.
   */
  submit: (action: ConductorAction) => Promise<BankedJobResult>;
  /** Serializes submissions that share a funding wallet. */
  gate: SubmissionGate;
  /** The funding wallet this launch's actions are paid from. */
  fundingWalletKey: string;
  /**
   * Whether this action can be built here at all.
   *
   * Two of them need something only the platform can produce. A loop with no
   * way to supply those should say so rather than treat the launch as up to
   * date — a launch waiting on one looks, from the chain, exactly like one
   * that is simply early.
   */
  canSupplyOffChainInput?: (action: ConductorAction) => boolean;
  /** Read and plan for real; submit nothing. */
  dryRun?: boolean;
  /** How many times this action has already been tried, for the backoff. */
  attempt?: number;
}

export type ConductorTickResult =
  | { did: 'nothing'; verdict: ConductorVerdict }
  | { did: 'planned'; action: ConductorAction; note: string }
  | { did: 'submitted'; action: ConductorAction; result: BankedJobResult }
  | { did: 'failed'; action: ConductorAction; outcome: SubmissionOutcome; retryInMs: number | null }
  | { did: 'blocked'; action: ConductorAction; note: string };

/**
 * Run one turn for one launch.
 *
 * Never throws for an ordinary outcome — a refused submission, a launch that
 * is early, an action nothing can build — because those are states to report
 * and tick again from, not faults. A throw from here means the READ failed,
 * which is the one thing a tick genuinely cannot proceed past.
 */
export async function runConductorTick(input: ConductorTickInput): Promise<ConductorTickResult> {
  const snapshot = await input.readSnapshot();
  const verdict = nextAction({ snapshot, nowSeconds: input.now() });

  if (verdict.status !== 'due') {
    return { did: 'nothing', verdict };
  }

  const action = verdict.action;

  if (action.needsOffChainInput && input.canSupplyOffChainInput?.(action) === false) {
    return {
      did: 'blocked',
      action,
      note:
        `${action.kind} is due (${action.because}) and cannot be built from chain state alone. ` +
        'Nothing will move this launch until it is supplied.',
    };
  }

  if (input.dryRun) {
    return {
      did: 'planned',
      action,
      note: `would ${action.kind}: ${action.because}`,
    };
  }

  const result = await input.gate.submit(input.fundingWalletKey, () => input.submit(action));

  // Success is not asserted here. The next read answers it, and a tick that
  // tried to decide from an exit code would be trusting the one stream the
  // node's own verdict does not survive in.
  if (!looksRejected(result)) {
    return { did: 'submitted', action, result };
  }

  const outcome = classifySubmission(result);
  return {
    did: 'failed',
    action,
    outcome,
    retryInMs: isAutomaticallyRecoverable(outcome) ? retryDelayMs(outcome, input.attempt ?? 1) : null,
  };
}

/**
 * Whether a banked result is a rejection at all.
 *
 * A non-zero exit or a stopped child. Deliberately not "does the stderr
 * mention an error": a CLI writes progress to stderr as a matter of course,
 * and treating that as failure would classify every successful run.
 */
function looksRejected(result: BankedJobResult): boolean {
  if (result.timedOut) return true;
  return typeof result.exitCode === 'number' && result.exitCode !== 0;
}

/** A one-line description of a tick, for a log that has to be readable at 3am. */
export function describeTick(launchId: string, tick: ConductorTickResult): string {
  switch (tick.did) {
    case 'nothing': {
      const verdict = tick.verdict;
      if (verdict.status === 'waiting') {
        return `${launchId}: waiting until ${verdict.until} — ${verdict.because}`;
      }
      // `due` cannot reach here — the tick would have acted on it — but the
      // type still admits it, so it is answered rather than asserted away.
      return verdict.status === 'idle'
        ? `${launchId}: idle — ${verdict.because}`
        : `${launchId}: ${verdict.action.kind} is due`;
    }
    case 'planned':
      return `${launchId}: DRY RUN — ${tick.note}`;
    case 'submitted':
      return `${launchId}: submitted ${tick.action.kind} — ${tick.action.because}`;
    case 'blocked':
      return `${launchId}: BLOCKED — ${tick.note}`;
    case 'failed':
      return (
        `${launchId}: ${tick.action.kind} was refused — ${tick.outcome.reason} ` +
        (tick.retryInMs === null ? '[needs an operator]' : `[retrying in ${Math.round(tick.retryInMs / 1000)}s]`)
      );
  }
}
