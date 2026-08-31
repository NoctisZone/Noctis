// trade-history-actions.test.ts
//
// The history reader turns a redeemer's constructor INDEX back into an action
// name, and for a long time it did so from hand-written index -> name maps
// with nothing checking them. They drifted: merging the treasury and ops fee
// claims into one removed an index, so from that point every later variant sat
// one lower than the maps said. A real SellTokens decoded as `ClaimOpsFees`, a
// real ClaimBuyback as `ExpireCurve`, and `BatchTrades` was unknown entirely.
//
// Nothing failed, because this module had no tests — while the trade feed and
// the CTO creator-activity check both read it.
//
// The maps are now derived from the same named table `redeemer-indices.test.ts`
// pins against the blueprint, so an index cannot drift. What remains testable
// is the join: a field list keyed by a constructor name that does not exist
// would silently decode that action as having no fields at all.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BONDING_CURVE_REDEEMER, BONDING_CURVE_TIER_B_REDEEMER } from '../redeemer-indices.js';
import {
  BONDING_CURVE_ACTIONS,
  BONDING_CURVE_TIER_B_ACTIONS,
  CURVE_FIELDS,
  VESTING_ACTIONS,
  VESTING_FIELDS,
} from '../tier-a-trade-history-reader.js';

interface Blueprint {
  definitions: Record<string, { anyOf?: Array<{ title: string; index: number }> }>;
}
const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);
const titles = (definition: string) => new Set((blueprint.definitions[definition]?.anyOf ?? []).map((c) => c.title));

describe('field lists name constructors that exist', () => {
  // A typo here costs nothing at compile time and decodes the action's fields
  // as `field0`, `field1` — losing exactly the names a consumer reads.
  it('every curve field list belongs to a real constructor on one tier or the other', () => {
    const real = new Set([
      ...titles('bonding_curve/BondingCurveRedeemer'),
      ...titles('bonding_curve_tier_b/BondingCurveTierBRedeemer'),
    ]);
    for (const name of Object.keys(CURVE_FIELDS)) expect(real, `${name} is not a curve redeemer`).toContain(name);
  });

  it('every vesting field list belongs to a real constructor', () => {
    const real = titles('vesting/VestingRedeemer');
    for (const name of Object.keys(VESTING_FIELDS)) expect(real, `${name} is not a vesting redeemer`).toContain(name);
  });
});

describe('the drift that actually happened', () => {
  // Written as literals on purpose. The point is to notice a SHIFT, and a test
  // that reads the same table the code reads cannot.
  it('decodes the linear curve index 4 as a sell, not an ops fee claim', () => {
    expect(BONDING_CURVE_ACTIONS[4]?.[0]).toBe('SellTokens');
    expect(BONDING_CURVE_ACTIONS[7]?.[0]).toBe('ClaimBuyback');
    expect(BONDING_CURVE_ACTIONS[12]?.[0]).toBe('BatchTrades');
  });

  it('does not reuse the linear curve’s numbering for Cardano Launch, which differs from index 2 on', () => {
    expect(BONDING_CURVE_TIER_B_ACTIONS[2]?.[0]).toBe('ClaimDarkVeilTokens');
    expect(BONDING_CURVE_TIER_B_ACTIONS[13]?.[0]).toBe('SellTokens');
    // The same name, two different numbers — which is the whole hazard.
    expect(BONDING_CURVE_TIER_B_REDEEMER.SellTokens).not.toBe(BONDING_CURVE_REDEEMER.SellTokens);
  });

  it('gives a trade its named fields on both tiers', () => {
    expect(BONDING_CURVE_ACTIONS[BONDING_CURVE_REDEEMER.BuyTokens]?.[1]).toEqual(['token_amount', 'buyer_key_hash']);
    expect(BONDING_CURVE_TIER_B_ACTIONS[BONDING_CURVE_TIER_B_REDEEMER.SellTokens]?.[1]).toEqual([
      'token_amount',
      'seller_key_hash',
    ]);
  });

  it('covers every constructor each validator declares', () => {
    expect(Object.keys(BONDING_CURVE_ACTIONS)).toHaveLength(titles('bonding_curve/BondingCurveRedeemer').size);
    expect(Object.keys(VESTING_ACTIONS)).toHaveLength(titles('vesting/VestingRedeemer').size);
  });
});
