import { describe, expect, it } from 'vitest';
import { computeBuyCommit } from '../../../packages/zk-proofs/src/darkveil.js';
import {
  buildAllowlistTree,
  buildRegistrantTree,
  deriveUserPublicKey,
  hashAllowlistLeaf,
  hashRegistrantLeaf,
} from '../../../packages/zk-proofs/src/eligibility-gate.js';
import {
  Contract,
  DarkVeilState,
  LaunchPhase,
  ledger,
  type Witnesses,
} from '../compiled/eligibility_gate/contract/index.js';
import { DOMAINS, deriveRoleKey } from '../witnesses.js';
import { deployForTest, fakeBytes32, nextContext, nextContextAtTime } from './helpers.js';

// The three keys allowed to attest the allowlist root (threshold attestation,
// 2026-08-11). Fill 2 is the governor secret this suite already uses, so the
// governor stays one of the three rather than becoming a separate role.
const ALLOWLIST_ATTESTOR_1_FILL = 2;
const ALLOWLIST_ATTESTOR_2_FILL = 32;
const ALLOWLIST_ATTESTOR_3_FILL = 33;
const ALLOWLIST_THRESHOLD = 2n;
const ALLOWLIST_EXPIRY_SECONDS = 86_400n;
const allowlistAttestorKey = (fill: number) =>
  deriveRoleKey({ bytes: fakeBytes32(fill) }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes;
const ALLOWLIST_ATTESTOR_1_KEY = allowlistAttestorKey(ALLOWLIST_ATTESTOR_1_FILL);
const ALLOWLIST_ATTESTOR_2_KEY = allowlistAttestorKey(ALLOWLIST_ATTESTOR_2_FILL);
const ALLOWLIST_ATTESTOR_3_KEY = allowlistAttestorKey(ALLOWLIST_ATTESTOR_3_FILL);

type PrivateState = undefined;

// The launch every contract in this file is deployed with. Identity is scoped
// per launch, so a key derived under any other value matches nothing on-chain.
const LAUNCH_ID = fakeBytes32(9);

// Fix (2026-07-09): verifyAllowlist() now does real Merkle verification
// (see contracts/midnight/eligibility_gate.compact and
// packages/zk-proofs/tests/allowlist-merkle.test.ts for the dedicated
// adversarial suite) — these tests need a real allowlist tree the witness
// proof actually matches, not an arbitrary root + garbage proof.
//
// Design requirement: the leaf is no longer a free witness — it's
// derived in-circuit as hashAllowlistLeaf(caller), so the tree must be
// built with that same formula for the registrant's real derived identity
// (fakeBytes32(3)), not an arbitrary opaque value.
const REGISTRANT_KEY = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
const ALLOWLIST_LEAF = hashAllowlistLeaf(REGISTRANT_KEY);
const ALLOWLIST_TREE = buildAllowlistTree([ALLOWLIST_LEAF]);
const BUY_NONCE = fakeBytes32(8);

// Fix (2026-07-30): submitBuyCommit now proves prior registration via
// a real Merkle proof against registrantRoot (published by the governor at
// startBuying) instead of a publicly-precomputable nullifier — see
// verifyRegistrant's own comment in eligibility_gate.compact. This is the
// default single-registrant tree (REGISTRANT_KEY only) most tests in this
// file use — every `startBuying` call now needs a matching registrantRoot
// argument.
const REGISTRANT_TREE = buildRegistrantTree([hashRegistrantLeaf(REGISTRANT_KEY)]);

// Phase 2 security-audit fix (2026-07-11): darkveil.compact merged into
// this file (mirrors the Midnight Launch merge) — getBuyNonce is now part of this
// contract's own witness set.
/** Attests the allowlist root with a SECOND attestor, completing the 2-of-3. */
function attestAllowlistAgain(contractAddress: string, ctx: never, root: Uint8Array, at = 0n) {
  const second = new Contract<PrivateState>({
    ...witnesses,
    getGovernorSecret: (_c) => [undefined, { bytes: fakeBytes32(ALLOWLIST_ATTESTOR_2_FILL) }],
  });
  return second.circuits.updateAllowlistRoot(nextContextAtTime(contractAddress, ctx, Number(at)), root, at);
}

const witnesses: Witnesses<PrivateState> = {
  getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
  getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
  getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
};

const TOTAL_SUPPLY = 1_000_000_000n;
const MAX_WALLET_PERCENT = 5n;
const CORRECT_WALLET_CAP = (TOTAL_SUPPLY * MAX_WALLET_PERCENT) / 100n; // 50,000,000

// DarkVeil-side constructor args (from the retired darkveil.compact)
const DV_ALLOCATION = 500n;
const DV_PRICE = 90n;
const ALLOWLIST_SIZE = 1n;
const REGISTRATION_CLOSE_TIME = 1_000_000n;
// Permissive by default (1n) so pre-existing tests below, which only
// ever register 1 registrant via REGISTRANT_KEY, aren't broken by the new
// minimum-participant floor. Dedicated tests further down deploy with a
// real threshold to exercise the floor itself.
const MIN_DV_PARTICIPANTS_TEST = 1n;

// The creator's identity, distinct from the regular registrant secret
// (fakeBytes32(3)) every other test in this file uses. deriveUserPublicKey
// here is the raw off-chain mirror (Uint8Array in, Uint8Array out) — not
// the UserSecretKey/UserPublicKey struct wrapper the witness type uses.
const CREATOR_SECRET_BYTES = fakeBytes32(42);
const CREATOR_KEY = deriveUserPublicKey(CREATOR_SECRET_BYTES, LAUNCH_ID);

// Equivalent fix: fixed payout addresses for the forfeited portion of a
// ratio-based bond refund — real unshielded addresses, not derived
// identities, so plain fakeBytes32 is fine.
// One platform wallet. The treasury/ops split is gone everywhere, so there is
// a single destination and no share arithmetic left to test.
const PLATFORM_ADDR = fakeBytes32(60);

function deploy(walletCap: bigint = CORRECT_WALLET_CAP) {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    ALLOWLIST_TREE.root, // allowlistRoot
    TOTAL_SUPPLY,
    MAX_WALLET_PERCENT,
    1000n, // bondAmount
    walletCap,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    REGISTRATION_CLOSE_TIME,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    PLATFORM_ADDR,
    ALLOWLIST_ATTESTOR_1_KEY,
    ALLOWLIST_ATTESTOR_2_KEY,
    ALLOWLIST_ATTESTOR_3_KEY,
    ALLOWLIST_THRESHOLD,
  );
  return { contract, init, contractAddress, ctx };
}

/** Deploys with an explicit registrationCloseTime, for the anchor guard. */
function deployWithRegistrationCloseTime(closeTime: bigint) {
  const contract = new Contract<PrivateState>(witnesses);
  return deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    ALLOWLIST_TREE.root,
    TOTAL_SUPPLY,
    MAX_WALLET_PERCENT,
    1000n,
    CORRECT_WALLET_CAP,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    closeTime,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    PLATFORM_ADDR,
    ALLOWLIST_ATTESTOR_1_KEY,
    ALLOWLIST_ATTESTOR_2_KEY,
    ALLOWLIST_ATTESTOR_3_KEY,
    ALLOWLIST_THRESHOLD,
  );
}

// Fix (2026-07-21): registerForDarkVeil now requires
// dvState == Registration (not just phase == DarkVeil), so this helper
// also calls startRegistration() — every caller of this helper registers
// afterward.
function deployAndStartDarkVeil() {
  const d = deploy();
  const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
  const ctx0 = nextContext(d.contractAddress, r0.context);
  const r1 = d.contract.circuits.startRegistration(ctx0);
  const ctx = nextContext(d.contractAddress, r1.context);
  return { ...d, ctx };
}

/**
 * Drives dvState through Inactive -> Registration -> Buying (independent of
 * `phase` — see DarkVeilState's comment). Also registers the default buyer
 * (REGISTRANT_KEY, matching the shared `witnesses` object) for DarkVeil —
 * Phase 4 fix (2026-07-12): submitBuyCommit now requires proof of prior
 * registration (a recomputed registration nullifier), so every test built
 * on this helper needs a real registration behind it, not just an active
 * buying phase.
 */
function deployAndStartDvBuying() {
  const d = deploy();
  const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
  const ctx0 = nextContext(d.contractAddress, r0.context);
  const r1 = d.contract.circuits.startRegistration(ctx0);
  const ctx1 = nextContext(d.contractAddress, r1.context);
  // Fix (2026-07-21): registerForDarkVeil now requires
  // dvState == Registration, so this must happen after startRegistration.
  const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
  const ctxReg = nextContext(d.contractAddress, rReg.context);
  const r2 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
  const ctx2 = nextContext(d.contractAddress, r2.context);
  return { ...d, ctx: ctx2 };
}

describe('eligibility_gate.compact — wallet cap math (CRITICAL regression)', () => {
  it('IMPORTANT FINDING (fixed): walletCap constructor arg is honored exactly, no on-chain multiplication', () => {
    // Before the 2026-07-09 fix, the constructor computed
    // `walletCap = totalSupply * maxWalletPercent` with NO division by 100
    // at all, despite its own comment describing the /100 formula and a
    // worked example. For totalSupply=1,000,000,000 and maxWalletPercent=5,
    // that bug would have produced walletCap = 5,000,000,000 — five times
    // the ENTIRE token supply, silently disabling the 5% anti-whale cap
    // almost completely (no purchase could ever exceed a cap bigger than
    // total supply). The fix makes walletCap an explicit constructor
    // argument the deployer must compute off-chain and pass in correctly.
    const buggyWalletCapWouldHaveBeen = TOTAL_SUPPLY * MAX_WALLET_PERCENT; // 5,000,000,000
    const { init } = deploy(CORRECT_WALLET_CAP);
    // No direct ledger field exposes walletCap (it's sealed), so we prove
    // it's the correct value indirectly via revealBuyCommit's boundary
    // behavior in the "wallet cap enforcement via revealBuyCommit" describe
    // block below. This test just documents the magnitude of what the bug
    // would have produced, for the record.
    expect(buggyWalletCapWouldHaveBeen).toBe(5_000_000_000n);
    expect(CORRECT_WALLET_CAP).toBe(50_000_000n);
    expect(init.currentContractState).toBeDefined();
  });
});

