// ============================================================================
// Noctis Zone — the linear curve shared Lucid Evolution Data schemas
// ============================================================================
// Single source of truth for bonding_curve/vesting/lp_escrow's real datum
// shapes, shared by read-tier-a-launch-state.ts (Phase 2, decode) and
// build-tier-a-genesis-datums.ts (Phase 3, encode) — extracted here
// 2026-07-17 specifically to avoid the two ever drifting apart, the same
// class of bug found for real once already in this project (a stale
// plutus.json producing a wrong-shaped transaction).
//
// Every field name/order/constructor-index mirrors contracts/cardano/
// plutus.json's real definitions as of 2026-07-17 (bonding_curve/
// BondingCurveDatum, vesting/VestingDatum, noctis/lp_escrow_datum/LpEscrowDatum + their
// *State enums) — not .ak source comments, which can drift. Re-verify
// against a freshly-regenerated plutus.json if any of the 3 .ak files
// change after this date.
//
// Credential fields (lp_escrow_credential, staking_pool_credential, and
// lp_escrow's dex_whitelist/multisig entries) use Lucid Evolution's own
// built-in CredentialSchema — verified positionally compatible with
// Aiken's Credential (VerificationKeyCredential=0, ScriptCredential=1 on
// both sides; CIP-57 titles are never encoded on-chain, only Constr index +
// positional fields matter) — same confirmed-compatible pattern
// darkveil-claim-submitter.ts already established for Cardano Launch.
// ============================================================================

import { Constr, CredentialSchema, Data } from '@lucid-evolution/lucid';

export const CurveStateSchema = Data.Enum([
  Data.Literal('Inactive'),
  Data.Literal('Active'),
  Data.Literal('Graduated'),
  Data.Literal('Cancelled'),
]);

/// Cardano Launch's CurveState is a DIFFERENT on-chain type from the linear curve's, and no
/// longer the same shape: it carries the DarkVeil claim window. `DvClaim` is
/// declared last on-chain precisely so `Active`/`Graduated`/`Cancelled` keep
/// their indices, so this must list it last too — the order here IS the
/// encoding. Do not collapse the two schemas back into one.
export const CurveStateTierBSchema = Data.Enum([
  Data.Literal('Inactive'),
  Data.Literal('Active'),
  Data.Literal('Graduated'),
  Data.Literal('Cancelled'),
  Data.Literal('DvClaim'),
]);

