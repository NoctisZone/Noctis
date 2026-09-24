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
// AND A DRY RUN IS A PRECONDITION, NOT A HABIT. Taking one is enforced here
// rather than left to whoever is running the window: a dry run banks a receipt
// for the transition it planned, and a live tick will not submit a transition
// that has no receipt. The requirement sits in the tick for the same reason
// everything else does — a runner cannot be written without it, because the
// input it needs is not optional. Waiving it is a named call that shows up in
// a diff.
//
// NOTHING HERE DECIDES WHETHER AN ACTION SUCCEEDED. The chain does, on the next
// tick. A submission that lands and a submission whose result is lost look the
// same from here, and asking the chain next time is both simpler and correct —
// every circuit either refuses a second submission or is deliberately
// idempotent, which is what makes that safe.
// ============================================================================

import { type ConductorAction, type ConductorVerdict, nextAction } from './launch-conductor.js';
import type { DarkVeilSnapshot } from './midnight-public-state.js';
import type { RehearsalEntry, RehearsalLog } from './rehearsal-log.js';
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
   * The deployed gate this tick acts on.
   *
   * Carried separately from `launchId` because a rehearsal is matched on it: a
   * name can be reused across a redeploy, and an address cannot.
   */
  contractAddress: string;
  /**
   * Reads the gate's public state. Wallet-free by construction — a read needs
   * no wallet, and a second wallet process beside a running one is the exact
   * shape that tears a snapshot.
   */
  readSnapshot: () => Promise<DarkVeilSnapshot>;
  /**
   * Seconds since the epoch. Midnight's unit.
   *
   * A dry run may move this ahead of the real clock — that is the only way to
   * rehearse a window before reaching it, and the read stays real either way.
   */
  now: () => bigint;
  /**
   * Real wall clock in milliseconds, for the rehearsal's own age.
   *
   * Separate from `now` precisely because `now` may be moved: a receipt dated
   * by a clock that had been pushed forward would clear itself for as long as
   * the push was large.
   */
  nowMs?: () => number;
  /**
   * Performs the action, returning the banked CLI result.
   *
   * Returns rather than throws, because the node's own error code survives
   * only in the subprocess's stderr and a thrown error has already lost it.
   */
  submit: (action: ConductorAction) => Promise<BankedJobResult>;
  /**
   * Whether every buyer who revealed has had their Cardano settlement recorded.
   *
   * A function of the snapshot just read, rather than a value, so it is
   * answered from the same read the plan is made from — the answer depends on
   * what the chain currently holds, and a value computed before the read would
   * be deciding about a block that is no longer the one being planned against.
   *
   * Left out, the conductor will not close the settlement record. That is the
   * safe direction: a record closed early marks a buyer as having settled
   * nothing, and the forfeiture sweep then takes their whole bond.
   */
  settlementsComplete?: (snapshot: DarkVeilSnapshot) => boolean | undefined;
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
  /**
   * Where rehearsals are banked and looked up.
   *
   * Required, not optional. A tick either records a rehearsal or checks for
   * one, and there is no third thing it could do with an absent log except
   * quietly skip the check — which is the failure this exists to prevent.
   * `rehearsalNotRequired()` is how a caller says so out loud.
   */
  rehearsal: RehearsalLog;
  /** Read and plan for real; submit nothing. */
  dryRun?: boolean;
  /** Recorded on a dry run, for whoever reads the receipt later. */
  rehearsalNote?: string;
  /** How many times this action has already been tried, for the backoff. */
  attempt?: number;
}

export type ConductorTickResult =
  | { did: 'nothing'; verdict: ConductorVerdict }
  | { did: 'planned'; action: ConductorAction; note: string }
  | { did: 'submitted'; action: ConductorAction; result: BankedJobResult }
  | { did: 'failed'; action: ConductorAction; outcome: SubmissionOutcome; retryInMs: number | null }
  | { did: 'blocked'; action: ConductorAction; note: string }
  | { did: 'unrehearsed'; action: ConductorAction; why: string };

/**
 * Run one turn for one launch.
 *
 * Never throws for an ordinary outcome — a refused submission, a launch that
 * is early, an action nothing can build, a transition nobody has rehearsed —
 * because those are states to report and tick again from, not faults. A throw
 * from here means the READ failed, or a dry run could not BANK its rehearsal:
 * the first is the one thing a tick cannot proceed past, and the second would
 * otherwise leave an operator believing they are cleared for a window they
 * are not.
 */
