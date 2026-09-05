// Each case is the valid input with ONE field changed, so the field under test
// is the only thing it can fail on — the same discipline as the eligibility
// gate's deploy-args tests.

import { describe, expect, it } from 'vitest';
import {
  CTO_MAX_VOTER_CAP_PCT,
  CTO_MIN_VOTER_COUNT,
  resolveCtoGovernanceDeployArgs,
} from '../cto-governance-deploy-args.js';

const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);

const VALID = {
  launchIdHex: hex(0x01),
  totalSupply: '1000000000',
  graduationTimestamp: '1780000000',
  creatorPubKeyHex: hex(0x03),
  hasClaimableBalance: true,
  breakGlassBondMin: '1000000',
  platformAddrHex: hex(0x04),
  attestorKeysHex: [hex(0xa1), hex(0xa2), hex(0xa3)] as [string, string, string],
  attestThreshold: 2,
};

describe('resolveCtoGovernanceDeployArgs', () => {
  it('resolves a valid input, deriving the voter cap and the voter floor from the constants', () => {
    const args = resolveCtoGovernanceDeployArgs(VALID);
    expect(CTO_MAX_VOTER_CAP_PCT).toBe(1);
    expect(CTO_MIN_VOTER_COUNT).toBe(15);
    // 1% of 1,000,000,000.
    expect(args.maxVoterCap).toBe(10_000_000n);
    expect(args.minVoterCount).toBe(15n);
    expect(args.attestThreshold).toBe(2n);
    expect(args.graduationTimestamp).toBe(1_780_000_000n);
    expect(args.launchId).toHaveLength(32);
    expect(args.attestorKeys).toHaveLength(3);
  });

  it('accepts a supplied maxVoterCap that agrees, and refuses one that does not', () => {
    expect(resolveCtoGovernanceDeployArgs({ ...VALID, maxVoterCap: '10000000' }).maxVoterCap).toBe(10_000_000n);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, maxVoterCap: '10000001' })).toThrow(
      /does not equal totalSupply \* maxVoterCapPercent \/ 100/,
    );
  });

  it('honours an explicit percent and refuses one outside 1..100', () => {
    expect(resolveCtoGovernanceDeployArgs({ ...VALID, maxVoterCapPercent: 2 }).maxVoterCap).toBe(20_000_000n);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, maxVoterCapPercent: 0 })).toThrow(/maxVoterCapPercent/);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, maxVoterCapPercent: 101 })).toThrow(/maxVoterCapPercent/);
  });

  it('refuses a cap that derives to zero', () => {
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, totalSupply: '50' })).toThrow(/derives to zero/);
  });

  it('refuses a zero minVoterCount and a non-integer one', () => {
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, minVoterCount: 0 })).toThrow(/minVoterCount/);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, minVoterCount: 1.5 })).toThrow(/minVoterCount/);
  });

  it('refuses an all-zero attestor key', () => {
    expect(() =>
      resolveCtoGovernanceDeployArgs({ ...VALID, attestorKeysHex: [hex(0x00), hex(0xa2), hex(0xa3)] }),
    ).toThrow(/attestorKeysHex\[0\] cannot be all zero/);
  });

  it('refuses two attestors sharing a key', () => {
    expect(() =>
      resolveCtoGovernanceDeployArgs({ ...VALID, attestorKeysHex: [hex(0xa1), hex(0xa1), hex(0xa3)] }),
    ).toThrow(/attestorKeysHex\[0\] and \[1\] are the same key/);
  });

  it('refuses a threshold that is not 2 or 3', () => {
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, attestThreshold: 1 })).toThrow(/attestThreshold/);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, attestThreshold: 4 })).toThrow(/attestThreshold/);
  });

  it('refuses an empty creator key, an empty platform address, and a zero bond floor', () => {
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, creatorPubKeyHex: hex(0x00) })).toThrow(/creatorPubKeyHex/);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, platformAddrHex: hex(0x00) })).toThrow(/platformAddrHex/);
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, breakGlassBondMin: '0' })).toThrow(/breakGlassBondMin/);
  });

  it('refuses a non-boolean hasClaimableBalance', () => {
    expect(() =>
      resolveCtoGovernanceDeployArgs({ ...VALID, hasClaimableBalance: 'yes' as unknown as boolean }),
    ).toThrow(/hasClaimableBalance/);
  });

  it('refuses a malformed hex field by name', () => {
    expect(() => resolveCtoGovernanceDeployArgs({ ...VALID, launchIdHex: 'abc' })).toThrow(/launchIdHex/);
  });
});
