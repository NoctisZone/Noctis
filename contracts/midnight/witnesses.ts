// ============================================================================
// Noctis Zone — TypeScript Witness Definitions for All 8 Midnight PSMs
// ============================================================================
// This file provides the TypeScript witness providers for every PSM contract
// in the Noctis Zone. Each PSM requires specific witnesses that supply
// private data (secret keys, nonces, Merkle proofs) to the circuit without
// revealing them on-chain.
//
// Phase 2 security-audit fix (2026-07-11): darkveil.compact was retired as
// a standalone deployment — its logic is now merged into eligibility_gate.compact
// (Cardano Launch) and was already merged into bonding_curve.compact (Midnight Launch).
// 8 PSMs -> 7: there is no separate DarkVeilWitnesses/darkveilWitnesses
// anymore; getBuyNonce moved into EligibilityGateWitnesses/
// eligibilityGateWitnesses (Cardano Launch) and stays part of BondingCurveWitnesses
// (Midnight Launch, unchanged by this pass).
//
// Fix (2026-07-30): back to 8 — staking_pool.compact (added
// 2026-07-14) was a real, later-added 8th PSM with no entry in this file
// at all (this header still said "7" and had no factory for it) until
// StakingPoolWitnesses/stakingPoolWitnesses was added below. Different
// PSM than the darkveil-merge count above; coincidence that both notes
// mention "7"/"8".
//
// Usage: import the witness provider for the PSM you're interacting with,
// construct the compiled Contract with it, then call circuits with the
// real, positional-argument `.callTx.<circuit>(...)` API (see
// integration/midnight-client.ts for the full pattern — there is no
// `sdk.call(name, argsRecord)` shape on any real @midnight-ntwrk package):
//
//   const contract = new EligibilityGateContract(
//     eligibilityGateWitnesses(userSk, merkleProof, buyNonce)
//   );
//   await deployed.callTx.registerForDarkVeil(bondCommitment);
//
// All secret keys are generated client-side and NEVER shared on-chain.
// Domain separation is used across PSMs to prevent key reuse attacks.
//
// Compiler: compactc v0.31.1
// ============================================================================

import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';

// ============================================================================
// SHARED TYPES
// ============================================================================

/**
 * Every Noctis PSM uses trivial private state — witnesses close over
 * client-held secrets directly rather than accumulating state across calls.
 * Matches the `PrivateState = undefined` convention already validated in
 * contracts/midnight/tests/*.test.ts against the real compiled contracts.
 */
export type PrivateState = undefined;

/**
 * A privileged secret, or a loud failure — never a quieter secret.
 *
 * Governor, creator and community secrets are optional arguments to the
 * factories below, because most calls never touch them. They used to fall back
 * to the user secret when absent, which is wrong in a way that does not
 * announce itself: six of these contracts derive their authority key from this
 * witness IN THE CONSTRUCTOR, into a SEALED ledger field. A deploy that simply
 * forgot the argument would therefore bind governor authority to whoever
 * deployed, permanently, with every later governor check passing for that
 * person and no signal anywhere that the wrong key is in charge.
 *
 * Failing here instead costs nothing: the runtime only invokes a witness the
 * circuit actually reads, so an ordinary call that never touches governor
 * authority never reaches this — verified by running the whole suite with
 * every one of these throwing, which changed no result.
 *
 * A test that wants to prove a privileged check REJECTS an impostor should
 * supply a different secret, not omit this one. Omitting it is a caller bug,
 * and that is what this reports.
 */
function requirePrivileged(
  secret: UserSecretKey | undefined,
  argumentName: string,
  contractName: string,
): UserSecretKey {
  if (secret === undefined) {
    throw new Error(
      `${contractName} witnesses: this call needs ${argumentName}, which was not supplied. ` +
        'Privileged secrets do not fall back to the user secret — the authority key is derived ' +
        'from this witness into a sealed field at deploy, so a fallback would bind that authority ' +
        'to the caller silently and permanently. Pass the real secret, or, to test that a ' +
        'privileged check rejects an impostor, pass a DIFFERENT one.',
    );
  }
  return secret;
}