export const BondingCurveDatumShape = Data.Object({
  curve_state: CurveStateSchema,
  // One platform wallet: a single accrual, claimed once.
  platform_fees_accrued: Data.Integer(),
  creator_fees_accrued: Data.Integer(),
  total_raised: Data.Integer(),
  tokens_sold: Data.Integer(),
  /** The keys allowed to apply a batch against this curve — checked by the
   *  batch arm alongside the transaction's real signatures, so naming a key in
   *  the redeemer is no longer enough on its own. Rewritten only by
   *  SetBatcherAllowlist, which is why it sits with the written fields at the
   *  front rather than with the read-only ones at the back. */
  batcher_allowlist: Data.Array(Data.Bytes()),
  // The cumulative wallet cap, as one root over `key -> tokens taken from this
  // curve`. Genesis writes CAP_EMPTY_ROOT (see cap-accumulator-tree.ts); every
  // trade rewrites it. Appended last on both tiers because a datum is
  // positional.
  cap_root: Data.Bytes(),
  community_pub_key_hash: Data.Bytes(),
  cto_triggered: Data.Boolean(),
  phase_started_at: Data.Integer(),
  lp_seeded: Data.Boolean(),
  staking_seeded: Data.Boolean(),
  launch_id: Data.Bytes(),
  creator_pub_key_hash: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  base_price: Data.Integer(),
  max_price: Data.Integer(),
  curve_supply: Data.Integer(),
  wallet_cap: Data.Integer(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  lp_escrow_credential: CredentialSchema,
  lp_reserve_tokens: Data.Integer(),
  staking_enabled: Data.Boolean(),
  staking_pool_credential: CredentialSchema,
  staking_reserve_tokens: Data.Integer(),
  /** The runway the creator commits to at launch creation. With the reserve it
   *  fixes the pool's emission rate for life, and the curve pins that rate on
   *  chain at graduation — so a wrong value here cannot be corrected later. */
  staking_duration_days: Data.Integer(),
  // Fix (2026-07-23): added to the on-chain datum after this
  // schema was first written. thread_nft_policy is a PolicyId (bytes).
  cto_governance_credential: CredentialSchema,
  thread_nft_policy: Data.Bytes(),
});
export type BondingCurveDatumData = Data.Static<typeof BondingCurveDatumShape>;
export const BondingCurveDatumSchema = BondingCurveDatumShape as unknown as BondingCurveDatumData;

// Cardano Launch's bonding_curve_tier_b.ak datum is a genuinely different shape
// from the linear curve's above (adds
// dv_allocation_root/dv_claimed for the DarkVeil-claim mechanism) —
// verified directly against BondingCurveTierBDatum's real field order
// before writing this, not assumed from the linear curve's shape.
export const BondingCurveTierBDatumShape = Data.Object({
  curve_state: CurveStateTierBSchema,
  // One platform wallet: a single accrual, claimed once.
  platform_fees_accrued: Data.Integer(),
  creator_fees_accrued: Data.Integer(),
  total_raised: Data.Integer(),
  tokens_sold: Data.Integer(),
  /** The keys allowed to apply a batch against this curve — checked by the
   *  batch arm alongside the transaction's real signatures, so naming a key in
   *  the redeemer is no longer enough on its own. Rewritten only by
   *  SetBatcherAllowlist, which is why it sits with the written fields at the
   *  front rather than with the read-only ones at the back. */
  batcher_allowlist: Data.Array(Data.Bytes()),
  // Same field, same tree, same position as the linear curve's — one accumulator
  // definition serves both curves. On Cardano Launch it additionally spans the
  // DarkVeil claim window, so a claim and a public buy draw on one 5%.
  cap_root: Data.Bytes(),
  // Was `dv_claimed`, a growing list of every claimant's key hash. Now one
  // bit per allocation leaf, sized once at OpenDvClaim and emptied by
  // ActivateCurve — so the datum carried by every public trade holds no
  // claim state, whatever the launch's participation was.
  claimed_bits: Data.Bytes(),
  // Posix ms the claim window opened; 0 until OpenDvClaim.
  dv_claim_opened_at: Data.Integer(),
  community_pub_key_hash: Data.Bytes(),
  cto_triggered: Data.Boolean(),
  phase_started_at: Data.Integer(),
  // (2026-07-19, Cardano Launch cross-chain audit): whether
  // dv_allocation_root has been anchored to a real value yet — see
  // bonding_curve_tier_b.ak's own field comment for the full reasoning.
  dv_settled: Data.Boolean(),
  dv_allocation_root: Data.Bytes(),
  lp_seeded: Data.Boolean(),
  staking_seeded: Data.Boolean(),
  launch_id: Data.Bytes(),
  creator_pub_key_hash: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  base_price: Data.Integer(),
  max_price: Data.Integer(),
  curve_supply: Data.Integer(),
  wallet_cap: Data.Integer(),
  // The DarkVeil share of curve_supply — there is no separate token
  // carve-out, so anything unclaimed when the window closes is simply still
  // sellable on the public curve. 0 for a launch with no DarkVeil phase.
  dv_reserve_tokens: Data.Integer(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  lp_escrow_credential: CredentialSchema,
  lp_reserve_tokens: Data.Integer(),
  staking_enabled: Data.Boolean(),
  staking_pool_credential: CredentialSchema,
  staking_reserve_tokens: Data.Integer(),
  /** The runway the creator commits to at launch creation. With the reserve it
   *  fixes the pool's emission rate for life, and the curve pins that rate on
   *  chain at graduation — so a wrong value here cannot be corrected later. */
  staking_duration_days: Data.Integer(),
  // Fix (2026-07-23): added to the on-chain datum after this
  // schema was first written. thread_nft_policy is a PolicyId (bytes).
  cto_governance_credential: CredentialSchema,
  thread_nft_policy: Data.Bytes(),
  // The launch's own DarkVeil claim and settlement windows, in Posix
  // milliseconds. Declared at genesis, never rewritten, and therefore last —
  // the validator's datum orders written fields first and these two are only
  // ever read. The encoding is positional, so their position here must match
  // the validator's or a decode lands on the wrong field rather than failing.
  dv_claim_window: Data.Integer(),
  dv_settlement_window: Data.Integer(),
});
export type BondingCurveTierBDatumData = Data.Static<typeof BondingCurveTierBDatumShape>;
export const BondingCurveTierBDatumSchema = BondingCurveTierBDatumShape as unknown as BondingCurveTierBDatumData;

export const VestingStateSchema = Data.Enum([
  Data.Literal('NotStarted'),
  Data.Literal('Vesting'),
  Data.Literal('FullyClaimed'),
  Data.Literal('CTOFrozen'),
  Data.Literal('Cancelled'),
]);

export const VestingDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  creator_pub_key_hash: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  token_allocation: Data.Integer(),
  vest_days: Data.Integer(),
  vesting_state: VestingStateSchema,
  claimed_tokens: Data.Integer(),
  vest_start_timestamp: Data.Integer(),
  cto_triggered: Data.Boolean(),
  community_treasury_wallet: Data.Bytes(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  // Fix (2026-07-23): added after this schema was first
  // written. thread_nft_policy is a PolicyId (bytes);
  // last_claimed_allocation_timestamp starts at 0 at genesis.
  cto_governance_credential: CredentialSchema,
  thread_nft_policy: Data.Bytes(),
  last_claimed_allocation_timestamp: Data.Integer(),
});
export type VestingDatumData = Data.Static<typeof VestingDatumShape>;
export const VestingDatumSchema = VestingDatumShape as unknown as VestingDatumData;

export const LpStateSchema = Data.Enum([Data.Literal('Locked'), Data.Literal('Cancelled')]);

export const LpEscrowDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  lock_timestamp: Data.Integer(),
  lock_duration: Data.Integer(),
  lp_state: LpStateSchema,
  governor_pub_key_hash: Data.Bytes(),
  community_wallet_hash: Data.Bytes(),
  cto_triggered: Data.Boolean(),
  fee_recipient_pub_key_hash: Data.Bytes(),
  dex_whitelist: Data.Array(CredentialSchema),
  multisig_signers: Data.Array(Data.Bytes()),
  multisig_threshold: Data.Integer(),
  pending_dex_change: Data.Nullable(Data.Any()),
  lp_token_policy_id: Data.Bytes(),
  lp_token_name: Data.Bytes(),
  lp_token_amount: Data.Integer(),
  // Fix (2026-07-23): added after this schema was first
  // written. thread_nft_policy is a PolicyId (bytes).
  cto_governance_credential: CredentialSchema,
  thread_nft_policy: Data.Bytes(),
  // Chain time in ms of the most recent migration, 0 if never migrated.
  // Migrate requires a full cooldown to have elapsed since.
  last_migration_timestamp: Data.Integer(),
});
export type LpEscrowDatumData = Data.Static<typeof LpEscrowDatumShape>;
export const LpEscrowDatumSchema = LpEscrowDatumShape as unknown as LpEscrowDatumData;

