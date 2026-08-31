// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 3
// Genesis-datum encoder: BondingCurveDatum / VestingDatum / LpEscrowDatum
// ============================================================================
// Produces the 3 CBOR-encoded inline datums the linear curve mint+seed transaction
// must attach to its 3 genesis outputs (bonding_curve/vesting/lp_escrow's
// fixed script addresses — see finding #1 in TIER_A_PREPROD_MILESTONE.md:
// none of the 3 validators take constructor parameters, so every launch
// shares ONE address per validator and is distinguished purely by its
// datum's launch_id field).
//
// Schemas are imported from ../tier-a-schemas.ts, the SAME module
// read-tier-a-launch-state.ts (Phase 2) uses to decode — Data.to() here is
// the direct inverse of that file's Data.from(), so the two can never
// silently drift apart (the class of bug already caused once for real
// in this project: a stale plutus.json producing a wrong-shaped tx).
//
// Genesis field values below were derived by reading each validator's own
// redeemer-handling logic directly (not assumed from CLAUDE.md prose, which
// documents intent but not exact datum shape) — specifically:
//   - bonding_curve.ak's mock_datum() + Graduate's lp_seeding_output_ok():
//     community_pub_key_hash starts "" (empty), cto_triggered/lp_seeded/
//     staking_seeded start False, lp_escrow_credential/staking_pool_credential
//     are the FIXED script addresses' own credentials (ScriptCredential),
//     not placeholder key credentials — Graduate later verifies real value
//     lands exactly there.
//   - vesting.ak's StartVesting: only checks vesting_state == NotStarted,
//     does not cross-check token_allocation against deposited value — but
//     community_treasury_wallet still starts "" per its own mock_datum().
//   - lp_escrow.ak's SealLock + lp_value_received(): lock_timestamp must be
//     exactly 0, lock_duration must be >= min_lock_duration (31_536_000s /
//     365 days) — and critically, lp_value_received() checks the SEALING
//     transaction deposits exactly datum.lp_token_amount of
//     (datum.lp_token_policy_id, datum.lp_token_name); SealLock's own
//     equality check on new_datum never updates those 3 fields, meaning
//     they must ALREADY be correct at GENESIS, not set later. Concretely:
//     lp_token_policy_id/lp_token_name = the launch's own token identity,
//     lp_token_amount = lp_reserve_tokens (same figure bonding_curve's own
//     lp_reserve_tokens field holds) — confirmed by reading lp_value_received()
//     directly, not assumed from the "15% of supply" prose alone.
//
// launch_id scheme (fresh decision, 2026-07-17, restated explicitly here
// since it wasn't preserved verbatim across a context compaction earlier
// this session): blake2b_256(token_policy_id_bytes ++ token_asset_name_bytes),
// 32 bytes. A minted policy+asset pair is already globally unique per launch
// (Anvil generates a fresh policy per mint) and is known before genesis
// datums are built (policy provisioning happens before the mint tx), so
// hashing it produces a deterministic, collision-safe, opaque launch_id
// with no extra input needed. Uses @noble/hashes/blake2.js's real
// blake2b(msg, {dkLen}) API — same verified-real primitive/package
// zk-cert-relayer.ts already uses for Blake2b-256 hashing on this project.
//
// Credential encoding: CredentialSchema's real runtime shape (verified
// against @lucid-evolution/lucid's own .d.ts, not assumed) is a discriminated
// union of { PubKeyCredential: [hashHex] } | { ScriptCredential: [hashHex] }
// — a different, PlutusData-encoding-specific type from Lucid's own
// address-building `Credential` ({type:"Key"|"Script",hash}), which is NOT
// what Data.to() needs here. lp_escrow/staking_pool script hashes come from
// validatorToScriptHash() against the same freshly-loaded plutus.json
// validators the mint-tx builder and Phase 2's reader both use.
//
// Input: single JSON object on stdin (includes `network`, same
// preview/preprod/mainnet convention as read-tier-a-launch-state.ts). Output:
// single JSON object on stdout with 3 CBOR-hex-encoded datums, the computed
// launch_id, the supply split, AND the 3 fixed validator addresses
// (bonding_curve/vesting/lp_escrow, network-specific, derived the same way
// Phase 2's reader derives them) — so the PHP mint-flow orchestrator never
// needs its own bech32 address derivation; this script is the one place
// that loads plutus.json and owns that logic. Caller attaches the 3 CBOR
// datums as inlineDatum on outputs at these 3 addresses, and persists
// launch_id_hex back to the np_launch CPT (per inc/cpt/launch.php's own
// "populated once minted — Phase 3+" comment).
//
// NOT yet tested against a real Preprod submission — this script only
// proves it can construct byte-correct CBOR; the mint+seed transaction
// itself (build-tier-a-mint-tx.ts or an anvil-client.php extension,
// depending on Phase 0's still-pending datum-output spike result) is the
// next deliverable that actually uses this output for real.
// ============================================================================