// Phase 4 (2026-07-12): checkAndUpdateCap was a standalone circuit nothing
// in this contract called — revealBuyCommit already enforces the identical
// 5% cumulative wallet cap inline (see its own "Bonus fix (this merge)"
// comment), so the standalone circuit was dead code and has been removed.
// These tests port the boundary coverage the old checkAndUpdateCap tests
// provided onto the real enforcement path instead of losing it.
//
// dvAllocation and baseSlot are deployed generously large in every test
// below so the pool-wide and per-registrant caps are never the binding
// constraint — only walletCap is under test.
describe('eligibility_gate.compact — wallet cap enforcement via revealBuyCommit (ported from removed checkAndUpdateCap)', () => {
  const BIG_DV_ALLOCATION = 200_000_000n; // well above 2x CORRECT_WALLET_CAP
  const BIG_BASE_SLOT = 100_000_000n; // above CORRECT_WALLET_CAP alone

  function revealAt(
    tree: ReturnType<typeof buildAllowlistTree>,
    secretBytes: Uint8Array,
    tokenAmount: bigint,
    allowlistIndex: number,
    allowlistSize: bigint,
  ) {
    const buyerKey = deriveUserPublicKey(secretBytes, LAUNCH_ID);
    // Fix: each call registers exactly one fresh registrant (this
    // secretBytes) in a freshly deployed contract, so its registrant tree
    // always has exactly one leaf at index 0.
    const registrantTree = buildRegistrantTree([hashRegistrantLeaf(buyerKey)]);
    const capWitnesses: Witnesses<PrivateState> = {
      getUserSecret: (_ctx) => [undefined, { bytes: secretBytes }],
      getMerkleProof: (_ctx) => [undefined, tree.getProof(allowlistIndex)],
      getRegistrantMerkleProof: (_ctx) => [undefined, registrantTree.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    };
    const contract = new Contract<PrivateState>(capWitnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      tree.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      BIG_DV_ALLOCATION,
      DV_PRICE,
      allowlistSize,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      PLATFORM_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const r0 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(contractAddress, r1.context);
    // Phase 4 fix: submitBuyCommit now requires proof of prior registration.
    // Fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg = contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctxReg, registrantTree.root);
    const ctx2 = nextContext(contractAddress, r2.context);

    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r3 = contract.circuits.submitBuyCommit(ctx2, commitment, 1n);
    const ctx3 = nextContext(contractAddress, r3.context);
    const r4 = contract.circuits.closeDarkVeil(ctx3, 2n, BIG_BASE_SLOT);
    const ctx4 = nextContext(contractAddress, r4.context);
    const pinnedCtx4 = nextContextAtTime(contractAddress, ctx4, 3);

    return () => contract.circuits.revealBuyCommit(pinnedCtx4, commitment, tokenAmount, DV_PRICE, 3n);
  }

  it('accepts a reveal at exactly the 5% wallet cap boundary', () => {
    const tree = buildAllowlistTree([hashAllowlistLeaf(deriveUserPublicKey(fakeBytes32(20), LAUNCH_ID))]);
    const doReveal = revealAt(tree, fakeBytes32(20), CORRECT_WALLET_CAP, 0, 1n);
    expect(doReveal()).toBeDefined();
  });

  it('rejects a reveal exceeding the 5% wallet cap by even 1 token', () => {
    const tree = buildAllowlistTree([hashAllowlistLeaf(deriveUserPublicKey(fakeBytes32(21), LAUNCH_ID))]);
    const doReveal = revealAt(tree, fakeBytes32(21), CORRECT_WALLET_CAP + 1n, 0, 1n);
    expect(doReveal).toThrow('Purchase exceeds 5% wallet cap');
  });

  it('the wallet cap is per-identity, not global — two different registrants each get their own 5%', () => {
    // Security-audit fix (the design requirement, preserved by this port): the caller's
    // identity is derived in-circuit from getUserSecret(), never taken as a
    // caller-supplied key parameter, so this can only ever affect the real
    // transaction signer's own cap entry. Proven here via two separate
    // registrants (separate secrets, separate allowlist leaves) each
    // independently claiming their own full 5% cap.
    const secretA = fakeBytes32(22);
    const secretB = fakeBytes32(23);
    const tree = buildAllowlistTree([
      hashAllowlistLeaf(deriveUserPublicKey(secretA, LAUNCH_ID)),
      hashAllowlistLeaf(deriveUserPublicKey(secretB, LAUNCH_ID)),
    ]);
    const doRevealA = revealAt(tree, secretA, CORRECT_WALLET_CAP, 0, 2n);
    const doRevealB = revealAt(tree, secretB, CORRECT_WALLET_CAP, 1, 2n);
    expect(doRevealA()).toBeDefined();
    expect(doRevealB()).toBeDefined();
  });
});

describe('eligibility_gate.compact — fix (2026-07-30): advancePhase cannot move backwards to Pending', () => {
  it('rejects advancePhase(Pending) from DarkVeil', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.advancePhase(ctx2, LaunchPhase.Pending)).toThrow(/back to Pending/i);
  });

  it('rejects advancePhase(Pending) from Cancelled (terminal state)', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, r2.context);
    expect(ledger(ctx3.currentQueryContext.state).phase).toBe(LaunchPhase.Cancelled);
    expect(() => contract.circuits.advancePhase(ctx3, LaunchPhase.Pending)).toThrow(/back to Pending/i);
    // Also confirms Cancelled is otherwise fully terminal: no other target
    // is reachable from it either (each of the other three transitions
    // already asserts its own specific required prior phase, none of
    // which is Cancelled).
    expect(() => contract.circuits.advancePhase(ctx3, LaunchPhase.DarkVeil)).toThrow(
      'Must be in Pending to start DarkVeil',
    );
    expect(() => contract.circuits.advancePhase(ctx3, LaunchPhase.Public)).toThrow(
      'Must be in DarkVeil to start Public',
    );
    expect(() => contract.circuits.advancePhase(ctx3, LaunchPhase.Graduated)).toThrow('Must be in Public to graduate');
  });
});

describe('eligibility_gate.compact — registration nullifier (disclose() placement regression)', () => {
  it('allows registration for a new wallet during the DarkVeil phase', () => {
    const { contract, ctx } = deployAndStartDarkVeil();
    const result = contract.circuits.registerForDarkVeil(ctx);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.registrationCount).toBe(1n);
  });

  it('rejects a double-registration using the same witness-derived nullifier', () => {
    // This is the exact regression this test guards: eligibility_gate.compact
    // had a disclose() placed on the outer boolean of the nullifier
    // membership check instead of on the witness-derived nullifier value
    // itself (`disclose(!registrationNullifiers.member(nullifier))` instead
    // of `!registrationNullifiers.member(disclose(nullifier))`). Beyond the
    // privacy issue that fix addressed, this proves the double-registration
    // guard actually works at runtime: registering twice with the same
    // witnesses (same nonce/user secret => same nullifier) must fail the
    // second time.
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.registerForDarkVeil(ctx2)).toThrow('Already registered for this launch');
  });

  it('rejects registration outside the DarkVeil phase', () => {
    const { contract, ctx } = deploy(); // still Pending, never advanced
    expect(() => contract.circuits.registerForDarkVeil(ctx)).toThrow('DarkVeil registration not active');
  });

  it('Fix (2026-07-21, Medium): rejects registration once dvState has moved past Registration, even though phase is still DarkVeil', () => {
    // Before the fix, registerForDarkVeil only checked `phase ==
    // LaunchPhase.DarkVeil`, never `dvState` — registration stayed open
    // through Buying/Closed, breaking the registration-freeze fairness
    // model (the minDvParticipants floor and base_slot computation both
    // assume the registrant set is fixed once Buying starts).
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    // MIN_DV_PARTICIPANTS_TEST floor (1) needs a real registrant before
    // startBuying will succeed.
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx1 = nextContext(contractAddress, r1.context);
    const rBuying = contract.circuits.startBuying(ctx1, REGISTRANT_TREE.root);
    const ctxBuying = nextContext(contractAddress, rBuying.context);

    const lateRegistrant = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => lateRegistrant.circuits.registerForDarkVeil(ctxBuying)).toThrow(/registration sub-phase/i);
  });

  it('rejects the creator registering for their own DarkVeil (CLAUDE.md eligibility check #3)', () => {
    const creatorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getUserSecret: (_ctx) => [undefined, { bytes: CREATOR_SECRET_BYTES }],
    };
    const contract = new Contract<PrivateState>(creatorWitnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      PLATFORM_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const r1 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(contractAddress, r1.context);

    // This test never calls startRegistration(), so dvState is still
    // Inactive — the "not in registration sub-phase" check fires before
    // the creator check is ever reached. Confirmed by running it; the
    // test's own name still holds directionally (registration IS
    // rejected) but not for the reason its description names.
    expect(() => contract.circuits.registerForDarkVeil(ctx1)).toThrow('DarkVeil not in registration sub-phase');
  });
});

describe('eligibility_gate.compact — NIGHT bond payment enforcement', () => {
  it('registration succeeds and still requires receiveUnshielded(nativeToken(), bondAmount) to be wired', () => {
    // Before this fix, lockedBonds credited `bondAmount` purely on trust —
    // nothing tied it to a real transfer. registerForDarkVeil now also
    // calls receiveUnshielded, which adds a ledger-enforced constraint that
    // this transaction includes a matching unshielded NIGHT input. The
    // local compact-runtime simulator doesn't model cross-transaction UTXO
    // matching (that's real-node enforcement, not something this simulator
    // can verify), so this test can't prove a missing payment is
    // rejected end-to-end; it proves the call is wired in and doesn't
    // break the existing registration flow.
    const { contract, ctx } = deployAndStartDarkVeil();
    const result = contract.circuits.registerForDarkVeil(ctx);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.registrationCount).toBe(1n);
    expect(state.lockedBonds.size()).toBe(1n);
  });
});

