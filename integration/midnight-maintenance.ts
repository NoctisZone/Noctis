// ============================================================================
// Noctis Zone — completing a contract deployed in phases
// ============================================================================
// A deploy writes the whole contract state at once: the constructor's ledger
// plus one verifier key per exported circuit. A contract with many circuits is
// therefore delivered in phases — the deploy carries the circuits needed
// first, and the rest arrive afterwards as maintenance updates, authorised by
// the contract's own maintenance authority.
//
// A verifier key compiles independently of which other circuits were built
// alongside it, so a contract completed this way holds exactly the keys a
// single-shot deploy would have. `verifyDeliveredCircuits` below is what
// proves that for a given contract rather than assuming it.
//
// WRITE BUDGET
// `submitInsertVerifierKeyTx` carries ONE key per transaction (verified
// against the installed SDK's own implementation), so each update writes one
// key plus its overhead. Run with NP_TX_COST=1 to have the real figure printed
// for every transaction rather than inferred.
//
// AUTHORITY
// Each update must be signed by the maintenance authority the deploy sealed
// in. That key is derived from the governor secret and the launch id
// (`deriveContractSigningKey`), so it can be recomputed at any time from
// material the governor already holds — no key file has to survive between the
// deploy and the updates that complete it.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { submitInsertVerifierKeyTx, verifierKeysEqual } from '@midnight-ntwrk/midnight-js-contracts';
import { describeError } from './error-detail.js';
import { operationNames } from './midnight-deploy-subset.js';
import { classifySubmission, indexerOutageIn, isAutomaticallyRecoverable, retryDelayMs } from './submission-outcome.js';

/** What a contract still needs, measured against what it should end up with. */
export interface CircuitDelivery {
  /** Circuits the compiled contract defines. */
  readonly expected: readonly string[];
  /** Circuits already on chain. */
  readonly present: readonly string[];
  /** Circuits still to be delivered, in the order given. */
  readonly missing: readonly string[];
  /**
   * Circuits on chain that the compiled contract does not define.
   *
   * Never empty for an innocent reason: it means the deployed contract and the
   * local build disagree about what this contract is.
   */
  readonly unexpected: readonly string[];
}

/**
 * Compares a deployed contract against the build that should complete it.
 *
 * `expected` is taken in its given order so a caller can decide delivery
 * priority — the circuits a launch needs soonest first.
 */
export function planCircuitDelivery(
  onChainOperations: readonly string[],
  expected: readonly string[],
): CircuitDelivery {
  const present = new Set(onChainOperations);
  const defined = new Set(expected);
  return {
    expected,
    present: [...onChainOperations],
    missing: expected.filter((name) => !present.has(name)),
    unexpected: onChainOperations.filter((name) => !defined.has(name)),
  };
}

export interface DeliveredCircuit {
  readonly circuitId: string;
  readonly txId?: string;
  readonly txHash?: string;
  readonly blockHeight?: number;
  /**
   * Set when the update's own receipt was lost — the node's reply could not
   * be decoded, or the indexer went away under it — and a read of the chain
   * confirmed the circuit present instead. No transaction ids in that case:
   * the read does not return one, and an invented one would be worse than
   * none.
   */
  readonly confirmedByChain?: true;
}