// staking_pool.ak (shared by both Cardano curves — one validator, not tier-
// specific like bonding_curve vs bonding_curve_tier_b). Field order/
// constructor indices verified directly against a freshly-regenerated
// plutus.json's real `definitions` block, not assumed from .ak source
// comments (same discipline this file's own header describes) — StakingDatum:
// Pool=0, Position=1; StakingPoolRedeemer: Unstake=0, ClaimRewards=1,
// TopUpPool=2, PublishRewardRoot=3, QueryState=4 (hardened to always-False,
// never constructed by this submitter).
// zk_anchor.ak's ZkAnchorDatum. Moved here 2026-08-03 from
// cardano-anchor-submitter.ts, which previously defined its own private copy:
// the genesis builder now authors this datum too, and two independent
// definitions of the same on-chain shape is precisely the drift this module
// exists to prevent.
export const CertificateTypeSchema = Data.Enum([
  Data.Literal('DarkVeilCert'),
  Data.Literal('FullZKCert'),
  Data.Literal('CtoVoteResult'),
  Data.Literal('GraduationCert'),
]);

/// curve_order.ak's OrderDatum. One UTXO per order, which is what lets many
/// users place orders in the same block without contending for the curve.
///
/// `curve_credential` is checked as a real input credential by ApplyOrder, so
/// an order can only be filled in a transaction that also runs the curve
/// validator — the price is never this contract's word for it.
export const OrderDatumShape = Data.Object({
  owner: Data.Bytes(),
  /// The owner's stake credential, when their address has one.
  ///
  /// A payout has to reach an address the owner can SPEND FROM. Matching the
  /// payment credential alone accepts the bare enterprise address, which an
  /// ordinary seed-phrase wallet never derives and therefore never sees.
  /// `null` means an enterprise address is genuinely intended.
  owner_stake: Data.Nullable(CredentialSchema),
  launch_id: Data.Bytes(),
  curve_credential: CredentialSchema,
  /// True buys tokens with the ADA held here; False sells the tokens held here.
  is_buy: Data.Boolean(),
  amount: Data.Integer(),
  /// The owner's slippage bound: tokens for a buy, lovelace for a sell.
  min_received: Data.Integer(),
  /// The most of what the order HOLDS that may leave it — lovelace for a buy,
  /// tokens for a sell. Everything above it returns to the owner.
  ///
  /// `min_received` bounds what arrives; this bounds what leaves. The order
  /// validator never computes a price, so it cannot tell a fair fill from one
  /// that paid the curve correctly and kept the difference — which is why the
  /// owner names this rather than it being derived. It is also the batcher's
  /// ceiling: whatever the batcher does not take goes back.
  max_spend: Data.Integer(),
  /// Posix ms. Past this, anyone may return the funds to the owner.
  deadline: Data.Integer(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
});
export type OrderDatumData = Data.Static<typeof OrderDatumShape>;
export const OrderDatumSchema = OrderDatumShape as unknown as OrderDatumData;

export const ZkAnchorDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  cert_type: CertificateTypeSchema,
  proof_bundle_hash: Data.Bytes(),
  proof_ipfs_cid: Data.Bytes(),
  anchor_timestamp: Data.Integer(),
  relayer_credential_hash: Data.Bytes(),
  governor_credential_hash: Data.Bytes(),
  metadata_hash: Data.Bytes(),
  thread_nft_policy: Data.Bytes(),
});
export type ZkAnchorDatumData = Data.Static<typeof ZkAnchorDatumShape>;
export const ZkAnchorDatumSchema = ZkAnchorDatumShape as unknown as ZkAnchorDatumData;

