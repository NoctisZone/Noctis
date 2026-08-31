// ============================================================================
// Noctis Zone — redeemer constructor indices, by name
// ============================================================================
// A redeemer is carried on chain as a constructor INDEX, not a name. Aiken
// assigns those indices by declaration order, so inserting a variant anywhere
// but the end renumbers every variant after it — and off-chain code that
// hardcoded the old number now sends a different redeemer entirely, one whose
// fields do not even decode.
//
// That is not theoretical. `AnchorDvAllocationRoot` was written as 12, was 12
// when written, and became 11 when a variant was added ahead of it. The
// transaction still built, still signed, and failed evaluation with a message
// that named neither the redeemer nor the index.
//
// So indices live here, once, by name — and `redeemer-indices.test.ts` checks
// every one of them against what the compiled blueprint actually declares.
// Reordering a validator's redeemers now fails a test instead of a
// transaction, and adding one fails until it is recorded here.
//
// Naming matches the Aiken constructor exactly. That is what the test joins on.

/** `contracts/cardano/validators/bonding_curve.ak` — Tier A. */
export const BONDING_CURVE_REDEEMER = {
  ActivateCurve: 0,
  BuyTokens: 1,
  ClaimCreatorFees: 2,
  ClaimPlatformFees: 3,
  SellTokens: 4,
  CancelCurve: 5,
  ExpireCurve: 6,
  ClaimBuyback: 7,
  Graduate: 8,
  TriggerCTO: 9,
  DissolveCTO: 10,
  QueryState: 11,
  BatchTrades: 12,
} as const;

/** `contracts/cardano/validators/bonding_curve_tier_b.ak` — Tier B. */
export const BONDING_CURVE_TIER_B_REDEEMER = {
  ActivateCurve: 0,
  BuyTokens: 1,
  ClaimDarkVeilTokens: 2,
  ClaimCreatorFees: 3,
  ClaimPlatformFees: 4,
  CancelCurve: 5,
  ExpireCurve: 6,
  ClaimBuyback: 7,
  Graduate: 8,
  TriggerCTO: 9,
  DissolveCTO: 10,
  AnchorDvAllocationRoot: 11,
  QueryState: 12,
  SellTokens: 13,
  OpenDvClaim: 14,
  BatchTrades: 15,
} as const;

/** `contracts/cardano/validators/curve_order.ak`. */
export const CURVE_ORDER_REDEEMER = {
  ApplyOrder: 0,
  CancelOrderByOwner: 1,
  CancelExpiredOrder: 2,
} as const;

/** `contracts/cardano/validators/cto_governance.ak`. */
export const CTO_GOVERNANCE_REDEEMER = {
  AnchorVoteResult: 0,
  ExecuteProposal: 1,
  ExpireProposal: 2,
  ClearProposal: 3,
  EmergencyFreezeCommunityWallet: 4,
  VoidPendingProposal: 5,
  ReclaimRelayerBond: 6,
  QueryState: 7,
} as const;

/** `contracts/cardano/validators/lp_escrow.ak`. */
export const LP_ESCROW_REDEEMER = {
  SealLock: 0,
  ProposeDexChange: 1,
  ExecuteDexChange: 2,
  CancelPendingDexChange: 3,
  Migrate: 4,
  TriggerCTO: 5,
  DissolveCTO: 6,
  CancelLaunch: 7,
  HarvestFees: 8,
  QueryState: 9,
} as const;

/** `contracts/cardano/validators/staking_pool.ak`. */
export const STAKING_POOL_REDEEMER = {
  Stake: 0,
  Unstake: 1,
  ClaimRewards: 2,
  TopUpPool: 3,
  ClosePool: 4,
} as const;

/** `contracts/cardano/validators/token_metadata.ak`. */
export const TOKEN_METADATA_REDEEMER = {
  UpdateMetadata: 0,
  TriggerCTO: 1,
  DissolveCTO: 2,
} as const;

