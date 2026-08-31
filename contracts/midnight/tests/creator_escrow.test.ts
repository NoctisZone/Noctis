import { describe, expect, it } from 'vitest';
import { hashDomainKey } from '../../../packages/zk-proofs/src/compact-types.js';
import { Contract, Currency, EscrowState, ledger, type Witnesses } from '../compiled/creator_escrow/contract/index.js';
import { deployForTest, fakeBytes32, nextContext, nextContextAtTime } from './helpers.js';

/** creator_escrow.compact:88 — `deriveCommunityKey`. */
function deriveCommunityKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:escrow:community:pk:v1', secretKeyBytes);
}

type PrivateState = undefined;

const witnesses: Witnesses<PrivateState> = {
  getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
  getCommunitySecret: (_ctx) => [undefined, { bytes: fakeBytes32(4) }],
};

function deploy(currency: Currency = Currency.Ada) {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(contract, undefined, fakeBytes32(9), currency);
  return { contract, init, contractAddress, ctx };
}

// Fix (2026-07-21): closeEscrowAtGraduation/claimFees/
// claimByCommunity/checkCreatorSilence now bind their currentTimestamp/
// graduationTimestamp arguments to real chain time (blockTimeGte/
// blockTimeLte, same idiom as lp_escrow.compact's sealLock) — every call
// site below now pins the simulator's block time via nextContextAtTime to
// match, same pattern lp_escrow.test.ts/cto_governance.test.ts already use.
function deployAndClose(graduationTimestamp = 500n) {
  const d = deploy();
  const r1 = d.contract.circuits.depositFees(d.ctx, 10_000n);
  const ctx1 = nextContext(d.contractAddress, r1.context);
  const pinnedCtx1 = nextContextAtTime(d.contractAddress, ctx1, Number(graduationTimestamp));
  const r2 = d.contract.circuits.closeEscrowAtGraduation(pinnedCtx1, graduationTimestamp);
  const ctx = nextContext(d.contractAddress, r2.context);
  return { ...d, ctx };
}

