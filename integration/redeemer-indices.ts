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

/** `contracts/cardano/validators/bonding_curve.ak` — the linear curve. */
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
  SetBatcherAllowlist: 13,
} as const;

/** `contracts/cardano/validators/bonding_curve_tier_b.ak` — Cardano Launch. */
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
  SetBatcherAllowlist: 16,
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
 * `contracts/cardano-dex/validators/royalty_pool/pool_mint.ak` — NoctisSwap's
 * pool factory, as a MINTING policy.
 *
 * `Create` is the only redeemer a graduation ever sends, and its two integer
 * fields are indices into the transaction's own output list. That makes this
 * table load-bearing twice over: the constructor index says which arm runs,
 * and getting it wrong sends `Burn` — which passes only for a transaction
 * that mints nothing positive, so a graduation carrying it fails with no
 * mention of either.
 */
export const POOL_MINT_REDEEMER = { Create: 0, Burn: 1 } as const;

/**
 * `noctisswap/orders/SwapAction` — a swap request being filled, or taken back.
 *
 * `Fill` carries three positions: two into the transaction's INPUTS and one
 * into its outputs. Inputs are sorted by the builder, so those two are not the
 * order a plan lists them in — see `venue-fill-submitter.ts`, which predicts
 * the sort and then checks the finished transaction against the prediction.
 */
export const SWAP_ORDER_REDEEMER = { Fill: 0, Cancel: 1 } as const;

/**
 * `noctisswap/orders/OrderAction` — the deposit, redeem and withdraw requests.
 *
 * `Apply` is what an executor sends and `Refund` is what the placer sends. The
 * validators recognise a request being APPLIED by this constructor index
 * reaching them as plain data, so it is load-bearing across files rather than
 * only inside one.
 */
export const VENUE_ORDER_REDEEMER = { Apply: 0, Refund: 1 } as const;

/** `royalty_pool/redirect/RedirectAction` — the community-takeover arm. */
export const VENUE_REDIRECT_REDEEMER = { Takeover: 0, Dissolve: 1 } as const;

/** `royalty_pool/treasury/TreasuryAction` — the platform's own two moves. */
export const VENUE_TREASURY_REDEEMER = { Withdraw: 0, SetTreasuryFee: 1 } as const;

/**
 * `royalty_pool/pool/PoolRedeemer` — one constructor carrying two fields.
 *
 * There is nothing to shift here today, which is the point of recording it:
 * a variant added to this type turns a record into a sum, every existing
 * redeemer keeps encoding to constructor 0, and nothing else would notice.
 * The pool's ARM is chosen by the `action` field rather than by a constructor
 * — those integers are in `venue-swap.ts`, pinned against the validator's own
 * constants, because a field value is not something a blueprint records.
 */
export const VENUE_POOL_REDEEMER = { PoolRedeemer: 0 } as const;

/** `splash/orders/royalty_withdraw/RoyaltyWithdrawRedeemer` — same shape, same reason. */
export const VENUE_ROYALTY_WITHDRAW_REDEEMER = { RoyaltyWithdrawRedeemer: 0 } as const;

/**
 * Every table above, against the blueprint definition it must agree with.
 *
 * The test walks this in BOTH directions — every entry against the blueprint,
 * and every `*Redeemer` definition in the blueprint against this list — so a
 * validator whose redeemers are recorded nowhere fails a test rather than
 * sitting unchecked. `zk_anchor` did exactly that until it was noticed.
 *
 * `package` names which blueprint the definition lives in: the launch package
 * (`contracts/cardano`) or the venue (`contracts/cardano-dex`). They are
 * separately compiled, so one file cannot answer for both.
 */
export const REDEEMER_TABLES: ReadonlyArray<{
  definition: string;
  indices: Readonly<Record<string, number>>;
  package?: 'launch' | 'venue';
}> = [
  { definition: 'royalty_pool/pool_mint/MintAction', indices: POOL_MINT_REDEEMER, package: 'venue' },
  { definition: 'noctisswap/orders/SwapAction', indices: SWAP_ORDER_REDEEMER, package: 'venue' },
  { definition: 'noctisswap/orders/OrderAction', indices: VENUE_ORDER_REDEEMER, package: 'venue' },
  { definition: 'royalty_pool/redirect/RedirectAction', indices: VENUE_REDIRECT_REDEEMER, package: 'venue' },
  { definition: 'royalty_pool/treasury/TreasuryAction', indices: VENUE_TREASURY_REDEEMER, package: 'venue' },
  { definition: 'royalty_pool/pool/PoolRedeemer', indices: VENUE_POOL_REDEEMER, package: 'venue' },
  {
    definition: 'splash/orders/royalty_withdraw/RoyaltyWithdrawRedeemer',
    indices: VENUE_ROYALTY_WITHDRAW_REDEEMER,
    package: 'venue',
  },
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