// ============================================================================
// Thread NFT naming — MUST match contracts/cardano/lib/noctis/thread_nft.ak
// ============================================================================
// One governor-signature policy mints a distinct thread NFT for each of a
// launch's state UTXOs. `launch_id` is 32 bytes and Cardano's asset-name limit
// is also 32, so `launch_id ++ role` does not fit; the name is a one-byte role
// tag followed by the first 31 bytes of the launch id.
//
// Kept here rather than inline at each call site for the same reason the Aiken
// side has its own module: if the two ever disagree, every launch mints tokens
// its own validators reject, and the failure appears only at spend time.
export const THREAD_NFT_ROLES = {
  ctoGovernance: '00',
  bondingCurve: '01',
  bondingCurveTierB: '02',
  lpEscrow: '03',
  vesting: '04',
  stakingPool: '05',
  zkAnchor: '06',
} as const;

export type ThreadNftRole = keyof typeof THREAD_NFT_ROLES;

/**
 * The asset name (hex) this launch's thread NFT carries for a given role.
 * `launchIdHex` is the full 32-byte launch id; only its first 31 bytes (62 hex
 * characters) are used, matching `bytearray.take(launch_id, 31)` on-chain.
 */
export function threadNftAssetName(role: ThreadNftRole, launchIdHex: string): string {
  return THREAD_NFT_ROLES[role] + launchIdHex.slice(0, 62);
}

/** Every role's asset name for one launch, keyed by role — what the genesis mint must create. */
export function threadNftAssetNames(launchIdHex: string): Record<ThreadNftRole, string> {
  const out = {} as Record<ThreadNftRole, string>;
  for (const role of Object.keys(THREAD_NFT_ROLES) as ThreadNftRole[]) {
    out[role] = threadNftAssetName(role, launchIdHex);
  }
  return out;
}

// ============================================================================
// CIP-68 labels — MUST match contracts/cardano/lib/noctis/cip68.ak
// ============================================================================
// CIP-68 binds a token to its metadata by name under one shared policy: the
// launch token and its reference NFT carry the same base name behind CIP-67
// labels 333 and 100. That binding is the entire discovery mechanism, so the
// labels are constants pinned on both sides rather than derived at run time —
// a wrong label mints successfully and is simply never resolved by anything.