/**
 * A witness function's real shape, per compactc-generated
 * `Witnesses<PS>` (see any contracts/midnight/compiled/<psm>/contract/index.d.ts):
 * takes a `WitnessContext<Ledger, PS>` and returns `[PS, value]`, NOT a
 * bare `() => value` getter. `Ledger`/`WitnessContext` are intentionally
 * `any` here since this type is only used to shape the tuple return —
 * each PSM's real `Witnesses<PS>` (imported from its own compiled output)
 * is what actually constrains call sites.
 */
type WitnessFn<T> = (context: unknown) => [PrivateState, T];

/** 32-byte secret key — generated client-side, never revealed */
export interface UserSecretKey {
  bytes: Uint8Array; // 32 bytes
}

/** 32-byte public key — derived from secret key via domain-separated hash */
export interface UserPublicKey {
  bytes: Uint8Array; // 32 bytes
}

/**
 * One level of a Merkle inclusion proof — matches
 * eligibility_gate.compact's `MerkleProofEntry` struct (fix, 2026-07-09).
 * `goesLeft` is required per-level (not derivable from a leaf index alone
 * without also fixing the tree's leaf ordering convention) since the
 * circuit needs to know whether to hash(node, sibling) or
 * hash(sibling, node) at each step.
 */
export interface MerkleProofEntry {
  sibling: Uint8Array; // Bytes<32>
  goesLeft: boolean;
}

/**
 * Merkle proof — always exactly 20 entries (2026-07-12 — depth
 * reduced from the original 32 to cut proving cost; this comment was
 * stale until now), matching the circuit's fixed-depth
 * `Vector<20, MerkleProofEntry>` witness. Build one with
 * `buildAllowlistTree` from packages/zk-proofs/src/eligibility-gate.ts,
 * which implements the exact same node-hashing and padding convention
 * `verifyAllowlist()` checks against.
 */
export type MerkleProof = MerkleProofEntry[]; // 20 entries

/**
 * `pad(32, s)` — Compact's stdlib domain-separator helper. UTF-8 bytes of
 * `s`, right-padded with zero bytes to a fixed 32-byte length. Matches
 * packages/zk-proofs/src/compact-types.ts's `pad32`, duplicated here rather
 * than imported to keep this file dependency-free of that package (no
 * workspace link exists between contracts/midnight and packages/zk-proofs).
 */
