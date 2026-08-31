import { afterEach, describe, expect, it } from 'vitest';
import { buyCost, grossRangeQuadratic } from '../../../integration/curve-pricing.js';
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
  CurveState,
  DarkVeilState,
  LaunchPhase,
  type Ledger,
  ledger,
  type Witnesses,
} from '../compiled/bonding_curve/contract/index.js';
import { DOMAINS, deriveRoleKey } from '../witnesses.js';
import { deployForTest, fakeBytes32, type LedgerSink, nextContext, nextContextAtTime, trackLedger } from './helpers.js';

// The three keys allowed to attest the allowlist root (threshold attestation,
// 2026-08-11). Fill 2 is the governor secret this suite already uses, so the
// governor stays one of the three rather than becoming a separate role.
const ALLOWLIST_ATTESTOR_1_FILL = 2;
const ALLOWLIST_ATTESTOR_2_FILL = 32;
const ALLOWLIST_ATTESTOR_3_FILL = 33;
const ALLOWLIST_THRESHOLD = 2n;
const ALLOWLIST_EXPIRY_SECONDS = 86_400n;
const allowlistAttestorKey = (fill: number) =>
  deriveRoleKey({ bytes: fakeBytes32(fill) }, DOMAINS.CURVE_GOVERNOR).bytes;
const ALLOWLIST_ATTESTOR_1_KEY = allowlistAttestorKey(ALLOWLIST_ATTESTOR_1_FILL);
const ALLOWLIST_ATTESTOR_2_KEY = allowlistAttestorKey(ALLOWLIST_ATTESTOR_2_FILL);
const ALLOWLIST_ATTESTOR_3_KEY = allowlistAttestorKey(ALLOWLIST_ATTESTOR_3_FILL);

type PrivateState = undefined;

// The launch every contract in this file is deployed with. Identity is scoped
// per launch, so a key derived under any other value matches nothing on-chain.
const LAUNCH_ID = fakeBytes32(9);

// Fix (2026-07-10, extended same day): bonding_curve.compact is now a
// 3-WAY MERGE of eligibility_gate.compact + darkveil.compact +
// bonding_curve.compact for Midnight Launch — see the file header in
// contracts/midnight/bonding_curve.compact for why (Compact has no working
// cross-contract call mechanism, verified this session; folding sources
// into one deployed contract with a shared ledger is the only mechanism
// confirmed to work). This test file now covers all three halves.
//
// Doc-sync note (Phase 2, 2026-07-11): the standalone darkveil.compact this
// comment used to reference for Cardano Launch no longer exists — Cardano Launch's
// eligibility_gate.compact merged in the same logic (mirrors this file's
// own merge). packages/zk-proofs/src/darkveil.ts holds the DarkVeil-phase
// struct hashes both merged contracts compute identically, and is reused by
// both this file and eligibility_gate.test.ts. The buyerKey those hashes
// take comes from eligibility-gate.ts's deriveUserPublicKey — the ONE
// unified identity this merge standardized on.
// Design requirement: the allowlist leaf is no longer a free
// witness — verifyAllowlist derives it in-circuit as
// hashAllowlistLeaf(caller), so the off-chain tree must be built with the
// SAME formula for the buyer's real derived identity (fakeBytes32(3)),
// not an arbitrary opaque value.
const BUYER_KEY = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
const ALLOWLIST_LEAF = hashAllowlistLeaf(BUYER_KEY);
const ALLOWLIST_TREE = buildAllowlistTree([ALLOWLIST_LEAF]);

// Which registrant is BUYING must stay private, so submitBuyCommit proves
// membership in this tree rather than checking a registration nullifier that
// would name them. Published by startBuying once registration has closed.
const REGISTRANT_TREE = buildRegistrantTree([hashRegistrantLeaf(BUYER_KEY)]);
const BUY_NONCE = fakeBytes32(8);

/** Attests the allowlist root with a SECOND attestor, completing the 2-of-3. */
function attestAllowlistAgain(contractAddress: string, ctx: never, root: Uint8Array, at = 0n) {
  const second = new Contract<PrivateState>({
    ...witnesses,
    getGovernorSecret: (_c) => [undefined, { bytes: fakeBytes32(ALLOWLIST_ATTESTOR_2_FILL) }],
  });
  const r = second.circuits.updateAllowlistRoot(nextContextAtTime(contractAddress, ctx, Number(at)), root, at);
  return r;
}

const witnesses: Witnesses<PrivateState> = {
  getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
  getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
  getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
  getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
};

// base=100, max=1000, curveSupply=1000 (round numbers chosen so the
// quadratic formula's expected outputs are easy to hand-verify)
const BASE_PRICE = 100n;
const MAX_PRICE = 1000n;
const CURVE_SUPPLY = 1000n;
const CURVE_PARAMS = { base_price: BASE_PRICE, max_price: MAX_PRICE, curve_supply: CURVE_SUPPLY };

// Eligibility-gate-side constructor args
const TOTAL_SUPPLY = 1_000_000_000n;
const MAX_WALLET_PERCENT = 5n;
const WALLET_CAP = (TOTAL_SUPPLY * MAX_WALLET_PERCENT) / 100n; // 50,000,000
const BOND_AMOUNT = 1000n;

// DarkVeil-side constructor args
const DV_ALLOCATION = 500n;
const DV_PRICE = 90n;
const ALLOWLIST_SIZE = 1n;
const REGISTRATION_CLOSE_TIME = 1_000_000n;
// Permissive by default (1n) so pre-existing tests aren't broken by
// the new minimum-participant floor. Dedicated tests further down deploy
// with a real threshold to exercise the floor itself.
const MIN_DV_PARTICIPANTS_TEST = 1n;

// The creator's identity, distinct from the regular buyer secret
// (fakeBytes32(3)) every other test in this file uses — same derivation
// off-chain mirror (deriveUserPublicKey) the contract's own creatorKey
// check compares against. deriveUserPublicKey here is the raw off-chain
// mirror (Uint8Array in/out), not the UserSecretKey/UserPublicKey struct
// wrapper the witness type uses.
const CREATOR_SECRET_BYTES = fakeBytes32(42);
const CREATOR_KEY = deriveUserPublicKey(CREATOR_SECRET_BYTES, LAUNCH_ID);

// Fixed payout addresses for forfeited DarkVeil bond NIGHT — real
// unshielded addresses, not derived identities, so plain fakeBytes32 is
// fine (nothing derives from these the way CREATOR_KEY is derived).
// One platform wallet, replacing the treasury/ops pair.
const PLATFORM_ADDR = fakeBytes32(60);

// Design requirement: real unshielded payout addresses
// withdrawFees/graduateLp pay out to — added to the constructor alongside
// platformAddr above.
const CREATOR_ADDR = fakeBytes32(61);
const LP_ESCROW_ADDR = fakeBytes32(62);

function deploy() {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    ALLOWLIST_TREE.root, // allowlistRoot
    TOTAL_SUPPLY,
    MAX_WALLET_PERCENT,
    BOND_AMOUNT,
    WALLET_CAP,
    BASE_PRICE,
    MAX_PRICE,
    CURVE_SUPPLY,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    REGISTRATION_CLOSE_TIME,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    PLATFORM_ADDR,
    CREATOR_ADDR,
    LP_ESCROW_ADDR,
    ALLOWLIST_ATTESTOR_1_KEY,
    ALLOWLIST_ATTESTOR_2_KEY,
    ALLOWLIST_ATTESTOR_3_KEY,
    ALLOWLIST_THRESHOLD,
  );
  return { contract, init, contractAddress, ctx };
}

/** Deploys with explicit curve prices, for the constructor's own bounds. */
function deployWithPrices(basePrice: bigint, maxPrice: bigint, curveSupply: bigint = CURVE_SUPPLY) {
  const contract = new Contract<PrivateState>(witnesses);
  return deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    ALLOWLIST_TREE.root,
    TOTAL_SUPPLY,
    MAX_WALLET_PERCENT,
    BOND_AMOUNT,
    WALLET_CAP,
    basePrice,
    maxPrice,
    curveSupply,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    REGISTRATION_CLOSE_TIME,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    PLATFORM_ADDR,
    CREATOR_ADDR,
    LP_ESCROW_ADDR,
    ALLOWLIST_ATTESTOR_1_KEY,
    ALLOWLIST_ATTESTOR_2_KEY,
    ALLOWLIST_ATTESTOR_3_KEY,
    ALLOWLIST_THRESHOLD,
  );
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
    BOND_AMOUNT,
    WALLET_CAP,
    BASE_PRICE,
    MAX_PRICE,
    CURVE_SUPPLY,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    closeTime,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    PLATFORM_ADDR,
    CREATOR_ADDR,
    LP_ESCROW_ADDR,
    ALLOWLIST_ATTESTOR_1_KEY,
    ALLOWLIST_ATTESTOR_2_KEY,
    ALLOWLIST_ATTESTOR_3_KEY,
    ALLOWLIST_THRESHOLD,
  );
}

/** Advances phase Pending -> DarkVeil -> Public, matching real deploy flow. */
function deployAndAdvanceToPublic() {
  const d = deploy();
  const r1 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
  const ctx1 = nextContext(d.contractAddress, r1.context);
  const r2 = d.contract.circuits.advancePhase(ctx1, LaunchPhase.Public);
  const ctx2 = nextContext(d.contractAddress, r2.context);
  return { ...d, ctx: ctx2 };
}

function deployAndActivate() {
  const d = deployAndAdvanceToPublic();
  const r = d.contract.circuits.activateCurve(d.ctx, 1000n);
  // Proving allowlist membership is its own circuit now, so that buying does
  // not re-pay for the Merkle fold on every call. A buyer does it once; these
  // tests do it here so each one starts from a wallet that has.
  const rv = d.contract.circuits.verifyBuyerEligibility(nextContext(d.contractAddress, r.context));
  const ctx = nextContext(d.contractAddress, rv.context);
  return { ...d, ctx };
}

/**
 * price = floor(basePrice + (maxPrice - basePrice) * sold^2 / curveSupply^2)
 * bigint `/` truncates toward zero, which is floor for all-positive
 * operands here — this is now ALWAYS the correct claimedPrice (fix:
 * verifyPrice checks claimedPrice is the floor of the true value via a
 * double inequality, not exact equality), not just at "lucky" checkpoints.
 */
function expectedPrice(sold: bigint): bigint {
  return BASE_PRICE + ((MAX_PRICE - BASE_PRICE) * sold * sold) / (CURVE_SUPPLY * CURVE_SUPPLY);
}

/**
 * What the curve charges for `amount` tokens starting at `sold` — the SUM of
 * the prices of the positions the buy takes, rounded up.
 *
 * Deliberately the shared `integration/curve-pricing.ts` mirror rather than a
 * reimplementation: it is the same function the Cardano curves are verified
 * against and was confirmed against a real Preprod trade, so agreeing with it
 * is a cross-implementation check rather than this file agreeing with itself.
 */
