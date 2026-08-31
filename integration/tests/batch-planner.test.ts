// batch-planner.test.ts — the fold that has to agree with the validator's.
//
// A plan the curve disagrees with is not a wrong number, it is a transaction
// that never lands: the validator re-derives every figure and refuses anything
// that does not match. So the tests worth having are the ones that pin the
// properties a plausible-looking implementation gets wrong — pricing each
// order at its own position, threading the cap root through the batch, and
// leaving an unfillable order OUT rather than failing the whole batch with it.
//
// The pricing here is deliberately checked against `curve-pricing`'s own
// functions rather than against hard-coded lovelace figures. Those functions
// are the mirror of the validator, tested against it in their own file; a
// literal here would pin the planner to whatever it happened to produce the
// day it was written.

import { describe, expect, it } from 'vitest';
import {
  type BatchPlan,
  type CandidateOrder,
  MAX_ORDERS_PER_BATCH,
  type PlannerCurve,
  planBatch,
} from '../batch-planner.js';
import { bytesToHex, CAP_EMPTY_ROOT, CapAccumulator, hexToBytes } from '../cap-accumulator-tree.js';
import { buyCost, CREATOR_BPS, feeSlice, PLATFORM_BPS, sellProceeds } from '../curve-pricing.js';

const CREATOR = '99'.repeat(28);
const ALICE = 'aa'.repeat(28);
const BOB = 'bb'.repeat(28);

const NOW = 1_000_000n;
const LATER = NOW + 1_000_000n;

function curve(overrides: Partial<PlannerCurve> = {}): PlannerCurve {
  return {
    base_price: 100n,
    max_price: 1000n,
    curve_supply: 1000n,
    tokens_sold: 0n,
    total_raised: 0n,
    creator_fees_accrued: 0n,
    platform_fees_accrued: 0n,
    wallet_cap: 500n,
    cap_root: bytesToHex(CAP_EMPTY_ROOT),
    creator_pub_key_hash: CREATOR,
    ...overrides,
  };
}

let nextIndex = 0;
function order(overrides: Partial<CandidateOrder> = {}): CandidateOrder {
  nextIndex += 1;
  return {
    txHash: 'ee'.repeat(32),
    outputIndex: nextIndex,
    ownerKeyHashHex: ALICE,
    isBuy: true,
    amount: 100n,
    minReceived: 100n,
    maxSpend: 500_000_000n,
    deadlineMs: LATER,
    heldLovelace: 500_000_000n,
    heldTokens: 0n,
    ...overrides,
  };
}

function plan(orders: CandidateOrder[], opts: Partial<Parameters<typeof planBatch>[0]> = {}): BatchPlan {
  return planBatch({
    shape: 'linear',
    curve: curve(),
    capState: new CapAccumulator(),
    orders,
    nowMs: NOW,
    ...opts,
  });
}

describe('planBatch — pricing', () => {
  it('prices each order where the one before it finished', () => {
    const c = curve();
    const result = plan([
      order({ amount: 400n, minReceived: 400n }),
      order({ ownerKeyHashHex: BOB, amount: 300n, minReceived: 300n }),
    ]);

    expect(result.fills).toHaveLength(2);
    expect(result.fills[0]?.gross).toBe(buyCost('linear', c, 0n, 400n));
    // The property: from 400, not from 0.
    expect(result.fills[1]?.gross).toBe(buyCost('linear', c, 400n, 300n));
    expect(result.fills[1]?.gross).not.toBe(buyCost('linear', c, 0n, 300n));
  });

  it('charges a batch exactly what the same trades cost one at a time', () => {
    const c = curve();
    const split = plan([
      order({ amount: 200n, minReceived: 200n }),
      order({ ownerKeyHashHex: BOB, amount: 300n, minReceived: 300n }),
    ]);
    const together = buyCost('linear', c, 0n, 500n);
    const summed = (split.fills[0]?.gross ?? 0n) + (split.fills[1]?.gross ?? 0n);
    // Cost is additive over adjacent ranges, so splitting a purchase changes
    // nothing. If it did, the batch would be a cheaper way to buy.
    expect(summed).toBe(together);
  });

  it('floors each fee slice independently, leaving the remainder with the curve', () => {
    const result = plan([order({ amount: 333n, minReceived: 333n })]);
    const fill = result.fills[0];
    expect(fill?.creatorFee).toBe(feeSlice(fill?.gross ?? 0n, CREATOR_BPS));
    expect(fill?.platformFee).toBe(feeSlice(fill?.gross ?? 0n, PLATFORM_BPS));
    expect((fill?.creatorFee ?? 0n) + (fill?.platformFee ?? 0n)).toBeLessThanOrEqual(
      ((fill?.gross ?? 0n) * 150n) / 10_000n,
    );
  });

  it('quotes a sell the same range a buy of that size at that position pays', () => {
    const c = curve({ tokens_sold: 500n });
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const result = planBatch({
      shape: 'linear',
      curve: { ...c, cap_root: bytesToHex(state.root) },
      capState: state,
      orders: [order({ isBuy: false, amount: 100n, minReceived: 0n, maxSpend: 100n, heldTokens: 100n })],
      nowMs: NOW,
      // This one is about pricing, not the payout floor.
      minPayoutLovelace: 1n,
    });
    expect(result.fills[0]?.gross).toBe(sellProceeds('linear', c, 400n, 100n));
  });
});