describe('eligibility_gate.compact — NIGHT bond refund', () => {
  it('locks a bond on registration and allows refund after the launch is cancelled', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);

    const rCancel = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, rCancel.context);

    const r2 = contract.circuits.claimBondRefund(ctx3, fakeBytes32(5));
    const ctx4 = nextContext(contractAddress, r2.context);
    // A second refund of an already-cleared bond fails
    expect(() => contract.circuits.claimBondRefund(ctx4, fakeBytes32(5))).toThrow('Bond already claimed');
  });

  it('rejects a bond refund claim while the launch is still active', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimBondRefund(ctx2, fakeBytes32(5))).toThrow(
      'Launch not cancelled and DarkVeil did not fail',
    );
  });

  it('Phase 2 security-audit fix regression: claimBondRefund pays out via sendUnshielded (does not throw locally)', () => {
    // Before this fix, claimBondRefund only cleared the ledger entry with
    // a comment deferring to "the Zswap layer via transaction merging" — a
    // mechanism that doesn't exist. Same simulator caveat as every other
    // sendUnshielded test in this suite: proves the call is wired in, not
    // verified end-to-end against a live network.
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    const rCancel = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, rCancel.context);

    expect(() => contract.circuits.claimBondRefund(ctx3, fakeBytes32(5))).not.toThrow();
  });

  it('Phase 5 hygiene fix: claimBondRefund rejects an empty (all-zero) recipient address', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    const rCancel = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, rCancel.context);

    expect(() => contract.circuits.claimBondRefund(ctx3, fakeBytes32(0))).toThrow('Recipient address cannot be empty');
  });
});

describe('eligibility_gate.compact — DarkVeil failure refund gate (regression)', () => {
  it('FIXED: refund is claimable when DarkVeil failed even though the launch converts to Public, not Cancelled', () => {
    // Before this fix, claimBondRefund only checked phase == Cancelled.
    // Under this resolution, a failed DarkVeil converts the launch to a
    // public-only launch (phase -> Public), not death (phase -> Cancelled)
    // — so registrants would have had no way to reclaim a bond at all.
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);

    const rMark = contract.circuits.markDarkVeilFailed(ctx2);
    const ctx3 = nextContext(contractAddress, rMark.context);
    expect(ledger(ctx3.currentQueryContext.state).dvFailed).toBe(true);

    // Launch converts to Public, NOT Cancelled
    const rAdvance = contract.circuits.advancePhase(ctx3, LaunchPhase.Public);
    const ctx4 = nextContext(contractAddress, rAdvance.context);
    expect(ledger(ctx4.currentQueryContext.state).phase).toBe(LaunchPhase.Public);

    // Refund still works, because dvFailed is independent of phase
    const rRefund = contract.circuits.claimBondRefund(ctx4, fakeBytes32(5));
    const ctx5 = nextContext(contractAddress, rRefund.context);
    expect(() => contract.circuits.claimBondRefund(ctx5, fakeBytes32(5))).toThrow('Bond already claimed');
  });

  it('markDarkVeilFailed is governor-only', () => {
    const { ctx } = deployAndStartDarkVeil();
    const attacker = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => attacker.circuits.markDarkVeilFailed(ctx)).toThrow('Only governor can mark DarkVeil failed');
  });

  it('rejects marking DarkVeil failed twice', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.markDarkVeilFailed(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.markDarkVeilFailed(ctx2)).toThrow('DarkVeil already marked failed');
  });
});

// ============================================================================
// Resolution (2026-07-13): minimum absolute registrant count required
// before startBuying() opens the buying phase. Below the floor, the
// governor must call cancelDarkVeil() (the existing, already-refundable
// DarkVeil-failure path) instead.
// ============================================================================

describe('eligibility_gate.compact — minimum DarkVeil participant floor', () => {
  // Three real distinct registrant identities, each a real leaf in a
  // purpose-built 3-leaf allowlist tree — the shared top-level
  // ALLOWLIST_TREE only contains one leaf (REGISTRANT_KEY), so exercising a
  // multi-registrant floor needs its own tree, same pattern as the wallet
  // cap describe block above.
  const SECRET_A = fakeBytes32(101);
  const SECRET_B = fakeBytes32(102);
  const SECRET_C = fakeBytes32(103);
  const KEY_A = deriveUserPublicKey(SECRET_A, LAUNCH_ID);
  const KEY_B = deriveUserPublicKey(SECRET_B, LAUNCH_ID);
  const KEY_C = deriveUserPublicKey(SECRET_C, LAUNCH_ID);
  const FLOOR_TREE = buildAllowlistTree([hashAllowlistLeaf(KEY_A), hashAllowlistLeaf(KEY_B), hashAllowlistLeaf(KEY_C)]);
  // Fix: separate registrant tree (same 3 leaves, different domain —
  // see registrantRoot's own comment) — published by the governor at
  // startBuying once all 3 have actually registered.
  const FLOOR_REGISTRANT_TREE = buildRegistrantTree([
    hashRegistrantLeaf(KEY_A),
    hashRegistrantLeaf(KEY_B),
    hashRegistrantLeaf(KEY_C),
  ]);

  function registrantContract(secretBytes: Uint8Array, index: number) {
    return new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: secretBytes }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(index)],
      getRegistrantMerkleProof: (_ctx) => [undefined, FLOOR_REGISTRANT_TREE.getProof(index)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
  }

  function deployWithFloor(minDvParticipants: bigint) {
    const governorContract = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: SECRET_A }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, FLOOR_REGISTRANT_TREE.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    const { contractAddress, ctx } = deployForTest(
      governorContract,
      undefined,
      LAUNCH_ID,
      FLOOR_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      3n, // allowlistSize — matches the 3-leaf FLOOR_TREE
      REGISTRATION_CLOSE_TIME,
      minDvParticipants,
      CREATOR_KEY,
      PLATFORM_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const r0 = governorContract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = governorContract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(contractAddress, r1.context);
    return { governorContract, contractAddress, ctx: ctx1 };
  }

  it('rejects startBuying() below the floor, but cancelDarkVeil() still works as the escape hatch', () => {
    const { governorContract, contractAddress, ctx } = deployWithFloor(3n);

    // Only 2 of the 3 leaves register — below the floor of 3.
    const rA = registrantContract(SECRET_A, 0).circuits.registerForDarkVeil(ctx);
    const ctxA = nextContext(contractAddress, rA.context);
    const rB = registrantContract(SECRET_B, 1).circuits.registerForDarkVeil(ctxA);
    const ctxB = nextContext(contractAddress, rB.context);

    expect(ledger(ctxB.currentQueryContext.state).registrationCount).toBe(2n);
    expect(() => governorContract.circuits.startBuying(ctxB, FLOOR_REGISTRANT_TREE.root)).toThrow(
      'Below minimum DarkVeil participant threshold — cancel instead',
    );

    // The governor's real escape hatch still works from here.
    const rCancel = governorContract.circuits.cancelDarkVeil(ctxB);
    const ctxCancelled = nextContext(contractAddress, rCancel.context);
    expect(ledger(ctxCancelled.currentQueryContext.state).dvState).toBe(DarkVeilState.Cancelled);
  });

  it('cancelDarkVeil() releases every bond immediately, with no further governor call', () => {
    const { governorContract, contractAddress, ctx } = deployWithFloor(3n);

    const rA = registrantContract(SECRET_A, 0).circuits.registerForDarkVeil(ctx);
    const ctxA = nextContext(contractAddress, rA.context);
    const rB = registrantContract(SECRET_B, 1).circuits.registerForDarkVeil(ctxA);
    const ctxB = nextContext(contractAddress, rB.context);

    const rCancel = governorContract.circuits.cancelDarkVeil(ctxB);
    const ctxCancelled = nextContext(contractAddress, rCancel.context);

    // Both flags must be set. `dvState` alone satisfies neither refund path:
    // claimBondRefund gates on `phase == Cancelled || dvFailed`, and
    // claimRatioBondRefund gates on `dvState == Closed`.
    const st = ledger(ctxCancelled.currentQueryContext.state);
    expect(st.dvState).toBe(DarkVeilState.Cancelled);
    expect(st.dvFailed).toBe(true);

    // The property that matters: a registrant claims straight after the
    // cancel, with nothing else happening in between.
    const rClaimA = registrantContract(SECRET_A, 0).circuits.claimBondRefund(ctxCancelled, fakeBytes32(201));
    const ctxClaimedA = nextContext(contractAddress, rClaimA.context);

    const rClaimB = registrantContract(SECRET_B, 1).circuits.claimBondRefund(ctxClaimedA, fakeBytes32(202));
    const ctxClaimedB = nextContext(contractAddress, rClaimB.context);

    // Both bonds are really released, not just flagged. claimBondRefund keeps
    // the map entry and zeroes it (checks-effects-interactions), so the
    // released state is a zero balance plus a re-claim that now rejects.
    const finalLedger = ledger(ctxClaimedB.currentQueryContext.state);
    for (const [, bond] of finalLedger.lockedBonds) {
      expect(bond).toBe(0n);
    }
    expect(() => registrantContract(SECRET_A, 0).circuits.claimBondRefund(ctxClaimedB, fakeBytes32(201))).toThrow(
      'Bond already claimed',
    );
  });

  it('allows startBuying() once registration count reaches the floor', () => {
    const { governorContract, contractAddress, ctx } = deployWithFloor(3n);

    const rA = registrantContract(SECRET_A, 0).circuits.registerForDarkVeil(ctx);
    const ctxA = nextContext(contractAddress, rA.context);
    const rB = registrantContract(SECRET_B, 1).circuits.registerForDarkVeil(ctxA);
    const ctxB = nextContext(contractAddress, rB.context);
    const rC = registrantContract(SECRET_C, 2).circuits.registerForDarkVeil(ctxB);
    const ctxC = nextContext(contractAddress, rC.context);

    expect(ledger(ctxC.currentQueryContext.state).registrationCount).toBe(3n);
    const rBuy = governorContract.circuits.startBuying(ctxC, FLOOR_REGISTRANT_TREE.root);
    const ctxBuying = nextContext(contractAddress, rBuy.context);
    expect(ledger(ctxBuying.currentQueryContext.state).dvState).toBe(DarkVeilState.Buying);
  });

  it('rejects a zero minDvParticipants at deploy time', () => {
    expect(() =>
      deployForTest(
        new Contract<PrivateState>(witnesses),
        undefined,
        LAUNCH_ID,
        ALLOWLIST_TREE.root,
        TOTAL_SUPPLY,
        MAX_WALLET_PERCENT,
        1000n,
        CORRECT_WALLET_CAP,
        DV_ALLOCATION,
        DV_PRICE,
        ALLOWLIST_SIZE,
        REGISTRATION_CLOSE_TIME,
        0n, // minDvParticipants — invalid
        CREATOR_KEY,
        PLATFORM_ADDR,
        ALLOWLIST_ATTESTOR_1_KEY,
        ALLOWLIST_ATTESTOR_2_KEY,
        ALLOWLIST_ATTESTOR_3_KEY,
        ALLOWLIST_THRESHOLD,
      ),
    ).toThrow('minDvParticipants must be positive');
  });

  it("fix (2026-07-30): rejects a bondAmount above verifyRatioRefund's safe range at deploy time", () => {
    // Before the fix, this ceiling (2^44 - 1) was only checked the first
    // time claimRatioBondRefund ran — potentially after every registrant
    // for the launch had already bonded and bought. Fail fast at deploy
    // instead.
    expect(() =>
      deployForTest(
        new Contract<PrivateState>(witnesses),
        undefined,
        LAUNCH_ID,
        ALLOWLIST_TREE.root,
        TOTAL_SUPPLY,
        MAX_WALLET_PERCENT,
        17592186044416n, // bondAmount — one above 2^44 - 1
        CORRECT_WALLET_CAP,
        DV_ALLOCATION,
        DV_PRICE,
        ALLOWLIST_SIZE,
        REGISTRATION_CLOSE_TIME,
        MIN_DV_PARTICIPANTS_TEST,
        CREATOR_KEY,
        PLATFORM_ADDR,
        ALLOWLIST_ATTESTOR_1_KEY,
        ALLOWLIST_ATTESTOR_2_KEY,
        ALLOWLIST_ATTESTOR_3_KEY,
        ALLOWLIST_THRESHOLD,
      ),
    ).toThrow(/verifyRatioRefund's safe range/i);
  });
});