describe('creator_escrow.compact — pure fee accrual, no vesting curve (split regression)', () => {
  it('accrues fees via depositFees while Active, with no day-based curve applied', () => {
    // The old merged contract applied a vesting-curve check to this same
    // value; this contract has no such check at all — depositFees just
    // accumulates, unconditionally, while Active.
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 1000n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 2500n);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.escrowAmount).toBe(3500n);
  });

  it('rejects claimFees before the escrow is closed at graduation', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 1000n);
    const pinnedCtx = nextContextAtTime(contractAddress, r1.context, 1);
    expect(() => contract.circuits.claimFees(pinnedCtx, 500n, 1n, fakeBytes32(5))).toThrow(
      'Escrow not closed yet — wait for graduation',
    );
  });

  it('closeEscrowAtGraduation fixes the balance and unlocks claiming', () => {
    const { ctx } = deployAndClose(); // deposited 10,000, closed at t=500
    const state = ledger(ctx.currentQueryContext.state);
    expect(state.escrowState).toBe(EscrowState.Closed);
    expect(state.escrowAmount).toBe(10_000n);
    expect(state.lastClaimTimestamp).toBe(500n);
  });

  it('allows the creator to claim up to the closed balance, any amount, no vesting schedule', () => {
    const { contract, contractAddress, ctx } = deployAndClose();
    // Unlike vesting.compact, there is no elapsed-time formula here at all
    // — claim the full balance immediately after closing.
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, 501);
    const result = contract.circuits.claimFees(pinnedCtx, 10_000n, 501n, fakeBytes32(5));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.claimedAmount).toBe(10_000n);
    expect(state.escrowState).toBe(EscrowState.FullyClaimed);
  });

  it('rejects a claim exceeding the closed balance', () => {
    const { contract, contractAddress, ctx } = deployAndClose();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, 501);
    expect(() => contract.circuits.claimFees(pinnedCtx, 10_001n, 501n, fakeBytes32(5))).toThrow(
      'Claim exceeds escrow balance',
    );
  });

  it('rejects a claim from anyone but the creator', () => {
    const otherWitnesses: Witnesses<PrivateState> = {
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // not the deployer's creator key
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getCommunitySecret: (_ctx) => [undefined, { bytes: fakeBytes32(4) }],
    };
    const attackerContract = new Contract<PrivateState>(otherWitnesses);
    const { contractAddress, ctx } = deployAndClose();
    // Reuse the legitimately-deployed ctx but call through a contract
    // instance whose witness returns a different creator secret.
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, 501);
    expect(() => attackerContract.circuits.claimFees(pinnedCtx, 1000n, 501n, fakeBytes32(5))).toThrow(
      'Only creator can claim',
    );
  });

  it('regression: a Night-currency claim pays out via sendUnshielded (does not throw locally)', () => {
    // Design requirement: claimFees must never only decrement
    // claimedAmount with a comment deferring to "the Zswap layer" — a
    // mechanism that doesn't exist. Now pays out for real via
    // sendUnshielded when currency == Night. Same simulator caveat as
    // every other sendUnshielded test in this suite (see the payment-enforcement tests
    // below): proves the call is wired in, not verified end-to-end.
    const d = deploy(Currency.Night);
    const r1 = d.contract.circuits.depositFees(d.ctx, 10_000n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, ctx1, 500);
    const r2 = d.contract.circuits.closeEscrowAtGraduation(pinnedCtx1, 500n);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, 501);

    expect(() => d.contract.circuits.claimFees(pinnedCtx2, 10_000n, 501n, fakeBytes32(5))).not.toThrow();
  });

  it('Phase 5 hygiene fix: claimFees rejects an empty (all-zero) recipient address', () => {
    const d = deploy(Currency.Night);
    const r1 = d.contract.circuits.depositFees(d.ctx, 10_000n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, ctx1, 500);
    const r2 = d.contract.circuits.closeEscrowAtGraduation(pinnedCtx1, 500n);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, 501);

    expect(() => d.contract.circuits.claimFees(pinnedCtx2, 10_000n, 501n, fakeBytes32(0))).toThrow(
      'Recipient address cannot be empty',
    );
  });

  it('Phase 5 hygiene fix: triggerCTO rejects an empty (all-zero) community wallet address', () => {
    const { contract, ctx } = deployAndClose();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(210), fakeBytes32(0))).toThrow(
      'Community wallet address cannot be empty',
    );
  });

  it('CTO trigger redirects new deposits to the post-CTO accumulator', () => {
    const { contract, contractAddress, ctx } = deployAndClose();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(211), fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, rTrigger.context);

    // depositFees still works post-CTO, but routes to postCtoFees instead
    // of escrowAmount
    const rDeposit = contract.circuits.depositFees(ctx2, 2000n);
    const state = ledger(rDeposit.context.currentQueryContext.state);
    expect(state.postCtoFees).toBe(2000n);
    expect(state.escrowAmount).toBe(10_000n); // unchanged
  });

  it("rejects a community claim when the caller's derived key does not match the stored community wallet", () => {
    // The community wallet stored by triggerCTO must be a pre-derived key
    // (deriveCommunityKey(secret)) supplied by the caller, not a raw
    // address — claimByCommunity/claimRemainingEscrowByCommunity re-derive
    // the key from getCommunitySecret() and compare. Passing an arbitrary
    // raw value (as this test does) proves the check is live: an attacker
    // can't just claim by trying an address, they need the actual secret
    // whose derived key matches what was stored.
    const { contract, contractAddress, ctx } = deployAndClose();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(212), fakeBytes32(4)); // not a real derived key
    const ctx2 = nextContext(contractAddress, rTrigger.context);
    const pinnedCtx2 = nextContextAtTime(contractAddress, ctx2, 501);

    expect(() => contract.circuits.claimRemainingEscrowByCommunity(pinnedCtx2, 10_000n, 501n, fakeBytes32(5))).toThrow(
      'Only community wallet can claim',
    );
  });

  it('claimByCommunity pays out accumulated post-CTO fees to the correct community wallet holder', () => {
    // Testing-gap fix: claimByCommunity had zero test coverage of any kind
    // before this pass, stale signature or not.
    const { contract, contractAddress, ctx } = deployAndClose();
    // triggerCTO's communityWalletAddr param must be the REAL derived key
    // (deriveCommunityKey(secret)) — this file's witnesses use
    // fakeBytes32(4) as the community secret, so claimByCommunity's
    // internal re-derivation only matches if triggerCTO was seeded with
    // that same secret's derived key, not the raw secret bytes.
    const communityKey = deriveCommunityKey(fakeBytes32(4));
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(213), communityKey);
    const ctx2 = nextContext(contractAddress, rTrigger.context);
    const rDeposit = contract.circuits.depositFees(ctx2, 2000n);
    const ctx3 = nextContext(contractAddress, rDeposit.context);
    const pinnedCtx3 = nextContextAtTime(contractAddress, ctx3, 501);

    expect(() => contract.circuits.claimByCommunity(pinnedCtx3, 2000n, 501n, fakeBytes32(5))).not.toThrow();
  });

  it('Fix (2026-07-21, Medium): dissolveCTO sweeps unclaimed post-CTO fees back into creator-claimable escrowAmount', () => {
    // Before the fix, postCtoFees deposited during a CTO window but never
    // claimed by the community became permanently stranded once
    // dissolveCTO fired — claimByCommunity/claimRemainingEscrowByCommunity
    // both require ctoTriggered == true, and claimFees (creator-side) never
    // read postCtoFees at all.
    const { contract, contractAddress, ctx } = deployAndClose(); // escrowAmount = 10,000
    const communityKey = deriveCommunityKey(fakeBytes32(4));
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(214), communityKey);
    const ctx2 = nextContext(contractAddress, rTrigger.context);
    const rDeposit = contract.circuits.depositFees(ctx2, 2000n); // -> postCtoFees, unclaimed
    const ctx3 = nextContext(contractAddress, rDeposit.context);

    const rDissolve = contract.circuits.dissolveCTO(ctx3, fakeBytes32(215));
    const state = ledger(rDissolve.context.currentQueryContext.state);
    expect(state.escrowAmount).toBe(12_000n); // 10,000 original + 2,000 swept back
    expect(state.postCtoFees).toBe(0n); // communityClaimedAmount was 0

    // The creator can now claim the swept amount through the normal path.
    const pinnedCtx = nextContextAtTime(contractAddress, rDissolve.context, 600);
    const rClaim = contract.circuits.claimFees(pinnedCtx, 12_000n, 600n, fakeBytes32(5));
    expect(ledger(rClaim.context.currentQueryContext.state).claimedAmount).toBe(12_000n);
  });

  it('Fix (2026-07-21, Medium): rejects depositFees once the escrow is in a terminal state (FullyClaimed)', () => {
    // Before the fix, a deposit after FullyClaimed was silently accepted
    // with no remaining way to ever claim it — a latent fund-lock footgun.
    const { contract, contractAddress, ctx } = deployAndClose();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, 501);
    const rClaim = contract.circuits.claimFees(pinnedCtx, 10_000n, 501n, fakeBytes32(5)); // fully claims
    const ctx2 = nextContext(contractAddress, rClaim.context);
    expect(ledger(ctx2.currentQueryContext.state).escrowState).toBe(EscrowState.FullyClaimed);

    expect(() => contract.circuits.depositFees(ctx2, 1000n)).toThrow(/terminal state/i);
  });

  it('Fix (2026-07-21, Medium): rejects depositFees once the escrow is Cancelled', () => {
    const { contract, contractAddress, ctx } = deploy();
    const rCancel = contract.circuits.cancelLaunch(ctx);
    const ctx2 = nextContext(contractAddress, rCancel.context);
    expect(() => contract.circuits.depositFees(ctx2, 1000n)).toThrow(/terminal state/i);
  });

  it('checkCreatorSilence reflects elapsed time since the last claim/deposit-close', () => {
    const { contract, contractAddress, ctx } = deployAndClose(); // lastClaimTimestamp = 500
    const t1 = 500n + 7_775_999n;
    const pinnedCtx1 = nextContextAtTime(contractAddress, ctx, Number(t1));
    const notSilentYet = contract.circuits.checkCreatorSilence(pinnedCtx1, t1);
    expect(notSilentYet.result).toBe(false);

    const t2 = 500n + 7_776_000n; // exactly 90 days
    const pinnedCtx2 = nextContextAtTime(contractAddress, ctx, Number(t2));
    const silentNow = contract.circuits.checkCreatorSilence(pinnedCtx2, t2);
    expect(silentNow.result).toBe(true);
  });

  it('Fix (2026-07-21): checkCreatorSilence degrades to false instead of aborting when currentTimestamp predates lastClaimTimestamp', () => {
    // Before the fix, a forged-far-future lastClaimTimestamp (or any
    // currentTimestamp <= lastClaimTimestamp) would underflow-abort this
    // circuit for every future caller — a DoS on the community-recovery
    // trust anchor. Now it returns false instead of throwing.
    const { contract, contractAddress, ctx } = deployAndClose(500n);
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, 500);
    const result = contract.circuits.checkCreatorSilence(pinnedCtx, 500n); // == lastClaimTimestamp
    expect(result.result).toBe(false);
  });
});

