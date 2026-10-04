// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 2
// Live chain-state reader: bonding_curve / vesting / lp_escrow, by launch_id
// ============================================================================
// None of the linear curve's 3 relevant validators (bonding_curve.ak, vesting.ak,
// lp_escrow.ak) take constructor parameters — confirmed directly against
// contracts/cardano/plutus.json (`parameters` is undefined on all 3 spend
// validators). Every launch shares ONE fixed script address per validator;
// finding a specific launch's state means scanning that address's UTxOs for
// the one whose datum's `launch_id` field matches.
//
// Schema note: every field name/order/constructor-index below is read
// directly from contracts/cardano/plutus.json at runtime (fs.readFileSync,
// not a bundled import) — never hardcoded or copied from .ak source
// comments, which can drift (confirmed happening for real once already this
// project — see darkveil-claim-submitter.ts's own header for the same
// lesson). Re-run `aiken build` before trusting this script if any of the 3
// .ak files have changed since the last build.
//
// No script hash is written down here. Hashes move with every validator
// edit, so a recorded one is a claim that goes stale silently — this file
// carried three from 2026-07-16 and two of them had moved since. The
// blueprint is the only current answer.
// Not hardcoded as constants below — derived fresh from plutus.json's own
// compiledCode via validatorToAddress() every run, so this file can never
// silently drift from what's actually deployed.
//
// Input: single JSON object on stdin (never argv), same convention as
// check-night-balance.ts. Output: single JSON object on stdout, exit 0 on a
// successful check (found or not-found are both success), non-zero with
// {"error": "..."} on any failure the caller couldn't complete.
//
// NOT yet tested against a real launch's UTxOs — no real mint has happened
// yet (Phase 3 of this milestone). What IS real and tested: the "not found"
// path against real Preprod addresses that today hold zero UTxOs (Phase 3
// hasn't seeded them), which is exactly this phase's own checkpoint.
// ============================================================================

import { Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { cardanoProvider } from '../cardano-provider.js';
import {
  BondingCurveTierBDatumSchema,
  LpEscrowDatumSchema,
  loadValidator,
  VestingDatumSchema,
} from '../launch-schemas.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  parseJsonStdin,
  readStdin,
  requireFieldsFalsy,
} from './cli-io.js';

// Bundled as CJS (see build.mjs's readLaunchStateCliConfig comment) —
// __dirname is a native CJS global here, no fileURLToPath(import.meta.url)
// dance needed the way the ESM-format CLI bundles in this directory do.
declare const __dirname: string;

// Datum schemas (BondingCurveTierBDatumSchema/VestingDatumSchema/LpEscrowDatumSchema)
// and loadValidator() now live in ../launch-schemas.ts, shared with the
// genesis-datum encoder (Phase 3) so the two can never drift apart — see
// that file's own header for the full rationale. Extracted 2026-07-17.

// ============================================================================
// Input
// ============================================================================

interface ReadLaunchStateInput {
  launchIdHex: string;
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /**
   * The Cardano Launch curve, the only one there is; absent means the same,
   * and any other value is refused below rather than read against a curve
   * that no longer exists.
   */
  tier?: 'B';
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ReadLaunchStateInput>(raw);

  requireFieldsFalsy(input, ['launchIdHex', 'network', 'blockfrostProjectId', 'blockfrostUrl']);

  // __dirname resolves relative to where the BUNDLED .cjs actually runs
  // from (cli/dist/), not this source file's own location (cli/) — one
  // extra '..' to compensate for that (found via a real run, not assumed).
  const blueprint = loadPlutusBlueprint(__dirname);

  const tier = input.tier ?? 'B';
  if (tier !== 'B') {
    throw new Error(`tier must be "B" - the linear-curve path is retired, got ${JSON.stringify(input.tier)}`);
  }
  // The datum schema travels with the address: a curve decoded against the
  // wrong schema fails Data.from and is skipped as "not our UTxO", the same
  // silent null a wrong address gives.
  const bondingCurveValidator = loadValidator(blueprint, 'bonding_curve_tier_b.bonding_curve_tier_b.spend');
  const bondingCurveSchema = BondingCurveTierBDatumSchema;
  const vestingValidator = loadValidator(blueprint, 'vesting.vesting.spend');
  const lpEscrowValidator = loadValidator(blueprint, 'lp_escrow.lp_escrow.spend');

  // Lucid Evolution's real Network type is capitalized ("Preprod", not
  // "preprod" — confirmed against @lucid-evolution/core-types' own .d.ts,
  // not assumed) — this input field stays lowercase for consistency with
  // every other network field across this codebase's PHP/TS boundary.
  const network = CARDANO_NETWORK_MAP[input.network];
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator);
  const vestingAddress = validatorToAddress(network, vestingValidator);
  const lpEscrowAddress = validatorToAddress(network, lpEscrowValidator);

  const lucid = await Lucid(cardanoProvider(input), network);

  async function findLaunchUtxo<T>(
    address: string,
    schema: T,
  ): Promise<{ decoded: unknown; txHash: string; outputIndex: number } | null> {
    const utxos = await lucid.utxosAt(address);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: unknown;
      try {
        decoded = Data.from(utxo.datum, schema as never);
      } catch {
        continue; // datum doesn't match this schema shape — not our launch's UTxO (or a stale/foreign one)
      }
      const d = decoded as { launch_id?: string };
      if (d.launch_id === input.launchIdHex) {
        return { decoded, txHash: utxo.txHash, outputIndex: utxo.outputIndex };
      }
    }
    return null;
  }

  const [bondingCurve, vesting, lpEscrow] = await Promise.all([
    findLaunchUtxo(bondingCurveAddress, bondingCurveSchema),
    findLaunchUtxo(vestingAddress, VestingDatumSchema),
    findLaunchUtxo(lpEscrowAddress, LpEscrowDatumSchema),
  ]);

  process.stdout.write(
    JSON.stringify({
      found: !!(bondingCurve || vesting || lpEscrow),
      bondingCurve: bondingCurve
        ? {
            ...(jsonSafe(bondingCurve.decoded) as object),
            txHash: bondingCurve.txHash,
            outputIndex: bondingCurve.outputIndex,
          }
        : null,
      vesting: vesting
        ? {
            ...(jsonSafe(vesting.decoded) as object),
            txHash: vesting.txHash,
            outputIndex: vesting.outputIndex,
          }
        : null,
      lpEscrow: lpEscrow
        ? {
            ...(jsonSafe(lpEscrow.decoded) as object),
            txHash: lpEscrow.txHash,
            outputIndex: lpEscrow.outputIndex,
          }
        : null,
    }),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