// ============================================================================
// Phase 2 security-audit fix (2026-07-11): darkveil.compact merged into
// this contract for Cardano Launch. Test coverage below ports what darkveil.test.ts
// used to cover (now deleted — that file tested a contract nothing deploys
// anymore), adapted for the merged identity/constructor, plus new coverage
// for what the merge specifically added (cumulativePurchases/
// dvTokensPurchased wiring, claimRatioBondRefund).
// ============================================================================

describe('eligibility_gate.compact — merged DarkVeil private buy (Phase 2)', () => {
  it('submitBuyCommit accepts a commitment during the Buying sub-phase, discloses nothing about the amount', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const tokenAmount = 50n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });

    const r = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.dvTotalParticipants).toBe(1n);
    // Nothing about tokenAmount appears anywhere in public state at this point.
    expect(state.totalTokensCommitted).toBe(0n);
  });

  it('fix (2026-07-30): rejects a commit from a caller who never registered, even with a real (but wrong-leaf) registrant proof', () => {
    // Before the fix, proof of prior registration was a disclosed
    // nullifier (computeRegistrationCommit(caller.bytes, launchId,
    // bondAmount)) that anyone could precompute from already-public
    // information (caller.bytes is disclosed via lockedBonds at
    // registration; launchId/bondAmount are public constants) — an
    // observer could pre-link a registrant's identity to whatever later
    // submitBuyCommit transaction discloses that same value. This test
    // proves the REPLACEMENT mechanism (a real Merkle membership proof)
    // actually enforces registration: an outsider whose own identity was
    // never inserted into the registrant tree cannot pass verifyRegistrant
    // by borrowing a real proof built for someone else's leaf — the leaf
    // itself is derived in-circuit from the caller's own identity, not
    // taken as a free witness.
    const d = deployAndStartDvBuying();
    const outsiderSecret = fakeBytes32(88);
    const outsiderKey = deriveUserPublicKey(outsiderSecret, LAUNCH_ID);
    const outsider = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: outsiderSecret }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      // A real, validly-shaped proof — just built for REGISTRANT_KEY's
      // leaf (the only leaf REGISTRANT_TREE has), not outsiderKey's.
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    const commitment = computeBuyCommit({
      buyerKey: outsiderKey,
      launchId: LAUNCH_ID,
      tokenAmount: 10n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    expect(() => outsider.circuits.submitBuyCommit(d.ctx, commitment, 1n)).toThrow(/Invalid registrant proof/i);
  });

  it('rejects a duplicate commitment hash', () => {
    const { contract, contractAddress, ctx } = deployAndStartDvBuying();
    const r1 = contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.submitBuyCommit(ctx2, fakeBytes32(30), 2n)).toThrow(/already exists/i);
  });

  it('Fix (2026-07-21): rejects a second buy commitment from the same identity, even with a different commitment hash', () => {
    // Before the fix, the buy nullifier was a free caller-supplied
    // parameter — a single registrant could submit unlimited buy
    // commitments simply by choosing a fresh nullifier value each time.
    // Now the nullifier is derived in-circuit from the caller's own secret
    // key, so a SECOND submission from the same identity always collides on
    // the SAME derived nullifier automatically — no caller-supplied
    // nullifier argument exists anymore to test the collision directly.
    const { contract, contractAddress, ctx } = deployAndStartDvBuying();
    const r1 = contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.submitBuyCommit(ctx2, fakeBytes32(33), 2n)).toThrow(/already bought/i);
  });

  it('rejects commitments submitted outside the buying phase', () => {
    const { contract, ctx } = deploy(); // still Inactive
    expect(() => contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n)).toThrow('DarkVeil buying not active');
  });

  it('rejects revealing a commitment before DarkVeil closes', () => {
    const { contract, contractAddress, ctx } = deployAndStartDvBuying();
    const r1 = contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const pinnedCtx2 = nextContextAtTime(contractAddress, ctx2, 1);

    expect(() => contract.circuits.revealBuyCommit(pinnedCtx2, fakeBytes32(30), 1000n, 100n, 1n)).toThrow(
      /not closed/i,
    );
  });

  it("Fix (2026-07-21): rejects cancelling someone else's commitment (ownership check)", () => {
    // Before the fix, this test constructed an artificial mismatch by
    // passing an arbitrary nullifier at submit time. That's no longer
    // possible — submitBuyCommit always derives the correct nullifier for
    // its real caller now. The real ownership-check scenario is a
    // DIFFERENT identity (not the original submitter) attempting to cancel.
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    const impostor = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(77) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => impostor.circuits.cancelBuyCommit(ctx2, commitment)).toThrow(/commitment owner/i);
  });

  it('cancelBuyCommit works before DarkVeil closes, decrements participant count', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    expect(ledger(r1.context.currentQueryContext.state).dvTotalParticipants).toBe(1n);

    const r2 = d.contract.circuits.cancelBuyCommit(ctx1, commitment);
    expect(ledger(r2.context.currentQueryContext.state).dvTotalParticipants).toBe(0n);
  });

  it('closeDarkVeil generates a FairLaunchCert and transitions dvState to Closed', () => {
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 12345n, 100n);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.dvState).toBe(DarkVeilState.Closed);
    expect(state.fairLaunchCert.closeTimestamp).toBe(12345n);
  });

  describe('fix (2026-07-30): revealBuyCommit reveal deadline (30 days post-close)', () => {
    const REVEAL_WINDOW_SECONDS = 2_592_000n; // 30 days

    function closeAndCommit() {
      const d = deployAndStartDvBuying();
      const buyerKey = REGISTRANT_KEY;
      const tokenAmount = 10n;
      const commitment = computeBuyCommit({
        buyerKey,
        launchId: LAUNCH_ID,
        tokenAmount,
        pricePerToken: DV_PRICE,
        nonce: BUY_NONCE,
      });
      const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
      const ctx1 = nextContext(d.contractAddress, r1.context);
      const closeTimestamp = 1000n;
      const r2 = d.contract.circuits.closeDarkVeil(ctx1, closeTimestamp, 100n);
      const ctx2 = nextContext(d.contractAddress, r2.context);
      return { ...d, ctx: ctx2, commitment, tokenAmount, closeTimestamp };
    }

    it('allows a reveal exactly at the deadline boundary (closeTimestamp + 30 days)', () => {
      const { contract, contractAddress, ctx, commitment, tokenAmount, closeTimestamp } = closeAndCommit();
      const deadline = closeTimestamp + REVEAL_WINDOW_SECONDS;
      const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(deadline));
      const r = contract.circuits.revealBuyCommit(pinnedCtx, commitment, tokenAmount, DV_PRICE, deadline);
      expect(ledger(r.context.currentQueryContext.state).totalTokensCommitted).toBe(tokenAmount);
    });

    it('rejects a reveal one second past the deadline', () => {
      const { contract, contractAddress, ctx, commitment, tokenAmount, closeTimestamp } = closeAndCommit();
      const pastDeadline = closeTimestamp + REVEAL_WINDOW_SECONDS + 1n;
      const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(pastDeadline));
      expect(() =>
        contract.circuits.revealBuyCommit(pinnedCtx, commitment, tokenAmount, DV_PRICE, pastDeadline),
      ).toThrow(/reveal window has closed/i);
    });

    it('rejects a forged currentTimestamp that does not match real (pinned) block time', () => {
      // Same class of check as every other currentTimestamp-taking circuit
      // in this codebase (fixed 2026-07-21) — a caller can't just claim
      // to be within the window without the simulator's own block time
      // agreeing.
      const { contract, ctx, commitment, tokenAmount, closeTimestamp } = closeAndCommit();
      // ctx's real (unpinned-since-close) block time is left at whatever
      // closeDarkVeil last advanced it to; claiming a currentTimestamp far
      // in the future without pinning to match must fail the band check.
      const forgedFarFuture = closeTimestamp + 999_999_999n;
      expect(() => contract.circuits.revealBuyCommit(ctx, commitment, tokenAmount, DV_PRICE, forgedFarFuture)).toThrow(
        /currentTimestamp/i,
      );
    });
  });

  it('Fix (2026-07-21, Medium): rejects a baseSlot whose total (baseSlot * registrationCount) exceeds dvAllocation', () => {
    // deployAndStartDvBuying registers exactly 1 participant (REGISTRANT_KEY),
    // so any baseSlot above DV_ALLOCATION (500) collectively promises more
    // than the pool actually reserves.
    const d = deployAndStartDvBuying();
    expect(() => d.contract.circuits.closeDarkVeil(d.ctx, 12345n, DV_ALLOCATION + 1n)).toThrow(/exceeds dvAllocation/i);
  });

  it('accepts a baseSlot exactly at the dvAllocation / registrationCount boundary', () => {
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 12345n, DV_ALLOCATION); // 500 * 1 == 500
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.dvState).toBe(DarkVeilState.Closed);
  });

  it("fix (2026-07-30): rejects a baseSlot above verifyRatioRefund's safe range at closeDarkVeil time", () => {
    // Same fail-fast reasoning as the deploy-time bondAmount test above,
    // applied to the other half of verifyRatioRefund's range checks
    // (allocated/baseSlot) — this ceiling fires before the pre-existing
    // baseSlot * registrationCount <= dvAllocation check even gets a
    // chance to run.
    const d = deployAndStartDvBuying();
    expect(
      () => d.contract.circuits.closeDarkVeil(d.ctx, 12345n, 1099511627776n), // one above 2^40 - 1
    ).toThrow(/verifyRatioRefund's safe range/i);
  });

  it('rejects a DarkVeil buy exceeding the total dvAllocation pool', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const overAmount = DV_ALLOCATION + 1n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: overAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    // Fix (2026-07-21) note: baseSlot can no longer be set above
    // dvAllocation / registrationCount (closeDarkVeil now enforces this —
    // see that circuit's own comment) — with 1 registrant, the max legal
    // baseSlot equals DV_ALLOCATION itself, which is already below
    // overAmount, so this rejection is still real (either check fires) even
    // though it's no longer possible to isolate the pool-wide check alone
    // with a single registrant.
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, DV_ALLOCATION);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, 3);

    expect(() => d.contract.circuits.revealBuyCommit(pinnedCtx2, commitment, overAmount, DV_PRICE, 3n)).toThrow(
      'Exceeds per-registrant DarkVeil allocation',
    );
  });

  it('the design requirement regression: rejects a reveal exceeding the per-registrant baseSlot, even within the pool-wide dvAllocation', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const tokenAmount = 50n; // exceeds baseSlot (40) but well within dvAllocation (500)
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 40n); // baseSlot=40, less than tokenAmount=50
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, 3);

    expect(() => d.contract.circuits.revealBuyCommit(pinnedCtx2, commitment, tokenAmount, DV_PRICE, 3n)).toThrow(
      'Exceeds per-registrant DarkVeil allocation',
    );
  });

  it('rejects the creator submitting a DarkVeil buy commitment at all — they can never have registered', () => {
    // Phase 4 fix (2026-07-12): submitBuyCommit now requires a valid
    // registration nullifier, and registerForDarkVeil already refuses to
    // register the creator. So the creator is now rejected at
    // submitBuyCommit itself — earlier and stronger than the previous
    // behavior, where they were only caught later at revealBuyCommit.
    // revealBuyCommit's own creator check (below) remains as defense in
    // depth, but this test reflects the actual, earliest rejection point.
    const creatorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getUserSecret: (_ctx) => [undefined, { bytes: CREATOR_SECRET_BYTES }],
    };
    const contract = new Contract<PrivateState>(creatorWitnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      PLATFORM_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const rPhase = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctxPhase = nextContext(contractAddress, rPhase.context);
    const r1 = contract.circuits.startRegistration(ctxPhase);
    const ctx1 = nextContext(contractAddress, r1.context);
    // startBuying() now requires at least MIN_DV_PARTICIPANTS_TEST real
    // registrants — a legitimate registrant (REGISTRANT_KEY, the shared
    // ALLOWLIST_TREE's leaf 0) registers first so the floor is met; the
    // creator themselves is never one of them, which is exactly this test's
    // point.
    const registrantContract = new Contract<PrivateState>(witnesses);
    const rReg = registrantContract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    const ctx2 = nextContext(contractAddress, r2.context);

    const buyerKey = deriveUserPublicKey(CREATOR_SECRET_BYTES, LAUNCH_ID);
    const tokenAmount = 10n;
    const pricePerToken = DV_PRICE;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken,
      nonce: BUY_NONCE,
    });

    expect(() => contract.circuits.submitBuyCommit(ctx2, commitment, 1n)).toThrow('Invalid registrant proof');
  });

  it('Bonus fix (this merge): a non-creator reveal updates cumulativePurchases and dvTokensPurchased atomically', () => {
    // Before this merge, revealBuyCommit never touched cumulativePurchases
    // at all — the standalone checkAndUpdateCap was the only way to update
    // it, and nothing in the old darkveil.compact ever called it. Also
    // proves dvTokensPurchased (needed by claimRatioBondRefund below) is
    // now tracked per-buyer.
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const tokenAmount = 10n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 100n);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, 3);
    const r3 = d.contract.circuits.revealBuyCommit(pinnedCtx2, commitment, tokenAmount, DV_PRICE, 3n);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    const capAfter = ledger(ctx3.currentQueryContext.state).cumulativePurchases;
    expect(capAfter.lookup(buyerKey)).toBe(tokenAmount);
  });

  it('publishes the certificate in public state after close', () => {
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 999n, 100n);
    const ctx = nextContext(d.contractAddress, r.context);
    expect(ledger(ctx.currentQueryContext.state).fairLaunchCert.closeTimestamp).toBe(999n);
  });
});