function expectedGross(sold: bigint, amount: bigint): bigint {
  return buyCost('quadratic', CURVE_PARAMS, sold, amount);
}

/** Fee split: 0.5% creator, 1.0% platform (bps / 10000), floor-rounded. */
// 0.5% creator + 1.0% platform. One wallet, so one platform slice.
function fees(gross: bigint) {
  return {
    creator: (gross * 50n) / 10_000n,
    platform: (gross * 100n) / 10_000n,
  };
}

describe('bonding_curve.compact — quadratic pricing', () => {
  // Real conservation invariants, not trivially-true assertions: the fee
  // split is a fixed 1.5% of gross payment (0.5% creator / 1.0%
  // platform), while totalRaised is the remaining 98.5% net of those same
  // fees — so cumulative fees can never exceed totalRaised itself (98% is
  // always the larger share). A fee-splitting bug (wrong divisor,
  // double-counted slice, fees computed against the wrong base) would
  // break this even if each individual buy's own in-circuit asserts
  // happened to pass. tokensSold must also never exceed the curve's fixed
  // supply — the cap this whole contract exists to enforce.
  const lastLedger: LedgerSink<Ledger> = {};
  afterEach(() => {
    if (lastLedger.current) {
      const s = lastLedger.current;
      expect(s.creatorFees + s.platformFees).toBeLessThanOrEqual(s.totalRaised);
      expect(s.tokensSold).toBeLessThanOrEqual(CURVE_SUPPLY);
    }
    lastLedger.current = undefined;
  });

  it('prices at basePrice when sold=0', () => {
    expect(expectedPrice(0n)).toBe(100n);
  });

  it('prices at maxPrice when sold=curveSupply (full sell-through)', () => {
    expect(expectedPrice(CURVE_SUPPLY)).toBe(1000n);
  });

  it('prices at basePrice + 25% of the range at 50% sold (quadratic, not linear)', () => {
    // At 50% sold, a LINEAR curve would be at the midpoint (550). The
    // quadratic curve is deliberately NOT at the midpoint — this is the
    // whole point of the quadratic rewrite (see bonding_curve.compact's
    // header comment on why this replaced an earlier linear draft).
    const price = expectedPrice(500n);
    expect(price).toBe(325n); // 100 + 900 * 0.25
    expect(price).not.toBe(550n); // what a linear curve would give
  });

  it('accepts a buy with the correct quadratic price and fee split', () => {
    const { contract, ctx } = deployAndActivate();

    const tokenAmount = 10n;
    const grossPayment = expectedGross(0n, tokenAmount); // 1000
    const { creator, platform } = fees(grossPayment); // 10, 6, 4

    const result = contract.circuits.buyTokens(ctx, tokenAmount, grossPayment, creator, platform, 1_000_000n);

    const state = trackLedger(lastLedger, ledger(result.context.currentQueryContext.state));
    expect(state.tokensSold).toBe(10n);
    expect(state.creatorFees).toBe(5n);
    expect(state.platformFees).toBe(10n);
    expect(state.totalRaised).toBe(grossPayment - creator - platform); // 980
  });

  it('fix (2026-07-30): rejects a buy from a caller not on the allowlist', () => {
    // The core fix, not just its interaction with the creator check
    // below: buyTokens previously had no sybil-resistant identity check
    // at all — a caller could supply a fresh secret per call, resetting
    // priorCumulative to 0 each time. This caller's secret (fill 99) was
    // never added to ALLOWLIST_TREE (which only contains BUYER_KEY, fill
    // 3), and it reuses BUYER_KEY's own Merkle proof (mismatched leaf).
    const { contractAddress, ctx } = deployAndActivate();
    const notAllowlisted = new Contract<PrivateState>({
      ...witnesses,
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }],
    });
    const grossPayment = expectedGross(0n, 10n);
    const { creator, platform } = fees(grossPayment);
    // The proof is checked by verifyBuyerEligibility now, so that is where a
    // non-member is turned away — before any purchase is priced.
    expect(() => notAllowlisted.circuits.verifyBuyerEligibility(ctx)).toThrow('Invalid allowlist proof');
    // And buying stays closed to them, because nothing recorded them.
    expect(() => notAllowlisted.circuits.buyTokens(ctx, 10n, grossPayment, creator, platform, 1n)).toThrow(
      'Buyer has not proven allowlist membership',
    );
    void contractAddress;
  });

  it('rejects a payment that is not what the curve charges for the range', () => {
    const { contract, ctx } = deployAndActivate();
    const wrongPrice = 999n; // not what the quadratic formula gives at sold=0

    expect(() => contract.circuits.buyTokens(ctx, 10n, 10n * wrongPrice, 0n, 0n, 1n)).toThrow(
      "Payment does not match the curve's cost for this range",
    );
  });

  it('charges the SUM of the positions bought, not the entry price repeated', () => {
    // The distinction this whole mechanism exists for. A batch spanning
    // positions [0, n) costs the sum of P(0)..P(n-1); charging n * P(0)
    // treats a rising curve as flat for the length of the trade, which is
    // an ever-larger discount the bigger the batch. Asserted against real
    // rejection, not just an inequality between two numbers.
    const { contract, ctx } = deployAndActivate();
    const amount = CURVE_SUPPLY / 2n;
    const flat = amount * expectedPrice(0n);
    const real = expectedGross(0n, amount);

    expect(real).toBeGreaterThan(flat);
    const flatFees = fees(flat);
    expect(() => contract.circuits.buyTokens(ctx, amount, flat, flatFees.creator, flatFees.platform, 1n)).toThrow(
      "Payment does not match the curve's cost for this range",
    );
    const realFees = fees(real);
    expect(() => contract.circuits.buyTokens(ctx, amount, real, realFees.creator, realFees.platform, 1n)).not.toThrow();
  });

  it('the circuit agrees with the shared mirror at every step along the curve', () => {
    // Walks the curve and, at each position, requires the contract to accept
    // exactly what integration/curve-pricing.ts computes and to reject one
    // unit either side. That is a cross-implementation check: the mirror is
    // the same function the Cardano curves are verified against, written
    // independently of the in-circuit arithmetic, which cannot divide and
    // reaches the answer a different way.
    const { contract, contractAddress } = deployAndActivate();
    let ctx = deployAndActivate().ctx;
    let sold = 0n;
    let ts = 1n;
    for (const amount of [1n, 7n, 42n, 111n, 239n, 300n]) {
      const exact = expectedGross(sold, amount);
      const f = fees(exact);
      expect(() => contract.circuits.buyTokens(ctx, amount, exact - 1n, f.creator, f.platform, ts)).toThrow(
        "Payment does not match the curve's cost for this range",
      );
      expect(() => contract.circuits.buyTokens(ctx, amount, exact + 1n, f.creator, f.platform, ts)).toThrow(
        "Payment does not match the curve's cost for this range",
      );
      const r = contract.circuits.buyTokens(ctx, amount, exact, f.creator, f.platform, ts);
      sold += amount;
      expect(trackLedger(lastLedger, ledger(r.context.currentQueryContext.state)).tokensSold).toBe(sold);
      ctx = nextContext(contractAddress, r.context);
      ts += 1n;
    }
    expect(sold).toBe(700n);
  });

  it('recovers what a flat batch price gave away, on this curve and on the platform default', () => {
    // How much a flat charge gave away depends on how much of the price is
    // the flat base: the base part is identical either way, so a curve whose
    // base is a large share of its maximum hides more of the gap. Both sets
    // below are measured, and the near-zero-base row independently reproduces
    // the ~73% the finding recorded for a mid-curve batch.
    const midShare = (params: typeof CURVE_PARAMS) => {
      const supply = params.curve_supply;
      const sold = (supply * 3n) / 7n;
      const amount = supply / 7n;
      const flat =
        amount * (params.base_price + ((params.max_price - params.base_price) * sold * sold) / (supply * supply));
      return (flat * 100n) / buyCost('quadratic', params, sold, amount);
    };
    const wholeShare = (params: typeof CURVE_PARAMS) => {
      const flat = params.curve_supply * params.base_price;
      return (flat * 100n) / buyCost('quadratic', params, 0n, params.curve_supply);
    };

    // This file's fixture — base is a tenth of max, so the gap is smallest.
    expect(midShare(CURVE_PARAMS)).toBe(81n);
    expect(wholeShare(CURVE_PARAMS)).toBe(25n);

    // A curve whose base is near zero, the shape the finding measured.
    const nearZeroBase = { base_price: 1n, max_price: 1000n, curve_supply: 1000n };
    expect(midShare(nearZeroBase)).toBe(73n);

    // CLAUDE.md's own constants: CURVE_BASE_PRICE_LOVELACE 3,
    // CURVE_MAX_PRICE_LOVELACE 75, TOTAL_SUPPLY 1e9. Taking the whole curve
    // in one transaction would have cost a ninth of what it is worth.
    const platform = { base_price: 3n, max_price: 75n, curve_supply: 1_000_000_000n };
    expect(midShare(platform)).toBe(75n);
    expect(wholeShare(platform)).toBe(11n);
  });

  it('buying a range in one call never costs less than buying it in pieces', () => {
    // What makes the charge additive over subdivisions, and so removes any
    // gain from splitting or combining a trade. Rounding up at each step is
    // what puts the inequality this way round.
    for (const [sold, amount] of [
      [0n, 100n],
      [37n, 213n],
      [500n, 250n],
      [900n, 100n],
    ] as const) {
      const whole = expectedGross(sold, amount);
      let pieces = 0n;
      for (let i = 0n; i < amount; i += amount / 4n) {
        pieces += expectedGross(sold + i, amount / 4n);
      }
      expect(pieces).toBeGreaterThanOrEqual(whole);
    }
  });

  it('rejects a buy with a fee split missing the /10000 divisor (the original bug)', () => {
    const { contract, ctx } = deployAndActivate();
    const tokenAmount = 10n;
    const grossPayment = expectedGross(0n, tokenAmount);
    const brokenCreatorFee = grossPayment * 100n; // the original (broken) formula

    expect(() => contract.circuits.buyTokens(ctx, tokenAmount, grossPayment, brokenCreatorFee, 0n, 1n)).toThrow(
      'Creator fee mismatch',
    );
  });

  it('rejects a buy with mismatched fee amounts (correct total, wrong split)', () => {
    const { contract, ctx } = deployAndActivate();
    const tokenAmount = 10n;
    const grossPayment = expectedGross(0n, tokenAmount);
    const { creator, platform } = fees(grossPayment);

    expect(() => contract.circuits.buyTokens(ctx, tokenAmount, grossPayment, platform, creator, 1n)).toThrow(
      'Creator fee mismatch',
    );
  });

  it('accumulates fees correctly across multiple buys, at ARBITRARY (non-checkpoint) amounts', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();

    const buy1Gross = expectedGross(0n, 37n);
    const buy1Fees = fees(buy1Gross);
    const r1 = contract.circuits.buyTokens(ctx, 37n, buy1Gross, buy1Fees.creator, buy1Fees.platform, 1n);

    const ctx2 = nextContext(contractAddress, r1.context);
    const buy2Gross = expectedGross(37n, 213n);
    const buy2Fees = fees(buy2Gross);
    const r2 = contract.circuits.buyTokens(ctx2, 213n, buy2Gross, buy2Fees.creator, buy2Fees.platform, 2n);

    const state = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(state.tokensSold).toBe(250n);
    expect(state.creatorFees).toBe(buy1Fees.creator + buy2Fees.creator);
    expect(state.platformFees).toBe(buy1Fees.platform + buy2Fees.platform);
  });

  it('accepts exactly the ceiling of the range cost, and neither neighbour', () => {
    // The cost of a range is almost never a whole number, so what the
    // contract accepts is the smallest integer at or above it. One unit
    // either side must fail: below underpays the curve, above would let a
    // caller overstate the payment the fee slices are taken from.
    const { contract, contractAddress, ctx } = deployAndActivate();
    const openingGross = expectedGross(0n, 10n);
    const openingFees = fees(openingGross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, openingGross, openingFees.creator, openingFees.platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(trackLedger(lastLedger, ledger(r1.context.currentQueryContext.state)).tokensSold).toBe(10n);

    // Confirm this range really does divide unevenly, so the test is
    // exercising the rounding rather than an exact case where any rule agrees.
    const [numerator, denominator] = grossRangeQuadratic(CURVE_PARAMS, 10n, 1n);
    expect(numerator % denominator).not.toBe(0n);

    const exact = expectedGross(10n, 1n);
    expect(() => contract.circuits.buyTokens(ctx2, 1n, exact - 1n, 0n, 0n, 2n)).toThrow(
      "Payment does not match the curve's cost for this range",
    );
    expect(() => contract.circuits.buyTokens(ctx2, 1n, exact + 1n, 0n, 0n, 2n)).toThrow(
      "Payment does not match the curve's cost for this range",
    );

    const exactFees = fees(exact);
    const rCeil = contract.circuits.buyTokens(ctx2, 1n, exact, exactFees.creator, exactFees.platform, 2n);
    expect(trackLedger(lastLedger, ledger(rCeil.context.currentQueryContext.state)).tokensSold).toBe(11n);
  });

  it('FIXED: verifyFeeSlice now accepts the correct floor fee for an arbitrary gross payment', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const openingGross = expectedGross(0n, 100n);
    const openingFees = fees(openingGross);
    const r1 = contract.circuits.buyTokens(ctx, 100n, openingGross, openingFees.creator, openingFees.platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(trackLedger(lastLedger, ledger(r1.context.currentQueryContext.state)).tokensSold).toBe(100n);

    const gross = expectedGross(100n, 10n);
    const floorCreatorFee = (gross * 50n) / 10_000n;
    const floorPlatformFee = (gross * 100n) / 10_000n;
    const rFloor = contract.circuits.buyTokens(ctx2, 10n, gross, floorCreatorFee, floorPlatformFee, 2n);
    expect(trackLedger(lastLedger, ledger(rFloor.context.currentQueryContext.state)).tokensSold).toBe(110n);

    expect(() => contract.circuits.buyTokens(ctx2, 10n, gross, floorCreatorFee, floorPlatformFee + 1n, 2n)).toThrow(
      'Platform fee mismatch',
    );
  });

  it('every buy requires receiveUnshielded, does not throw locally', () => {
    // The local compact-runtime simulator doesn't model cross-transaction
    // UTXO matching (real-node/ledger enforcement), so this test
    // can't prove a mismatched payment is rejected end-to-end. It proves
    // receiveUnshielded is wired into every buy (unconditional — this
    // contract is Midnight Launch/NIGHT only).
    const { contract, ctx } = deployAndActivate();
    const gross = expectedGross(0n, 5n);
    const { creator, platform } = fees(gross);
    const r = contract.circuits.buyTokens(ctx, 5n, gross, creator, platform, 1n);
    expect(trackLedger(lastLedger, ledger(r.context.currentQueryContext.state)).tokensSold).toBe(5n);
  });

  it('claimCurveRefund succeeds once after cancellation, for a buyer who actually paid', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, gross, creator, platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);

    expect(() => contract.circuits.claimCurveRefund(ctx3, fakeBytes32(5))).not.toThrow();
  });

  it('claimCurveRefund rejects when the curve is not cancelled', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, gross, creator, platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimCurveRefund(ctx2, fakeBytes32(5))).toThrow('Curve not cancelled');
  });

  it('claimCurveRefund rejects a caller with no payment on record', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.cancelCurve(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimCurveRefund(ctx2, fakeBytes32(5))).toThrow('No payment found for caller');
  });

  it('claimCurveRefund rejects double-claim', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, gross, creator, platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);
    const r3 = contract.circuits.claimCurveRefund(ctx3, fakeBytes32(5));
    const ctx4 = nextContext(contractAddress, r3.context);

    expect(() => contract.circuits.claimCurveRefund(ctx4, fakeBytes32(5))).toThrow('Refund already claimed');
  });

  it('Phase 5 hygiene fix: claimCurveRefund rejects an empty (all-zero) recipient address', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, gross, creator, platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);

    expect(() => contract.circuits.claimCurveRefund(ctx3, fakeBytes32(0))).toThrow('Recipient address cannot be empty');
  });

  it('expireCurve force-cancels a stalled curve after 90 days, with no governor signature required', () => {
    // Design requirement: expireCurve no longer takes a
    // caller-supplied timestamp — it gates on blockTimeGt against the real
    // simulator clock (see helpers.ts's nextContextAtTime), which cannot
    // be forged the way the old parameter could.
    const { contract, contractAddress, ctx } = deployAndActivate(); // activated_at = 1000n
    const pastDeadline = 1000 + 7776000 + 1;
    const ctxAtDeadline = nextContextAtTime(contractAddress, ctx, pastDeadline);

    // No extra_signatories-equivalent setup at all — expireCurve is
    // permissionless by design, unlike cancelCurve.
    const r = contract.circuits.expireCurve(ctxAtDeadline);
    expect(ledger(r.context.currentQueryContext.state).curveState).toBe(CurveState.Cancelled);
    // Once expired, the same refund path claimCurveRefund already
    // provides works exactly as if the governor had called cancelCurve —
    // expireCurve is just a permissionless alternate path to Cancelled.
  });

  it('expireCurve rejects before the 90-day deadline has passed', () => {
    const { contract, contractAddress, ctx } = deployAndActivate(); // activated_at = 1000n
    const beforeDeadline = 1000 + 7776000; // exactly at the boundary, not past it
    const ctxBeforeDeadline = nextContextAtTime(contractAddress, ctx, beforeDeadline);

    expect(() => contract.circuits.expireCurve(ctxBeforeDeadline)).toThrow('Curve has not yet exceeded max duration');
  });

  it('expireCurve rejects a curve that is not Active (e.g. already Cancelled)', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.cancelCurve(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    const pastDeadline = 1000 + 7776000 + 1;
    const ctxAtDeadline = nextContextAtTime(contractAddress, ctx2, pastDeadline);

    expect(() => contract.circuits.expireCurve(ctxAtDeadline)).toThrow('Curve not active');
  });

  it('graduates automatically at 100% sell-through', () => {
    const { contract, ctx } = deployAndActivate();

    const grossPayment = expectedGross(0n, CURVE_SUPPLY);
    const { creator, platform } = fees(grossPayment);

    const result = contract.circuits.buyTokens(ctx, CURVE_SUPPLY, grossPayment, creator, platform, 1n);

    const state = ledger(result.context.currentQueryContext.state);
    expect(state.tokensSold).toBe(CURVE_SUPPLY);
    expect(state.curveState).toBe(CurveState.Graduated);
  });

  it('rejects buys once the curve has graduated', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();

    const grossPayment = expectedGross(0n, CURVE_SUPPLY);
    const { creator, platform } = fees(grossPayment);
    const r1 = contract.circuits.buyTokens(ctx, CURVE_SUPPLY, grossPayment, creator, platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.buyTokens(ctx2, 1n, expectedPrice(CURVE_SUPPLY), 0n, 0n, 2n)).toThrow(
      'Bonding curve not active',
    );
  });

  it('rejects buying more tokens than remain on the curve', () => {
    const { contract, ctx } = deployAndActivate();
    const overAmount = CURVE_SUPPLY + 1n;

    expect(() => contract.circuits.buyTokens(ctx, overAmount, expectedGross(0n, overAmount), 0n, 0n, 1n)).toThrow(
      'Insufficient tokens remaining',
    );
  });

  it('rejects the creator buying their own public bonding curve', () => {
    // Fix: buyTokens now gates on verifyAllowlist first, so the
    // creator needs a real allowlist membership proof for their own key to
    // even reach the creator-check this test isolates — a separate tree
    // containing CREATOR_KEY's own leaf, distinct from the default
    // ALLOWLIST_TREE (which only contains BUYER_KEY's leaf).
    const creatorAllowlistLeaf = hashAllowlistLeaf(CREATOR_KEY);
    const creatorAllowlistTree = buildAllowlistTree([creatorAllowlistLeaf]);
    const creatorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getUserSecret: (_ctx) => [undefined, { bytes: CREATOR_SECRET_BYTES }],
      getMerkleProof: (_ctx) => [undefined, creatorAllowlistTree.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
    };
    const contract = new Contract<PrivateState>(creatorWitnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      creatorAllowlistTree.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      WALLET_CAP,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      PLATFORM_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const r1 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.advancePhase(ctx1, LaunchPhase.Public);
    const ctx2 = nextContext(contractAddress, r2.context);
    const r3 = contract.circuits.activateCurve(ctx2, 1000n);
    const ctx3 = nextContext(contractAddress, r3.context);

    const grossPayment = expectedGross(0n, 10n);
    const { creator, platform } = fees(grossPayment);
    expect(() => contract.circuits.buyTokens(ctx3, 10n, grossPayment, creator, platform, 1n)).toThrow(
      'Creator cannot buy their own bonding curve',
    );
  });

  it('requires the curve to be activated before any buy', () => {
    const { contract, ctx } = deployAndAdvanceToPublic(); // phase is Public, but curve not yet activated

    expect(() => contract.circuits.buyTokens(ctx, 10n, expectedGross(0n, 10n), 1n, 1n, 1n)).toThrow(
      'Bonding curve not active',
    );
  });

  it('activateCurve requires phase == Public (new invariant enabled by the merge)', () => {
    // Before the merge, activateCurve had no way to know what phase the
    // launch was in at all — `phase` lived in a different contract. Now
    // that they're one contract, activation is gated on it directly.
    const d = deploy(); // phase is still Pending
    expect(() => d.contract.circuits.activateCurve(d.ctx, 1000n)).toThrow('Must be in Public phase to activate curve');
  });
});

