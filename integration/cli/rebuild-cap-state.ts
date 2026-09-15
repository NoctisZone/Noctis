// ============================================================================
// Noctis Zone — rebuild a launch's per-wallet cap totals from chain
// ============================================================================
// The cumulative wallet cap keeps its totals off chain behind a 32-byte root,
// so every trade must arrive already knowing its own total and a proof of it.
// This replays the launch's public history and prints those totals in the
// shape every trade CLI takes as `capState`.
//
// It CHECKS itself against the curve's own root before printing, so a caller
// gets either a usable answer or a refusal — never a plausible-looking list
// that would produce proofs the validator rejects.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { Blockfrost, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { rebuildCapAccumulator } from '../cap-accumulator-from-history.js';
import { bytesToHex } from '../cap-accumulator-tree.js';
import { selectLaunchUtxo } from '../launch-utxo-lookup.js';
import { BondingCurveTierBDatumSchema } from '../tier-a-schemas.js';
import { TierATradeHistoryReader } from '../tier-a-trade-history-reader.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

interface Input {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  tier: 'B';
}

const CURVE_TITLE = 'bonding_curve_tier_b.bonding_curve_tier_b.spend';

// The linear-curve path is retired, so the only tier this resolves is the
// quadratic one. Checked at runtime rather than left to the type: input
// arrives as JSON, and a retired tier silently resolving to a different
// validator would run this command against a contract nobody named.
function requireLiveTier(tier: string): void {
  if (tier !== 'B') {
    throw new Error(`tier must be "B" - the linear-curve path is retired (got "${tier}")`);
  }
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'blockfrostProjectId',
    'blockfrostUrl',
    'tier',
  ]);
  requireLiveTier(input.tier);

  const network = CARDANO_NETWORK_MAP[input.network];
  const blueprint = loadPlutusBlueprint(__dirname);
  const compiledScriptCbor = loadValidatorCbor(blueprint, CURVE_TITLE);
  const curveAddress = validatorToAddress(network, { type: 'PlutusV3', script: compiledScriptCbor });

  // The root to check against comes from the launch's own authenticated UTXO,
  // not from any argument — the point of the check is lost if the caller can
  // supply what it is checked against.
  const lucid = await Lucid(new Blockfrost(input.blockfrostUrl, input.blockfrostProjectId), network);
  const schema = BondingCurveTierBDatumSchema;
  const found = selectLaunchUtxo<{ cap_root: string; launch_id: string; thread_nft_policy: string }>(
    await lucid.utxosAt(curveAddress),
    curveAddress,
    input.launchIdHex,
    'bondingCurveTierB',
    schema as never,
    input.threadNftPolicyId,
  );
  if (!found.utxo.datum) throw new Error('The launch UTXO carries no inline datum.');
  const { cap_root } = Data.from<{ cap_root: string }>(found.utxo.datum, schema as never);

  const reader = new TierATradeHistoryReader({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    bondingCurveAddress: curveAddress,
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
    tier: input.tier,
  } as never);

  const acc = await rebuildCapAccumulator(reader, cap_root);
  process.stdout.write(
    JSON.stringify(
      jsonSafe({
        capRoot: cap_root,
        capState: acc.entries().map((e) => ({ keyHashHex: bytesToHex(e.key), total: e.total })),
      }),
    ),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