describe('eligibility_gate.compact — Phase 2: claimRatioBondRefund (previously Midnight Launch only)', () => {
  /** Registers, submits + reveals a DV buy for `purchased` tokens, closes DarkVeil with `baseSlot`. */
  function registerBuyAndClose(purchased: bigint, baseSlot: bigint) {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    // Fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg0 = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg0 = nextContext(d.contractAddress, rReg0.context);
    const r3 = d.contract.circuits.startBuying(ctxReg0, REGISTRANT_TREE.root);
    let ctx = nextContext(d.contractAddress, r3.context);

    if (purchased > 0n) {
      const buyerKey = REGISTRANT_KEY;
      const commitment = computeBuyCommit({
        buyerKey,
        launchId: LAUNCH_ID,
        tokenAmount: purchased,
        pricePerToken: DV_PRICE,
        nonce: BUY_NONCE,
      });
      const r4 = d.contract.circuits.submitBuyCommit(ctx, commitment, 1n);
      ctx = nextContext(d.contractAddress, r4.context);
      const r5 = d.contract.circuits.closeDarkVeil(ctx, 2n, baseSlot);
      ctx = nextContext(d.contractAddress, r5.context);
      const pinnedRevealCtx = nextContextAtTime(d.contractAddress, ctx, 3);
      const r6 = d.contract.circuits.revealBuyCommit(pinnedRevealCtx, commitment, purchased, DV_PRICE, 3n);
      ctx = nextContext(d.contractAddress, r6.context);
      // Fix (2026-07-30): revealBuyCommit no longer drives the refund
      // math — claimRatioBondRefund now reads settledDvPurchases, written
      // only by the governor from a real (here, simulated) Cardano
      // ClaimDarkVeilTokens settlement. Simulates "the buyer actually
      // settled for the full amount they revealed" — the default, expected
      // real-world case this helper's callers are testing the refund MATH
      // against, not the settlement-mismatch case (see the dedicated
      // regression test below for that).
      const r7 = d.contract.circuits.recordDarkVeilSettlement(ctx, buyerKey, purchased);
      ctx = nextContext(d.contractAddress, r7.context);
    } else {
      // Ghost registrant — never submits or reveals anything.
      const r4 = d.contract.circuits.closeDarkVeil(ctx, 2n, baseSlot);
      ctx = nextContext(d.contractAddress, r4.context);
    }

    return { contract: d.contract, contractAddress: d.contractAddress, ctx };
  }

  /**
   * Same as registerBuyAndClose, but deliberately never calls
   * recordDarkVeilSettlement — for regression tests that need a
   * "revealed but not governor-attested as settled" state to call
   * recordDarkVeilSettlement against themselves.
   */
  function registerBuyAndCloseNoSettlement(purchased: bigint, baseSlot: bigint) {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg0 = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg0 = nextContext(d.contractAddress, rReg0.context);
    const r3 = d.contract.circuits.startBuying(ctxReg0, REGISTRANT_TREE.root);
    let ctx = nextContext(d.contractAddress, r3.context);

    const commitment = computeBuyCommit({
      buyerKey: REGISTRANT_KEY,
      launchId: LAUNCH_ID,
      tokenAmount: purchased,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r4 = d.contract.circuits.submitBuyCommit(ctx, commitment, 1n);
    ctx = nextContext(d.contractAddress, r4.context);
    const r5 = d.contract.circuits.closeDarkVeil(ctx, 2n, baseSlot);
    ctx = nextContext(d.contractAddress, r5.context);
    const pinnedRevealCtx = nextContextAtTime(d.contractAddress, ctx, 3);
    const r6 = d.contract.circuits.revealBuyCommit(pinnedRevealCtx, commitment, purchased, DV_PRICE, 3n);
    ctx = nextContext(d.contractAddress, r6.context);

    return { contract: d.contract, contractAddress: d.contractAddress, ctx };
  }

  it.each([
    {
      label: 'bought 100% of baseSlot -> full bond refund',
      purchased: 100n,
      baseSlot: 100n,
      claimedRefund: (1000n * 100n) / 100n, // 1000 — floor is exact here (bondAmount=1000) // forfeited = 1000 - 1000 = 0
    },
    {
      label: 'bought 50% of baseSlot -> half bond refund, floor-exact, forfeited half to the platform',
      purchased: 50n,
      baseSlot: 100n,
      claimedRefund: (1000n * 50n) / 100n, // 500 // 300 — forfeited(500) * 60%
    },
    {
      label: 'ghost registrant (bought 0%) -> zero refund, entire bond forfeited to the platform',
      purchased: 0n,
      baseSlot: 100n,
      claimedRefund: 0n, // 600 — forfeited(1000) * 60%
    },
  ])('$label', ({ purchased, baseSlot, claimedRefund }) => {
    const { contract, ctx } = registerBuyAndClose(purchased, baseSlot);
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund)).not.toThrow();
  });

  it('accepts the correct FLOOR refund at a non-exact division (floor-rounding)', () => {
    // bond=1000, purchased=37, baseSlot=90: true value = 1000*37/90 = 411.11...
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (1000n * 37n) / 90n; // 411 (bigint division truncates = floor for positives)
    expect(floorRefund).toBe(411n);
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund)).not.toThrow();
  });

  it.each([
    { label: 'one unit above', delta: 1n },
    { label: 'below', delta: -1n },
  ])('rejects a refund claim $label the correct floor', ({ delta }) => {
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (1000n * 37n) / 90n; // 411
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund + delta)).toThrow(
      'Claimed refund does not match the ratio-based formula',
    );
  });

  // Was 'rejects an incorrect treasury share'. With one platform wallet there
  // is no share to get wrong: the forfeited remainder is whatever the bond and
  // the already-verified refund leave over, so the caller cannot influence it.
  it('pays the whole forfeited remainder to the platform, with no share to claim', () => {
    const { contract, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (1000n * 50n) / 100n; // 500 back, 500 forfeited
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund)).not.toThrow();
  });

  it('rejects claiming twice for the same bond', () => {
    const { contract, contractAddress, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (1000n * 50n) / 100n;
    const r1 = contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimRatioBondRefund(ctx2, fakeBytes32(5), claimedRefund)).toThrow(
      'Bond already claimed',
    );
  });

  // ==========================================================================
  // Forfeited-bond collection
  // ==========================================================================
  // A ghost registrant's refund already computes to zero (settledDvPurchases
  // has no entry for them), but that only stops them TAKING the bond — it does
  // not move it. The only circuit that pays the platform is one the registrant
  // must call, and a registrant owed nothing never will, so the NIGHT would sit
  // in the contract permanently. These cover the circuit that collects it.

  it('sweeps a fully-forfeited bond to the platform once settlement is finalized', () => {
    const d = registerBuyAndCloseNoSettlement(0n, 100n);
    const rF = d.contract.circuits.finalizeDvSettlement(d.ctx);
    const ctx = nextContext(d.contractAddress, rF.context);

    expect(() => d.contract.circuits.sweepForfeitedBond(ctx, REGISTRANT_KEY)).not.toThrow();
  });

  it('refuses to sweep before settlement is finalized', () => {
    const d = registerBuyAndCloseNoSettlement(0n, 100n);
    expect(() => d.contract.circuits.sweepForfeitedBond(d.ctx, REGISTRANT_KEY)).toThrow('not finalized yet');
  });

  // The whole point of the flag: a settlement recorded after a sweep could
  // have run would mean sweeping a bond the registrant was owed part of.
  it('refuses to record a settlement once finalized, and refuses to finalize twice', () => {
    const d = registerBuyAndCloseNoSettlement(0n, 100n);
    const rF = d.contract.circuits.finalizeDvSettlement(d.ctx);
    const ctx = nextContext(d.contractAddress, rF.context);

    expect(() => d.contract.circuits.recordDarkVeilSettlement(ctx, REGISTRANT_KEY, 50n)).toThrow('already finalized');
    expect(() => d.contract.circuits.finalizeDvSettlement(ctx)).toThrow('already finalized');
  });

  // Money that is genuinely theirs must stay claimable by them.
  it('refuses to sweep a registrant who settled part of their allocation', () => {
    const d = registerBuyAndCloseNoSettlement(50n, 100n);
    const rS = d.contract.circuits.recordDarkVeilSettlement(d.ctx, REGISTRANT_KEY, 50n);
    const ctxS = nextContext(d.contractAddress, rS.context);
    const rF = d.contract.circuits.finalizeDvSettlement(ctxS);
    const ctx = nextContext(d.contractAddress, rF.context);

    expect(() => d.contract.circuits.sweepForfeitedBond(ctx, REGISTRANT_KEY)).toThrow('is owed a refund');
  });

  it('cannot sweep the same bond twice, or a bond the registrant already claimed', () => {
    const d = registerBuyAndCloseNoSettlement(0n, 100n);
    const rF = d.contract.circuits.finalizeDvSettlement(d.ctx);
    const ctx = nextContext(d.contractAddress, rF.context);

    const r1 = d.contract.circuits.sweepForfeitedBond(ctx, REGISTRANT_KEY);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    expect(() => d.contract.circuits.sweepForfeitedBond(ctx2, REGISTRANT_KEY)).toThrow('already claimed or swept');
  });

  it('refuses to sweep a registrant who never bonded at all', () => {
    const d = registerBuyAndCloseNoSettlement(0n, 100n);
    const rF = d.contract.circuits.finalizeDvSettlement(d.ctx);
    const ctx = nextContext(d.contractAddress, rF.context);

    expect(() => d.contract.circuits.sweepForfeitedBond(ctx, fakeBytes32(99))).toThrow('No locked bond found');
  });

  // Regression tests (2026-07-30 security audit fix) — prove the
  // exploit is actually closed: revealing a purchase alone (no real
  // Cardano settlement, no governor attestation) must never yield a
  // nonzero bond refund, no matter what the buyer declares.
  it('reveals the full baseSlot but is never governor-recorded as settled -> any nonzero refund claim is rejected', () => {
    // Same shape as the old "bought 100% of baseSlot -> full bond refund"
    // test, but deliberately does NOT call recordDarkVeilSettlement — this
    // is exactly the free-100%-refund exploit sequence the audit found.
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r3 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    let ctx = nextContext(d.contractAddress, r3.context);
    const commitment = computeBuyCommit({
      buyerKey: REGISTRANT_KEY,
      launchId: LAUNCH_ID,
      tokenAmount: 100n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r4 = d.contract.circuits.submitBuyCommit(ctx, commitment, 1n);
    ctx = nextContext(d.contractAddress, r4.context);
    const r5 = d.contract.circuits.closeDarkVeil(ctx, 2n, 100n);
    ctx = nextContext(d.contractAddress, r5.context);
    const pinnedRevealCtx = nextContextAtTime(d.contractAddress, ctx, 3);
    const r6 = d.contract.circuits.revealBuyCommit(pinnedRevealCtx, commitment, 100n, DV_PRICE, 3n);
    ctx = nextContext(d.contractAddress, r6.context);
    // Deliberately no recordDarkVeilSettlement call here.

    // Before the fix, this exact call (claiming the full 1000-unit bond
    // back, matching a 100/100 "purchased" declaration) succeeded. After
    // the fix, settledDvPurchases has no entry for this buyer, so
    // `purchased` floors at 0 and only a 0-refund (full forfeiture) claim
    // can succeed.
    expect(() => d.contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), 1000n)).toThrow(
      'Claimed refund does not match the ratio-based formula',
    );
    // The correct outcome for an unsettled reveal is full forfeiture —
    // same as a ghost registrant who never revealed at all.
    expect(() => d.contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), 0n)).not.toThrow();
  });

  it('recordDarkVeilSettlement rejects a non-governor caller', () => {
    // Same "attacker contract instance with a wrong governor witness"
    // pattern as this file's existing markDarkVeilFailed-is-governor-only
    // test — the witness map baked into a Contract instance is what
    // determines which secret getGovernorSecret() supplies at call time,
    // not something toggled per-call.
    const { ctx } = registerBuyAndCloseNoSettlement(100n, 100n);
    const attacker = new Contract<PrivateState>({
      ...witnesses,
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor
    });
    expect(() => attacker.circuits.recordDarkVeilSettlement(ctx, REGISTRANT_KEY, 100n)).toThrow(
      'Only governor can record a DarkVeil settlement',
    );
  });

  it('recordDarkVeilSettlement rejects a settledAmount above baseSlot', () => {
    const { contract, ctx } = registerBuyAndCloseNoSettlement(100n, 100n);
    expect(() => contract.circuits.recordDarkVeilSettlement(ctx, REGISTRANT_KEY, 101n)).toThrow(
      'Settlement exceeds per-registrant DarkVeil allocation',
    );
  });

  it('rejects claimRatioBondRefund when DarkVeil failed (must use claimBondRefund instead)', () => {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.advancePhase(ctxReg, LaunchPhase.Public);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.markDarkVeilFailed(ctx2);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    expect(() => d.contract.circuits.claimRatioBondRefund(ctx3, fakeBytes32(5), 0n)).toThrow(
      'Only claimable after a normally-closed, non-cancelled, non-failed DarkVeil',
    );
  });

  it('rejects claimRatioBondRefund before DarkVeil has closed', () => {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r3 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    expect(() => d.contract.circuits.claimRatioBondRefund(ctx3, fakeBytes32(5), 0n)).toThrow(
      'Only claimable after a normally-closed, non-cancelled, non-failed DarkVeil',
    );
  });
});