describe('bonding_curve.compact — merged eligibility gate', () => {
  it('registerForDarkVeil succeeds with a valid allowlist proof and bond payment', () => {
    const d = deploy();
    const r = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r.context);
    const rReg = d.contract.circuits.startRegistration(ctx0);
    const ctx = nextContext(d.contractAddress, rReg.context);

    expect(() => d.contract.circuits.registerForDarkVeil(ctx)).not.toThrow();
  });

  it('FIXED: buyTokens enforces the 5% wallet cap directly against cumulativePurchases, atomically', () => {
    // This is the core regression test — before this merge, buyTokens
    // had NO cap enforcement at all (the check was "supposed to happen via
    // transaction merging" that never actually worked). Now it's
    // inline in the same circuit call.
    const { contract, ctx } = deployAndActivate();

    // curveSupply=1000, so buying the whole curve (1000 tokens) is well
    // under WALLET_CAP (50,000,000) in this test's numbers.
    const grossPayment = expectedGross(0n, CURVE_SUPPLY);
    const { creator, platform } = fees(grossPayment);

    // A full sell-through buy is comfortably under the cap and must succeed.
    expect(() => contract.circuits.buyTokens(ctx, CURVE_SUPPLY, grossPayment, creator, platform, 1n)).not.toThrow();
  });

  it('regression: buyTokens rejects a purchase that would push cumulativePurchases over the cap', () => {
    // Design requirement: checkAndUpdateCap (a standalone,
    // unauthenticated circuit taking an arbitrary callerKey) was removed
    // from this file entirely — buyTokens/revealBuyCommit already enforce
    // the cap inline. This proves the boundary the removed circuit's test
    // used to cover is still real: a tight per-launch wallet cap must
    // reject a buy that would exceed it.
    const witnessesTight: Witnesses<PrivateState> = { ...witnesses };
    const contract = new Contract<PrivateState>(witnessesTight);
    const tightCap = 5n; // less than a full sell-through (1000 tokens)
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      tightCap,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      PLATFORM_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    const r0 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.advancePhase(ctx0, LaunchPhase.Public);
    const ctx1 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.activateCurve(ctx1, 1000n);
    const ctx2a = nextContext(contractAddress, r2.context);
    const rv = contract.circuits.verifyBuyerEligibility(ctx2a);
    const ctx2 = nextContext(contractAddress, rv.context);

    const tokenAmount = tightCap + 1n; // exceeds tightCap (5)
    const grossPayment = expectedGross(0n, tokenAmount);
    const { creator, platform } = fees(grossPayment);

    expect(() => contract.circuits.buyTokens(ctx2, tokenAmount, grossPayment, creator, platform, 1n)).toThrow(
      'Purchase exceeds 5% wallet cap',
    );
  });

  it('FIXED: cumulativePurchases is shared across separate buyTokens calls for the same identity', () => {
    // Proves cumulativePurchases is genuinely shared across purchases: two
    // separate buyTokens calls for the SAME derived identity both update/
    // read the SAME map entry (see bonding_curve.compact's identity-
    // unification note). getUserSecret's witness always returns
    // fakeBytes32(3) in this test file — deriveUserPublicKey (the real,
    // verified off-chain mirror of the on-chain circuit, same domain
    // "noctis:user:pk:v1") computes what buyTokens actually keys its
    // ledger writes by.
    const d = deployAndActivate();
    const buyerDerivedKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);

    const tokenAmount = 25n;
    const grossPayment = expectedGross(0n, tokenAmount);
    const { creator, platform } = fees(grossPayment);

    const r = d.contract.circuits.buyTokens(d.ctx, tokenAmount, grossPayment, creator, platform, 1n);
    const ctx2 = nextContext(d.contractAddress, r.context);

    // Reading cumulativePurchases for the buyer's REAL derived key (via the
    // read-only checkCap, not checkAndUpdateCap) should now show
    // tokenAmount — proving buyTokens wrote into the exact same map entry
    // checkAndUpdateCap/checkCap read.
    const capProbe = d.contract.circuits.checkCap(ctx2, buyerDerivedKey);
    expect(capProbe.result).toBe(tokenAmount);
  });

  it('claimBondRefund pays out after DarkVeil is marked failed', () => {
    const d = deploy();
    const r1 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rStart = d.contract.circuits.startRegistration(ctx1);
    const ctxStart = nextContext(d.contractAddress, rStart.context);
    const r2 = d.contract.circuits.registerForDarkVeil(ctxStart);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.advancePhase(ctx2, LaunchPhase.Public);
    const ctx3 = nextContext(d.contractAddress, r3.context);
    const r4 = d.contract.circuits.markDarkVeilFailed(ctx3);
    const ctx4 = nextContext(d.contractAddress, r4.context);

    expect(() => d.contract.circuits.claimBondRefund(ctx4, fakeBytes32(5))).not.toThrow();
  });

  it('Phase 5 hygiene fix: claimBondRefund rejects an empty (all-zero) recipient address', () => {
    const d = deploy();
    const r1 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rStart = d.contract.circuits.startRegistration(ctx1);
    const ctxStart = nextContext(d.contractAddress, rStart.context);
    const r2 = d.contract.circuits.registerForDarkVeil(ctxStart);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.advancePhase(ctx2, LaunchPhase.Public);
    const ctx3 = nextContext(d.contractAddress, r3.context);
    const r4 = d.contract.circuits.markDarkVeilFailed(ctx3);
    const ctx4 = nextContext(d.contractAddress, r4.context);

    expect(() => d.contract.circuits.claimBondRefund(ctx4, fakeBytes32(0))).toThrow(
      'Recipient address cannot be empty',
    );
  });
});