function pad32(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > 32) {
    throw new Error(`pad32: "${s}" is ${encoded.length} bytes, exceeds 32`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

const bytes32Type = new CompactTypeBytes(32);
const domainKeyVectorType = new CompactTypeVector(2, bytes32Type);
const scopedKeyVectorType = new CompactTypeVector(3, bytes32Type);

/**
 * Domain-separated key derivation for the platform's fixed roles — matches
 * `persistentHash<Vector<2, Bytes<32>>>([pad(32, domain), sk.bytes])`
 * (verified against `@midnight-ntwrk/compact-runtime`'s `persistentHash`,
 * the same primitive packages/zk-proofs/src/compact-types.ts's
 * `hashDomainKey` uses and hash-parity.test.ts proves correct against real
 * compiled circuits). Security-audit fix: this used to be a non-hashing
 * byte-slice stub, silently wrong for any real on-chain comparison —
 * integration/midnight-client.ts calls this for real.
 *
 * Governor, creator, and community keys derive this way: those identities
 * are the same party across every launch by definition, so there is nothing
 * to scope. A USER's identity is a different case — see
 * `deriveUserPublicKey` below.
 */
export function deriveRoleKey(sk: UserSecretKey, domain: string): UserPublicKey {
  return { bytes: persistentHash(domainKeyVectorType, [pad32(domain), sk.bytes]) };
}

/**
 * A user's identity, scoped to one launch — matches every PSM's
 * `persistentHash<Vector<3, Bytes<32>>>([pad(32, domain), sk.bytes,
 * launchId])`.
 *
 * The same secret derives a DIFFERENT key under every `launchId`, so one
 * person's participation in two launches cannot be linked by comparing the
 * keys those launches publish. Each contract's `launchId` is a sealed
 * ledger field, so the scope is fixed at deployment and a launch cannot
 * move an identity afterwards.
 *
 * `launchId` must be the same 32 bytes the target contract was deployed
 * with; a key derived under any other value will not match anything
 * on-chain.
 */
export function deriveUserPublicKey(sk: UserSecretKey, domain: string, launchId: Uint8Array): UserPublicKey {
  return { bytes: persistentHash(scopedKeyVectorType, [pad32(domain), sk.bytes, launchId]) };
}

// NOTE: there are deliberately no random secret/nonce generators here.
// Every value that must survive a cleared browser — the user secret, the
// DarkVeil registration nonce, the buy nonce, and the CTO voting identity —
// is DERIVED from a single wallet signature, so it is reproducible on any
// device. See integration/private-state-store.ts (SK_DOMAIN /
// REG_NONCE_DOMAIN / BUY_NONCE_DOMAIN) and integration/cto-private-state-
// store.ts (CTO_SK_DOMAIN), both reached via widget/wallet-session.ts.
// A randomly generated secret would be unrecoverable the moment a browser
// clears its storage, stranding any bond or allocation locked against it.

// ============================================================================
// DOMAIN SEPARATION STRINGS (must match the pad(32, "...") in each .compact)
// ============================================================================

// Security-audit fix: ELIGIBILITY_*/CURVE_* previously read
// 'noctis:eligibility:...'/'noctis:curve:...', which predates the merge.
// eligibility_gate.compact and bonding_curve.compact's merged Midnight Launch
// copy both derive identity under the SAME unified domain today (see
// bonding_curve.compact's file header "Identity note") — kept as two named
// constants (rather than collapsing to one) only so existing call sites
// referencing either name don't need to change, but both now correctly
// point at the one real on-chain domain.
export const DOMAINS = {
  // Eligibility Gate (Cardano Launch, merged with DarkVeil — post-Phase-2: same
  // domain as Bonding Curve, see below. DARKVEIL_USER/GOVERNOR retired
  // along with the standalone darkveil.compact deployment — Cardano Launch's
  // DarkVeil circuits now derive identity under this same domain.)
  ELIGIBILITY_USER: 'noctis:user:pk:v1',
  ELIGIBILITY_GOVERNOR: 'noctis:governor:pk:v1',

  // Bonding Curve (Midnight Launch, merged with Eligibility Gate + DarkVeil,
  // unified with Eligibility Gate's domain)
  CURVE_USER: 'noctis:user:pk:v1',
  CURVE_GOVERNOR: 'noctis:governor:pk:v1',

  // Creator Escrow
  ESCROW_CREATOR: 'noctis:escrow:creator:pk:v1',
  ESCROW_GOVERNOR: 'noctis:escrow:governor:pk:v1',
  ESCROW_COMMUNITY: 'noctis:escrow:community:pk:v1',

  // LP Escrow
  LP_GOVERNOR: 'noctis:lp:governor:pk:v1',
  LP_COMMUNITY: 'noctis:lp:community:pk:v1',

  // Treasury
  TREASURY_GOVERNOR: 'noctis:treasury:governor:pk:v1',

  // CTO Governance
  CTO_USER: 'noctis:cto:user:pk:v1',
  CTO_GOVERNOR: 'noctis:cto:governor:pk:v1',
} as const;

// ============================================================================
// WITNESS PROVIDERS — ONE PER PSM
// ============================================================================

// ---------------------------------------------------------------------------
// 1. ELIGIBILITY GATE PSM (Cardano Launch — merged with DarkVeil, Phase 2 2026-07-11)
// Witnesses: getUserSecret, getMerkleProof, getRegistrantMerkleProof,
//            getGovernorSecret, getBuyNonce
//
// Security-audit fix (Phase 2, 2026-07-11): eligibility_gate.compact is now
// MERGED with darkveil.compact for Cardano Launch (mirrors the Midnight Launch merge of
// bonding_curve.compact — Compact has no working cross-contract call
// mechanism, so folding the two sources into one deployed contract with a
// shared ledger was the only way to make claimRatioBondRefund's per-
// registrant purchase data enforceable). getBuyNonce (previously the
// standalone DarkVeilWitnesses/darkveilWitnesses below) is now part of this
// same witness set — there is no separate darkveil.compact deployment for
// either tier anymore.
//
// Design requirement: getAllowlistLeaf removed — the allowlist
// leaf is now derived in-circuit from the caller's own identity
// (verifyAllowlist(caller)), closing the "borrow someone else's leaf+proof"
// gap a free witness value allowed. The off-chain Merkle tree must be built
// with each leaf as hashAllowlistLeaf(registrantPubKey) — see
// packages/zk-proofs/src/eligibility-gate.ts.
// ---------------------------------------------------------------------------

// Fix (2026-07-30): eligibility_gate.compact gained a second Merkle
// witness, getRegistrantMerkleProof — submitBuyCommit now proves prior
// DarkVeil registration via a real Merkle proof against registrantRoot
// (published by the governor at startBuying, the registration freeze)
// instead of a publicly-precomputable nullifier. See
// packages/zk-proofs/src/eligibility-gate.ts's buildRegistrantTree for the
// off-chain tree builder, and registrantRoot's own ledger comment in
// eligibility_gate.compact for the full rationale. Optional here (not
// every caller submits a buy commitment — registration/admin calls don't
// need it) so existing call sites that never touch submitBuyCommit aren't
// forced to supply one.
// A declared-but-never-called witness does not reach the compiled contract:
// `getRegistrationNonce` was dropped from eligibility_gate.compact once nothing
// read it, and the compiler leaves it out of bonding_curve.compact's generated
// witness type too, where it is still declared but uncalled. Neither compiled
// contract asks for it, so neither builder below offers it — a witness in this
// object that the contract never requests reads as private input it needs.
export type EligibilityGateWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getMerkleProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getRegistrantMerkleProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getBuyNonce: WitnessFn<Uint8Array>; // Bytes<32>
};

export function eligibilityGateWitnesses(
  userSk: UserSecretKey,
  merkleProof: MerkleProofEntry[],
  buyNonce: Uint8Array,
  governorSk?: UserSecretKey,
  registrantMerkleProof?: MerkleProofEntry[],
): EligibilityGateWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getMerkleProof: () => [undefined, merkleProof],
    getRegistrantMerkleProof: () => [undefined, registrantMerkleProof ?? merkleProof],
    getGovernorSecret: () => [undefined, requirePrivileged(governorSk, 'governorSk', 'eligibilityGateWitnesses')],
    getBuyNonce: () => [undefined, buyNonce],
  };
}