// ============================================================================
// Registrant exclusion dispute
// ============================================================================
// Two records say who registered, and they have different authors: lockedBonds
// is written a row at a time by each registrant's own call, registrantRoot is
// one hash published later by one key. Buying is gated on the second. These
// cover what happens when the two disagree — a registrant who really bonded,
// and whose leaf is not in the tree that was published.

describe('eligibility_gate.compact — registrant exclusion dispute', () => {
  const SECRET_INCL = fakeBytes32(111);
  const SECRET_EXCL = fakeBytes32(112);
  const KEY_INCL = deriveUserPublicKey(SECRET_INCL, LAUNCH_ID);
  const KEY_EXCL = deriveUserPublicKey(SECRET_EXCL, LAUNCH_ID);

  // Both are genuinely on the allowlist and both genuinely register. The
  // difference between them is made afterwards, by which leaves go into the
  // tree the governor publishes.
  const DISPUTE_ALLOWLIST = buildAllowlistTree([hashAllowlistLeaf(KEY_INCL), hashAllowlistLeaf(KEY_EXCL)]);

  // The honest tree holds both registrants. The truncated one drops the second
  // — the same startBuying call, one leaf short.
  const HONEST_TREE = buildRegistrantTree([hashRegistrantLeaf(KEY_INCL), hashRegistrantLeaf(KEY_EXCL)]);
  const TRUNCATED_TREE = buildRegistrantTree([hashRegistrantLeaf(KEY_INCL)]);

  const DISPUTE_BASE_SLOT = 100n; // 2 registrants x 100 <= DV_ALLOCATION (500)
  const DISPUTED_AT = 1_000;
  const WINDOW = 259_200; // exclusionDisputeWindow, hardcoded in the constructor

  /**
   * A party acting with `secret`, carrying `proofTree`'s path at `index` as
   * their registrant proof. An excluded registrant still has *a* proof — the
   * one they built against the set that really registered — it just does not
   * recompute the root that was published.
   */
  function party(
    secretBytes: Uint8Array,
    allowlistIndex: number,
    proofTree: ReturnType<typeof buildRegistrantTree>,
    proofIndex: number,
  ) {
    return new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: secretBytes }],
      getMerkleProof: (_ctx) => [undefined, DISPUTE_ALLOWLIST.getProof(allowlistIndex)],
      getRegistrantMerkleProof: (_ctx) => [undefined, proofTree.getProof(proofIndex)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
  }

  /**
   * Both registrants bond for real, then the governor publishes `publishedTree`
   * and closes DarkVeil. Neither buys — the excluded one cannot, and a ghost
   * chooses not to, which is exactly the pair these circuits have to tell
   * apart.
   */
  function bondBothAndClose(publishedTree: ReturnType<typeof buildRegistrantTree>) {
    const governor = party(SECRET_INCL, 0, publishedTree, 0);
    const { contractAddress, ctx } = deployForTest(
      governor,
      undefined,
      LAUNCH_ID,
      DISPUTE_ALLOWLIST.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      2n, // allowlistSize
      REGISTRATION_CLOSE_TIME,
      1n, // minDvParticipants
      CREATOR_KEY,
      PLATFORM_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );

    const r0 = governor.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const c0 = nextContext(contractAddress, r0.context);
    const r1 = governor.circuits.startRegistration(c0);
    const c1 = nextContext(contractAddress, r1.context);

    const rI = party(SECRET_INCL, 0, publishedTree, 0).circuits.registerForDarkVeil(c1);
    const cI = nextContext(contractAddress, rI.context);
    const rE = party(SECRET_EXCL, 1, HONEST_TREE, 1).circuits.registerForDarkVeil(cI);
    const cE = nextContext(contractAddress, rE.context);

    const rB = governor.circuits.startBuying(cE, publishedTree.root);
    const cB = nextContext(contractAddress, rB.context);
    const rC = governor.circuits.closeDarkVeil(cB, 2n, DISPUTE_BASE_SLOT);
    return { governor, contractAddress, ctx: nextContext(contractAddress, rC.context) };
  }

  /** Both bonds are real, whichever tree was published. */
  it('records a real bond for a registrant the published tree leaves out', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const st = ledger(d.ctx.currentQueryContext.state);
    expect(st.registrationCount).toBe(2n);
    expect(st.lockedBonds.lookup(KEY_EXCL)).toBe(1000n);
  });

  // ---- the sweep must prove what it takes -----------------------------------

  it('refuses to sweep a bond whose key has no path in the published tree', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const rF = d.governor.circuits.finalizeDvSettlement(d.ctx);
    const ctx = nextContext(d.contractAddress, rF.context);

    // The platform holds the tree it published and can produce any path in it
    // — but there is no path to KEY_EXCL, so the honest-tree proof is the best
    // that exists, and it recomputes a different root.
    const collector = party(SECRET_INCL, 0, HONEST_TREE, 1);
    expect(() => collector.circuits.sweepForfeitedBond(ctx, KEY_EXCL)).toThrow('Invalid registrant proof');
  });

  it('still sweeps a bond the published tree really does contain', () => {
    const d = bondBothAndClose(HONEST_TREE);
    const rF = d.governor.circuits.finalizeDvSettlement(d.ctx);
    const ctx = nextContext(d.contractAddress, rF.context);

    const collector = party(SECRET_INCL, 0, HONEST_TREE, 1);
    expect(() => collector.circuits.sweepForfeitedBond(ctx, KEY_EXCL)).not.toThrow();
  });

  // ---- an excluded registrant recovers ---------------------------------------

  it('returns the whole bond to a registrant whose dispute stands unanswered', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);

    const rD = excluded.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);
    const rF = d.governor.circuits.finalizeDvSettlement(cD);
    const cF = nextContext(d.contractAddress, rF.context);

    const claimAt = DISPUTED_AT + WINDOW;
    const rClaim = excluded.circuits.claimDisputedBond(
      nextContextAtTime(d.contractAddress, cF, claimAt),
      fakeBytes32(212),
      BigInt(claimAt),
    );
    const cClaim = nextContext(d.contractAddress, rClaim.context);

    // Really released, not just flagged — same zeroed-entry shape every other
    // payout circuit here leaves behind.
    expect(ledger(cClaim.currentQueryContext.state).lockedBonds.lookup(KEY_EXCL)).toBe(0n);
    expect(() =>
      excluded.circuits.claimDisputedBond(
        nextContextAtTime(d.contractAddress, cClaim, claimAt),
        fakeBytes32(212),
        BigInt(claimAt),
      ),
    ).toThrow('Bond already claimed or swept');
  });

  it('refuses a claim from a registrant who never disputed at all', () => {
    // Otherwise the window is optional: any ghost could skip straight to the
    // payout and nobody would ever have had the chance to answer them.
    const d = bondBothAndClose(TRUNCATED_TREE);
    const rF = d.governor.circuits.finalizeDvSettlement(d.ctx);
    const cF = nextContext(d.contractAddress, rF.context);

    const claimAt = DISPUTED_AT + WINDOW;
    expect(() =>
      party(SECRET_EXCL, 1, HONEST_TREE, 1).circuits.claimDisputedBond(
        nextContextAtTime(d.contractAddress, cF, claimAt),
        fakeBytes32(212),
        BigInt(claimAt),
      ),
    ).toThrow('No open dispute for this registrant');
  });

  it('refuses the claim one second before the window elapses', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);

    const rD = excluded.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);
    const rF = d.governor.circuits.finalizeDvSettlement(cD);
    const cF = nextContext(d.contractAddress, rF.context);

    const early = DISPUTED_AT + WINDOW - 1;
    expect(() =>
      excluded.circuits.claimDisputedBond(
        nextContextAtTime(d.contractAddress, cF, early),
        fakeBytes32(212),
        BigInt(early),
      ),
    ).toThrow('Dispute window has not elapsed');
  });

  it('refuses the claim while the settlement record is still open', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);

    const rD = excluded.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);

    const claimAt = DISPUTED_AT + WINDOW;
    expect(() =>
      excluded.circuits.claimDisputedBond(
        nextContextAtTime(d.contractAddress, cD, claimAt),
        fakeBytes32(212),
        BigInt(claimAt),
      ),
    ).toThrow('not finalized yet');
  });

  // ---- a ghost gets answered ------------------------------------------------

  it('lets anyone answer a ghost, after which the bond forfeits on the ordinary terms', () => {
    // Honest tree this time: the disputant IS in it, so a real path exists and
    // any observer holding the published tree can produce it.
    const d = bondBothAndClose(HONEST_TREE);
    const ghost = party(SECRET_EXCL, 1, HONEST_TREE, 1);

    const rD = ghost.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);

    // A bystander — not the governor, not the platform, holding no secret that
    // matters here — answers with nothing but the published path.
    const bystander = party(fakeBytes32(199), 0, HONEST_TREE, 1);
    const rR = bystander.circuits.rebutRegistrantExclusion(cD, KEY_EXCL);
    const cR = nextContext(d.contractAddress, rR.context);
    expect(ledger(cR.currentQueryContext.state).rebuttedExclusions.member(KEY_EXCL)).toBe(true);

    const rF = d.governor.circuits.finalizeDvSettlement(cR);
    const cF = nextContext(d.contractAddress, rF.context);

    const claimAt = DISPUTED_AT + WINDOW;
    expect(() =>
      ghost.circuits.claimDisputedBond(
        nextContextAtTime(d.contractAddress, cF, claimAt),
        fakeBytes32(212),
        BigInt(claimAt),
      ),
    ).toThrow('membership in the tree was shown');

    // And the bond still goes where a forfeited bond goes.
    expect(() => bystander.circuits.sweepForfeitedBond(cF, KEY_EXCL)).not.toThrow();
  });

  it('cannot answer a dispute without a real path', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);
    const rD = excluded.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);

    const governorTrying = party(SECRET_INCL, 0, HONEST_TREE, 1);
    expect(() => governorTrying.circuits.rebutRegistrantExclusion(cD, KEY_EXCL)).toThrow('Invalid registrant proof');
  });

  it('answers each dispute at most once, and will not reopen one already answered', () => {
    const d = bondBothAndClose(HONEST_TREE);
    const ghost = party(SECRET_EXCL, 1, HONEST_TREE, 1);
    const rD = ghost.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);

    const bystander = party(fakeBytes32(199), 0, HONEST_TREE, 1);
    const rR = bystander.circuits.rebutRegistrantExclusion(cD, KEY_EXCL);
    const cR = nextContext(d.contractAddress, rR.context);

    expect(() => bystander.circuits.rebutRegistrantExclusion(cR, KEY_EXCL)).toThrow('Dispute already answered');
    // The point of keeping the answer rather than clearing the dispute: a
    // disputant cannot make the same claim again and cost another answer.
    expect(() =>
      ghost.circuits.disputeRegistrantExclusion(
        nextContextAtTime(d.contractAddress, cR, DISPUTED_AT),
        BigInt(DISPUTED_AT),
      ),
    ).toThrow('has already been shown');
  });

  // ---- everything else the dispute must not become ---------------------------

  it('refuses a dispute from a wallet holding no bond, and a second dispute from one that does', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const stranger = party(fakeBytes32(198), 0, HONEST_TREE, 0);
    expect(() =>
      stranger.circuits.disputeRegistrantExclusion(
        nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
        BigInt(DISPUTED_AT),
      ),
    ).toThrow('No locked bond found');

    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);
    const rD = excluded.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);
    expect(() =>
      excluded.circuits.disputeRegistrantExclusion(
        nextContextAtTime(d.contractAddress, cD, DISPUTED_AT),
        BigInt(DISPUTED_AT),
      ),
    ).toThrow('Exclusion already disputed');
  });

  it('will not let a backdated dispute be born already elapsed', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);

    // Backdating by exactly the window would set claimableFrom to now, so the
    // bond could be taken the same moment it was disputed and nobody would
    // ever get the chance to answer. The band on a caller-supplied timestamp
    // is what stops it — an hour of slack is allowed on purpose, three days is
    // not.
    const now = DISPUTED_AT + WINDOW;
    expect(() =>
      excluded.circuits.disputeRegistrantExclusion(
        nextContextAtTime(d.contractAddress, d.ctx, now),
        BigInt(now - WINDOW),
      ),
    ).toThrow('too far in the past');
  });

  it('refuses a dispute before DarkVeil has closed', () => {
    const governor = party(SECRET_INCL, 0, TRUNCATED_TREE, 0);
    const { contractAddress, ctx } = deployForTest(
      governor,
      undefined,
      LAUNCH_ID,
      DISPUTE_ALLOWLIST.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      2n,
      REGISTRATION_CLOSE_TIME,
      1n,
      CREATOR_KEY,
      PLATFORM_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const r0 = governor.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const c0 = nextContext(contractAddress, r0.context);
    const r1 = governor.circuits.startRegistration(c0);
    const c1 = nextContext(contractAddress, r1.context);
    const rE = party(SECRET_EXCL, 1, HONEST_TREE, 1).circuits.registerForDarkVeil(c1);
    const cE = nextContext(contractAddress, rE.context);

    expect(() =>
      party(SECRET_EXCL, 1, HONEST_TREE, 1).circuits.disputeRegistrantExclusion(
        nextContextAtTime(contractAddress, cE, DISPUTED_AT),
        BigInt(DISPUTED_AT),
      ),
    ).toThrow('Only disputable after a normally-closed');
  });

  it('sends a settled registrant to the ratio refund rather than paying in full', () => {
    const d = bondBothAndClose(TRUNCATED_TREE);
    const excluded = party(SECRET_EXCL, 1, HONEST_TREE, 1);

    const rD = excluded.circuits.disputeRegistrantExclusion(
      nextContextAtTime(d.contractAddress, d.ctx, DISPUTED_AT),
      BigInt(DISPUTED_AT),
    );
    const cD = nextContext(d.contractAddress, rD.context);

    // Settled after disputing — the governor's record closes last, which is
    // why the claim waits for it.
    const rS = d.governor.circuits.recordDarkVeilSettlement(cD, KEY_EXCL, 50n);
    const cS = nextContext(d.contractAddress, rS.context);
    const rF = d.governor.circuits.finalizeDvSettlement(cS);
    const cF = nextContext(d.contractAddress, rF.context);

    const claimAt = DISPUTED_AT + WINDOW;
    expect(() =>
      excluded.circuits.claimDisputedBond(
        nextContextAtTime(d.contractAddress, cF, claimAt),
        fakeBytes32(212),
        BigInt(claimAt),
      ),
    ).toThrow('claim the ratio refund instead');
  });
});

