// ============================================================================
// Noctis Zone — run the conductor against a real launch
// ============================================================================
// This replaces the phase drivers. They were two scripts that each walked a
// fixed sequence of calls for one phase, holding the order, the arithmetic and
// the preconditions inline, and they were written for a specific rehearsal on
// a specific evening. What a launch is owed is now decided by a pure function
// of a chain read and the clock (launch-conductor.ts), composed into one turn
// (conductor-tick.ts), with the call shapes and their refusals in
// conductor-actions.ts. What is left here is the part that genuinely has to
// touch the world: reading the chain, spawning the action, and the loop.
//
// ONE PROCESS PER SUBMISSION, DELIBERATELY. Every action is a child running
// darkveil-action.mjs, not an in-process call, for two reasons that both cost
// something and are both worth it. A Midnight prove holds roughly two
// gigabytes and the SDK rejects across two wasm instances, so one process per
// action is the shape that survives a long run. And the node's own rejection
// code exists ONLY in that child's stderr — a caller sees an error that names
// no code at all — so banking the child's output is the only way a rejection
// can be classified rather than guessed at. That is the exact defect that
// stopped a settlement at step 25 of 39.
//
// THE READ TAKES NO WALLET. It is an indexer query and nothing more, which
// keeps a second wallet process from standing beside a running one — the shape
// that tears a dust snapshot — and means a tick that only looks costs nothing
// and can be run as often as one likes.
//
// ONE INDEXER PASS PER TICK. The headline state, who revealed, and what has
// been recorded as settled all come from ONE decode of ONE query, so a tick
// can never decide from two different blocks.
//
// A DRY RUN IS THE PRECONDITION, AND `atSeconds` IS WHAT MAKES ONE POSSIBLE
// AHEAD OF A WINDOW. The planner only names a transition once it is due, so a
// rehearsal taken an hour early would otherwise only ever report "waiting".
// Moving the clock forward against a REAL read is what lets the transition
// that is about to happen be planned in full before it happens. It is refused
// on a live run, where a moved clock would mean submitting something that is
// not due.
//
// WHAT THIS DOES NOT DO, AND MUST NOT LEARN TO. Registering, committing a buy,
// revealing one, claiming a refund: those are made by participants from their
// own seeds. The rehearsal harness simulates them because in a rehearsal there
// is nobody else to; a conductor that could make them would be a conductor
// holding fifteen people's identities.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  type CallContext,
  type OffChainInputs,
  planCall,
  type RegistrantRootInput,
  type SettlementAttestation,
  settlementCompleteness,
} from '../conductor-actions.js';
import { type ConductorTickResult, describeTick, runConductorTick } from '../conductor-tick.js';
import { nextAction } from '../launch-conductor.js';
import { readEligibilityGateLedger, summarizeDarkVeil } from '../midnight-public-state.js';
import { defaultNetworkConfig, type MidnightNetwork } from '../midnight-server-wallet.js';
import { fileRehearsalLog } from '../rehearsal-log.js';
import { SubmissionGate } from '../submission-gate.js';
import type { BankedJobResult } from '../submission-outcome.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

/**
 * How long one action may run before it is stopped.
 *
 * Above the CLI's own sync timeout on purpose. A bound below that one does not
 * catch a stall — it kills runs the child would have finished, and loses the
 * child's own account of why in favour of a bare deadline. This is a backstop
 * for a process that is not going to report anything at all.
 *
 * A child stopped here may already have submitted, which is why the classifier
 * treats a stopped child as an operator's problem rather than retrying it.
 */
const DEFAULT_ACTION_TIMEOUT_MS = 2_400_000;

interface Input {
  /** A name for this launch in every reported line. */
  launchId: string;
  network: MidnightNetwork;
  contractAddress: string;
  zkConfigBasePath: string;
  proofServerUrl: string;
  /** Pays the fee for whatever this submits. */
  walletSeedHex: string;
  /** Only the governor transitions need it; supply it only if one is expected. */
  governorSecretHex?: string;
  snapshotDir?: string;
  snapshotPassphrase?: string;
  snapshotAccountId?: string;
  syncTimeoutMs?: number;

