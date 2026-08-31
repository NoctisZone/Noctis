// ============================================================================
// Noctis Zone — DarkVeil widget: Cardano Launch claim flow
// ============================================================================
// Thin wrapper around darkveil-claim-submitter.ts's real Lucid Evolution
// submitter. Unlike registration/buy-flow, this needs NO ContractProviders
// (it's a plain Cardano transaction) — just the buyer's own connected
// Cardano wallet API object.
//
// dvAmount/salt/merkleProof are inputs to this module, not something it
// fetches. They come from a DIFFERENT Merkle tree than registration's
// allowlist — bonding_curve_tier_b.ak's dv_allocation_root, built by the
// governor/relayer AFTER DarkVeil closes, containing each buyer's actual
// purchased amount (see the DarkVeil claim settlement design).
// darkveil-registration.php's allowlist-proof endpoint serves the EARLIER
// registration-eligibility tree, so it is not the source for these.
// Serving a buyer their own allocation proof is dedicated per-buyer work:
// it belongs behind an endpoint that returns one buyer's own leaf, which is
// what keeps the rest of the roster private. Callers supply these three
// values; this module fetches no private data.
//
// The cap accumulator is the deliberate exception, and it is not private:
// it is rebuilt here from the launch's own public trade history and checked
// against the `cap_root` the curve datum carries. Taking it from the caller
// would mean trusting a value the chain already has the authority on, and a
// wrong one fails at signing time with nothing useful to say.
// ============================================================================

import type { WalletApi } from '@lucid-evolution/lucid';
import { rebuildCapAccumulator } from '../cap-accumulator-from-history.js';
import { LucidDarkVeilClaimSubmitter, type LucidDarkVeilClaimSubmitterConfig } from '../darkveil-claim-submitter.js';
import { TierATradeHistoryReader } from '../tier-a-trade-history-reader.js';

export interface ClaimTierBParams {
  dvAmount: bigint;
  salt: Uint8Array;
  merkleProof: Array<{ sibling: Uint8Array; goesLeft: boolean }>;
  buyerKeyHash: Uint8Array;
  /** This registrant's index in the allocation tree — selects their bit in the
   *  curve's `claimed_bits`, and is hashed into their own leaf so it cannot be
   *  aimed at anyone else's. Served by the same per-buyer endpoint as the
   *  proof above, for the same privacy reason. */
  leafIndex: number;
}

/**
 * `walletApi` is the raw CIP-30 API object (e.g. `await window.cardano[walletId].enable()`)
 * — the buyer signs and pays for this transaction themselves, no relayer
 * key involved.
 */
export async function claimTierBTokens(
  config: LucidDarkVeilClaimSubmitterConfig,
  walletApi: WalletApi,
  params: ClaimTierBParams,
): Promise<{ txHash: string }> {
  const submitter = new LucidDarkVeilClaimSubmitter(config);
  const datum = await submitter.readCurveDatum();
  const reader = new TierATradeHistoryReader({
    blockfrostProjectId: config.blockfrostProjectId,
    blockfrostUrl: config.blockfrostUrl,
    bondingCurveAddress: submitter.curveAddress,
    launchIdHex: Buffer.from(config.launchId).toString('hex'),
    tier: 'B',
  });
  const capState = await rebuildCapAccumulator(reader, datum.cap_root);

  return submitter.claimDarkVeilTokens(
    walletApi,
    {
      dvAmount: params.dvAmount,
      salt: params.salt,
      merkleProof: params.merkleProof,
      buyerKeyHash: params.buyerKeyHash,
      leafIndex: params.leafIndex,
    },
    capState,
  );
}