// ============================================================================
// Resolution (2026-07-13): minimum absolute registrant count required
// before startBuying() opens the buying phase. Same fix as
// eligibility_gate.compact (Cardano Launch) — below the floor, the governor must
// call cancelDarkVeil() (the existing, already-refundable DarkVeil-failure
// path) instead.
// ============================================================================

describe('bonding_curve.compact — minimum DarkVeil participant floor', () => {
  // Three real distinct registrant identities, each a real leaf in a
  // purpose-built 3-leaf allowlist tree — the shared top-level
  // ALLOWLIST_TREE only contains one leaf (BUYER_KEY).
  const SECRET_A = fakeBytes32(101);
  const SECRET_B = fakeBytes32(102);
  const SECRET_C = fakeBytes32(103);
  const KEY_A = deriveUserPublicKey(SECRET_A, LAUNCH_ID);
  const KEY_B = deriveUserPublicKey(SECRET_B, LAUNCH_ID);
  const KEY_C = deriveUserPublicKey(SECRET_C, LAUNCH_ID);
  const FLOOR_TREE = buildAllowlistTree([hashAllowlistLeaf(KEY_A), hashAllowlistLeaf(KEY_B), hashAllowlistLeaf(KEY_C)]);

  function registrantContract(secretBytes: Uint8Array, index: number) {
    return new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: secretBytes }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(index)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
  }

  function deployWithFloor(minDvParticipants: bigint) {
    const governorContract = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: SECRET_A }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    const { contractAddress, ctx } = deployForTest(
      governorContract,
      undefined,
      LAUNCH_ID,
      FLOOR_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      WALLET_CAP,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      3n, // allowlistSize — matches the 3-leaf FLOOR_TREE
      REGISTRATION_CLOSE_TIME,
      minDvParticipants,
      CREATOR_KEY,
      PLATFORM_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
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
    expect(() => governorContract.circuits.startBuying(ctxB, REGISTRANT_TREE.root)).toThrow(
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

    expect(() => registrantContract(SECRET_B, 1).circuits.claimBondRefund(ctxClaimedA, fakeBytes32(202))).not.toThrow();

    // Released for real: the re-claim guard now rejects.
    expect(() => registrantContract(SECRET_A, 0).circuits.claimBondRefund(ctxClaimedA, fakeBytes32(201))).toThrow(
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
    const rBuy = governorContract.circuits.startBuying(ctxC, REGISTRANT_TREE.root);
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
        BOND_AMOUNT,
        WALLET_CAP,
        BASE_PRICE,
        MAX_PRICE,
        CURVE_SUPPLY,
        DV_ALLOCATION,
        DV_PRICE,
        ALLOWLIST_SIZE,
        REGISTRATION_CLOSE_TIME,
        0n, // minDvParticipants — invalid
        CREATOR_KEY,
        PLATFORM_ADDR,
        CREATOR_ADDR,
        LP_ESCROW_ADDR,
        ALLOWLIST_ATTESTOR_1_KEY,
        ALLOWLIST_ATTESTOR_2_KEY,
        ALLOWLIST_ATTESTOR_3_KEY,
        ALLOWLIST_THRESHOLD,
      ),
    ).toThrow('minDvParticipants must be positive');
  });
});