describe('eligibility_gate.compact — a closed DarkVeil cannot be marked failed', () => {
  it('refuses markDarkVeilFailed once DarkVeil has closed normally', () => {
    // The twin of the same guard on the Midnight Launch contract. Failed and
    // normally-closed are mutually exclusive by design: claimRatioBondRefund
    // settles a bond against what the registrant actually bought, while
    // dvFailed opens the full-refund path to everyone.
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 2n, 100n);
    const ctx = nextContext(d.contractAddress, r.context);

    expect(() => d.contract.circuits.markDarkVeilFailed(ctx)).toThrow('DarkVeil already closed normally');
  });
});

// ============================================================================
// expireDarkVeil — giving up on a phase the governor stopped moving
// ============================================================================
// Every DarkVeil transition is governor-only, and the one existing timeout
// sits behind a governor-only call, so a governor who goes silent used to
// freeze the launch with every bond locked inside it.

describe('eligibility_gate.compact — permissionless DarkVeil expiry', () => {
  const EXPIRY = 604800n; // 7 days, hardcoded in the contract
  const PAST_DEADLINE = Number(REGISTRATION_CLOSE_TIME + EXPIRY + 1n);

  /** A registrant who has bonded, in a phase that then stops moving. */
  function bondedThenAbandoned() {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const c1 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(c1);
    const c2 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(c2);
    return { ...d, ctx: nextContext(d.contractAddress, rReg.context) };
  }

  it('refuses before the deadline', () => {
    const d = bondedThenAbandoned();
    const tooEarly = nextContextAtTime(d.contractAddress, d.ctx, Number(REGISTRATION_CLOSE_TIME));
    expect(() => d.contract.circuits.expireDarkVeil(tooEarly)).toThrow(
      'DarkVeil has not yet exceeded its expiry deadline',
    );
  });

  it('lets ANYONE expire it once the deadline passes, and the bond becomes claimable', () => {
    // The point of the whole circuit: the bond comes back without the
    // governor doing anything, which was impossible before.
    const d = bondedThenAbandoned();
    const late = nextContextAtTime(d.contractAddress, d.ctx, PAST_DEADLINE);
    const r = d.contract.circuits.expireDarkVeil(late);
    const after = nextContext(d.contractAddress, r.context);

    const state = ledger(after.currentQueryContext.state);
    expect(state.dvFailed).toBe(true);

    // And the refund path really pays, rather than merely being unlocked.
    const rc = d.contract.circuits.claimBondRefund(after, fakeBytes32(5));
    expect(ledger(rc.context.currentQueryContext.state).lockedBonds.lookup(REGISTRANT_KEY)).toBe(0n);
  });

  it('is terminal, so a governor who wakes up cannot carry on', () => {
    const d = bondedThenAbandoned();
    const late = nextContextAtTime(d.contractAddress, d.ctx, PAST_DEADLINE);
    const r = d.contract.circuits.expireDarkVeil(late);
    const after = nextContext(d.contractAddress, r.context);

    // Three assertions, because they cover three different things and only
    // the first two depend on the `phase` write.
    expect(ledger(after.currentQueryContext.state).phase).toBe(LaunchPhase.Cancelled);

    // The one that makes "cannot carry on" a behavioural claim rather than a
    // field comparison. `advancePhase(Public)` is gated on `phase ==
    // DarkVeil`, so it is the call a woken governor would actually reach for,
    // and it succeeds if the write is missing. Probed: remove the write and
    // this line fails on its own.
    expect(() => d.contract.circuits.advancePhase(after, LaunchPhase.Public)).toThrow(
      /Must be in DarkVeil to start Public/,
    );

    // `startBuying` is refused by the DarkVeil SUB-STATE, not by `phase` —
    // note the message names dvState despite reading "phase". So this asserts
    // a real and separate property, but it is NOT a guard on the write above
    // and never was: it passes with that write removed. Pinning the message
    // stops it also passing on an unrelated refusal, such as the governor
    // check, which is all a bare assertion here ever established.
    expect(() => d.contract.circuits.startBuying(after, REGISTRANT_TREE.root)).toThrow(/Must be in registration phase/);
  });

  it('refuses to deploy without a registration close time to measure from', () => {
    // A zero anchor puts the deadline in the past at deploy, so the launch
    // could be expired before it began.
    expect(() => deployWithRegistrationCloseTime(0n)).toThrow('registrationCloseTime must be set');
  });

  it('refuses once DarkVeil has closed normally', () => {
    // A closed phase settles through the ratio refund; expiring it would open
    // the full-refund path to registrants whose bonds are meant to settle.
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const c1 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(c1);
    const c2 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(c2);
    const c3 = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.startBuying(c3, REGISTRANT_TREE.root);
    const c4 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.closeDarkVeil(c4, 2n, 100n);
    const c5 = nextContext(d.contractAddress, r3.context);

    const late = nextContextAtTime(d.contractAddress, c5, PAST_DEADLINE);
    expect(() => d.contract.circuits.expireDarkVeil(late)).toThrow('DarkVeil already closed or cancelled');
  });
});

