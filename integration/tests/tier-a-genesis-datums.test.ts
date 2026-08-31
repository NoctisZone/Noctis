// The genesis datum builder had no test at all. This covers the one field
// this change made load-bearing rather than inert: `phase_started_at`.
//
// It is the clock ExpireCurve measures its stall window from, and ExpireCurve
// now reaches Inactive — so a genesis writing zero here would not be a cosmetic
// default, it would mean every launch is expirable from the moment it is
// minted, by anyone, before the governor has activated it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { buildGenesisDatums } from '../tier-a-genesis-datums.js';
import { BondingCurveDatumSchema, BondingCurveTierBDatumSchema } from '../tier-a-schemas.js';

const KEYHASH = 'aa'.repeat(28);
const POLICY = 'bb'.repeat(28);

// The builder's own default resolves relative to the bundled CLI, so a test
// has to supply this — see the `blueprint` input's comment.
const blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

function input(overrides: Record<string, unknown> = {}) {
  return {
    blueprint,
    network: 'preprod' as const,
    creatorPubKeyHashHex: KEYHASH,
    governorPubKeyHashHex: 'cc'.repeat(28),
    treasuryPubKeyHashHex: 'dd'.repeat(28),
    opsPubKeyHashHex: 'ee'.repeat(28),
    tokenPolicyIdHex: POLICY,
    tokenBaseNameHex: Buffer.from('TEST').toString('hex'),
    tokenName: 'Test Token',
    tokenDescription: 'A launch built only to inspect its genesis datum.',
    threadNftPolicyIdHex: 'ff'.repeat(28),
    basePrice: 3,
    maxPrice: 75,
    vestDays: 90,
    ...overrides,
  };
}

describe('tier-a-genesis-datums.ts — the stall clock starts at the mint', () => {
  it('stamps phase_started_at with the genesis time on the linear curve, not zero', async () => {
    const at = 1_785_000_000_000;
    const g = await buildGenesisDatums(input({ genesisTimestampMs: at }));
    const datum = Data.from(g.datums.bondingCurve, BondingCurveDatumSchema);
    expect(datum.phase_started_at).toBe(BigInt(at));
  });

  it('stamps phase_started_at with the genesis time on Cardano Launch too', async () => {
    const at = 1_785_000_000_000;
    const g = await buildGenesisDatums(input({ tier: 'B', genesisTimestampMs: at }));
    const datum = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    expect(datum.phase_started_at).toBe(BigInt(at));
  });

  it('defaults to now rather than zero when no genesis time is given', async () => {
    // The default is the case that actually ships — an explicit timestamp is
    // the test-and-reproducibility path — so leaving it at zero would be the
    // real bug and this is the test that would catch it.
    const before = Date.now();
    const g = await buildGenesisDatums(input());
    const after = Date.now();
    const datum = Data.from(g.datums.bondingCurve, BondingCurveDatumSchema);
    expect(datum.phase_started_at).toBeGreaterThanOrEqual(BigInt(before));
    expect(datum.phase_started_at).toBeLessThanOrEqual(BigInt(after));
  });

  it('opens the curve Inactive, which is the state the stall clock is timing', async () => {
    const g = await buildGenesisDatums(input());
    const datum = Data.from(g.datums.bondingCurve, BondingCurveDatumSchema);
    expect(datum.curve_state).toBe('Inactive');
  });
});