export async function runConductorTick(input: ConductorTickInput): Promise<ConductorTickResult> {
  const snapshot = await input.readSnapshot();
  const verdict = nextAction({
    snapshot,
    nowSeconds: input.now(),
    settlementsComplete: input.settlementsComplete?.(snapshot),
  });

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
    const entry: RehearsalEntry = {
      contractAddress: input.contractAddress,
      action: action.kind,
      // The state it was planned FROM. A live tick matches on this, so a
      // rehearsal taken from one lifecycle position never clears the same
      // transition reached from another.
      dvState: Number(snapshot.dvState),
      rehearsedAtMs: input.nowMs?.() ?? Date.now(),
      plannedForSeconds: input.now().toString(),
      because: action.because,
      note: input.rehearsalNote,
    };
    // Deliberately not caught. A dry run whose receipt did not land has not
    // cleared anything, and reporting success here is how an operator reaches
    // a live window believing otherwise.
    await input.rehearsal.record(entry);
    return {
      did: 'planned',
      action,
      note: `would ${action.kind}: ${action.because}`,
    };
  }

  const cleared = await input.rehearsal.recall({
    contractAddress: input.contractAddress,
    action: action.kind,
    dvState: Number(snapshot.dvState),
    nowMs: input.nowMs?.() ?? Date.now(),
  });
  if (!cleared.rehearsed) {
    return { did: 'unrehearsed', action, why: cleared.why };
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
 * Refusals that changed nothing on chain and ask only to be tried again soon:
 * a DUST-root race (170), a lost receipt that needs a fresh read (104, 107),
 * an indexer that is behind (171). A stale wallet and an empty DUST balance are
 * left out on purpose — their waits run to minutes or hours, and a run that
 * meets one should spend its turns on it visibly rather than quietly stretch.
 */
const FREE_RETRY_DISPOSITIONS: ReadonlySet<string> = new Set(['retry', 'replan', 'wait-indexer']);

/** How many of those a run absorbs without spending a turn. */
export const DEFAULT_FREE_RETRIES = 6;

export interface ConductorTurnsInput {
  /** Turns the caller asked for: submissions, and anything else that ends a turn. */
  ticks: number;
  /** Retryable refusals absorbed without spending a turn. Defaults to {@link DEFAULT_FREE_RETRIES}. */
  retries?: number;
  /** Least wait between turns. */
  pollMs?: number;
  dryRun?: boolean;
  /** One turn. `attempt` counts consecutive failures of the same action, for the backoff. */
  turn: (attempt: number) => Promise<ConductorTickResult>;
  onTurn?: (tick: ConductorTickResult) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs up to `ticks` turns for one launch. The only loop over turns.
 *
 * A REFUSAL THE NODE ASKS US TO RETRY IS NOT A TURN. A 170 changed nothing on
 * chain, so charging it to the budget ended a run short of the work it was
 * asked for: a settlement run given one turn per entry plus one stopped a turn
 * before its finalize. Those refusals draw on their own budget instead, and the
 * backoff grows with consecutive failures of the same action (the tick used to
 * be told attempt 1 every time). A refusal nobody should retry automatically
 * still ends the run, as does a turn with nothing to do, a blocked or
 * unrehearsed action, and any dry run.
 */
export async function runConductorTurns(input: ConductorTurnsInput): Promise<ConductorTickResult[]> {
  const ticks = Math.max(1, Math.floor(input.ticks));
  let free = Math.max(0, Math.floor(input.retries ?? DEFAULT_FREE_RETRIES));
  const pollMs = input.pollMs ?? 0;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const turns: ConductorTickResult[] = [];
  let spent = 0;
  let streak = 0;
  let streakKind: string | undefined;

  while (spent < ticks) {
    const tick = await input.turn(streak + 1);
    turns.push(tick);
    input.onTurn?.(tick);

    if (tick.did === 'nothing' || tick.did === 'blocked' || tick.did === 'unrehearsed' || input.dryRun) break;

    if (tick.did === 'failed') {
      if (tick.retryInMs === null) break;
      streak = streakKind === tick.action.kind ? streak + 1 : 1;
      streakKind = tick.action.kind;
      if (free > 0 && FREE_RETRY_DISPOSITIONS.has(tick.outcome.disposition)) {
        free -= 1;
      } else {
        spent += 1;
        if (spent >= ticks) break;
      }
      // The failure names its own wait — long enough for the indexer to show
      // the block a lost receipt was about, or for a ctime race to pass — and
      // the next turn's read is what settles it.
      await sleep(Math.max(pollMs, tick.retryInMs));
      continue;
    }

    streak = 0;
    streakKind = undefined;
    spent += 1;
    // Ticking again at once would plan from the state the submission just
    // changed, before the indexer shows it.
    if (spent < ticks && pollMs > 0) await sleep(pollMs);
  }
  return turns;
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
    case 'unrehearsed':
      return `${launchId}: NOT REHEARSED — ${tick.action.kind} was not submitted: ${tick.why}`;
    case 'failed': {
      const next =
        tick.retryInMs === null
          ? '[needs an operator]'
          : `[${tick.outcome.disposition === 'replan' || tick.outcome.disposition === 'wait-indexer' ? 're-reading' : 'retrying'} in ${Math.round(tick.retryInMs / 1000)}s]`;
      // A lost receipt or an outage is not a refusal, and a log line that
      // called it one sent an operator looking for a failure that had not
      // happened. The chain is read again before anything is resubmitted.
      const what =
        tick.outcome.disposition === 'replan'
          ? 'needs a fresh read'
          : tick.outcome.disposition === 'wait-indexer'
            ? 'is waiting on the indexer'
            : 'was refused';
      return `${launchId}: ${tick.action.kind} ${what} — ${tick.outcome.reason} ${next}`;
    }
  }
}