describe('planBatch — the cumulative cap', () => {
  it('threads the root so one wallet cannot split a purchase past the cap', () => {
    // 300 + 300 = 600 against a 500 cap. Each order is under it alone.
    const result = plan([order({ amount: 300n, minReceived: 300n }), order({ amount: 300n, minReceived: 300n })]);
    expect(result.fills).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('exceeds-wallet-cap');
    expect(result.skipped[0]?.detail).toContain('600');
  });

  it('lets one wallet fill two orders that fit together', () => {
    const result = plan([order({ amount: 200n, minReceived: 200n }), order({ amount: 200n, minReceived: 200n })]);
    expect(result.fills).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    // The second proves against what the first left, not against the start.
    expect(result.fills[0]?.capCommittedBefore).toBe(0n);
    expect(result.fills[1]?.capCommittedBefore).toBe(200n);
  });

  it('counts what a wallet already took before the batch', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 400n }]);
    const result = plan([order({ amount: 200n, minReceived: 200n })], {
      curve: curve({ cap_root: bytesToHex(state.root) }),
      capState: state,
    });
    expect(result.fills).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('exceeds-wallet-cap');
  });

  it('gives a sell back its headroom, floored at zero', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 100n }]);
    const c = curve({ tokens_sold: 500n, cap_root: bytesToHex(state.root) });
    const result = planBatch({
      shape: 'linear',
      curve: c,
      capState: state,
      // Selling more than they ever bought here: the total floors rather than
      // going negative, because a seller may hold tokens from elsewhere.
      orders: [order({ isBuy: false, amount: 300n, minReceived: 0n, maxSpend: 300n, heldTokens: 300n })],
      nowMs: NOW,
      minPayoutLovelace: 1n,
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.capCommittedBefore).toBe(100n);
    // A second buy afterwards sees a clear slot.
    expect(result.next.cap_root).toBe(bytesToHex(new CapAccumulator().root));
  });

  it('leaves the caller’s accumulator untouched, so a discarded plan costs nothing', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 100n }]);
    const before = bytesToHex(state.root);
    plan([order({ amount: 200n, minReceived: 200n })], {
      curve: curve({ cap_root: before }),
      capState: state,
    });
    expect(bytesToHex(state.root)).toBe(before);
    expect(state.totalOf(hexToBytes(ALICE))).toBe(100n);
  });

  it('refuses to plan against a stale accumulator rather than producing dead proofs', () => {
    expect(() => plan([order()], { capState: new CapAccumulator([{ key: hexToBytes(BOB), total: 5n }]) })).toThrow(
      /stale/i,
    );
  });
});