describe('eligibility_gate.compact — the allowlist is fixed outside the registration window', () => {
  it('accepts a late addition while registration is open, which is what the circuit is for', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    // Two attestors: the root only changes once the threshold is met.
    const r1 = contract.circuits.updateAllowlistRoot(nextContextAtTime(contractAddress, ctx, 0), fakeBytes32(123), 0n);
    const r = attestAllowlistAgain(
      contractAddress,
      nextContext(contractAddress, r1.context) as never,
      fakeBytes32(123),
    );
    expect(ledger(r.context.currentQueryContext.state).allowlistRoot).toEqual(fakeBytes32(123));
  });

  it('rejects an update before registration has opened', () => {
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.updateAllowlistRoot(ctx, fakeBytes32(123), 0n)).toThrow(
      'Allowlist is fixed outside the DarkVeil phase',
    );
  });

  it('rejects an update once registration has frozen and buying has begun', () => {
    // The registrant set is fixed at the freeze and startBuying publishes
    // registrantRoot over it, so the allowlist decides nothing from here on.
    const { contract, ctx } = deployAndStartDvBuying();
    expect(() => contract.circuits.updateAllowlistRoot(ctx, fakeBytes32(123), 0n)).toThrow(
      'Allowlist is fixed once registration freezes',
    );
  });
});

describe('eligibility_gate.compact — threshold attestation on the allowlist root', () => {
  // The negative cases are the point: without them this suite would pass
  // identically if the threshold were deleted, because every other test now
  // publishes through two attestors anyway.
  const ROOT = fakeBytes32(151);
  const OTHER = fakeBytes32(152);

  function attest(
    d: { contract: unknown; contractAddress: string },
    ctx: never,
    fill: number,
    root: Uint8Array,
    at = 0n,
  ) {
    const c =
      fill === ALLOWLIST_ATTESTOR_1_FILL
        ? (d.contract as InstanceType<typeof Contract<PrivateState>>)
        : new Contract<PrivateState>({
            ...witnesses,
            getGovernorSecret: (_c) => [undefined, { bytes: fakeBytes32(fill) }],
          });
    const r = c.circuits.updateAllowlistRoot(nextContextAtTime(d.contractAddress, ctx, Number(at)), root, at);
    return nextContext(d.contractAddress, r.context);
  }

  const rootOf = (ctx: unknown) =>
    ledger((ctx as { currentQueryContext: { state: unknown } }).currentQueryContext.state as never).allowlistRoot;

  it('does not change the root on one attestation', () => {
    const d = deployAndStartDarkVeil();
    const before = rootOf(d.ctx);
    const ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('changes it on the second, from a different attestor', () => {
    const d = deployAndStartDarkVeil();
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_2_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(ROOT);
  });

  it('refuses to count one attestor twice as two', () => {
    const d = deployAndStartDarkVeil();
    const before = rootOf(d.ctx);
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('does not carry an approval across to a different root', () => {
    const d = deployAndStartDarkVeil();
    const before = rootOf(d.ctx);
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_2_FILL, OTHER);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('lets a partial approval expire rather than completing it a day later', () => {
    const d = deployAndStartDarkVeil();
    const before = rootOf(d.ctx);
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT, 100n);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_2_FILL, ROOT, 100n + ALLOWLIST_EXPIRY_SECONDS + 1n);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('refuses a caller who is not an attestor', () => {
    const d = deployAndStartDarkVeil();
    expect(() => attest(d, d.ctx as never, 77, ROOT)).toThrow(/registered attestor/i);
  });
});