// ---------------------------------------------------------------------------
// 2. BONDING CURVE PSM
// Witnesses: getUserSecret, getGovernorSecret
// ---------------------------------------------------------------------------

// Fix (2026-07-10): bonding_curve.compact is now MERGED with
// eligibility_gate.compact for Midnight Launch (see the file header in
// contracts/midnight/bonding_curve.compact for why — Compact has no
// working cross-contract call mechanism, so folding the two sources into
// one deployed contract with a shared ledger was the only way to make the
// 5% cumulative cap enforceable). This witness type carries both halves'
// requirements now.
// Follow-up (2026-07-10): darkveil.compact's getBuyNonce is now also
// part of this merged contract's witness set — see
// contracts/midnight/bonding_curve.compact's file header for the 3-way
// merge (eligibility_gate + darkveil + bonding_curve, Midnight Launch only).
// Design requirement: getAllowlistLeaf removed here too — same
// reasoning as EligibilityGateWitnesses above (this contract merges that
// same verifyAllowlist(caller) logic for Midnight Launch).
export type BondingCurveWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getMerkleProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  // Membership in the REGISTRANT tree, which is a different tree published at
  // a different time from the allowlist — see the twin builder above.
  getRegistrantMerkleProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getBuyNonce: WitnessFn<Uint8Array>; // Bytes<32>
};

export function bondingCurveWitnesses(
  userSk: UserSecretKey,
  merkleProof: MerkleProofEntry[],
  buyNonce: Uint8Array,
  governorSk?: UserSecretKey,
  registrantMerkleProof?: MerkleProofEntry[],
): BondingCurveWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getGovernorSecret: () => [undefined, requirePrivileged(governorSk, 'governorSk', 'bondingCurveWitnesses')],
    getMerkleProof: () => [undefined, merkleProof],
    // Same shape and same fallback as the Cardano Launch builder above, deliberately:
    // the two contracts carry the same DarkVeil circuits and their witness
    // builders should not diverge. A proof for the wrong tree does not pass
    // silently — verifyRegistrant recomputes the published root or the call
    // fails.
    getRegistrantMerkleProof: () => [undefined, registrantMerkleProof ?? merkleProof],
    getBuyNonce: () => [undefined, buyNonce],
  };
}

// ---------------------------------------------------------------------------
// 3. CREATOR ESCROW PSM
// Witnesses: getCreatorSecret, getGovernorSecret, getCommunitySecret
// ---------------------------------------------------------------------------