describe('creator_escrow.compact — payment enforcement', () => {
  it('a Night-currency (Midnight Launch) deposit requires receiveUnshielded and does not throw locally', () => {
    // Same caveat as bonding_curve/eligibility_gate's equivalent tests: the local
    // compact-runtime simulator doesn't model cross-transaction UTXO
    // matching, so this proves the currency-gated call is wired in and
    // doesn't break the deposit flow, not that a missing payment is
    // rejected end-to-end (that's real-node enforcement).
    const { contract, ctx } = deploy(Currency.Night);
    const result = contract.circuits.depositFees(ctx, 5000n);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.escrowAmount).toBe(5000n);
  });

  it('an Ada-currency (Cardano Launch) deposit never calls receiveUnshielded, unchanged behavior', () => {
    const { contract, ctx } = deploy(Currency.Ada);
    const result = contract.circuits.depositFees(ctx, 5000n);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.escrowAmount).toBe(5000n);
  });

  it('fix (2026-07-30): rejects an Ada deposit from a non-governor caller', () => {
    // depositFees's Ada branch had the earlier payment-check gap fixed but never
    // got an access-control gate, unlike treasury.compact's identical Ada
    // branch (fixed 2026-07-21) — any caller could inflate escrowAmount
    // (or postCtoFees, post-CTO) arbitrarily. Mirrors treasury.test.ts's
    // own non-governor rejection test for the same class of bug.
    const { ctx } = deploy(Currency.Ada);
    const attacker = new Contract<PrivateState>({
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor
      getCommunitySecret: (_ctx) => [undefined, { bytes: fakeBytes32(4) }],
    });
    expect(() => attacker.circuits.depositFees(ctx, 2000n)).toThrow(/governor/i);
  });
});

