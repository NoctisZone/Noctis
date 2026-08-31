// ============================================================================
// Noctis Zone — reading a DarkVeil launch's published state
// ============================================================================
// Everything a launch page needs to render — the phase, the DarkVeil price and
// allocation, how much has been committed, the Fair Launch Certificate — is
// published in the contract's own public ledger. This module reads it straight
// off the indexer.
//
// That makes these figures free and permissionless to read. No wallet, no
// proof server, no DUST, and no transaction: anyone can check a launch's
// published numbers against the chain without asking the platform, which is
// the point of publishing them.
//
// Verified against the real deployed Cardano Launch gate on Preprod (contract
// 5dd23569…) before this module was written: `queryContractState` returns the
// live state, and returns `null` for an address holding no contract.
// ============================================================================

import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import {
  type DarkVeilState,
  ledger as decodeEligibilityGateLedger,
  type Ledger as EligibilityGateLedger,
  type FairLaunchCert,
  type LaunchPhase,
} from '../contracts/midnight/compiled/eligibility_gate/contract/index.js';

export type { EligibilityGateLedger };

/**
 * Reads and decodes the whole published ledger of a Cardano Launch eligibility gate.
 *
 * Callers wanting only the headline figures should prefer
 * {@link readDarkVeilSnapshot}, which returns a plain, serialisable object.
 * This one hands back the raw decoded ledger, including its map-shaped fields
 * (`lockedBonds`, `cumulativePurchases`, …), which are live objects with
 * `lookup`/`member` methods rather than data.
 *
 * @throws if no contract exists at `contractAddress`.
 */
export async function readEligibilityGateLedger(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<EligibilityGateLedger> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (contractState === null) {
    throw new Error(
      `No contract found at ${contractAddress}. Check the address and that the indexer is following the same network the contract was deployed to.`,
    );
  }
  return decodeEligibilityGateLedger(contractState.data);
}

/**
 * The headline figures of a DarkVeil phase, as a plain object.
 *
 * Deliberately flat and free of live map handles so it can be serialised
 * straight to JSON — a CLI's stdout, or a widget's state — without a caller
 * having to know which fields are really method-bearing objects.
 */
export interface DarkVeilSnapshot {
  /** Where the launch as a whole has got to. */
  phase: LaunchPhase;
  /** Where the DarkVeil phase specifically has got to. */
  dvState: DarkVeilState;
  /** Whether the phase ended in failure, which routes every bond back in full. */
  dvFailed: boolean;
  /** Flat DarkVeil price per token, in the launch's own denomination. */
  dvPrice: bigint;
  /** Total tokens the DarkVeil phase may distribute. */
  dvAllocation: bigint;
  /** Per-registrant allocation, fixed once the phase closes. Zero until then. */
  baseSlot: bigint;
  /** Registrants admitted so far. */
  registrationCount: bigint;
  /** Tokens committed by revealed buys. */
  totalTokensCommitted: bigint;
  /** Value committed by revealed buys. */
  totalRaisedCommitted: bigint;
  /** The published allowlist root registrants prove membership against. */
  allowlistRootHex: string;
  /** The registrant root published when buying opens. Zero before that. */
  registrantRootHex: string;
  /** Whether the settlement record has been closed. */
  settlementFinalized: boolean;
  /** The ZK Fair Launch Certificate, filled in when the phase closes. */
  fairLaunchCert: FairLaunchCert;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Narrows a decoded ledger to the headline figures. */
export function summarizeDarkVeil(ledger: EligibilityGateLedger): DarkVeilSnapshot {
  return {
    phase: ledger.phase,
    dvState: ledger.dvState,
    dvFailed: ledger.dvFailed,
    dvPrice: ledger.dvPrice,
    dvAllocation: ledger.dvAllocation,
    baseSlot: ledger.baseSlot,
    registrationCount: ledger.registrationCount,
    totalTokensCommitted: ledger.totalTokensCommitted,
    totalRaisedCommitted: ledger.totalRaisedCommitted,
    allowlistRootHex: toHex(ledger.allowlistRoot),
    registrantRootHex: toHex(ledger.registrantRoot),
    settlementFinalized: ledger.settlementFinalized,
    fairLaunchCert: ledger.fairLaunchCert,
  };
}

/** Reads a Cardano Launch gate and returns only its headline figures. */
export async function readDarkVeilSnapshot(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<DarkVeilSnapshot> {
  return summarizeDarkVeil(await readEligibilityGateLedger(publicDataProvider, contractAddress));
}