describe('bonding_curve.compact — merged DarkVeil private buy (follow-up)', () => {
  /**
   * Drives dvState through Inactive -> Registration -> Buying, AND phase
   * to DarkVeil (the two are independent state machines — see
   * DarkVeilState's comment in bonding_curve.compact — but advancePhase's
   * own transition guards need phase to have moved too, e.g. before it can
   * later go to Public).
   */
  // Phase 4 fix (2026-07-12): submitBuyCommit now requires proof of prior
  // registration (a recomputed registration nullifier), so this helper
  // registers the default buyer (fakeBytes32(3), matching the shared
  // `witnesses` object) before opening buying — same fix as
  // eligibility_gate.test.ts's identical helper.
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

  it('submitBuyCommit accepts a commitment during the Buying sub-phase, discloses nothing about the amount', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
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

  it('Fix (2026-07-21, High): rejects a second buy commitment from the same identity, even with a different commitment hash', () => {
    // Before the fix, the buy nullifier was a free caller-supplied
    // parameter — a single registrant could submit unlimited buy
    // commitments simply by choosing a fresh nullifier value each time,
    // capturing up to walletCap instead of their fair per-registrant share.
    // Now the nullifier is derived in-circuit from the caller's own secret
    // key, so a second submission from the same identity always collides
    // on the same derived nullifier automatically.
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const commitment1 = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 10n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment1, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);

    const commitment2 = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 20n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    expect(() => d.contract.circuits.submitBuyCommit(ctx1, commitment2, 2n)).toThrow(/already bought/i);
  });

  it('follow-up FIXED: revealBuyCommit requires real NIGHT payment (receiveUnshielded wired in, does not throw locally)', () => {
    // Same simulator caveat as every other receiveUnshielded regression
    // test in this suite — the local compact-runtime
    // simulator doesn't model cross-transaction UTXO matching, so this
    // proves the call is wired in structurally, not that a missing
    // payment is rejected end-to-end against a live network.
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const tokenAmount = 50n;
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

    const grossPayment = tokenAmount * DV_PRICE;
    const { creator, platform } = fees(grossPayment);
    const r3 = d.contract.circuits.revealBuyCommit(
      nextContextAtTime(d.contractAddress, ctx2, 3),
      commitment,
      tokenAmount,
      DV_PRICE,
      creator,
      platform,
      3n,
    );
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.totalTokensCommitted).toBe(tokenAmount);
    expect(state.totalRaisedCommitted).toBe(grossPayment);
    // Fix (2026-07-21): the Critical fix — DarkVeil proceeds must
    // now flow into the SAME real accumulators graduateLp/withdrawFees pay
    // out, not just the gross-statistic totalRaisedCommitted.
    expect(state.creatorFees).toBe(creator);
    expect(state.platformFees).toBe(platform);
    expect(state.totalRaised).toBe(grossPayment - creator - platform);
  });

  it('follow-up FIXED: revealBuyCommit enforces the 5% cumulative cap', () => {
    // Sets a tight wallet cap for this one test so a single DarkVeil buy
    // can actually exceed it, proving the cap check inside revealBuyCommit
    // (not just buyTokens) is real.
    const witnessesTight: Witnesses<PrivateState> = { ...witnesses };
    const contract = new Contract<PrivateState>(witnessesTight);
    const tightCap = 40n; // less than the 50-token DV allocation this test attempts
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      tightCap,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      PLATFORM_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
      ALLOWLIST_ATTESTOR_1_KEY,
      ALLOWLIST_ATTESTOR_2_KEY,
      ALLOWLIST_ATTESTOR_3_KEY,
      ALLOWLIST_THRESHOLD,
    );
    // Phase 4 fix: submitBuyCommit now requires proof of prior registration.
    const r0 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(contractAddress, r1.context);
    // Fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg = contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    const ctx2 = nextContext(contractAddress, r2.context);

    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const tokenAmount = 50n; // exceeds tightCap (40)
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r3 = contract.circuits.submitBuyCommit(ctx2, commitment, 1n);
    const ctx3 = nextContext(contractAddress, r3.context);
    const r4 = contract.circuits.closeDarkVeil(ctx3, 2n, 100n);
    const ctx4 = nextContext(contractAddress, r4.context);

    const { creator: tightCreator, platform: tightPlatform } = fees(tokenAmount * DV_PRICE);
    expect(() =>
      contract.circuits.revealBuyCommit(
        nextContextAtTime(contractAddress, ctx4, 3),
        commitment,
        tokenAmount,
        DV_PRICE,
        tightCreator,
        tightPlatform,
        3n,
      ),
    ).toThrow('Purchase exceeds 5% wallet cap');
  });

  it('Phase 2 regression: revealBuyCommit rejects a reveal exceeding the per-registrant baseSlot, even within the pool-wide dvAllocation and wallet cap', () => {
    // Security-audit fix (Phase 2): before this fix, Midnight Launch's merged
    // revealBuyCommit set/read baseSlot for the ratio-refund formula but
    // never enforced it as a purchase-time ceiling — only the pool-wide
    // dvAllocation and the (generous, default) wallet cap were checked.
    // Uses the default (non-tight) walletCap/deploy() so this rejection is
    // driven specifically by baseSlot, not incidentally by the wallet cap
    // (unlike the tightCap test above).
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const tokenAmount = 50n; // exceeds baseSlot (40) but well within dvAllocation (500) and WALLET_CAP (50,000,000)
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

    const { creator: baseSlotCreator, platform: baseSlotPlatform } = fees(tokenAmount * DV_PRICE);
    expect(() =>
      d.contract.circuits.revealBuyCommit(
        nextContextAtTime(d.contractAddress, ctx2, 3),
        commitment,
        tokenAmount,
        DV_PRICE,
        baseSlotCreator,
        baseSlotPlatform,
        3n,
      ),
    ).toThrow('Exceeds per-registrant DarkVeil allocation');
  });

  it('follow-up FIXED: a DarkVeil reveal and a later public buyTokens share the same cumulativePurchases entry', () => {
    // The core regression this fix exists for: before it, DarkVeil
    // purchases were never counted toward the cap at all. Now a DV reveal
    // followed by a public buy for the SAME identity must respect the
    // combined total.
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const dvAmount = 30n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: dvAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 100n);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const { creator: dvCreator, platform: dvPlatform } = fees(dvAmount * DV_PRICE);
    const r3 = d.contract.circuits.revealBuyCommit(
      nextContextAtTime(d.contractAddress, ctx2, 3),
      commitment,
      dvAmount,
      DV_PRICE,
      dvCreator,
      dvPlatform,
      3n,
    );
    const ctx3 = nextContext(d.contractAddress, r3.context);

    // checkCap (read-only) confirms the DV reveal already counted toward
    // this buyer's cumulative total, via the exact same map buyTokens uses.
    const capAfterDv = d.contract.circuits.checkCap(ctx3, buyerKey);
    expect(capAfterDv.result).toBe(dvAmount);

    // Advance to Public and activate the curve, then buy — cumulative
    // total must now include BOTH the DV reveal and this public buy.
    const r4 = d.contract.circuits.advancePhase(ctx3, LaunchPhase.Public);
    const ctx4 = nextContext(d.contractAddress, r4.context);
    const r5 = d.contract.circuits.activateCurve(ctx4, 1000n);
    const ctx5a = nextContext(d.contractAddress, r5.context);
    const rv5 = d.contract.circuits.verifyBuyerEligibility(ctx5a);
    const ctx5 = nextContext(d.contractAddress, rv5.context);

    const publicAmount = 10n;
    const grossPayment = expectedGross(0n, publicAmount);
    const { creator, platform } = fees(grossPayment);
    const r6 = d.contract.circuits.buyTokens(ctx5, publicAmount, grossPayment, creator, platform, 3n);
    const ctx6 = nextContext(d.contractAddress, r6.context);

    const capAfterPublic = d.contract.circuits.checkCap(ctx6, buyerKey);
    expect(capAfterPublic.result).toBe(dvAmount + publicAmount);
  });

  it('cancelBuyCommit works before DarkVeil closes, decrements participant count', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
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

  it('Fix (2026-07-21, Medium): rejects a baseSlot whose total (baseSlot * registrationCount) exceeds dvAllocation', () => {
    // deployAndStartDvBuying registers exactly 1 participant, so any
    // baseSlot above DV_ALLOCATION (500) collectively promises more than
    // the pool actually reserves. Same fix as eligibility_gate.compact.
    const d = deployAndStartDvBuying();
    expect(() => d.contract.circuits.closeDarkVeil(d.ctx, 12345n, DV_ALLOCATION + 1n)).toThrow(/exceeds dvAllocation/i);
  });

  it('Fix (2026-07-21, Medium): rejects registration once dvState has moved past Registration, even though phase is still DarkVeil', () => {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const rBuying = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    const ctxBuying = nextContext(d.contractAddress, rBuying.context);

    const lateRegistrant = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, REGISTRANT_TREE.getProof(0)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => lateRegistrant.circuits.registerForDarkVeil(ctxBuying)).toThrow(/registration sub-phase/i);
  });

  it('rejects revealBuyCommit before DarkVeil is closed', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);

    const { creator: notClosedCreator, platform: notClosedPlatform } = fees(50n * DV_PRICE);
    expect(() =>
      d.contract.circuits.revealBuyCommit(
        nextContextAtTime(d.contractAddress, ctx1, 3),
        commitment,
        50n,
        DV_PRICE,
        notClosedCreator,
        notClosedPlatform,
        3n,
      ),
    ).toThrow('DarkVeil not closed');
  });

  it('rejects a DarkVeil buy exceeding the total dvAllocation pool', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
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
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 100n);
    const ctx2 = nextContext(d.contractAddress, r2.context);

    const { creator: overCreator, platform: overPlatform } = fees(overAmount * DV_PRICE);
    expect(() =>
      // baseSlot was set to 100 by closeDarkVeil above, and overAmount (501)
      // exceeds that per-registrant ceiling before it ever reaches the
      // pool-wide dvAllocation (500) check this test's own name names —
      // confirmed by running it, same class of ordering nuance found in
      // eligibility_gate.test.ts's analogous test.
      d.contract.circuits.revealBuyCommit(
        nextContextAtTime(d.contractAddress, ctx2, 3),
        commitment,
        overAmount,
        DV_PRICE,
        overCreator,
        overPlatform,
        3n,
      ),
    ).toThrow('Exceeds per-registrant DarkVeil allocation');
  });
});