export type CreatorEscrowWitnesses = {
  getCreatorSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getCommunitySecret: WitnessFn<UserSecretKey>;
};

export function creatorEscrowWitnesses(
  creatorSk: UserSecretKey,
  governorSk: UserSecretKey,
  communitySk?: UserSecretKey,
): CreatorEscrowWitnesses {
  return {
    getCreatorSecret: () => [undefined, creatorSk],
    getGovernorSecret: () => [undefined, governorSk],
    getCommunitySecret: () => [undefined, requirePrivileged(communitySk, 'communitySk', 'creatorEscrowWitnesses')],
  };
}

// ---------------------------------------------------------------------------
// 4. VESTING PSM
// Witnesses: getCreatorSecret, getGovernorSecret
// New 2026-07-09 — see the "v3" note on CreatorEscrowCalls above for why
// this is a separate PSM from Creator Escrow. No community witness: the
// CTO redirect here is a one-time freeze-and-hand-off at trigger time
// (matching CLAUDE.md's "frozen, redirected to community treasury"), not
// an ongoing claim relationship like Creator Escrow's post-CTO fee claims.
// ---------------------------------------------------------------------------

export type VestingWitnesses = {
  getCreatorSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
};

export function vestingWitnesses(creatorSk: UserSecretKey, governorSk: UserSecretKey): VestingWitnesses {
  return {
    getCreatorSecret: () => [undefined, creatorSk],
    getGovernorSecret: () => [undefined, governorSk],
  };
}

// ---------------------------------------------------------------------------
// 5. LP ESCROW PSM
// Witnesses: getGovernorSecret, getCommunitySecret
// ---------------------------------------------------------------------------

export type LpEscrowWitnesses = {
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getCommunitySecret: WitnessFn<UserSecretKey>;
};

export function lpEscrowWitnesses(governorSk: UserSecretKey, communitySk?: UserSecretKey): LpEscrowWitnesses {
  return {
    getGovernorSecret: () => [undefined, governorSk],
    getCommunitySecret: () => [undefined, requirePrivileged(communitySk, 'communitySk', 'lpEscrowWitnesses')],
  };
}

// ---------------------------------------------------------------------------
// 6. TREASURY PSM
// Witnesses: getGovernorSecret
// ---------------------------------------------------------------------------

export type TreasuryWitnesses = {
  getGovernorSecret: WitnessFn<UserSecretKey>;
};

export function treasuryWitnesses(governorSk: UserSecretKey): TreasuryWitnesses {
  return {
    getGovernorSecret: () => [undefined, governorSk],
  };
}

// ---------------------------------------------------------------------------
// 7. CTO GOVERNANCE PSM
// Witnesses: getUserSecret, getGovernorSecret, getBalanceLeafAmount,
//            getBalanceLeafHeldSince, getBalanceProof
// Design requirement: getBalanceLeafAmount/getBalanceProof
// added — castVote no longer trusts a caller-supplied voteWeight/isCreator;
// the voter instead proves their real balance via a Merkle proof against a
// governor-published balanceSnapshotRoot. `balanceLeafAmount` is the
// voter's own real balance (private, disclosed only as the vote weight
// itself — which was already public before this fix); `balanceProof` is
// their 20-level inclusion proof (depth reduced from 32, 2026-07-12),
// built with packages/zk-proofs/src/cto-governance.ts's `buildBalanceSnapshotTree`.
// Anti-whale-takeover fix (2026-07-28): `balanceLeafHeldSince` added —
// the timestamp the governor's snapshot first observed this voter holding
// their leaf's balance, bound into the leaf hash itself
// (hashBalanceLeaf's 4th field) so it can't be supplied independently of
// what the proof actually covers. castVote uses it to enforce
// minHoldingPeriod (30 days) before this balance counts toward a vote.
// ---------------------------------------------------------------------------

export type CtoGovernanceWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getBalanceLeafAmount: WitnessFn<bigint>;
  getBalanceLeafHeldSince: WitnessFn<bigint>;
  getBalanceProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
};