describe('planBatch — what it leaves out', () => {
  it('skips rather than fails, and says why', () => {
    const result = plan([
      order({ amount: 600n, minReceived: 600n }), // over the 500 cap
      order({ ownerKeyHashHex: BOB, amount: 100n, minReceived: 100n }), // fine
    ]);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.order.ownerKeyHashHex).toBe(BOB);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('exceeds-wallet-cap');
  });

  it('will not fill an order past its deadline', () => {
    const result = plan([order({ deadlineMs: NOW - 1n })]);
    expect(result.fills).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('expired');
  });

  it('will not fill the creator’s own order', () => {
    const result = plan([order({ ownerKeyHashHex: CREATOR })]);
    expect(result.skipped[0]?.reason).toBe('creator');
  });

  it('will not fill a buy that costs more than the order allows', () => {
    const c = curve();
    const cost = buyCost('linear', c, 0n, 100n);
    const result = plan([order({ amount: 100n, minReceived: 100n, maxSpend: cost - 1n })]);
    expect(result.skipped[0]?.reason).toBe('exceeds-max-spend');
    expect(result.skipped[0]?.detail).toContain(cost.toString());
  });

  it('will not fill a sell whose proceeds fall short of its bound', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const c = curve({ tokens_sold: 500n, cap_root: bytesToHex(state.root) });
    const gross = sellProceeds('linear', c, 400n, 100n);
    const net = gross - feeSlice(gross, CREATOR_BPS) - feeSlice(gross, PLATFORM_BPS);
    const result = planBatch({
      shape: 'linear',
      curve: c,
      capState: state,
      orders: [order({ isBuy: false, amount: 100n, minReceived: net + 1n, maxSpend: 100n, heldTokens: 100n })],
      nowMs: NOW,
    });
    expect(result.skipped[0]?.reason).toBe('below-min-received');
  });

  // Found by a real Preprod rejection, not by reading the ledger spec: a
  // 997,805-lovelace sell payout was refused because the output carrying it
  // needed 1,055,950. Proposing it does not shortchange the seller — it builds
  // a batch the node refuses entire, taking every other order down with it.
  it('will not propose a sell whose proceeds cannot fill their own output', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const c = curve({ tokens_sold: 500n, cap_root: bytesToHex(state.root) });
    const result = planBatch({
      shape: 'linear',
      curve: c,
      capState: state,
      orders: [order({ isBuy: false, amount: 1n, minReceived: 0n, maxSpend: 1n, heldTokens: 1n })],
      nowMs: NOW,
    });
    expect(result.fills).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('proceeds-below-min-ada');
  });

  it('fills a sell large enough to pay for its own output', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const c = curve({ tokens_sold: 500n, cap_root: bytesToHex(state.root) });
    const result = planBatch({
      shape: 'linear',
      curve: c,
      capState: state,
      // The control for the rejection above. Without it that test would pass
      // against a planner that refused every sell.
      orders: [order({ isBuy: false, amount: 500n, minReceived: 0n, maxSpend: 500n, heldTokens: 500n })],
      nowMs: NOW,
      minPayoutLovelace: 1n,
    });
    expect(result.fills).toHaveLength(1);
  });

  it('will not sell more than the curve has outstanding', () => {
    const result = plan([order({ isBuy: false, amount: 100n, minReceived: 0n, maxSpend: 100n, heldTokens: 100n })], {
      curve: curve({ tokens_sold: 0n }),
    });
    expect(result.skipped[0]?.reason).toBe('oversells-curve');
  });

  it('will not sell past the end of the curve’s supply', () => {
    const result = plan([order({ amount: 1001n, minReceived: 1001n })]);
    expect(result.skipped[0]?.reason).toBe('exceeds-remaining-supply');
  });

  // The number itself came from Preprod, not from a fixture: eight orders were
  // refused for EXECUTION UNITS, having used 17,711,813 memory against a
  // 17,500,000 cap while spending only two thirds of the steps allowed. Size
  // was never close. Seven were accepted.
  //
  // Pinned as a literal so changing it is a deliberate act that fails a test.
  // Nothing offline can tell whether 7 is RIGHT — only a node can — so this is
  // a tripwire saying "re-measure", not a proof.
  it('keeps the ceiling at what was measured, or makes you say so', () => {
    expect(MAX_ORDERS_PER_BATCH).toBe(7);
  });

  // This one is real: it fails if the planner stops applying a default at all,
  // which is what would silently hand the node a batch it refuses.
  it('carries no more than the ceiling when nobody says otherwise', () => {
    // A distinct owner each, so the per-wallet cap cannot be what stops it.
    const orders = Array.from({ length: MAX_ORDERS_PER_BATCH + 3 }, (_, i) =>
      order({ ownerKeyHashHex: i.toString(16).padStart(2, '0').repeat(28), amount: 100n, minReceived: 100n }),
    );
    const result = plan(orders);
    expect(result.fills).toHaveLength(MAX_ORDERS_PER_BATCH);
    expect(result.skipped[0]?.reason).toBe('batch-full');
  });

  it('stops at maxOrders and says the rest were not tried', () => {
    const result = plan(
      [
        order({ amount: 100n, minReceived: 100n }),
        order({ ownerKeyHashHex: BOB, amount: 100n, minReceived: 100n }),
        order({ ownerKeyHashHex: BOB, amount: 100n, minReceived: 100n }),
      ],
      { maxOrders: 2 },
    );
    expect(result.fills).toHaveLength(2);
    expect(result.skipped[0]?.reason).toBe('batch-full');
  });
});