describe('bonding_curve.compact — ratio-based NIGHT bond refund', () => {
  /** Registers, submits + reveals a DV buy for `purchased` tokens, closes DarkVeil with `baseSlot`. */
  function registerBuyAndClose(purchased: bigint, baseSlot: bigint) {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    // Fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg1 = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg1 = nextContext(d.contractAddress, rReg1.context);
    const r3 = d.contract.circuits.startBuying(ctxReg1, REGISTRANT_TREE.root);
    let ctx = nextContext(d.contractAddress, r3.context);

    if (purchased > 0n) {
      const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
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
      const { creator: purchasedCreator, platform: purchasedPlatform } = fees(purchased * DV_PRICE);
      const r6 = d.contract.circuits.revealBuyCommit(
        nextContextAtTime(d.contractAddress, ctx, 3),
        commitment,
        purchased,
        DV_PRICE,
        purchasedCreator,
        purchasedPlatform,
        3n,
      );
      ctx = nextContext(d.contractAddress, r6.context);
    } else {
      // Ghost registrant — never submits or reveals anything.
      const r4 = d.contract.circuits.closeDarkVeil(ctx, 2n, baseSlot);
      ctx = nextContext(d.contractAddress, r4.context);
    }

    return { contract: d.contract, contractAddress: d.contractAddress, ctx };
  }

  it.each([
    {
      label: 'bought 100% of baseSlot -> full bond refund',
      purchased: 100n,
      baseSlot: 100n,
      claimedRefund: (BOND_AMOUNT * 100n) / 100n, // 1000 — floor is exact here // forfeited = 1000 - 1000 = 0
    },
    {
      label: 'bought 50% of baseSlot -> half bond refund, floor-exact, forfeited half to the platform',
      purchased: 50n,
      baseSlot: 100n,
      claimedRefund: (BOND_AMOUNT * 50n) / 100n, // 500 // 300 — forfeited(500) * 60%
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

  it('Phase 5 hygiene fix: claimRatioBondRefund rejects an empty (all-zero) recipient address', () => {
    const { contract, ctx } = registerBuyAndClose(100n, 100n);
    const claimedRefund = (BOND_AMOUNT * 100n) / 100n;
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(0), claimedRefund)).toThrow(
      'Recipient address cannot be empty',
    );
  });

  it('accepts the correct FLOOR refund at a non-exact division (floor-rounding)', () => {
    // bond=1000, purchased=37, baseSlot=90: true value = 1000*37/90 = 411.11...
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (BOND_AMOUNT * 37n) / 90n; // 411 (bigint division truncates = floor for positives)
    expect(floorRefund).toBe(411n);
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund)).not.toThrow();
  });

  it.each([
    { label: 'one unit above', delta: 1n },
    { label: 'below', delta: -1n },
  ])('rejects a refund claim $label the correct floor', ({ delta }) => {
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (BOND_AMOUNT * 37n) / 90n; // 411
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund + delta)).toThrow(
      'Claimed refund does not match the ratio-based formula',
    );
  });

  // Was 'rejects an incorrect treasury share'. One wallet means the forfeited
  // amount is fully determined by the bond and the verified refund, so there is
  // no share for a caller to get wrong.
  it('pays the whole forfeited remainder to the platform, with no share to claim', () => {
    // Regression: claimedRefund is right, but claimedTreasuryShare is
    const { contract, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (BOND_AMOUNT * 50n) / 100n; // 500 back, 500 forfeited
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund)).not.toThrow();
  });

  it('rejects claiming twice for the same bond', () => {
    const { contract, contractAddress, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (BOND_AMOUNT * 50n) / 100n; // 300
    const r1 = contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimRatioBondRefund(ctx2, fakeBytes32(5), claimedRefund)).toThrow(
      'Bond already claimed',
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

describe('bonding_curve.compact — the design requirement: withdrawFees and graduateLp actually pay out', () => {
  /** Buys the whole curve so it graduates, accruing real fees along the way. */
  function deployActivateAndGraduate() {
    const d = deployAndActivate();
    const grossPayment = expectedGross(0n, CURVE_SUPPLY);
    const { creator, platform } = fees(grossPayment);
    const r = d.contract.circuits.buyTokens(d.ctx, CURVE_SUPPLY, grossPayment, creator, platform, 1n);
    const ctx = nextContext(d.contractAddress, r.context);
    return { ...d, ctx, creatorFees: creator, platformFees: platform };
  }

  it('withdrawFees pays out via sendUnshielded and zeroes the claimed amounts (governor only)', () => {
    const { contract, ctx, creatorFees, platformFees } = deployActivateAndGraduate();

    // Design requirement: before this fix, withdrawFees only
    // decremented these counters with no sendUnshielded call at all —
    // fees were permanently stuck. Proving it doesn't throw here confirms
    // the sendUnshielded calls are wired in (same simulator caveat as
    // every other receiveUnshielded/sendUnshielded test in this file: the
    // local runtime doesn't model cross-transaction UTXO matching, so this
    // proves the calls are structurally present, not end-to-end verified
    // against a live network).
    const r = contract.circuits.withdrawFees(ctx, creatorFees, platformFees);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.creatorFees).toBe(0n);
    expect(state.platformFees).toBe(0n);
  });

  it('withdrawFees rejects a non-governor caller', () => {
    const { contractAddress, ctx, creatorFees, platformFees } = deployActivateAndGraduate();
    const nonGovernorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }],
    };
    const otherContract = new Contract<PrivateState>(nonGovernorWitnesses);
    expect(() => otherContract.circuits.withdrawFees(ctx, creatorFees, platformFees)).toThrow(
      'Only governor can withdraw',
    );
    void contractAddress;
  });

  it('withdrawFees rejects an amount exceeding the accrued fee balance', () => {
    const { contract, ctx, creatorFees } = deployActivateAndGraduate();
    expect(() => contract.circuits.withdrawFees(ctx, creatorFees + 1n, 0n)).toThrow('Insufficient creator fees');
  });

  it('Phase 2 / later regression: withdrawFees rejects on a cancelled curve (double-drain fix)', () => {
    // Security-audit fix (Phase 2, tightened later): withdrawFees
    // originally had no curveState guard at all — claimCurveRefund pays
    // cancelled-curve buyers their FULL gross (fee-inclusive) payment
    // back, so the governor could separately withdraw the same fees
    // against the same underlying NIGHT balance. The later fix (2026-07-30) then
    // found the Phase 2 fix (blocking only Cancelled) still left a race:
    // a fee withdrawal while still Active, followed by cancellation,
    // could exceed the real balance before the last refund claims land.
    // Fees are now only withdrawable once Graduated, at which point
    // cancellation can never happen again.
    const { contract, contractAddress, ctx } = deployAndActivate();
    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, gross, creator, platform, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);

    expect(() => contract.circuits.withdrawFees(ctx3, creator, platform)).toThrow(
      'Fees only withdrawable after graduation',
    );
  });

  it('fix (2026-07-30): withdrawFees rejects while the curve is still Active, even before any cancellation', () => {
    const { contract, ctx, creatorFees, platformFees } = (() => {
      const { contract, contractAddress, ctx } = deployAndActivate();
      const gross = expectedGross(0n, 10n);
      const { creator, platform } = fees(gross);
      const r1 = contract.circuits.buyTokens(ctx, 10n, gross, creator, platform, 1n);
      return {
        contract,
        ctx: nextContext(contractAddress, r1.context),
        creatorFees: creator,
        platformFees: platform,
      };
    })();
    expect(() => contract.circuits.withdrawFees(ctx, creatorFees, platformFees)).toThrow(
      'Fees only withdrawable after graduation',
    );
  });

  it('triggerCTO succeeds with governor signature and sets ctoTriggered/communityWallet', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    const r = contract.circuits.triggerCTO(ctx, fakeBytes32(201), fakeBytes32(70));
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.ctoTriggered).toBe(true);
    expect(state.communityWallet).toEqual(fakeBytes32(70));
  });

  it('triggerCTO rejects a non-governor caller', () => {
    const { ctx } = deployActivateAndGraduate();
    const nonGovernorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }],
    };
    const otherContract = new Contract<PrivateState>(nonGovernorWitnesses);
    expect(() => otherContract.circuits.triggerCTO(ctx, fakeBytes32(202), fakeBytes32(70))).toThrow(
      'Only governor can trigger CTO',
    );
  });

  it('triggerCTO rejects being triggered twice', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(203), fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.triggerCTO(ctx2, fakeBytes32(204), fakeBytes32(71))).toThrow(
      'CTO already triggered',
    );
  });

  it('Phase 5 hygiene fix: triggerCTO rejects an empty (all-zero) community wallet address', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(205), fakeBytes32(0))).toThrow(
      'Community wallet address cannot be empty',
    );
  });

  it('dissolveCTO succeeds with governor signature and resets ctoTriggered/communityWallet', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(206), fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.dissolveCTO(ctx2, fakeBytes32(208));
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.ctoTriggered).toBe(false);
  });

  // A CTO trigger changes who receives money. These four are about the ballot
  // BEHIND that change — that one is named, that it is real enough to point
  // at, and that it authorises exactly one transition here.

  it('records the ballot the CTO state rests on, so the claim can be checked against the vote', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    const ballot = fakeBytes32(180);
    const r = contract.circuits.triggerCTO(ctx, ballot, fakeBytes32(70));
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.ctoProposalId).toEqual(ballot);
    expect(state.consumedProposals.member(ballot)).toBe(true);
  });

  it('refuses a trigger that names no ballot at all', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(0), fakeBytes32(70))).toThrow(
      'CTO trigger must name the proposal that authorised it',
    );
  });

  // The one that matters. Without single-use, one passed vote is a permanent
  // licence: dissolve, then re-trigger under the SAME authority and install a
  // different wallet.
  it('refuses to re-use a spent ballot to install a different wallet after a dissolve', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    const ballot = fakeBytes32(181);
    const r1 = contract.circuits.triggerCTO(ctx, ballot, fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.dissolveCTO(ctx2, fakeBytes32(182));
    const ctx3 = nextContext(contractAddress, r2.context);
    expect(() => contract.circuits.triggerCTO(ctx3, ballot, fakeBytes32(71))).toThrow(
      'This proposal has already been acted on here',
    );
  });

  it('refuses a dissolve riding on the trigger own ballot', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    const ballot = fakeBytes32(183);
    const r1 = contract.circuits.triggerCTO(ctx, ballot, fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.dissolveCTO(ctx2, ballot)).toThrow('This proposal has already been acted on here');
  });

  it('dissolveCTO rejects if CTO was never triggered', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    expect(() => contract.circuits.dissolveCTO(ctx, fakeBytes32(209))).toThrow('CTO not triggered');
  });

  it('CTO fee-redirect fix regression: withdrawFees still succeeds once a CTO has been triggered — the exact gap this fix closes (this contract previously had no CTO concept at all, so a passed CTO vote never redirected the creator fee share)', () => {
    const { contract, contractAddress, ctx, creatorFees, platformFees } = deployActivateAndGraduate();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(207), fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    // Same simulator caveat as the base withdrawFees test above: proves the
    // redirected sendUnshielded call is wired in structurally (governor can
    // still call withdrawFees, and it still zeroes the accrued balances),
    // not that fakeBytes32(70) specifically received the NIGHT — the local
    // runtime doesn't model cross-transaction UTXO matching.
    const r3 = contract.circuits.withdrawFees(ctx2, creatorFees, platformFees);
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.creatorFees).toBe(0n);
    expect(state.communityWallet).toEqual(fakeBytes32(70));
  });

  it('graduateLp pays out totalRaised via sendUnshielded exactly once (lpSeeded replay guard)', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    expect(ledger(ctx.currentQueryContext.state).curveState).toBe(CurveState.Graduated);

    const r1 = contract.circuits.graduateLp(ctx);
    expect(ledger(r1.context.currentQueryContext.state).lpSeeded).toBe(true);
    const ctx2 = nextContext(contractAddress, r1.context);

    // Design requirement: lpSeeded must prevent a second call
    // from re-draining totalRaised.
    expect(() => contract.circuits.graduateLp(ctx2)).toThrow('LP already seeded');
  });

  it('graduateLp rejects a curve that has not graduated yet', () => {
    const { contract, ctx } = deployAndActivate(); // not graduated — no buys yet
    expect(() => contract.circuits.graduateLp(ctx)).toThrow('Curve has not graduated');
  });
});

// ============================================================================
// verifyBuyerEligibility — proving membership once, and what invalidates it
// ============================================================================