export interface DeliverCircuitsOptions {
  /** Called before each transaction, so a long run reports progress as it goes. */
  readonly onProgress?: (message: string) => void;
  /**
   * Waits for the indexer to come back. Supplied by a caller that knows where
   * the indexer is; without it an outage is waited out with the classifier's
   * own delay and a re-read, which is slower but not wrong.
   */
  readonly awaitIndexer?: () => Promise<void>;
  /** Replaceable so a test does not really wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many times one circuit may be submitted before the run stops. */
  readonly maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Delivers `circuits` to an already-deployed contract, one transaction each.
 *
 * Sequential rather than concurrent, and deliberately so: every update spends
 * the same wallet and builds on the contract state the previous one produced,
 * so overlapping them would race both. Each returns before the next starts,
 * which also means a run that stops partway leaves every circuit it already
 * delivered on chain — re-running skips those, because the plan is recomputed
 * from what the chain actually holds.
 */
export async function deliverCircuits(
  providers: ContractProviders,
  // The FULL compiled contract, including circuits not yet on chain: the
  // update names the circuit being added, so a build missing it cannot
  // describe it.
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's own signature for this parameter
  compiledContract: any,
  contractAddress: string,
  circuits: readonly string[],
  options: DeliverCircuitsOptions = {},
): Promise<DeliveredCircuit[]> {
  const { onProgress } = options;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delivered: DeliveredCircuit[] = [];

  for (const [index, circuitId] of circuits.entries()) {
    for (let attempt = 1; ; attempt++) {
      onProgress?.(
        `delivering ${circuitId} (${index + 1} of ${circuits.length}${attempt > 1 ? `, attempt ${attempt}` : ''})`,
      );

      const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
      try {
        const txData = await submitInsertVerifierKeyTx(
          providers,
          compiledContract,
          contractAddress,
          circuitId,
          verifierKey,
        );
        delivered.push({
          circuitId,
          txId: txData.txId,
          txHash: txData.txHash,
          blockHeight: txData.blockHeight,
        });
        onProgress?.(`  ${circuitId} in block ${txData.blockHeight}`);
        break;
      } catch (err) {
        // A failure the classifier cannot vouch for stops the run here, as it
        // always did, with the original error: everything already delivered
        // stays on chain and a re-run skips it.
        const account = describeError(err);
        const outcome = classifySubmission({ stderr: account, exitCode: 1 });
        if (!isAutomaticallyRecoverable(outcome)) throw err;
        onProgress?.(`  ${circuitId}: ${outcome.reason}`);

        if (outcome.disposition === 'wait-indexer' && options.awaitIndexer) {
          await options.awaitIndexer();
        } else {
          await sleep(retryDelayMs(outcome, attempt));
        }

        // THE CHAIN, NOT THE ERROR, SAYS WHETHER IT LANDED. A lost receipt
        // was measured three times in one night, and each time the circuit
        // was on chain at the next read; a resubmission would have been
        // refused as a duplicate and read as yet another failure.
        if (await isOnChain(providers, contractAddress, circuitId, options.awaitIndexer)) {
          delivered.push({ circuitId, confirmedByChain: true });
          onProgress?.(`  ${circuitId} is on chain — confirmed by a read; its receipt was lost`);
          break;
        }
        if (attempt >= maxAttempts) {
          throw new Error(
            `${circuitId} was submitted ${attempt} times and is still not on chain. Last failure: ${account}`,
          );
        }
      }
    }
  }

  return delivered;
}

/** Whether the contract carries `circuitId` right now, by reading it. */
async function isOnChain(
  providers: ContractProviders,
  contractAddress: string,
  circuitId: string,
  awaitIndexer?: () => Promise<void>,
): Promise<boolean> {
  const read = async () => {
    const state = await providers.publicDataProvider.queryContractState(contractAddress);
    return state !== null && operationNames(state).includes(circuitId);
  };
  try {
    return await read();
  } catch (err) {
    // The read goes through the indexer too. If that is what is gone, wait
    // for it and ask once more; anything else is the caller's to see.
    if (!awaitIndexer || !indexerOutageIn(describeError(err))) throw err;
    await awaitIndexer();
    return await read();
  }
}

export interface CircuitVerification {
  readonly circuitId: string;
  /** Whether the contract carries this circuit at all. */
  readonly present: boolean;
  /**
   * Whether the key on chain is byte-for-byte the locally built one.
   *
   * A present circuit whose key differs is the case worth catching: it would
   * accept calls and reject every proof built against this source.
   */
  readonly keyMatches: boolean;
}

/**
 * Checks a deployed contract carries every expected circuit, with the keys
 * this build produces.
 *
 * Deliberately reports on all of them rather than throwing at the first
 * disagreement — one run should say what the contract holds, not just that
 * something is wrong with it.
 */
export async function verifyDeliveredCircuits(
  providers: ContractProviders,
  contractAddress: string,
  expected: readonly string[],
): Promise<CircuitVerification[]> {
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState === null) {
    throw new Error(`No contract found at ${contractAddress}, so there is nothing to verify.`);
  }
  const present = new Set(operationNames(contractState));

  const results: CircuitVerification[] = [];
  for (const circuitId of expected) {
    if (!present.has(circuitId)) {
      results.push({ circuitId, present: false, keyMatches: false });
      continue;
    }
    const local = await providers.zkConfigProvider.getVerifierKey(circuitId);
    const onChain = contractState.operation(circuitId)?.verifierKey;
    results.push({
      circuitId,
      present: true,
      keyMatches: onChain !== undefined && verifierKeysEqual(local, onChain),
    });
  }
  return results;
}