/** CIP-67 label 100 — the reference NFT holding the metadata datum. */
export const CIP68_REFERENCE_NFT_LABEL = '000643b0';

/** CIP-67 label 333 — the fungible user token. The launch token is always this. */
export const CIP68_FUNGIBLE_TOKEN_LABEL = '0014df10';

/** A CIP-67 label is 4 bytes, so it costs 8 hex characters of the 64 available. */
export const CIP68_LABEL_HEX_LENGTH = 8;

/**
 * The on-chain asset name (hex) of the fungible launch token.
 * `baseNameHex` is the ticker as a creator typed it, hex-encoded.
 */
export function cip68FungibleAssetName(baseNameHex: string): string {
  return CIP68_FUNGIBLE_TOKEN_LABEL + baseNameHex;
}

/** The on-chain asset name (hex) of the matching reference NFT. */
export function cip68ReferenceAssetName(baseNameHex: string): string {
  return CIP68_REFERENCE_NFT_LABEL + baseNameHex;
}

/** The base name behind a label — the inverse of the two builders above. */
export function cip68BaseName(labelledNameHex: string): string {
  return labelledNameHex.slice(CIP68_LABEL_HEX_LENGTH);
}

/**
 * Cardano caps an asset name at 32 bytes and the label takes 4 of them, so a
 * ticker has 28 to work with. Enforced here because this is the only place
 * that knows the label is part of the budget.
 */
export const CIP68_MAX_BASE_NAME_BYTES = 28;

export function assertValidCip68BaseName(baseNameHex: string): void {
  if (!/^([0-9a-f]{2})*$/.test(baseNameHex)) {
    throw new Error(`Ticker must be lowercase hex with an even length, got "${baseNameHex}".`);
  }
  const bytes = baseNameHex.length / 2;
  if (bytes === 0 || bytes > CIP68_MAX_BASE_NAME_BYTES) {
    throw new Error(
      `A ticker must be 1-${CIP68_MAX_BASE_NAME_BYTES} bytes once the CIP-68 label is applied; got ${bytes}.`,
    );
  }
}

// ============================================================================
// token_metadata — the CIP-68 reference NFT's datum
// ============================================================================
// Mirrors token_metadata/TokenMetadataDatum in the compiled blueprint:
// constructor 0 over [metadata, version, extra], with `metadata` a real
// Plutus map. Held here rather than in the submitter because the genesis mint
// authors this datum and the metadata submitter revises it, and the two
// drifting apart is exactly the failure this module exists to prevent.

/**
 * CIP-68's own metadata map. Values are `Data.Any()` because the standard
 * mixes types — `name`/`ticker`/`logo` are byte strings, `decimals` is an
 * integer — and nothing on-chain reads them; the reader is a wallet.
 */
export const Cip68MetadataShape = Data.Map(Data.Bytes(), Data.Any());
export type Cip68MetadataData = Data.Static<typeof Cip68MetadataShape>;

/** CIP-68's third datum field, which the standard reserves for the issuer. */
export const NoctisMetadataExtraShape = Data.Object({
  launch_id: Data.Bytes(),
  bonding_curve_credential: CredentialSchema,
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  community_pub_key_hash: Data.Bytes(),
  cto_triggered: Data.Boolean(),
  cto_governance_credential: CredentialSchema,
  thread_nft_policy: Data.Bytes(),
  metadata_revision: Data.Integer(),
  last_updated_ts: Data.Integer(),
});
export type NoctisMetadataExtraData = Data.Static<typeof NoctisMetadataExtraShape>;

export const TokenMetadataDatumShape = Data.Object({
  metadata: Cip68MetadataShape,
  version: Data.Integer(),
  extra: NoctisMetadataExtraShape,
});
export type TokenMetadataDatumData = Data.Static<typeof TokenMetadataDatumShape>;
export const TokenMetadataDatumSchema = TokenMetadataDatumShape as unknown as TokenMetadataDatumData;

/**
 * CIP-68's own standard version, written into the datum's second field. This
 * is the version of the METADATA STANDARD, not a revision counter — the
 * revision counter is `extra.metadata_revision` and is the one that moves.
 */
export const CIP68_STANDARD_VERSION = 1n;