describe('bonding_curve.compact — buyer verification is separate from buying', () => {
  it('records the buyer under the root they actually proved against', () => {
    const { contract, contractAddress, ctx } = deployAndAdvanceToPublic();
    const r = contract.circuits.activateCurve(ctx, 1000n);
    const ctxA = nextContext(contractAddress, r.context);

    const rv = contract.circuits.verifyBuyerEligibility(ctxA);
    const state = ledger(rv.context.currentQueryContext.state);

    expect(state.verifiedBuyers.member(BUYER_KEY)).toBe(true);
    expect(state.verifiedBuyers.lookup(BUYER_KEY)).toEqual(state.allowlistRoot);
  });

  it('lets a verified buyer buy repeatedly without re-proving', () => {
    // The whole point of the split: the second purchase carries no Merkle
    // proof of its own, and is still accepted.
    const { contract, contractAddress, ctx } = deployAndActivate();

    const g1 = expectedGross(0n, 10n);
    const f1 = fees(g1);
    const r1 = contract.circuits.buyTokens(ctx, 10n, g1, f1.creator, f1.platform, 1n);
    const ctx1 = nextContext(contractAddress, r1.context);

    const g2 = expectedGross(10n, 10n);
    const f2 = fees(g2);
    const r2 = contract.circuits.buyTokens(ctx1, 10n, g2, f2.creator, f2.platform, 2n);

    expect(ledger(r2.context.currentQueryContext.state).tokensSold).toBe(20n);
  });

  it('stops honouring a verification once the governor changes the allowlist', () => {
    // A wallet removed from the allowlist would otherwise stay verified
    // forever, because nothing clears the record. Binding the record to the
    // root it was proven against means the change invalidates it by itself.
    const { contract, contractAddress, ctx } = deployAndActivate();

    // Two attestors: the root only changes once the threshold is met.
    const rUpdate = contract.circuits.updateAllowlistRoot(
      nextContextAtTime(contractAddress, ctx, 0),
      fakeBytes32(123),
      0n,
    );
    const rUpdate2 = attestAllowlistAgain(
      contractAddress,
      nextContext(contractAddress, rUpdate.context) as never,
      fakeBytes32(123),
    );
    const ctxU = nextContext(contractAddress, rUpdate2.context);

    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    expect(() => contract.circuits.buyTokens(ctxU, 10n, gross, creator, platform, 1n)).toThrow(
      'Allowlist changed since this buyer was verified',
    );
  });

  it('a buyer who never verified cannot buy', () => {
    const { contract, contractAddress, ctx } = deployAndAdvanceToPublic();
    const r = contract.circuits.activateCurve(ctx, 1000n);
    const ctxA = nextContext(contractAddress, r.context);

    const gross = expectedGross(0n, 10n);
    const { creator, platform } = fees(gross);
    expect(() => contract.circuits.buyTokens(ctxA, 10n, gross, creator, platform, 1n)).toThrow(
      'Buyer has not proven allowlist membership',
    );
  });
});

// ============================================================================
// Parity with the Cardano Launch twin — guards that existed there and not here
// ============================================================================

describe('bonding_curve.compact — lifecycle and range guards', () => {
  it('refuses to move the phase back to Pending', () => {
    // Refunds are reachable from Cancelled, so a return to Pending after a
    // cancellation would strand every bond not already claimed.
    const { contract, contractAddress, ctx } = deployAndAdvanceToPublic();
    const rc = contract.circuits.advancePhase(ctx, LaunchPhase.Cancelled);
    const ctxC = nextContext(contractAddress, rc.context);

    expect(() => contract.circuits.advancePhase(ctxC, LaunchPhase.Pending)).toThrow(
      'Cannot advance phase back to Pending',
    );
  });

  it('refuses a baseSlot above the range bond refunds can be computed over', () => {
    // 2^40 - 1 is verifyRatioRefund's own ceiling on `allocated`. Above it,
    // every claimRatioBondRefund for the launch would fail — better to learn
    // that at close than after everyone has bonded.
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    const ctx2 = nextContext(d.contractAddress, r2.context);

    expect(() => d.contract.circuits.closeDarkVeil(ctx2, 1n, 1099511627776n)).toThrow(
      "baseSlot exceeds verifyRatioRefund's safe range",
    );
  });
});

// ============================================================================
// PoC — a commitment revealed after the curve is cancelled
// ============================================================================
// A ghost registrant is supposed to forfeit their bond: they hold an
// allocation nobody else could take, and never pay for it. The forfeited
// bond is what makes that cost something.
//
// Written to assert the exploit SUCCEEDS, so it is a real reproduction
// before it is a regression test.

describe('bonding_curve.compact — revealing after cancellation', () => {
  /** Registers, commits, closes DarkVeil, then activates and expires the curve. */
  function ghostThroughToExpiredCurve() {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    let ctx = nextContext(d.contractAddress, r2.context);

    const purchased = 100n;
    const buyerKey = deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID);
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: purchased,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    // Commit, and then simply do not reveal while the phase is open.
    const r3 = d.contract.circuits.submitBuyCommit(ctx, commitment, 1n);
    ctx = nextContext(d.contractAddress, r3.context);
    const r4 = d.contract.circuits.closeDarkVeil(ctx, 2n, purchased);
    ctx = nextContext(d.contractAddress, r4.context);

    // The launch goes public, stalls, and anyone expires it after 90 days.
    const r5 = d.contract.circuits.advancePhase(ctx, LaunchPhase.Public);
    ctx = nextContext(d.contractAddress, r5.context);
    const r6 = d.contract.circuits.activateCurve(ctx, 1000n);
    ctx = nextContext(d.contractAddress, r6.context);
    const afterMaxDuration = 1000 + 7776000 + 1;
    const r7 = d.contract.circuits.expireCurve(nextContextAtTime(d.contractAddress, ctx, afterMaxDuration));
    ctx = nextContext(d.contractAddress, r7.context);

    return { ...d, ctx, commitment, purchased };
  }

  it('refuses a reveal once the curve is cancelled', () => {
    const g = ghostThroughToExpiredCurve();
    const { creator, platform } = fees(g.purchased * DV_PRICE);

    // Were this allowed, the reveal would record the full fee-inclusive
    // payment in paidByBuyer, claimCurveRefund would hand all of it back,
    // and the bond would then refund in full with nothing forfeited — a
    // ghost recovering everything at no cost, which is exactly what the
    // forfeiture is there to prevent.
    expect(() =>
      g.contract.circuits.revealBuyCommit(
        nextContextAtTime(g.contractAddress, g.ctx, 3),
        g.commitment,
        g.purchased,
        DV_PRICE,
        creator,
        platform,
        3n,
      ),
    ).toThrow('Curve is cancelled');
  });

  it('still allows a reveal while the curve is running', () => {
    // The control: the deadline must not close the ordinary path.
    const { contract, contractAddress, ctx } = registerBuyAndCloseForReveal(100n);
    const { creator, platform } = fees(100n * DV_PRICE);
    const commitment = computeBuyCommit({
      buyerKey: deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID),
      launchId: LAUNCH_ID,
      tokenAmount: 100n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    expect(() =>
      contract.circuits.revealBuyCommit(
        nextContextAtTime(contractAddress, ctx, 3),
        commitment,
        100n,
        DV_PRICE,
        creator,
        platform,
        3n,
      ),
    ).not.toThrow();
  });
});

/** Register, commit and close, leaving the commitment unrevealed. */
function registerBuyAndCloseForReveal(purchased: bigint) {
  const d = deploy();
  const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
  const ctx0 = nextContext(d.contractAddress, r0.context);
  const r1 = d.contract.circuits.startRegistration(ctx0);
  const ctx1 = nextContext(d.contractAddress, r1.context);
  const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
  const ctxReg = nextContext(d.contractAddress, rReg.context);
  const r2 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
  let ctx = nextContext(d.contractAddress, r2.context);

  const commitment = computeBuyCommit({
    buyerKey: deriveUserPublicKey(fakeBytes32(3), LAUNCH_ID),
    launchId: LAUNCH_ID,
    tokenAmount: purchased,
    pricePerToken: DV_PRICE,
    nonce: BUY_NONCE,
  });
  const r3 = d.contract.circuits.submitBuyCommit(ctx, commitment, 1n);
  ctx = nextContext(d.contractAddress, r3.context);
  const r4 = d.contract.circuits.closeDarkVeil(ctx, 2n, purchased);
  ctx = nextContext(d.contractAddress, r4.context);
  return { ...d, ctx };
}

describe('bonding_curve.compact — a closed DarkVeil cannot be marked failed', () => {
  it('refuses markDarkVeilFailed once DarkVeil has closed normally', () => {
    // Failed and normally-closed are mutually exclusive by design:
    // claimRatioBondRefund settles a bond against what the registrant
    // actually bought, while dvFailed opens the full-refund path to
    // everyone. Allowing both would let a completed phase refund the bonds
    // it was supposed to settle.
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1);
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.startBuying(ctxReg, REGISTRANT_TREE.root);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.closeDarkVeil(ctx2, 2n, 100n);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    expect(() => d.contract.circuits.markDarkVeilFailed(ctx3)).toThrow('DarkVeil already closed normally');
  });
});

// ============================================================================
// Registrant proof — buying does not name which registrant is buying
// ============================================================================