/** `contracts/cardano/validators/vesting.ak`. */
export const VESTING_REDEEMER = {
  StartVesting: 0,
  ClaimVested: 1,
  TriggerCTO: 2,
  DissolveCTO: 3,
  ClaimCommunityAllocation: 4,
  CancelLaunch: 5,
  ClaimCancelledAllocation: 6,
  QueryState: 7,
} as const;

/** `contracts/cardano/validators/zk_anchor.ak`. */
export const ZK_ANCHOR_REDEEMER = {
  AnchorCertificate: 0,
  AddRelayer: 1,
  RemoveRelayer: 2,
  QueryCertificate: 3,
  UpdateIpfsCid: 4,
} as const;

/** `contracts/cardano/validators/cto_sybil_challenge.ak`. */
export const CTO_SYBIL_CHALLENGE_REDEEMER = { ResolveChallenge: 0 } as const;

/**
 * The MINTING side of the same validator — see NHOP_MINT_REDEEMER for the
 * reasoning, which is identical. Both challenge contracts authenticate their
 * submission time by requiring a token this same script minted against a
 * narrow validity range, so the policy id is the validator's own hash.
 */
export const CTO_SYBIL_MINT_REDEEMER = { OpenChallenge: 0, CloseChallenge: 1 } as const;

/** `contracts/cardano/validators/nhop_challenge.ak`. */
export const NHOP_CHALLENGE_REDEEMER = { ResolveChallenge: 0 } as const;

/**
 * The MINTING side of the same validator.
 *
 * `nhop_challenge.ak` declares both a `spend` and a `mint` handler, which
 * compile to one script — so this policy id is the challenge validator's own
 * hash, and opening a challenge means minting under it rather than merely
 * paying its address. That is what makes the submission time a figure the
 * chain agreed with instead of one the challenger wrote.
 */
export const NHOP_MINT_REDEEMER = { OpenChallenge: 0, CloseChallenge: 1 } as const;

/**
 * Every table above, against the blueprint definition it must agree with.
 *
 * The test walks this in BOTH directions — every entry against the blueprint,
 * and every `*Redeemer` definition in the blueprint against this list — so a
 * validator whose redeemers are recorded nowhere fails a test rather than
 * sitting unchecked. `zk_anchor` did exactly that until it was noticed.
 */
export const REDEEMER_TABLES: ReadonlyArray<{
  definition: string;
  indices: Readonly<Record<string, number>>;
}> = [
  { definition: 'bonding_curve/BondingCurveRedeemer', indices: BONDING_CURVE_REDEEMER },
  { definition: 'bonding_curve_tier_b/BondingCurveTierBRedeemer', indices: BONDING_CURVE_TIER_B_REDEEMER },
  { definition: 'curve_order/OrderRedeemer', indices: CURVE_ORDER_REDEEMER },
  { definition: 'cto_governance/CtoGovernanceRedeemer', indices: CTO_GOVERNANCE_REDEEMER },
  { definition: 'lp_escrow/LpEscrowRedeemer', indices: LP_ESCROW_REDEEMER },
  { definition: 'staking_pool/StakingPoolRedeemer', indices: STAKING_POOL_REDEEMER },
  { definition: 'token_metadata/TokenMetadataRedeemer', indices: TOKEN_METADATA_REDEEMER },
  { definition: 'vesting/VestingRedeemer', indices: VESTING_REDEEMER },
  { definition: 'zk_anchor/ZkAnchorRedeemer', indices: ZK_ANCHOR_REDEEMER },
  { definition: 'cto_sybil_challenge/CtoSybilChallengeRedeemer', indices: CTO_SYBIL_CHALLENGE_REDEEMER },
  { definition: 'cto_sybil_challenge/CtoSybilMintRedeemer', indices: CTO_SYBIL_MINT_REDEEMER },
  { definition: 'nhop_challenge/NHopChallengeRedeemer', indices: NHOP_CHALLENGE_REDEEMER },
  { definition: 'nhop_challenge/NHopMintRedeemer', indices: NHOP_MINT_REDEEMER },
];
