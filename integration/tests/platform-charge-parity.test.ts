// platform-charge-parity.test.ts — asserts the platform charge the submitters
// quote is the charge the validators actually enforce.
//
// WHY THIS EXISTS
// ---------------
// This is the drift that produced a real, measurable gap. The charge lives in
// two places by necessity: a validator names it so the chain can enforce it,
// and a submitter names it so a transaction can pay it. Nothing connected the
// two, so they were free to disagree — and they did. A submitter quoting one
// figure while the chain enforces a smaller one is invisible: every transaction
// still succeeds, the tests still pass, and the only symptom is that less
// arrives than the platform believes it charged.
//
// TypeScript cannot catch this, because both sides are separately valid. So the
// test reads the real validator source and compares the number.
//
// WHAT IS COMPARED
// ----------------
// The literal assigned to `platform_charge_lovelace` in each validator that
// declares one, against the constant each submitter exports. All of them must
// agree on one figure. The point is not the specific value — it is that no one
// copy can move without this failing.
//
// WHY READ THE SOURCE RATHER THAN THE BLUEPRINT
// ---------------------------------------------
// A compile-time constant is inlined by the time it reaches plutus.json; there
// is no named field to read back. The .ak source is where the figure is stated,
// so it is what gets read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_CHARGE_LOVELACE as QUADRATIC_CURVE_CHARGE } from '../tier-b-curve-submitter.js';

const VALIDATORS = join(process.cwd(), '..', 'contracts', 'cardano', 'validators');

/** The literal a validator assigns to `platform_charge_lovelace`. */
function chargeDeclaredIn(validator: string): bigint {
  const source = readFileSync(join(VALIDATORS, validator), 'utf-8');
  const matches = [...source.matchAll(/\bconst platform_charge_lovelace\s*=\s*([0-9_]+)/g)];
  // Exactly one declaration, or the regex is reading something other than what
  // it thinks it is — which would make a passing assertion meaningless.
  expect(matches, `${validator} should declare platform_charge_lovelace exactly once`).toHaveLength(1);
  return BigInt(matches[0][1].replace(/_/g, ''));
}

describe('the platform charge is one figure, on chain and off', () => {
  const staking = 'staking_pool.ak';
  const quadratic = 'bonding_curve_tier_b.ak';

  it('every validator that charges declares the same amount', () => {
    const declared = [staking, quadratic].map((v) => [v, chargeDeclaredIn(v)] as const);
    const distinct = new Set(declared.map(([, amount]) => amount.toString()));
    expect(
      distinct.size,
      `validators disagree on the charge: ${declared.map(([v, a]) => `${v}=${a}`).join(', ')}`,
    ).toBe(1);
  });

  it('the quadratic curve submitter quotes what that validator enforces', () => {
    expect(QUADRATIC_CURVE_CHARGE).toBe(chargeDeclaredIn(quadratic));
  });

  it('the charge clears the protocol minimum ada a real claim measured', () => {
    // 1,055,950 lovelace, measured on Preprod. A charge at or below this is not
    // a charge at all: min-ada would already force that much into the output,
    // so the figure named in the contract would never be the figure that binds.
    const MEASURED_MIN_ADA_FOR_THE_CHARGE_OUTPUT = 1_055_950n;
    expect(chargeDeclaredIn(quadratic)).toBeGreaterThan(MEASURED_MIN_ADA_FOR_THE_CHARGE_OUTPUT);
    expect(chargeDeclaredIn(staking)).toBeGreaterThan(MEASURED_MIN_ADA_FOR_THE_CHARGE_OUTPUT);
  });
});