describe('planBatch — what the transaction has to build', () => {
  it('returns each buyer’s unspent lovelace, which the order validator requires', () => {
    const c = curve();
    const held = 500_000_000n;
    const result = plan([order({ amount: 100n, minReceived: 100n, heldLovelace: held })]);
    const fill = result.fills[0];
    expect(fill?.change).toBe(held - buyCost('linear', c, 0n, 100n));
    expect(fill?.received).toBe(100n);
  });

  it('returns a seller’s unsold tokens', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const result = planBatch({
      shape: 'linear',
      curve: curve({ tokens_sold: 500n, cap_root: bytesToHex(state.root) }),
      capState: state,
      orders: [order({ isBuy: false, amount: 100n, minReceived: 0n, maxSpend: 100n, heldTokens: 140n })],
      nowMs: NOW,
      minPayoutLovelace: 1n,
    });
    expect(result.fills[0]?.change).toBe(40n);
  });

  it('reports the curve’s own movement, which the validator checks directly', () => {
    const result = plan([
      order({ amount: 400n, minReceived: 400n }),
      order({ ownerKeyHashHex: BOB, amount: 300n, minReceived: 300n }),
    ]);
    const gross = (result.fills[0]?.gross ?? 0n) + (result.fills[1]?.gross ?? 0n);
    // Fees stay in the curve until claimed, so it keeps the whole gross.
    expect(result.curveLovelaceDelta).toBe(gross);
    expect(result.curveTokensSoldDelta).toBe(700n);
  });

  it('reports a net-selling batch as money leaving the curve', () => {
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const result = planBatch({
      shape: 'linear',
      curve: curve({ tokens_sold: 500n, cap_root: bytesToHex(state.root) }),
      capState: state,
      orders: [order({ isBuy: false, amount: 100n, minReceived: 0n, maxSpend: 100n, heldTokens: 100n })],
      nowMs: NOW,
      // This one is about pricing, not the payout floor.
      minPayoutLovelace: 1n,
    });
    expect(result.curveLovelaceDelta).toBeLessThan(0n);
    expect(result.curveTokensSoldDelta).toBe(-100n);
  });

  it('writes the datum the batch adds up to', () => {
    const result = plan([
      order({ amount: 400n, minReceived: 400n }),
      order({ ownerKeyHashHex: BOB, amount: 300n, minReceived: 300n }),
    ]);
    const creator = result.fills.reduce((a, f) => a + f.creatorFee, 0n);
    const platform = result.fills.reduce((a, f) => a + f.platformFee, 0n);
    const gross = result.fills.reduce((a, f) => a + f.gross, 0n);

    expect(result.next.tokens_sold).toBe(700n);
    expect(result.next.creator_fees_accrued).toBe(creator);
    expect(result.next.platform_fees_accrued).toBe(platform);
    expect(result.next.total_raised).toBe(gross - creator - platform);
  });

  it('leaves the curve untouched when nothing can be filled', () => {
    const c = curve();
    const result = plan([order({ deadlineMs: NOW - 1n })]);
    expect(result.fills).toEqual([]);
    expect(result.next.tokens_sold).toBe(c.tokens_sold);
    expect(result.next.cap_root).toBe(c.cap_root);
    expect(result.curveLovelaceDelta).toBe(0n);
  });

  it('carries the order reference each fill has to be tagged with', () => {
    const result = plan([order({ amount: 100n, minReceived: 100n })]);
    expect(result.fills[0]?.order.txHash).toBe('ee'.repeat(32));
    expect(typeof result.fills[0]?.order.outputIndex).toBe('number');
  });
});

describe('planBatch — Cardano Launch is a different curve, not a different fold', () => {
  it('prices quadratically when asked to', () => {
    const c = curve();
    const linear = plan([order({ amount: 400n, minReceived: 400n })]);
    const quadratic = plan([order({ amount: 400n, minReceived: 400n })], { shape: 'quadratic' });
    expect(quadratic.fills[0]?.gross).toBe(buyCost('quadratic', c, 0n, 400n));
    expect(quadratic.fills[0]?.gross).not.toBe(linear.fills[0]?.gross);
  });

  it('threads position on Cardano Launch too', () => {
    const c = curve();
    const result = plan(
      [order({ amount: 400n, minReceived: 400n }), order({ ownerKeyHashHex: BOB, amount: 300n, minReceived: 300n })],
      { shape: 'quadratic' },
    );
    expect(result.fills[1]?.gross).toBe(buyCost('quadratic', c, 400n, 300n));
  });
});
