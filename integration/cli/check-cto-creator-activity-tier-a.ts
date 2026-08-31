// ============================================================================
// Noctis Zone — CTO Governance: Creator Activity Check (Cardano)
// ============================================================================
// Computes the two facts cto_governance.compact's updateCreatorActivity
// circuit needs from off-chain observation of the real Cardano curve/
// vesting contracts — see that circuit's own doc comment:
//
//   lastCreatorActivity — the most recent timestamp the creator claimed
//     fees (ClaimCreatorFees, bonding_curve) or vested tokens (ClaimVested,
//     vesting). Both are real, creator-signature-gated actions —
//     same "real activity" signal CLAUDE.md's Silence Lock Conditions
//     already expects ("no monthly fee claim for 90+ consecutive days").
//   hasClaimableBalance — whether the curve currently holds a real,
//     nonzero unclaimed creator_fees_accrued balance right now, not just
//     whether one was EVER claimed. A launch that's never had any trade
//     volume has nothing to recover via a SilenceLockTrigger vote — see
//     the same reasoning in cto_governance.compact.
//
// Reuses two already-real, already-tested pieces rather than duplicating
// their logic: tier-a-trade-history-reader.ts's TierATradeHistoryReader
// (for the timestamp, via its own isCreatorAction flag) and the same live-
// UTxO-datum-read pattern read-tier-a-launch-state.ts already established
// (for the current balance) — this file's own Blockfrost/Lucid setup is
// self-contained rather than importing that CLI script directly, matching
// this codebase's existing per-CLI-script convention (read-tier-a-launch-
// state.ts itself doesn't import trade-history-reader.ts's overlapping
// Blockfrost logic either).
//
// Output is NOT yet wired into a live updateCreatorActivity call anywhere —
// that requires a governor Midnight signing key with no custody mechanism
// in this codebase yet, the same open blocker every other governor-
// only Midnight write already has. This CLI's job stops at "here are the
// two real facts," matching this codebase's existing pattern of separating
// read/compute steps from the (still-blocked) write step.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 on success (found or not-found are both success), non-
// zero with {"error": "..."} on any failure the caller couldn't complete.
// ============================================================================

import { Blockfrost, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { BondingCurveDatumSchema, BondingCurveTierBDatumSchema, loadValidator } from '../tier-a-schemas.js';
import { TierATradeHistoryReader } from '../tier-a-trade-history-reader.js';
import { CARDANO_NETWORK_MAP, loadPlutusBlueprint, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

declare const __dirname: string;

interface CheckCreatorActivityInput {
  launchIdHex: string;
  tier: 'A' | 'B';
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<CheckCreatorActivityInput>(raw);

  requireFieldsFalsy(input, ['launchIdHex', 'tier', 'network', 'blockfrostProjectId', 'blockfrostUrl']);
  if (input.tier !== 'A' && input.tier !== 'B') {
    throw new Error(`tier must be "A" or "B" (got "${input.tier}")`);
  }

  // __dirname resolves relative to the BUNDLED .cjs's own location
  // (cli/dist/), same gotcha read-tier-a-launch-state.ts already documents.
  const blueprint = loadPlutusBlueprint(__dirname);

  const validatorExportName =
    input.tier === 'A' ? 'bonding_curve.bonding_curve.spend' : 'bonding_curve_tier_b.bonding_curve_tier_b.spend';
  const bondingCurveValidator = loadValidator(blueprint, validatorExportName);

  const network = CARDANO_NETWORK_MAP[input.network];

  const lucid = await Lucid(new Blockfrost(input.blockfrostUrl, input.blockfrostProjectId), network);
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator);

  // --- Current balance: live datum read, same pattern as
  // read-tier-a-launch-state.ts's findLaunchUtxo. ---
  const datumSchema = input.tier === 'A' ? BondingCurveDatumSchema : BondingCurveTierBDatumSchema;
  const utxos = await lucid.utxosAt(bondingCurveAddress);
  let creatorFeesAccrued: bigint | null = null;
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    let decoded: unknown;
    try {
      decoded = Data.from(utxo.datum, datumSchema as never);
    } catch {
      continue;
    }
    const d = decoded as { launch_id?: string; creator_fees_accrued?: bigint };
    if (d.launch_id === input.launchIdHex) {
      creatorFeesAccrued = d.creator_fees_accrued ?? 0n;
      break;
    }
  }

  const found = creatorFeesAccrued !== null;
  const hasClaimableBalance = creatorFeesAccrued !== null && creatorFeesAccrued > 0n;

  // --- Last real creator activity: trade history, filtered to creator-signed
  // claim actions only (ClaimCreatorFees/ClaimVested — real-signature-
  // gated actions, matching CLAUDE.md's Silence Lock "monthly fee claim"
  // signal). Vesting address isn't wired here since it needs its own
  // launch_id datum lookup the same way — deliberately kept to the curve
  // address only for this first pass; ClaimCreatorFees alone is a real,
  // sufficient activity signal, and adding vesting's ClaimVested tracking
  // is a same-shape follow-up, not a blocker.
  const historyReader = new TierATradeHistoryReader({
    launchIdHex: input.launchIdHex,
    tier: input.tier,
    bondingCurveAddress,
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
  });
  const trades = await historyReader.getCurveTradeHistory();
  const creatorEvents = trades.filter((t) => t.isCreatorAction);
  const lastFeeClaimTimestamp = creatorEvents.length > 0 ? Math.max(...creatorEvents.map((e) => e.blockTime)) : 0;

  process.stdout.write(
    JSON.stringify({
      found,
      hasClaimableBalance,
      creatorFeesAccrued: creatorFeesAccrued !== null ? creatorFeesAccrued.toString() : null,
      lastFeeClaimTimestamp,
      creatorFeeClaimCount: creatorEvents.length,
    }),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