/** The metadata fields the 333 fungible-token sub-standard defines. */
export interface Cip68FungibleMetadata {
  /** Required by the sub-standard. */
  name: string;
  /** Required by the sub-standard. */
  description: string;
  ticker?: string;
  url?: string;
  /** How many decimal places a wallet should render. */
  decimals?: number;
  /** A URI, e.g. `ipfs://<cid>` — not a bare CID. */
  logo?: string;
}

function utf8ToHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

/**
 * Builds the on-chain metadata map from the fields a creator supplies.
 *
 * Keys and string values are byte strings, `decimals` is an integer, and
 * optional fields are omitted entirely rather than written empty — a wallet
 * reading an absent key falls back to its own default, whereas an empty
 * string renders as empty.
 */
export function buildCip68FungibleMetadata(fields: Cip68FungibleMetadata): Cip68MetadataData {
  if (!fields.name) throw new Error('CIP-68 metadata requires a non-empty name.');
  if (!fields.description) throw new Error('CIP-68 metadata requires a non-empty description.');

  const map = new Map<string, unknown>();
  map.set(utf8ToHex('name'), utf8ToHex(fields.name));
  map.set(utf8ToHex('description'), utf8ToHex(fields.description));
  if (fields.ticker) map.set(utf8ToHex('ticker'), utf8ToHex(fields.ticker));
  if (fields.url) map.set(utf8ToHex('url'), utf8ToHex(fields.url));
  if (fields.decimals !== undefined) map.set(utf8ToHex('decimals'), BigInt(fields.decimals));
  if (fields.logo) map.set(utf8ToHex('logo'), utf8ToHex(fields.logo));
  return map as Cip68MetadataData;
}

/// noctis/stake_accumulator's Position — one staker's slot in the pool's
/// stake root. Not a UTXO: positions stopped being their own outputs when
/// reward accounting moved on chain, because `debt` decides a payout and a
/// datum anyone can author would then be an authorization. See that module.
export const StakePositionShape = Data.Object({
  amount: Data.Integer(),
  debt: Data.Integer(),
  since: Data.Integer(),
});
export type StakePositionData = Data.Static<typeof StakePositionShape>;
export const StakePositionSchema = StakePositionShape as unknown as StakePositionData;

/// noctis/staking_pool_datum's StakingPoolDatum. ONE per launch, and its own
/// UTXO value holds every staked token AND the reward budget — `total_staked`
/// says which is which.
///
/// Field order verified against the compiled blueprint, not read off the .ak
/// source, same discipline as every other schema in this file.
export const StakingPoolDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  /// Where the residue goes when an exhausted pool is retired. Not an
  /// authority: no redeemer checks this key's signature.
  creator_pub_key_hash: Data.Bytes(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  thread_nft_policy: Data.Bytes(),
  /// Fixed when the pool opened, from the runway committed to at launch
  /// creation. Nothing changes it, top-ups included.
  emission_per_day: Data.Integer(),
  /// Every staker's position, behind one root.
  stake_root: Data.Bytes(),
  /// Reward per token staked, ever, scaled by ACC_SCALE. Monotonic.
  acc_reward_per_token: Data.Integer(),
  total_staked: Data.Integer(),
  /// Reward tokens not yet credited to anyone. The only stopping condition.
  unallocated: Data.Integer(),
  last_update_ms: Data.Integer(),
  /// When `unallocated` first reached zero. A top-up clears it.
  exhausted_at: Data.Nullable(Data.Integer()),
  /// Who the flat claim charge is paid to — the same key the curve pays its
  /// own platform fees to. Last, matching the .ak field order, which appends
  /// it so the five fields above keep the indices every redeemer rewrites.
  governor_pub_key_hash: Data.Bytes(),
});
export type StakingPoolDatumData = Data.Static<typeof StakingPoolDatumShape>;
export const StakingPoolDatumSchema = StakingPoolDatumShape as unknown as StakingPoolDatumData;

// cto_governance.ak's own CtoGovernanceDatum — field order verified directly
// against the .ak source (2026-07-28, Phase G of the CIP-68 prerequisite
// block). active_proposal/last_executed_proposal are Option<ProposalAnchor>;
// genesis always sets both to null, so — same convention already established
// by lp_escrow's pending_dex_change above — Data.Nullable(Data.Any()) is used
// rather than fully modeling ProposalAnchor's nested shape, which genesis
// never constructs.
export const CtoAnchorStateSchema = Data.Enum([
  Data.Literal('PreCTO'),
  Data.Literal('CTOTriggered'),
  Data.Literal('CTODissolved'),
]);