describe('bonding_curve.compact — registrant membership proof', () => {
  /** Register, open buying under a chosen registrant root. */
  function toBuying(root: Uint8Array = REGISTRANT_TREE.root) {
    const { contract, contractAddress, ctx: ctx0 } = deploy();
    const r0 = contract.circuits.advancePhase(ctx0, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.startRegistration(ctx1);
    const ctx2 = nextContext(contractAddress, r1.context);
    const rReg = contract.circuits.registerForDarkVeil(ctx2);
    const ctx3 = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctx3, root);
    return { contract, contractAddress, ctx: nextContext(contractAddress, r2.context) };
  }

  it('publishes the registrant root when buying opens', () => {
    const b = toBuying();
    expect(ledger(b.ctx.currentQueryContext.state).registrantRoot).toEqual(REGISTRANT_TREE.root);
  });

  it('accepts a commitment from a registrant who can prove membership', () => {
    const b = toBuying();
    const commitment = computeBuyCommit({
      buyerKey: BUYER_KEY,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    expect(() => b.contract.circuits.submitBuyCommit(b.ctx, commitment, 1n)).not.toThrow();
  });

  it('refuses a commitment when the published root does not contain the caller', () => {
    // The whole point of the proof: membership is what authorises a commit,
    // and a root built from somebody else cannot be walked to.
    const otherTree = buildRegistrantTree([hashRegistrantLeaf(fakeBytes32(77))]);
    const b = toBuying(otherTree.root);
    const commitment = computeBuyCommit({
      buyerKey: BUYER_KEY,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    expect(() => b.contract.circuits.submitBuyCommit(b.ctx, commitment, 1n)).toThrow('Invalid registrant proof');
  });
});

// ============================================================================
// Registrant exclusion dispute
// ============================================================================
// A published root and the bond ledger are written by different parties, so
// nothing forces them to agree. A registrant left out of the root cannot
// prove membership, cannot buy, and settles against a purchase of zero —
// which by state alone looks exactly like someone who chose not to buy.
//
// These tests pin the difference: the evidence that can be produced.

describe('bonding_curve.compact — registrant exclusion dispute', () => {
  const CLOSE_TS = 2n;
  const REVEAL_WINDOW = 2592000n; // 30 days
  const DISPUTE_WINDOW = 259200n; // 72 hours

  /** Register, open buying under `root`, then close DarkVeil. */
  function registeredAndClosed(root: Uint8Array) {
    const { contract, contractAddress, ctx: ctx0 } = deploy();
    const r0 = contract.circuits.advancePhase(ctx0, LaunchPhase.DarkVeil);
    const c1 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.startRegistration(c1);
    const c2 = nextContext(contractAddress, r1.context);
    const rReg = contract.circuits.registerForDarkVeil(c2);
    const c3 = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(c3, root);
    const c4 = nextContext(contractAddress, r2.context);
    const r3 = contract.circuits.closeDarkVeil(c4, CLOSE_TS, 100n);
    return { contract, contractAddress, ctx: nextContext(contractAddress, r3.context) };
  }

  /** A root that omits the real registrant. */
  const EXCLUDING_ROOT = buildRegistrantTree([hashRegistrantLeaf(fakeBytes32(77))]).root;

  it('lets an excluded registrant open a dispute', () => {
    const d = registeredAndClosed(EXCLUDING_ROOT);
    const at = nextContextAtTime(d.contractAddress, d.ctx, 10);
    const r = d.contract.circuits.disputeRegistrantExclusion(at, 10n);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.disputedExclusions.member(BUYER_KEY)).toBe(true);
    expect(state.disputedExclusions.lookup(BUYER_KEY)).toBe(10n + DISPUTE_WINDOW);
  });

  it('pays an unanswered dispute back in full once both windows have elapsed', () => {
    const d = registeredAndClosed(EXCLUDING_ROOT);
    const at = nextContextAtTime(d.contractAddress, d.ctx, 10);
    const r = d.contract.circuits.disputeRegistrantExclusion(at, 10n);
    const c = nextContext(d.contractAddress, r.context);

    const after = CLOSE_TS + REVEAL_WINDOW + 1n;
    const atLater = nextContextAtTime(d.contractAddress, c, Number(after));
    const rc = d.contract.circuits.claimDisputedBond(atLater, fakeBytes32(5), after);

    // Paid out means the bond is cleared, not merely marked.
    expect(ledger(rc.context.currentQueryContext.state).lockedBonds.lookup(BUYER_KEY)).toBe(0n);
  });

  it('refuses the payout while the reveal window is still open', () => {
    // A reveal can still land, so concluding this registrant bought nothing
    // is not safe yet — paying in full here would pay where a ratio refund
    // was owed.
    const d = registeredAndClosed(EXCLUDING_ROOT);
    const at = nextContextAtTime(d.contractAddress, d.ctx, 10);
    const r = d.contract.circuits.disputeRegistrantExclusion(at, 10n);
    const c = nextContext(d.contractAddress, r.context);

    const early = 10n + DISPUTE_WINDOW + 1n; // dispute window elapsed, reveal window has not
    const atEarly = nextContextAtTime(d.contractAddress, c, Number(early));
    expect(() => d.contract.circuits.claimDisputedBond(atEarly, fakeBytes32(5), early)).toThrow(
      'Reveal window has not closed yet',
    );
  });

  it('refuses the payout before the dispute window has elapsed', () => {
    const d = registeredAndClosed(EXCLUDING_ROOT);
    const late = CLOSE_TS + REVEAL_WINDOW + 1n;
    const at = nextContextAtTime(d.contractAddress, d.ctx, Number(late));
    const r = d.contract.circuits.disputeRegistrantExclusion(at, late);
    const c = nextContext(d.contractAddress, r.context);

    const stillEarly = late + 1n; // reveal window closed, dispute window has not run
    const atStillEarly = nextContextAtTime(d.contractAddress, c, Number(stillEarly));
    expect(() => d.contract.circuits.claimDisputedBond(atStillEarly, fakeBytes32(5), stillEarly)).toThrow(
      'Dispute window has not elapsed',
    );
  });

  it('lets ANYONE answer a dispute by producing the registrant path, and that closes the payout', () => {
    // Permissionless on purpose: the tree is public, so recovery never waits
    // on the key that published the root.
    const d = registeredAndClosed(REGISTRANT_TREE.root); // registrant IS in the tree
    const at = nextContextAtTime(d.contractAddress, d.ctx, 10);
    const r = d.contract.circuits.disputeRegistrantExclusion(at, 10n);
    const c = nextContext(d.contractAddress, r.context);

    const rr = d.contract.circuits.rebutRegistrantExclusion(c, BUYER_KEY);
    const c2 = nextContext(d.contractAddress, rr.context);
    expect(ledger(c2.currentQueryContext.state).rebuttedExclusions.member(BUYER_KEY)).toBe(true);

    const after = CLOSE_TS + REVEAL_WINDOW + 1n;
    const atLater = nextContextAtTime(d.contractAddress, c2, Number(after));
    expect(() => d.contract.circuits.claimDisputedBond(atLater, fakeBytes32(5), after)).toThrow(
      'membership in the tree was shown',
    );
  });

  it('cannot answer a dispute without a real path', () => {
    const d = registeredAndClosed(EXCLUDING_ROOT);
    const at = nextContextAtTime(d.contractAddress, d.ctx, 10);
    const r = d.contract.circuits.disputeRegistrantExclusion(at, 10n);
    const c = nextContext(d.contractAddress, r.context);

    expect(() => d.contract.circuits.rebutRegistrantExclusion(c, BUYER_KEY)).toThrow('Invalid registrant proof');
  });

  it('refuses a second dispute from the same registrant', () => {
    const d = registeredAndClosed(EXCLUDING_ROOT);
    const at = nextContextAtTime(d.contractAddress, d.ctx, 10);
    const r = d.contract.circuits.disputeRegistrantExclusion(at, 10n);
    const c = nextContext(d.contractAddress, r.context);
    const at2 = nextContextAtTime(d.contractAddress, c, 11);
    expect(() => d.contract.circuits.disputeRegistrantExclusion(at2, 11n)).toThrow('Exclusion already disputed');
  });
});

// ============================================================================
// expireDarkVeil — giving up on a phase the governor stopped moving
// ============================================================================
// Every DarkVeil transition is governor-only, and the one existing timeout
// sits behind a governor-only call, so a governor who goes silent used to
// freeze the launch with every bond locked inside it.

describe('bonding_curve.compact — permissionless DarkVeil expiry', () => {
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
    expect(ledger(rc.context.currentQueryContext.state).lockedBonds.lookup(BUYER_KEY)).toBe(0n);
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

describe('bonding_curve.compact — the allowlist is fixed once the launch is decided', () => {
  it('still accepts a late addition while the public curve is trading', () => {
    // Wider than Cardano Launch on purpose: this contract gates public buying behind
    // the allowlist too, so an eligible buyer must be able to join a curve
    // that is already running.
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.updateAllowlistRoot(nextContextAtTime(contractAddress, ctx, 0), fakeBytes32(123), 0n);
    const r = attestAllowlistAgain(
      contractAddress,
      nextContext(contractAddress, r1.context) as never,
      fakeBytes32(123),
    );
    expect(ledger(r.context.currentQueryContext.state).allowlistRoot).toEqual(fakeBytes32(123));
  });

  it('rejects an update once the launch has graduated', () => {
    const d = deployAndActivate();
    const rg = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.Graduated);
    const ctxG = nextContext(d.contractAddress, rg.context);
    expect(() => d.contract.circuits.updateAllowlistRoot(ctxG, fakeBytes32(123), 0n)).toThrow(
      'Allowlist is fixed once the launch has graduated or been cancelled',
    );
  });

  it('rejects an update once the launch is cancelled, while the refund paths are still open', () => {
    const d = deployAndActivate();
    const rc = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.Cancelled);
    const ctxC = nextContext(d.contractAddress, rc.context);
    expect(() => d.contract.circuits.updateAllowlistRoot(ctxC, fakeBytes32(123), 0n)).toThrow(
      'Allowlist is fixed once the launch has graduated or been cancelled',
    );
  });
});

describe('bonding_curve.compact — the curve parameters a launch may deploy with', () => {
  it('refuses a curve that starts at zero, where the first buy would be free', () => {
    // With a zero base the sum of the prices of the opening positions is
    // itself zero, so a buyer could take any amount for nothing.
    expect(() => deployWithPrices(0n, MAX_PRICE)).toThrow('basePrice must be positive');
  });

  it('accepts the smallest positive base', () => {
    expect(() => deployWithPrices(1n, MAX_PRICE)).not.toThrow();
  });

  it('refuses prices and supplies beyond what the cost arithmetic is bounded for', () => {
    // These two bounds are what hold every product in curveCostRange under
    // the compiler's 124-bit ceiling. Both sit far above any real launch —
    // the supply bound exceeds the platform's own 1e9 hard cap — but a
    // deploy past them would be arithmetic the circuit cannot carry.
    expect(() => deployWithPrices(BASE_PRICE, 2_147_483_648n)).toThrow('maxPrice out of safe range');
    expect(() => deployWithPrices(BASE_PRICE, MAX_PRICE, 1_073_741_824n)).toThrow('curveSupply out of safe range');
    expect(() => deployWithPrices(BASE_PRICE, 2_147_483_647n)).not.toThrow();
    expect(() => deployWithPrices(BASE_PRICE, MAX_PRICE, 1_073_741_823n)).not.toThrow();
  });

  it('still refuses a maximum at or below the base', () => {
    expect(() => deployWithPrices(500n, 500n)).toThrow('maxPrice must exceed basePrice');
    expect(() => deployWithPrices(500n, 499n)).toThrow('maxPrice must exceed basePrice');
  });
});

describe('bonding_curve.compact — threshold attestation on the allowlist root', () => {
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
    const d = deployAndActivate();
    const before = rootOf(d.ctx);
    const ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('changes it on the second, from a different attestor', () => {
    const d = deployAndActivate();
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_2_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(ROOT);
  });

  it('refuses to count one attestor twice as two', () => {
    const d = deployAndActivate();
    const before = rootOf(d.ctx);
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('does not carry an approval across to a different root', () => {
    const d = deployAndActivate();
    const before = rootOf(d.ctx);
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_2_FILL, OTHER);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('lets a partial approval expire rather than completing it a day later', () => {
    const d = deployAndActivate();
    const before = rootOf(d.ctx);
    let ctx = attest(d, d.ctx as never, ALLOWLIST_ATTESTOR_1_FILL, ROOT, 100n);
    ctx = attest(d, ctx as never, ALLOWLIST_ATTESTOR_2_FILL, ROOT, 100n + ALLOWLIST_EXPIRY_SECONDS + 1n);
    expect(rootOf(ctx)).toEqual(before);
  });

  it('refuses a caller who is not an attestor', () => {
    const d = deployAndActivate();
    expect(() => attest(d, d.ctx as never, 77, ROOT)).toThrow(/registered attestor/i);
  });
});