  /** Where rehearsals are banked and looked up. */
  rehearsalLogPath: string;
  /** Overrides the default window a rehearsal clears its transition for. */
  rehearsalTtlMs?: number;
  /** Recorded on a dry run, for whoever reads the receipt. */
  rehearsalNote?: string;

  /** The root over the frozen registrant set, with the count it was built over. */
  registrantRoot?: RegistrantRootInput;
  /** What settled on Cardano, as the relayer observed it. */
  settlements?: SettlementAttestation;

  /** Read and plan for real, submit nothing, and bank a rehearsal. */
  dryRun?: boolean;
  /** Plan against this clock rather than the real one. Dry runs only. */
  atSeconds?: string | number;

  /** How many turns to take in this invocation. One by default. */
  ticks?: number;
  /** How long to wait between them. */
  pollMs?: number;
  /** Per-action deadline; see DEFAULT_ACTION_TIMEOUT_MS. */
  actionTimeoutMs?: number;
}

/** Everything one tick needs from the chain, from a single decode. */
interface ChainRead {
  snapshot: ReturnType<typeof summarizeDarkVeil>;
  revealedKeys: string[];
  recordedSettlements: Record<string, string>;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * Run one action as a child and bank everything it said.
 *
 * Resolves rather than rejects on any outcome, including a stop at the
 * deadline: a rejection here would throw away the stderr the verdict is read
 * from, which is the whole reason this is a subprocess.
 */
function runAction(cliPath: string, payload: unknown, timeoutMs: number): Promise<BankedJobResult> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--max-old-space-size=8192', cliPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n[conduct] could not start the action: ${err.message}`, exitCode: -1 });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        stderr += `\n[conduct] stopped after ${Math.round(timeoutMs / 1000)}s`;
      }
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, [
    'launchId',
    'network',
    'contractAddress',
    'zkConfigBasePath',
    'proofServerUrl',
    'walletSeedHex',
    'rehearsalLogPath',
  ]);

  // A moved clock on a live run would submit a transition that is not due —
  // the one thing the schedule exists to prevent. Refused rather than ignored,
  // because silently ignoring it would let a rehearsal command be re-run live
  // with one flag dropped and no sign that the clock had changed meaning.
  if (input.atSeconds !== undefined && !input.dryRun) {
    throw new Error(
      'atSeconds moves the clock the plan is made against and is a dry-run instrument. A live run takes ' +
        'the real time, or it would act before the schedule says it may.',
    );
  }

  const { indexerHttpUrl, indexerWsUrl } = defaultNetworkConfig(input.network, input.proofServerUrl);
  const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);
  // Resolved beside this bundle rather than from the working directory, so a
  // run started from anywhere reaches the action it was built with.
  const cliPath = fileURLToPath(new URL('./darkveil-action.mjs', import.meta.url));
  const timeoutMs = input.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  const rehearsal = fileRehearsalLog(input.rehearsalLogPath, { ttlMs: input.rehearsalTtlMs });
  const gate = new SubmissionGate({
    onWait: (r) => process.stderr.write(`  queued behind ${r.queuedAhead} on ${r.key} for ${r.waitedMs}ms\n`),
  });

  const offChain: OffChainInputs = { registrantRoot: input.registrantRoot, settlements: input.settlements };

  /** Everything a call decision is made from, all of it from one decode. */
  const contextFor = (chain: ChainRead): CallContext => ({
    snapshot: chain.snapshot,
    offChain,
    revealedKeys: chain.revealedKeys,
    recordedSettlements: chain.recordedSettlements,
  });

  /** One decode, so nothing in a tick can come from two different blocks. */
  const read = async (): Promise<ChainRead> => {
    const ledger = await readEligibilityGateLedger(publicDataProvider, input.contractAddress);
    const revealedKeys: string[] = [];
    for (const [key] of ledger.dvTokensPurchased) revealedKeys.push(hex(key));
    const recordedSettlements: Record<string, string> = {};
    for (const [key, amount] of ledger.settledDvPurchases) recordedSettlements[hex(key)] = amount.toString();
    return { snapshot: summarizeDarkVeil(ledger), revealedKeys, recordedSettlements };
  };

  const base = {
    network: input.network,
    contractAddress: input.contractAddress,
    zkConfigBasePath: input.zkConfigBasePath,
    proofServerUrl: input.proofServerUrl,
    walletSeedHex: input.walletSeedHex,
    snapshotDir: input.snapshotDir,
    snapshotPassphrase: input.snapshotPassphrase,
    snapshotAccountId: input.snapshotAccountId,
    syncTimeoutMs: input.syncTimeoutMs,
  };

  const turns: Array<{ line: string; tick: ConductorTickResult }> = [];
  const ticks = Math.max(1, Number(input.ticks ?? 1));

  for (let i = 0; i < ticks; i++) {
    // Held for this turn so the plan, the completeness verdict and the call
    // are all answered from the same decode.
    let current: ChainRead | null = null;

    const tick = await runConductorTick({
      launchId: input.launchId,
      contractAddress: input.contractAddress,
      readSnapshot: async () => {
        current = await read();
        return current.snapshot;
      },
      now: () => (input.atSeconds !== undefined ? BigInt(input.atSeconds) : BigInt(Math.floor(Date.now() / 1000))),
      nowMs: () => Date.now(),
      gate,
      fundingWalletKey: input.walletSeedHex,
      rehearsal,
      dryRun: input.dryRun,
      rehearsalNote: input.rehearsalNote,
      settlementsComplete: () => {
        const chain = current;
        if (!chain) return undefined;
        const verdict = settlementCompleteness(contextFor(chain));
        // "Unknown" is not "no" — it is the planner's own signal that the
        // record must not be closed, and it reads an absent value as exactly
        // that. Flattening it to false here would lose the distinction the
        // planner's own comment turns on.
        return verdict.complete === 'unknown' ? undefined : verdict.complete;
      },
      canSupplyOffChainInput: (action) => {
        const chain = current;
        if (!chain) return false;
        return planCall(action, contextFor(chain)).ok;
      },
      submit: async (action) => {
        const chain = current;
        if (!chain) throw new Error('the chain read did not complete before the action was built');
        const plan = planCall(action, contextFor(chain));
        if (!plan.ok) {
          // Reached only if the state moved between the check above and here,
          // which is a real possibility on a chain and not a fault. Reported
          // as a banked failure rather than thrown, so it classifies like any
          // other refusal instead of ending the run.
          return { stdout: '', stderr: `[conduct] needs ${plan.missing}`, exitCode: 1 };
        }
        if (plan.call.needsGovernorSecret && !input.governorSecretHex) {
          return { stdout: '', stderr: `[conduct] ${plan.call.action} must present the governor secret`, exitCode: 1 };
        }
        return runAction(
          cliPath,
          {
            ...base,
            action: plan.call.action,
            ...plan.call.args,
            ...(plan.call.needsGovernorSecret ? { governorSecretHex: input.governorSecretHex } : {}),
          },
          timeoutMs,
        );
      },
    });

    const line = describeTick(input.launchId, tick);
    process.stderr.write(`${line}\n`);
    turns.push({ line, tick });

    // Nothing left to do, or nothing that another turn would change.
    if (tick.did === 'nothing' || tick.did === 'blocked' || tick.did === 'unrehearsed' || input.dryRun) break;
    if (tick.did === 'failed' && tick.retryInMs === null) break;
    if (i + 1 < ticks && input.pollMs) await new Promise((r) => setTimeout(r, input.pollMs));
  }

  // Reported alongside the turns because it is the one judgement the conductor
  // cannot make for itself, and an operator reading a run needs to see what it
  // was working from.
  const finalRead = await read();
  const completeness = settlementCompleteness(contextFor(finalRead));

  process.stdout.write(
    JSON.stringify(
      jsonSafe({
        ok: true,
        launchId: input.launchId,
        contractAddress: input.contractAddress,
        dryRun: input.dryRun === true,
        turns,
        settlementCompleteness: completeness,
        verdict: nextAction({
          snapshot: finalRead.snapshot,
          nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
          settlementsComplete: completeness.complete === 'unknown' ? undefined : completeness.complete,
        }),
      }),
    ),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