export function ctoGovernanceWitnesses(
  userSk: UserSecretKey,
  balanceLeafAmount: bigint,
  balanceProof: MerkleProofEntry[],
  governorSk?: UserSecretKey,
  balanceLeafHeldSince = 0n,
): CtoGovernanceWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getGovernorSecret: () => [undefined, requirePrivileged(governorSk, 'governorSk', 'ctoGovernanceWitnesses')],
    getBalanceLeafAmount: () => [undefined, balanceLeafAmount],
    getBalanceLeafHeldSince: () => [undefined, balanceLeafHeldSince],
    getBalanceProof: () => [undefined, balanceProof],
  };
}

// ---------------------------------------------------------------------------
// 8. STAKING REWARDS POOL PSM (Midnight Launch only, 2026-07-14)
// Witnesses: getUserSecret, getGovernorSecret, getCreatorSecret,
//            getStakeProof, getStakeLeafAmount, getRewardProof,
//            getRewardLeafAmount
//
// Fix (2026-07-30): this file's own header claimed "7 PSMs" and had
// no entry for staking_pool.compact at all — a real gap (this file's
// header is now updated too), not just a stale count, since anyone
// wiring a real caller for this PSM off this file alone would have had
// no factory to use.
//
// Governor-attested stake/reward model (see staking_pool.compact's file
// header for the full rationale): stakeProof/stakeLeafAmount prove
// the caller's real staked amount against a governor-published
// stakeSnapshotRoot; rewardProof/rewardLeafAmount prove their real
// cumulative-accrued-reward-to-date against a governor-published
// rewardRoot. Same 20-level Merkle-proof shape as every other tree on
// this platform (allowlist, CTO balance-snapshot). creatorSk is only
// read by topUpPool (creator-only) — a fallback to userSk keeps this
// factory usable for non-creator calls without a separate secret.
// ---------------------------------------------------------------------------

export type StakingPoolWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getCreatorSecret: WitnessFn<UserSecretKey>;
  getStakeProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getStakeLeafAmount: WitnessFn<bigint>;
  getRewardProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getRewardLeafAmount: WitnessFn<bigint>;
};

export function stakingPoolWitnesses(
  userSk: UserSecretKey,
  stakeProof: MerkleProofEntry[],
  stakeLeafAmount: bigint,
  rewardProof: MerkleProofEntry[],
  rewardLeafAmount: bigint,
  governorSk?: UserSecretKey,
  creatorSk?: UserSecretKey,
): StakingPoolWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getGovernorSecret: () => [undefined, requirePrivileged(governorSk, 'governorSk', 'stakingPoolWitnesses')],
    getCreatorSecret: () => [undefined, requirePrivileged(creatorSk, 'creatorSk', 'stakingPoolWitnesses')],
    getStakeProof: () => [undefined, stakeProof],
    getStakeLeafAmount: () => [undefined, stakeLeafAmount],
    getRewardProof: () => [undefined, rewardProof],
    getRewardLeafAmount: () => [undefined, rewardLeafAmount],
  };
}

// ============================================================================
// CIRCUIT CALLS AND CROSS-PSM COMPOSITION — see integration/midnight-client.ts
// ============================================================================
// The `*Calls` object literals and `merged*` helpers that used to live here
// were built against a fictional `contract.call(name, argsRecord)` /
// `contract.createCall(name, argsRecord)` API — no such methods exist on
// @midnight-ntwrk/midnight-js-contracts's real `FoundContract`/
// `DeployedContract`. The real SDK exposes typed, POSITIONAL circuit calls
// via `deployed.callTx.<circuitName>(...args)`, so a name+object-args
// indirection layer adds nothing beyond what each compiled contract's own
// `Witnesses<PS>`/`ImpureCircuits<PS>` types already give you.
//
// Cross-PSM composition ("merged tx") is also NOT what it looked like here:
// the real SDK's only transaction-batching primitive,
// `withContractScopedTransaction<C, PCK>`, is parameterized by a single
// contract type `C` — it batches multiple calls to ONE contract, not calls
// across different contract types. Confirmed via
// @midnight-ntwrk/midnight-js-contracts@4.1.1's type declarations
// (2026-07-09). This means true cross-PSM atomicity is not something
// the current public SDK surface provides — Noctis's cross-PSM operations
// (buy + cap check, graduation, CTO execution, cancellation) are called
// sequentially in integration/midnight-client.ts, consistent with
// CLAUDE.md's default 10-minute settlement window pending that resolution.
// ============================================================================