import { Data, validatorToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import { calculateMinLovelaceFromUTxO, PROTOCOL_PARAMETERS_DEFAULT } from '@lucid-evolution/utils';
import { blake2b } from '@noble/hashes/blake2.js';
import { CAP_EMPTY_ROOT, bytesToHex as capBytesToHex } from './cap-accumulator-tree.js';
import { CARDANO_NETWORK_MAP, loadPlutusBlueprint, type PlutusBlueprint, requireFieldsStrict } from './cli/cli-io.js';
import {
  assertValidCip68BaseName,
  type BondingCurveDatumData,
  BondingCurveDatumSchema,
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  buildCip68FungibleMetadata,
  CIP68_STANDARD_VERSION,
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  cip68FungibleAssetName,
  cip68ReferenceAssetName,
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  loadValidator,
  type StakingPoolDatumData,
  StakingPoolDatumSchema,
  type TokenMetadataDatumData,
  TokenMetadataDatumSchema,
  threadNftAssetNames,
  type VestingDatumData,
  VestingDatumSchema,
  type ZkAnchorDatumData,
  ZkAnchorDatumSchema,
} from './tier-a-schemas.js';

declare const __dirname: string;

// ============================================================================
// Input
// ============================================================================

export interface BuildGenesisDatumsInput {
  network: 'preview' | 'preprod' | 'mainnet';
  // 'A' (default) → bonding_curve.ak / BondingCurveDatum.
  // 'B' → bonding_curve_tier_b.ak / BondingCurveTierBDatum. The ONLY genesis
  // difference is the curve validator + the curve datum's purchase-tracking
  // fields (Cardano Launch adds
  // dv_allocation_root/dv_claimed/dv_settled — the DarkVeil-claim
  // mechanism). Supply split is identical: DarkVeil claims draw from the SAME
  // curve_supply (verified against bonding_curve_tier_b.ak's
  // ClaimDarkVeilTokens — `dv_amount <= curve_supply - tokens_sold`), so there
  // is NO separate DarkVeil token carve-out at genesis. vesting/lp_escrow are
  // the shared validators, identical for both tiers.
  tier?: 'A' | 'B';
  /** DarkVeil allocation as a % of total supply — Cardano Launch only, 10-20,
   *  default DV_ALLOC_DEFAULT. Drawn from curve_supply rather than carved out
   *  of it; see dv_reserve_tokens below. */
  dvAllocPct?: number;
  /** DarkVeil claim window in milliseconds — Cardano Launch only. Defaults to 24h.
   *  The validator accepts 10 minutes to 7 days; this builder additionally
   *  refuses anything under an hour unless `allowShortDvWindows` is set. */
  dvClaimWindowMs?: number;
  /** Dead window between the claim window closing and the public curve
   *  opening, in milliseconds — Cardano Launch only. Defaults to 30 minutes. The
   *  validator accepts 1 minute to 24 hours. */
  dvSettlementWindowMs?: number;
  /** Opt in to sub-hour DarkVeil windows.
   *
   *  A short claim window is hostile to a real registrant: miss it and the
   *  allocation is forfeited. It exists for demos and tests, where the same
   *  operator places every claim, and it has to be asked for by name so it
   *  cannot be reached by passing a number that looked small enough. */
  allowShortDvWindows?: boolean;
  creatorPubKeyHashHex: string;
  governorPubKeyHashHex: string;
  tokenPolicyIdHex: string;
  /** The ticker as a creator typed it, hex-encoded — the CIP-68 BASE name.
   *  The on-chain asset name is this behind CIP-67 label 333; the reference
   *  NFT is the same base behind label 100. Never pass a labelled name. */
  tokenBaseNameHex: string;

  // CIP-68 metadata — what a wallet displays for this token. `name` and
  // `description` are required by the 333 sub-standard; the rest are
  // optional and all of them are worth setting.
  tokenName: string;
  tokenDescription: string;
  tokenUrl?: string;
  /** A URI, e.g. `ipfs://<cid>` — not a bare CID. */
  tokenLogoUri?: string;
  /** Defaults to 0: the curve prices and sells WHOLE tokens, so the supply
   *  really is 1,000,000,000 units rather than a scaled base amount. */
  tokenDecimals?: number;

  /** Wall-clock time written into the metadata datum's last_updated_ts.
   *  Defaults to now; overridable so a build is reproducible in tests. */
  genesisTimestampMs?: number;

  totalSupply?: number; // default 1_000_000_000 (CLAUDE.md TOTAL_SUPPLY)
  /** Default 20 (LP_RESERVE_PCT, platform-fixed). Raised from 15 on 2026-08-04:
   *  the LP receives 20% of supply plus the whole net-of-fee raise, and because
   *  a curve's average price is below its final price, the pool opens ABOVE the
   *  graduation price. 20% narrows that step to ~1.8x (the linear curve) / ~1.2x (Cardano Launch)
   *  and, unlike a higher figure, never inverts it in any allocation the wizard
   *  permits — a pool opening BELOW the graduation price would put late curve
   *  buyers underwater at the moment trading starts. */
  lpReservePct?: number;
  creatorAllocPct?: number; // default 5 (CREATOR_ALLOC_REC low end; 5-8 recommended, 10 max)
  walletCapPct?: number; // default 5 (WALLET_CAP_PCT)
  stakingEnabled?: boolean; // default false
  stakingAllocPct?: number; // default 25 (STAKING_ALLOC_PCT), only applied if stakingEnabled
  /**
   * The runway the creator commits to, STAKING_DURATION_MIN_DAYS..MAX_DAYS.
   * Required when staking is enabled and deliberately given no default: it
   * and the reserve together fix the pool's emission rate for life, and the
   * curve pins that rate on chain, so a wrong value here cannot be corrected
   * later.
   */
  stakingDurationDays?: number;
  /** Overrides the pool's opening timestamp. Real POSIX ms; defaults to now. */
  mintedAtMs?: number;

  /**
   * The payment key hashes allowed to apply a batch against this curve, as
   * 28-byte hex. The batch arm requires the batcher to be named here AND to
   * have signed, so a launch minted without one accepts no batches until the
   * governor sets the list — orders still stand and stay spendable by their
   * own owners, so nothing is stranded meanwhile.
   *
   * Defaults to empty deliberately rather than to some ambient platform key:
   * whoever mints a launch should say who may batch it, and a wrong default
   * would be a silent grant.
   */
  batcherAllowlistHex?: readonly string[];

  basePrice: number; // lovelace/token at sold=0
  maxPrice: number; // lovelace/token at sold=curve_supply
  vestDays: number; // 90-365, no default (CLAUDE.md: forced active selection)
  // Milliseconds, matching lp_escrow.ak's own min_lock_duration floor and the
  // chain time it is compared against. Default 31_536_000_000 (365 days).
  lpLockDurationMs?: number;

  // (2026-07-23): the governance thread-NFT policy id (PolicyId, 28-byte
  // hex) all three genesis datums carry (thread_nft_policy). Only read by
  // the cto_vote_verified check (CTO voting) — inert for mint/activate/buy/
  // graduate/vest/stake. Phase G (2026-07-28) closed the open off-chain half
  // of this: the caller now mints this NFT for real (governor-sig-only native
  // script, PHP-side, see anvil-client.php's
  // np_anvil_generate_governance_nft_policy) and must pass the real policy id
  // here — required, no more zero-byte placeholder, since this same value is
  // now also used below to build the real genesis cto_governance UTXO/datum.
  threadNftPolicyIdHex: string;

  // Phase G (2026-07-28): genesis inputs for the NEW 4th genesis output —
  // the initial cto_governance UTXO itself (previously only this validator's
  // SCRIPT HASH was embedded into the other 3 datums as a reference
  // credential; no actual governance UTXO was ever created). Real keyhashes,
  // not placeholders — governor is the same governorPubKeyHashHex already
  // required above; treasury/ops are the platform's own fee-recipient
  // wallets (same ones the mint tx already pays the launch fee split to).
  treasuryPubKeyHashHex: string;
  opsPubKeyHashHex: string;
  /**
   * Ballot window width in seconds (CLAUDE.md CTO_VOTE_WINDOW_HRS = 72).
   * Defaults to 259200. An anchored vote result must describe a window
   * exactly this wide, so a launch running a different ballot length has to
   * set it here.
   */
  ballotDurationSeconds?: number;
  // CTO constants (CLAUDE.md) — defaults match cto_governance.ak's own
  // mock_datum() test values, which already encode the anti-whale-takeover
  // fix (2026-07-28): quorum 5% (500 bps), unified 1% per-voter cap (100
  // bps, field named creator_vote_cap_bps for backward-compat blast-radius
  // reasons — see the .ak file's own field comment), 15-voter floor.
  /**
   * Protocol `coinsPerUtxoByte`, used to size each genesis output's minimum
   * lovelace. Defaults to the current mainnet/preprod value. Exposed so a
   * protocol-parameter change can be handled without a code change.
   */
  coinsPerUtxoByte?: string;
  /**
   * Extra headroom above the computed minimum, in basis points (default 2000
   * = +20%). Absorbs protocol-parameter drift and small datum growth. Not a
   * substitute for sizing an output that grows without bound.
   */
  minUtxoBufferBps?: number;
  quorumBps?: number;
  creatorVoteCapBps?: number;
  minVoterCount?: number;
  /**
   * The compiled blueprint to read validators from. Defaults to the one on
   * disk beside the bundled CLI.
   *
   * Exposed because the default resolves relative to the BUNDLE's location,
   * which is why this function had no test until now: called from anywhere
   * else — a test, another module — it looked for `plutus.json` in a directory
   * that does not exist. Passing it explicitly is the only way to exercise
   * genesis without reproducing the bundle layout.
   */
  blueprint?: PlutusBlueprint;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`Odd-length hex string: "${hex}"`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Builds every genesis datum for one launch, plus the addresses and
 * per-output minimum lovelace the mint transaction needs.
 *
 * Exported so the mint builder can call it in-process: the launch token's
 * policy id depends on which creator UTXO seeds the one-shot, and launch_id
 * hashes that policy id, so seed selection and datum construction have to
 * happen in one place, in that order. `main` below keeps the stdin/stdout
 * CLI shape for callers that only want the datums.
 */
export async function buildGenesisDatums(input: BuildGenesisDatumsInput) {
  requireFieldsStrict(input, [
    'network',
    'creatorPubKeyHashHex',
    'governorPubKeyHashHex',
    'tokenPolicyIdHex',
    'tokenBaseNameHex',
    'tokenName',
    'tokenDescription',
    'basePrice',
    'maxPrice',
    'vestDays',
    'threadNftPolicyIdHex',
    'treasuryPubKeyHashHex',
    'opsPubKeyHashHex',
  ]);

  const tier = input.tier ?? 'A';
  if (tier !== 'A' && tier !== 'B') {
    throw new Error(`tier must be 'A' or 'B', got ${JSON.stringify(tier)}`);
  }
  const totalSupply = input.totalSupply ?? 1_000_000_000;
  const lpReservePct = input.lpReservePct ?? 20;
  // Taking nothing is the default; a creator raises it deliberately or not at
  // all. `??` rather than `||` matters here — 0 is a real, chosen value.
  const creatorAllocPct = input.creatorAllocPct ?? 0;
  // The linear curve has no DarkVeil phase, so no reserve; Cardano Launch defaults to
  // DV_ALLOC_DEFAULT and is creator-adjustable within DV_ALLOC_MIN/MAX.
  const dvAllocPct = tier === 'B' ? (input.dvAllocPct ?? 15) : 0;
  if (tier === 'B' && (dvAllocPct < 10 || dvAllocPct > 20)) {
    throw new Error(`dvAllocPct must be 10-20 (DV_ALLOC_MIN/DV_ALLOC_MAX), got ${dvAllocPct}`);
  }

  // The launch's own DarkVeil windows. Production values by default; the
  // validator's own bounds are the outer limit and are repeated here so a bad
  // value is refused before it costs a transaction rather than after.
  const dvClaimWindowMs = input.dvClaimWindowMs ?? 86_400_000;
  const dvSettlementWindowMs = input.dvSettlementWindowMs ?? 1_800_000;
  if (tier === 'B') {
    if (dvClaimWindowMs < 600_000 || dvClaimWindowMs > 604_800_000) {
      throw new Error(`dvClaimWindowMs must be 600000 (10 min) to 604800000 (7 days), got ${dvClaimWindowMs}`);
    }
    if (dvSettlementWindowMs < 60_000 || dvSettlementWindowMs > 86_400_000) {
      throw new Error(`dvSettlementWindowMs must be 60000 (1 min) to 86400000 (24h), got ${dvSettlementWindowMs}`);
    }
    // Narrower than the chain's floor, and deliberately so. A registrant who
    // misses the claim window forfeits their allocation, so a sub-hour window
    // on a launch with real participants is a trap rather than a setting.
    // Demos, where one operator places every claim, opt in by name.
    if (dvClaimWindowMs < 3_600_000 && !input.allowShortDvWindows) {
      throw new Error(
        `dvClaimWindowMs of ${dvClaimWindowMs} is under an hour. A registrant who misses the claim ` +
          'window forfeits their allocation. Pass allowShortDvWindows: true to confirm this is a demo ' +
          'or test launch where the same operator places every claim.',
      );
    }
  }
  const walletCapPct = input.walletCapPct ?? 5;
  const stakingEnabled = input.stakingEnabled ?? false;
  const stakingAllocPct = input.stakingAllocPct ?? 25;
  const stakingDurationDays = input.stakingDurationDays ?? 0;
  if (stakingEnabled && (stakingDurationDays < 1095 || stakingDurationDays > 1825)) {
    throw new Error(
      `stakingDurationDays must be ${1095}-${1825} (STAKING_DURATION_MIN_DAYS..MAX_DAYS) when staking is enabled; ` +
        `got ${input.stakingDurationDays ?? 'nothing'}. It fixes the pool's emission rate for life and the curve ` +
        'pins that rate on chain, so there is no correcting it afterwards.',
    );
  }
  const lpLockDurationMs = input.lpLockDurationMs ?? 31_536_000_000;

  // Bounded here as well as on chain. The validator's cap is what actually
  // holds, but a genesis datum is whatever its author wrote — paying to a
  // script address runs no code — so a list too long to trade against would
  // otherwise only be discovered by the first batch that failed.
  const batcherAllowlistHex = input.batcherAllowlistHex ?? [];
  if (batcherAllowlistHex.length > 8) {
    throw new Error(
      `batcherAllowlistHex holds ${batcherAllowlistHex.length} keys, over the 8 the curve accepts. ` +
        'The list rides in the datum every trade carries, which is why it is capped.',
    );
  }
  for (const keyHash of batcherAllowlistHex) {
    if (!/^[0-9a-f]{56}$/i.test(keyHash)) {
      throw new Error(
        `batcherAllowlistHex entries must be 28-byte payment key hashes as hex, got ${JSON.stringify(keyHash)}.`,
      );
    }
  }

  if (input.vestDays < 90 || input.vestDays > 365) {
    throw new Error(`vestDays must be 90-365 (VESTING_MIN_DAYS/VESTING_MAX_DAYS), got ${input.vestDays}`);
  }
  if (creatorAllocPct < 0 || creatorAllocPct > 10) {
    throw new Error(`creatorAllocPct must be 0-10 (CREATOR_ALLOC_MAX), got ${creatorAllocPct}`);
  }
  if (lpLockDurationMs < 31_536_000_000) {
    throw new Error(
      `lpLockDurationMs must be >= 31,536,000,000 (lp_escrow.ak's own min_lock_duration), got ${lpLockDurationMs}`,
    );
  }

  const lpReserveTokens = Math.floor((totalSupply * lpReservePct) / 100);
  const creatorAllocTokens = Math.floor((totalSupply * creatorAllocPct) / 100);
  const stakingReserveTokens = stakingEnabled ? Math.floor((totalSupply * stakingAllocPct) / 100) : 0;
  const walletCap = Math.floor((totalSupply * walletCapPct) / 100);
  const curveSupply = totalSupply - lpReserveTokens - creatorAllocTokens - stakingReserveTokens;
  if (curveSupply <= 0) {
    throw new Error(
      `Supply split leaves curve_supply <= 0 (total=${totalSupply}, lp=${lpReserveTokens}, creator=${creatorAllocTokens}, staking=${stakingReserveTokens}) — allocations too large.`,
    );
  }

  // The on-chain names. Everything downstream uses the LABELLED name — it is
  // what the policy mints, what the curve holds, and what launch_id hashes.
  assertValidCip68BaseName(input.tokenBaseNameHex);
  const tokenAssetNameHex = cip68FungibleAssetName(input.tokenBaseNameHex);
  const referenceAssetNameHex = cip68ReferenceAssetName(input.tokenBaseNameHex);

  // launch_id = blake2b_256(policy_id_bytes ++ asset_name_bytes) — see file
  // header for the full rationale.
  const policyIdBytes = hexToBytes(input.tokenPolicyIdHex);
  const assetNameBytes = hexToBytes(tokenAssetNameHex);
  const launchIdBytes = blake2b(new Uint8Array([...policyIdBytes, ...assetNameBytes]), { dkLen: 32 });
  const launchIdHex = bytesToHex(launchIdBytes);

  // __dirname resolves relative to the BUNDLED .cjs's real location
  // (cli/dist/), not this source file's — same convention already
  // established and verified by read-tier-a-launch-state.ts. A caller that is
  // not the bundle supplies its own; see the input field's comment.
  const blueprint = input.blueprint ?? loadPlutusBlueprint(__dirname);

  const bondingCurveValidator = loadValidator(
    blueprint,
    tier === 'B' ? 'bonding_curve_tier_b.bonding_curve_tier_b.spend' : 'bonding_curve.bonding_curve.spend',
  );
  const vestingValidator = loadValidator(blueprint, 'vesting.vesting.spend');
  const lpEscrowValidator = loadValidator(blueprint, 'lp_escrow.lp_escrow.spend');
  const stakingPoolValidator = loadValidator(blueprint, 'staking_pool.staking_pool.spend');
  const ctoGovernanceValidator = loadValidator(blueprint, 'cto_governance.cto_governance.spend');
  const zkAnchorValidator = loadValidator(blueprint, 'zk_anchor.zk_anchor.spend');
  const tokenMetadataValidator = loadValidator(blueprint, 'token_metadata.token_metadata.spend');

  const lpEscrowScriptHash = validatorToScriptHash(lpEscrowValidator as never);
  const stakingPoolScriptHash = validatorToScriptHash(stakingPoolValidator as never);
  const ctoGovernanceScriptHash = validatorToScriptHash(ctoGovernanceValidator as never);

  // The on-chain BondingCurve/Vesting/LpEscrow datums now bind the CTO
  // governance validator's own credential (the redirect target the
  // cto_vote_verified NFT check authorizes) plus the governance thread-NFT
  // policy id. thread_nft_policy defaults to a valid 28-byte-zero placeholder
  // — see BuildGenesisDatumsInput.threadNftPolicyIdHex for why that is
  // safe for the pre-CTO test flow.
  const ctoGovernanceCredential = {
    ScriptCredential: [ctoGovernanceScriptHash] as [string],
  };
  const threadNftPolicyId = input.threadNftPolicyIdHex;
  const quorumBps = input.quorumBps ?? 500;
  const creatorVoteCapBps = input.creatorVoteCapBps ?? 100;
  const minVoterCount = input.minVoterCount ?? 15;
  // CLAUDE.md CTO_VOTE_WINDOW_HRS = 72. The anchor requires a result's window
  // to be exactly this wide, so a launch deploying a different ballot length
  // must say so here rather than leaving the validator to accept any.
  const ballotDurationSeconds = input.ballotDurationSeconds ?? 259_200;

  // Same Network capitalization mapping as read-tier-a-launch-state.ts
  // (Lucid Evolution's real Network type is "Preprod", not "preprod" —
  // confirmed against @lucid-evolution/core-types' own .d.ts).
  const network = CARDANO_NETWORK_MAP[input.network];
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator as never);
  const vestingAddress = validatorToAddress(network, vestingValidator as never);
  const lpEscrowAddress = validatorToAddress(network, lpEscrowValidator as never);
  const ctoGovernanceAddress = validatorToAddress(network, ctoGovernanceValidator as never);
  const stakingPoolAddress = validatorToAddress(network, stakingPoolValidator as never);
  const zkAnchorAddress = validatorToAddress(network, zkAnchorValidator as never);
  const tokenMetadataAddress = validatorToAddress(network, tokenMetadataValidator as never);

  const lpEscrowCredential = { ScriptCredential: [lpEscrowScriptHash] as [string] };
  const stakingPoolCredential = { ScriptCredential: [stakingPoolScriptHash] as [string] };

  // Fields shared by both curve datums. The tier-specific purchase-tracking
  // fields are added below. Data.to() reads fields by the SCHEMA's key order,
  // not this object's — so key position here is irrelevant, only presence +
  // value matter (verified: the round-trip decode below matches the contract's
  // own field order exactly).
  const sharedCurveFields = {
    launch_id: launchIdHex,
    creator_pub_key_hash: input.creatorPubKeyHashHex,
    governor_pub_key_hash: input.governorPubKeyHashHex,
    base_price: BigInt(input.basePrice),
    max_price: BigInt(input.maxPrice),
    curve_supply: BigInt(curveSupply),
    // 'as const' so this stays the literal the datum's enum expects rather
    // than widening to string, which is a different type to the encoder.
    curve_state: 'Inactive' as const,
    // The mint IS the start of the Inactive phase, and ExpireCurve measures
    // its stall window from this field — so a zero here would read as
    // "expired since 1970" and let anyone cancel the launch before the
    // governor ever activated it.
    phase_started_at: BigInt(input.genesisTimestampMs ?? Date.now()),
    tokens_sold: 0n,
    // Who may batch this curve. Sits with the written fields at the front
    // because SetBatcherAllowlist rewrites it; see the validator's own field
    // comment for why a rewritten field at the back is paid for in script
    // bytes.
    batcher_allowlist: batcherAllowlistHex.map((k) => k.toLowerCase()),
    total_raised: 0n,
    creator_fees_accrued: 0n,
    platform_fees_accrued: 0n,
    wallet_cap: BigInt(walletCap),
    token_policy_id: input.tokenPolicyIdHex,
    token_asset_name: tokenAssetNameHex,
    lp_escrow_credential: lpEscrowCredential,
    lp_reserve_tokens: BigInt(lpReserveTokens),
    lp_seeded: false,
    community_pub_key_hash: '',
    cto_triggered: false,
    staking_enabled: stakingEnabled,
    staking_pool_credential: stakingPoolCredential,
    staking_reserve_tokens: BigInt(stakingReserveTokens),
    staking_duration_days: BigInt(stakingDurationDays),
    staking_seeded: false,
    cto_governance_credential: ctoGovernanceCredential,
    thread_nft_policy: threadNftPolicyId,
    // The cumulative wallet cap starts with every slot empty, which is what
    // leaves the curve open to any wallet with no registration step: a
    // first-time buyer proves their own empty slot against this root. Derived
    // from the shared tree builder rather than written as a literal, so it
    // cannot drift from what the validator computes.
    cap_root: capBytesToHex(CAP_EMPTY_ROOT),
  };

  const bondingCurveDatum: BondingCurveDatumData | BondingCurveTierBDatumData =
    tier === 'B'
      ? {
          ...sharedCurveFields,
          // Cardano Launch DarkVeil-claim fields. All start empty/false at
          // dv_allocation_root is anchored later by AnchorDvAllocationRoot (with
          // dv_settled → true), which ActivateCurve then requires.
          dv_allocation_root: '',
          // The DarkVeil share of curve_supply. There is no separate token
          // carve-out — the reserve is enforced by the claim window, which is
          // the only time claims are possible, so anything unclaimed when it
          // closes is simply still sellable on the public curve.
          dv_reserve_tokens: BigInt(Math.floor((totalSupply * dvAllocPct) / 100)),
          // Both set by OpenDvClaim, once the registrant count is known.
          dv_claim_opened_at: 0n,
          claimed_bits: '',
          dv_settled: false,
          // The launch's own windows. Declared here, at genesis, so the terms
          // a registrant is shown before registering are the terms they get —
          // a value supplied later could be shortened by the one party who
          // already knows who registered.
          //
          // The validator bounds these when OpenDvClaim starts the clock; the
          // narrower refusal below is this builder's own, so a short window
          // has to be asked for rather than arrived at.
          dv_claim_window: BigInt(dvClaimWindowMs),
          dv_settlement_window: BigInt(dvSettlementWindowMs),
        }
      : {
          ...sharedCurveFields,
        };

  const bondingCurveSchema = tier === 'B' ? BondingCurveTierBDatumSchema : BondingCurveDatumSchema;

  const vestingDatum: VestingDatumData = {
    launch_id: launchIdHex,
    creator_pub_key_hash: input.creatorPubKeyHashHex,
    governor_pub_key_hash: input.governorPubKeyHashHex,
    token_allocation: BigInt(creatorAllocTokens),
    vest_days: BigInt(input.vestDays),
    vesting_state: 'NotStarted',
    claimed_tokens: 0n,
    vest_start_timestamp: 0n,
    cto_triggered: false,
    community_treasury_wallet: '',
    token_policy_id: input.tokenPolicyIdHex,
    token_asset_name: tokenAssetNameHex,
    cto_governance_credential: ctoGovernanceCredential,
    thread_nft_policy: threadNftPolicyId,
    last_claimed_allocation_timestamp: 0n, // starts at 0 at genesis
  };

  const lpEscrowDatum: LpEscrowDatumData = {
    launch_id: launchIdHex,
    lock_timestamp: 0n,
    lock_duration: BigInt(lpLockDurationMs),
    lp_state: 'Locked', // irrelevant pre-seal — SealLock always overwrites to Locked; no "NotStarted" LpState variant exists
    governor_pub_key_hash: input.governorPubKeyHashHex,
    community_wallet_hash: '',
    cto_triggered: false,
    fee_recipient_pub_key_hash: input.creatorPubKeyHashHex,
    dex_whitelist: [], // confirmed decision 2026-07-17: start empty, add Minswap via real governance in Phase 5b
    multisig_signers: [input.governorPubKeyHashHex], // confirmed decision 2026-07-17: governor only, 1-of-1
    multisig_threshold: 1n,
    pending_dex_change: null,
    lp_token_policy_id: input.tokenPolicyIdHex,
    lp_token_name: tokenAssetNameHex,
    lp_token_amount: BigInt(lpReserveTokens),
    cto_governance_credential: ctoGovernanceCredential,
    thread_nft_policy: threadNftPolicyId,
    last_migration_timestamp: 0n, // never migrated at genesis
  };

  // Phase G (2026-07-28): the 4th genesis output — the launch's own
  // cto_governance UTXO. Field values verified directly against
  // cto_governance.ak's own mock_datum() test fixture (the real starting
  // state every one of its tests builds from), not guessed: PreCTO,
  // proposal_count 0, both proposal Options None, zero pending relayer
  // bond/key. community_wallet_hash/pending_relayer_key_hash are
  // VerificationKeyHash fields with no real value yet — same '' convention
  // every other not-yet-set VerificationKeyHash field in this file already
  // uses (community_pub_key_hash, community_treasury_wallet, etc.).
  const ctoGovernanceDatum: CtoGovernanceDatumData = {
    launch_id: launchIdHex,
    cto_state: 'PreCTO',
    community_wallet_hash: '',
    governor_credential_hash: input.governorPubKeyHashHex,
    total_supply: BigInt(totalSupply),
    quorum_bps: BigInt(quorumBps),
    creator_vote_cap_bps: BigInt(creatorVoteCapBps),
    min_voter_count: BigInt(minVoterCount),
    active_proposal: null,
    proposal_count: 0n,
    last_executed_proposal: null,
    pending_relayer_bond: 0n,
    pending_relayer_key_hash: '',
    treasury_pub_key_hash: input.treasuryPubKeyHashHex,
    ops_pub_key_hash: input.opsPubKeyHashHex,
    thread_nft_policy: threadNftPolicyId,
    ballot_duration: BigInt(ballotDurationSeconds),
    // No ballot has run at genesis, so there is nothing to cool down from and
    // a launch's first one is never held back. The validator reads 0 as
    // exactly that rather than as a timestamp in 1970.
    last_ballot_end_timestamp: 0n,
  };

  // 2026-08-03: the staking pool's own genesis datum. Nothing anywhere
  // authored one before this — which is why graduation had no legitimate
  // Pool UTXO to seed into, and why the seeding check had nothing genuine to
  // compare against. Only emitted when the creator opted into staking;
  // otherwise there is no pool to create.
  //
  // Wrapped as the Pool variant of StakingDatum (Constr 0 with ONE nested
  // field), not the bare StakingPoolDatum — see StakingDatumShape's own
  // comment in tier-a-schemas.ts.
  const stakingPoolDatum: StakingPoolDatumData = {
    launch_id: launchIdHex,
    creator_pub_key_hash: input.creatorPubKeyHashHex,
    token_policy_id: input.tokenPolicyIdHex,
    token_asset_name: tokenAssetNameHex,
    thread_nft_policy: threadNftPolicyId,
    // The rate the pool keeps for life: the reserve the creator carved out,
    // spread across the runway they chose. Derived here and pinned on chain
    // by the curve's own seeding check, so graduation cannot choose it.
    // Guarded because this datum is constructed whether or not the creator
    // opted in — it is only EMITTED when they did, and 0/0 is NaN, which
    // BigInt refuses at a call site nowhere near the cause.
    emission_per_day: stakingEnabled ? BigInt(Math.floor(stakingReserveTokens / stakingDurationDays)) : 0n,
    stake_root: capBytesToHex(CAP_EMPTY_ROOT),
    acc_reward_per_token: 0n,
    total_staked: 0n,
    // Nothing to pay out yet. The reserve arrives at graduation, which is
    // also when the pool starts running — the tokens are still in the curve
    // until then, and `Stake` refuses a pool with no budget precisely so this
    // opening state cannot be disturbed before the curve seeds it.
    unallocated: 0n,
    last_update_ms: BigInt(input.mintedAtMs ?? Date.now()),
    exhausted_at: null,
  };

  // 2026-08-03: the ZK anchor's own genesis datum — also never authored
  // before. cert_type starts as the DarkVeil certificate since that is the
  // first one a Cardano Launch launch anchors; proof fields stay empty until a real
  // AnchorCertificate call fills them. relayer_credential_hash starts as the
  // governor's own key so the anchor is never left with no authorized
  // submitter; the governor reassigns it via AddRelayer.
  const zkAnchorDatum: ZkAnchorDatumData = {
    launch_id: launchIdHex,
    cert_type: 'DarkVeilCert',
    proof_bundle_hash: '',
    proof_ipfs_cid: '',
    anchor_timestamp: 0n,
    relayer_credential_hash: input.governorPubKeyHashHex,
    governor_credential_hash: input.governorPubKeyHashHex,
    metadata_hash: '',
    thread_nft_policy: threadNftPolicyId,
  };

  // The CIP-68 reference NFT's genesis datum — the launch's metadata itself.
  // Authored here, at genesis, because the reference NFT is minted here: the
  // launch token's one-shot policy mints the pair together, so there is no
  // later opportunity to create it. Revisions from this point on are spends
  // of this UTXO, never mints.
  const tokenMetadataDatum: TokenMetadataDatumData = {
    metadata: buildCip68FungibleMetadata({
      name: input.tokenName,
      description: input.tokenDescription,
      // The ticker as typed — the base name, decoded back out of the hex the
      // caller supplied, so the map and the asset name can never disagree.
      ticker: Buffer.from(input.tokenBaseNameHex, 'hex').toString('utf8'),
      url: input.tokenUrl,
      logo: input.tokenLogoUri,
      decimals: input.tokenDecimals ?? 0,
    }),
    version: CIP68_STANDARD_VERSION,
    extra: {
      launch_id: launchIdHex,
      bonding_curve_credential: {
        ScriptCredential: [validatorToScriptHash(bondingCurveValidator as never)] as [string],
      },
      token_policy_id: input.tokenPolicyIdHex,
      token_asset_name: tokenAssetNameHex,
      community_pub_key_hash: '',
      cto_triggered: false,
      cto_governance_credential: { ScriptCredential: [ctoGovernanceScriptHash] },
      thread_nft_policy: threadNftPolicyId,
      // First revision. Every UpdateMetadata increments it.
      metadata_revision: 1n,
      last_updated_ts: BigInt(input.genesisTimestampMs ?? Date.now()),
    },
  };

  const bondingCurveCbor = Data.to(bondingCurveDatum, bondingCurveSchema);
  const vestingCbor = Data.to(vestingDatum, VestingDatumSchema);
  const lpEscrowCbor = Data.to(lpEscrowDatum, LpEscrowDatumSchema);
  const ctoGovernanceCbor = Data.to(ctoGovernanceDatum, CtoGovernanceDatumSchema);
  const stakingPoolCbor = stakingEnabled ? Data.to(stakingPoolDatum, StakingPoolDatumSchema) : null;
  const zkAnchorCbor = Data.to(zkAnchorDatum, ZkAnchorDatumSchema);
  const tokenMetadataCbor = Data.to(tokenMetadataDatum, TokenMetadataDatumSchema);

  // ==========================================================================
  // Minimum lovelace per genesis output
  // ==========================================================================
  // Cardano requires every UTXO to hold ADA proportional to its serialized
  // size, so an output's minimum depends on its datum AND on the tokens it
  // carries. These outputs carry large inline datums and a thread NFT each,
  // and the figures they were previously given were fixed constants chosen
  // before the NFTs existed — one of them had already fallen below the floor
  // and only worked because the transaction builder silently corrected it.
  //
  // Computed here rather than at the call site because this is the only place
  // that knows every output's real address, datum and asset set. Verified
  // against a real built transaction: `calculateMinLovelaceFromUTxO` matched
  // the measured `(160 + serialized_bytes) * coinsPerUtxoByte` on all six
  // outputs to the lovelace.
  const coinsPerUtxoByte = BigInt(input.coinsPerUtxoByte ?? PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte);
  const bufferBps = BigInt(input.minUtxoBufferBps ?? 2000);

  const threadUnit = (role: keyof ReturnType<typeof threadNftAssetNames>) =>
    input.threadNftPolicyIdHex + threadNftAssetNames(launchIdHex)[role];
  const tokenUnit = input.tokenPolicyIdHex + tokenAssetNameHex;

  function minLovelaceFor(address: string, datumCbor: string, assets: Record<string, bigint>): string {
    const withAda = { lovelace: 0n, ...assets };
    const exact = calculateMinLovelaceFromUTxO(coinsPerUtxoByte, {
      txHash: '0'.repeat(64),
      outputIndex: 0,
      address,
      assets: withAda,
      datum: datumCbor,
    });
    return ((exact * (10000n + bufferBps)) / 10000n).toString();
  }

  const minLovelace: Record<string, string | null> = {
    bondingCurve: minLovelaceFor(bondingCurveAddress, bondingCurveCbor, {
      [tokenUnit]: BigInt(curveSupply + lpReserveTokens + stakingReserveTokens),
      [threadUnit(tier === 'B' ? 'bondingCurveTierB' : 'bondingCurve')]: 1n,
    }),
    vesting: minLovelaceFor(vestingAddress, vestingCbor, {
      [tokenUnit]: BigInt(creatorAllocTokens),
      [threadUnit('vesting')]: 1n,
    }),
    lpEscrow: minLovelaceFor(lpEscrowAddress, lpEscrowCbor, { [threadUnit('lpEscrow')]: 1n }),
    ctoGovernance: minLovelaceFor(ctoGovernanceAddress, ctoGovernanceCbor, {
      [threadUnit('ctoGovernance')]: 1n,
    }),
    zkAnchor: minLovelaceFor(zkAnchorAddress, zkAnchorCbor, { [threadUnit('zkAnchor')]: 1n }),
    // Authenticated by the reference NFT itself, not a thread NFT — CIP-68
    // already gives this UTXO a unique per-launch token under the launch's
    // own policy.
    tokenMetadata: minLovelaceFor(tokenMetadataAddress, tokenMetadataCbor, {
      [input.tokenPolicyIdHex + referenceAssetNameHex]: 1n,
    }),
    stakingPool:
      stakingEnabled && stakingPoolCbor
        ? minLovelaceFor(stakingPoolAddress, stakingPoolCbor, { [threadUnit('stakingPool')]: 1n })
        : null,
  };

  return {
    tier,
    launchIdHex,
    supplySplit: {
      totalSupply,
      curveSupply,
      lpReserveTokens,
      creatorAllocTokens,
      stakingReserveTokens,
      walletCap,
    },
    addresses: {
      bondingCurve: bondingCurveAddress,
      vesting: vestingAddress,
      lpEscrow: lpEscrowAddress,
      ctoGovernance: ctoGovernanceAddress,
      stakingPool: stakingPoolAddress,
      zkAnchor: zkAnchorAddress,
      tokenMetadata: tokenMetadataAddress,
    },
    lpEscrowScriptHash,
    stakingPoolScriptHash,
    bondingCurveScriptHash: validatorToScriptHash(bondingCurveValidator as never),
    ctoGovernanceScriptHash,
    datums: {
      bondingCurve: bondingCurveCbor,
      vesting: vestingCbor,
      lpEscrow: lpEscrowCbor,
      ctoGovernance: ctoGovernanceCbor,
      // null when the creator declined staking — no pool UTXO is created.
      stakingPool: stakingPoolCbor,
      zkAnchor: zkAnchorCbor,
      tokenMetadata: tokenMetadataCbor,
    },
    threadNftAssetNames: threadNftAssetNames(launchIdHex),
    // The two halves of the CIP-68 pair, so the mint builder never has to
    // re-derive them and risk deriving them differently.
    tokenAssetNameHex,
    referenceAssetNameHex,
    minLovelace,
  };
}