export const CtoGovernanceDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  cto_state: CtoAnchorStateSchema,
  community_wallet_hash: Data.Bytes(),
  governor_credential_hash: Data.Bytes(),
  total_supply: Data.Integer(),
  quorum_bps: Data.Integer(),
  creator_vote_cap_bps: Data.Integer(),
  min_voter_count: Data.Integer(),
  active_proposal: Data.Nullable(Data.Any()),
  proposal_count: Data.Integer(),
  last_executed_proposal: Data.Nullable(Data.Any()),
  pending_relayer_bond: Data.Integer(),
  pending_relayer_key_hash: Data.Bytes(),
  /** Where a forfeited challenge bond goes — one address, not a split. */
  payout_pub_key_hash: Data.Bytes(),
  thread_nft_policy: Data.Bytes(),
  // The ballot's own width, so an anchored result has to describe a ballot
  // that could really have run. AnchorVoteResult is open-relay by design, so
  // every timestamp in it is the relayer's to choose; this is what the
  // validator measures those choices against. Never written by any redeemer.
  ballot_duration: Data.Integer(),
  // When this launch's most recent ballot closed, or 0 if none ever has. The
  // anchor writes it from the ballot's own end and the next anchor is measured
  // against it, which is what puts the cooldown between two ballots — whatever
  // either one's outcome was.
  last_ballot_end_timestamp: Data.Integer(),
});
export type CtoGovernanceDatumData = Data.Static<typeof CtoGovernanceDatumShape>;
export const CtoGovernanceDatumSchema = CtoGovernanceDatumShape as unknown as CtoGovernanceDatumData;

export const MerkleProofStepShape = Data.Object({
  sibling: Data.Bytes(),
  goes_left: Data.Boolean(),
});
export type MerkleProofStepData = Data.Static<typeof MerkleProofStepShape>;

/// noctis/cap_accumulator's CapProofStep. Structurally identical to
/// MerkleProofStep above and deliberately kept separate anyway: they prove
/// membership in two DIFFERENT trees. MerkleProofStep carries a DarkVeil
/// allocation proof against `dv_allocation_root` (a fixed roster, variable
/// depth); this carries a running-total proof against `cap_root` (rewritten
/// every trade, fixed depth 32). Collapsing them would invite a caller to pass
/// one where the other belongs, which type-checks and then fails on chain.
export const CapProofStepShape = Data.Object({
  sibling: Data.Bytes(),
  goes_left: Data.Boolean(),
});
export type CapProofStepData = Data.Static<typeof CapProofStepShape>;

/**
 * A cap proof as Plutus data, for the raw-`Constr` redeemers.
 *
 * Every curve redeemer that touches the accumulator lives at a non-zero
 * constructor index, and `Data.Object` always serializes at index 0 — so those
 * redeemers are hand-built with `Constr`, and their proof field has to be
 * hand-encoded to match. Kept here, once, rather than repeated at each of the
 * five call sites: a `goes_left` encoded the wrong way round produces a proof
 * that walks the wrong path and fails on chain with nothing to point at.
 *
 * `CapProofStep` is one constructor (index 0) over `sibling` then `goes_left`,
 * and Aiken's `Bool` is `False = Constr(0, [])` / `True = Constr(1, [])`.
 */
export function capProofToPlutus(proof: readonly { sibling: Uint8Array; goesLeft: boolean }[]): Data[] {
  return proof.map(
    (step): Data =>
      new Constr(0, [
        Array.from(step.sibling, (b) => b.toString(16).padStart(2, '0')).join('') as Data,
        new Constr(step.goesLeft ? 1 : 0, []) as Data,
      ]),
  );
}

/**
 * One order inside a `BatchTrades` redeemer, as both curves declare it.
 *
 * Hand-encoded for the same reason `capProofToPlutus` is: `BatchTrades` sits
 * at a non-zero constructor index, so the whole redeemer is built with raw
 * `Constr` and every nested shape has to be built to match.
 *
 * **`orderRef` is the order UTXO being filled, and it is load-bearing.** The
 * curve looks for an output carrying exactly this reference paying exactly
 * this owner. One owner may hold several orders in a batch, and they are owed
 * separately — identifying a fill by its owner alone cannot tell two of them
 * apart, so one payment would read as satisfying both. Getting this wrong does
 * not produce a wrong price; it produces a batch the validator rejects, or an
 * owner paid once for two orders.
 *
 * Field order follows the Aiken declaration exactly. A reordering here
 * type-checks and fails on chain.
 */