describe('creator_escrow.compact — cancelLaunch authorization (GitHub #68 fix, 2026-07-14)', () => {
  it('succeeds with governor signature and transitions to Cancelled', () => {
    const { contract, ctx } = deploy();
    const result = contract.circuits.cancelLaunch(ctx);
    expect(ledger(result.context.currentQueryContext.state).escrowState).toBe(EscrowState.Cancelled);
  });

  it('rejects a caller without the governor signature', () => {
    const attacker = new Contract<PrivateState>({
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(66) }],
      getCommunitySecret: (_ctx) => [undefined, { bytes: fakeBytes32(4) }],
    });
    const { ctx } = deploy();
    expect(() => attacker.circuits.cancelLaunch(ctx)).toThrow('Only governor can cancel launch');
  });

  it('rejects cancelling an already-cancelled escrow', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.cancelLaunch(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.cancelLaunch(ctx2)).toThrow('Already cancelled');
  });
});

describe('creator_escrow.compact — a dissolved CTO leaves a claimable escrow', () => {
  /** Graduates with nothing accrued: escrowAmount and claimedAmount both 0. */
  function deployAndCloseEmpty(graduationTimestamp = 500n) {
    const d = deploy();
    const pinned = nextContextAtTime(d.contractAddress, d.ctx, Number(graduationTimestamp));
    const r = d.contract.circuits.closeEscrowAtGraduation(pinned, graduationTimestamp);
    return { ...d, ctx: nextContext(d.contractAddress, r.context) };
  }

  it('returns to Closed even when nothing is claimable at that instant', () => {
    // The transition used to be conditional on there being unclaimed funds,
    // so an escrow holding nothing stayed in CTORedirected — a state
    // claimFees refuses — with no way back. An escrow closing empty is not
    // exotic: neither tier's bonding curve deposits here today, so this is
    // the shape one currently graduates in.
    const { contract, contractAddress, ctx } = deployAndCloseEmpty();
    const communityKey = deriveCommunityKey(fakeBytes32(4));
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(300), communityKey);
    const ctxCto = nextContext(contractAddress, rTrigger.context);

    const rDissolve = contract.circuits.dissolveCTO(ctxCto, fakeBytes32(301));
    expect(ledger(rDissolve.context.currentQueryContext.state).escrowState).toBe(EscrowState.Closed);
  });

  it('a fee arriving after that dissolve is claimable, rather than locked forever', () => {
    // The consequence as the scenario it really is. The escrow does not stop
    // existing when a CTO dissolves: depositFees still accepts, ctoTriggered
    // is false so the fees are the creator's again, and before this fix
    // claimFees refused every one of them for the life of the launch.
    const { contract, contractAddress, ctx } = deployAndCloseEmpty();
    const communityKey = deriveCommunityKey(fakeBytes32(4));
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(302), communityKey);
    const ctxCto = nextContext(contractAddress, rTrigger.context);
    const rDissolve = contract.circuits.dissolveCTO(ctxCto, fakeBytes32(303));
    const ctxDissolved = nextContext(contractAddress, rDissolve.context);

    const rDeposit = contract.circuits.depositFees(ctxDissolved, 4_000n);
    const ctxDeposited = nextContext(contractAddress, rDeposit.context);
    const pinnedLater = nextContextAtTime(contractAddress, ctxDeposited, 700);
    const rSecond = contract.circuits.claimFees(pinnedLater, 4_000n, 700n, fakeBytes32(5));
    expect(ledger(rSecond.context.currentQueryContext.state).claimedAmount).toBe(4_000n);
  });
});