export interface BatchOrderFields {
  ownerKeyHashHex: string;
  /** The order UTXO this fill settles. */
  orderRef: { txHash: string; outputIndex: number };
  isBuy: boolean;
  amount: bigint;
  minReceived: bigint;
  capCommittedBefore: bigint;
  capProof: readonly { sibling: Uint8Array; goesLeft: boolean }[];
}

export function batchOrderToPlutus(order: BatchOrderFields): Data {
  return new Constr(0, [
    order.ownerKeyHashHex as Data,
    new Constr(0, [order.orderRef.txHash as Data, BigInt(order.orderRef.outputIndex) as Data]) as Data,
    new Constr(order.isBuy ? 1 : 0, []) as Data,
    order.amount as Data,
    order.minReceived as Data,
    order.capCommittedBefore as Data,
    capProofToPlutus(order.capProof) as unknown as Data,
  ]);
}

// ============================================================================
// Shared helpers
// ============================================================================

export interface PlutusBlueprintValidator {
  title: string;
  compiledCode: string;
}

export function loadValidator(
  blueprint: { validators: PlutusBlueprintValidator[] },
  title: string,
): { type: 'PlutusV3'; script: string } {
  const entry = blueprint.validators.find((v) => v.title === title);
  if (!entry) {
    throw new Error(
      `Validator "${title}" not found in plutus.json — has the blueprint drifted or not been regenerated?`,
    );
  }
  return { type: 'PlutusV3', script: entry.compiledCode };
}

/**
 * `cardano/transaction/OutputReference` — `Constr 0 [transaction_id, output_index]`.
 *
 * Note the transaction id is bare bytes: Aiken v1.1's `OutputReference` has no
 * nested `TransactionId` wrapper, and encoding one produces a datum no
 * validator can read.
 */
export const OutputReferenceShape = Data.Object({
  transaction_id: Data.Bytes(),
  output_index: Data.Integer(),
});
export type OutputReferenceData = Data.Static<typeof OutputReferenceShape>;
export const OutputReferenceSchema = OutputReferenceShape as unknown as OutputReferenceData;

/**
 * The datum a settlement output must carry: the reference of the input whose
 * obligation it discharges. See `lib/noctis/settlement.ak`.
 *
 * Every contract that pays a wallet requires this. Without it a payout is
 * matched by recipient and amount alone, which two different contracts owing
 * the same wallet the same sum both satisfy from one output — so a transaction
 * settling two obligations must build two outputs, one tagged for each.
 */
export function settlementDatum(utxo: { txHash: string; outputIndex: number }): string {
  // Checked rather than coerced, because the coercions here are silent and
  // each produces a tag that names a REAL but WRONG input. `BigInt` turns
  // `false`, `''` and `[]` into 0 — the first output of the transaction,
  // somebody else's obligation — and passes a negative through untouched.
  // `Data.Bytes()` rejects non-hex but accepts the empty string, giving a tag
  // that names no transaction at all. Only `undefined` and `null` throw on
  // their own, so a fixture missing the field was the one bad shape that
  // announced itself.
  //
  // A wrong tag is not a build-time failure: it settles against whatever
  // input it happens to name, and the mismatch surfaces against a real node
  // or, worse, discharges the wrong obligation.
  if (!/^[0-9a-fA-F]{64}$/.test(utxo?.txHash as string)) {
    throw new Error(
      `settlementDatum: txHash must be 64 hex characters, got ${JSON.stringify(utxo?.txHash)}. ` +
        'A settlement tag names the input it discharges; one naming no real transaction settles nothing.',
    );
  }
  if (!Number.isInteger(utxo.outputIndex) || utxo.outputIndex < 0) {
    throw new Error(
      `settlementDatum: outputIndex must be a non-negative integer, got ${JSON.stringify(utxo.outputIndex)}. ` +
        'Guessing an index here tags the payout against a different input than the one it settles.',
    );
  }
  return Data.to<OutputReferenceData>(
    { transaction_id: utxo.txHash, output_index: BigInt(utxo.outputIndex) },
    OutputReferenceSchema,
  );
}
