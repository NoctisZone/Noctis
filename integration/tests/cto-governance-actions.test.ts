import { describe, expect, it } from 'vitest';
import { ProposalType } from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  ATTESTOR_ACTIONS,
  CTO_ACTIONS,
  descriptionHashOf,
  IDENTITY_ACTIONS,
  identityFor,
  isCtoAction,
  OFFLINE_ACTIONS,
  OPEN_ACTIONS,
  resolveCurrentTimestamp,
  resolveProposalArgs,
  TIMESTAMP_FUTURE_TOLERANCE_SECONDS,
  TIMESTAMP_STALE_LIMIT_SECONDS,
} from '../cto-governance-actions.js';

const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);

describe('action roles', () => {
  it('assigns every action to exactly one identity class', () => {
    for (const action of CTO_ACTIONS) {
      const classes = [ATTESTOR_ACTIONS, IDENTITY_ACTIONS, OPEN_ACTIONS, OFFLINE_ACTIONS].filter((s) => s.has(action));
      expect(classes, action).toHaveLength(1);
    }
  });

  it('names the secret each action is made with', () => {
    expect(identityFor('publish-snapshot')).toBe('attestor');
    expect(identityFor('update-activity')).toBe('attestor');
    expect(identityFor('vote')).toBe('identity');
    expect(identityFor('create-proposal')).toBe('identity');
    expect(identityFor('heartbeat')).toBe('identity');
    expect(identityFor('claim-bond')).toBe('identity');
    expect(identityFor('finalize')).toBe('none');
    expect(identityFor('execute')).toBe('none');
    expect(identityFor('sweep-bond')).toBe('none');
    expect(identityFor('read')).toBe('none');
  });

  it('recognises an action name and nothing else', () => {
    expect(isCtoAction('vote')).toBe(true);
    expect(isCtoAction('castVote')).toBe(false);
    expect(isCtoAction(undefined)).toBe(false);
  });
});

describe('resolveCurrentTimestamp', () => {
  const NOW = 1_800_000_000;

  it('defaults to now, in seconds', () => {
    expect(resolveCurrentTimestamp(undefined, NOW)).toBe(BigInt(NOW));
    expect(resolveCurrentTimestamp('', NOW)).toBe(BigInt(NOW));
  });

  it('accepts a recent value in either form', () => {
    expect(resolveCurrentTimestamp(NOW - 5, NOW)).toBe(BigInt(NOW - 5));
    expect(resolveCurrentTimestamp(String(NOW - 5), NOW)).toBe(BigInt(NOW - 5));
  });

  it('refuses the future beyond the tolerance, and accepts it within', () => {
    expect(resolveCurrentTimestamp(NOW + TIMESTAMP_FUTURE_TOLERANCE_SECONDS, NOW)).toBe(
      BigInt(NOW + TIMESTAMP_FUTURE_TOLERANCE_SECONDS),
    );
    expect(() => resolveCurrentTimestamp(NOW + TIMESTAMP_FUTURE_TOLERANCE_SECONDS + 1, NOW)).toThrow(/in the future/);
  });

  it('refuses a value the inclusion delay could push past the contract hour', () => {
    expect(resolveCurrentTimestamp(NOW - TIMESTAMP_STALE_LIMIT_SECONDS, NOW)).toBe(
      BigInt(NOW - TIMESTAMP_STALE_LIMIT_SECONDS),
    );
    expect(() => resolveCurrentTimestamp(NOW - TIMESTAMP_STALE_LIMIT_SECONDS - 1, NOW)).toThrow(/behind now/);
  });

  it('refuses milliseconds, negatives and non-integers by name', () => {
    expect(() => resolveCurrentTimestamp(NOW * 1000, NOW)).toThrow(/milliseconds/);
    expect(() => resolveCurrentTimestamp(-1, NOW)).toThrow(/negative/);
    expect(() => resolveCurrentTimestamp('soon', NOW)).toThrow(/POSIX seconds/);
  });
});

describe('resolveProposalArgs', () => {
  const BASE = { bondAmount: '1000000', descriptionHashHex: hex(0x40) };

  it('hashes description text reproducibly when no hash is given', () => {
    const a = resolveProposalArgs({ proposalType: 'DissolveCTO', description: 'Dissolve', bondAmount: '5' });
    const b = resolveProposalArgs({ proposalType: 'DissolveCTO', description: 'Dissolve', bondAmount: '5' });
    expect(a.descriptionHash).toEqual(b.descriptionHash);
    expect(a.descriptionHash).toEqual(descriptionHashOf('Dissolve'));
    expect(a.descriptionHash).toHaveLength(32);
    expect(a.proposalType).toBe(ProposalType.DissolveCTO);
  });

  it('refuses a proposal with neither hash nor text', () => {
    expect(() => resolveProposalArgs({ proposalType: 'DissolveCTO', bondAmount: '5' })).toThrow(/descriptionHashHex/);
  });

  it('SilenceLockTrigger needs a community wallet', () => {
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'SilenceLockTrigger' })).toThrow(
      /proposedCommunityWalletHex/,
    );
    const ok = resolveProposalArgs({
      ...BASE,
      proposalType: 'SilenceLockTrigger',
      proposedCommunityWalletHex: hex(0x90),
    });
    expect(ok.proposalType).toBe(ProposalType.SilenceLockTrigger);
    expect(Buffer.from(ok.proposedCommunityWallet).toString('hex')).toBe(hex(0x90));
    // Untouched fields are the contract's "unused" zero bytes, not garbage.
    expect(ok.targetDexAddr.every((b) => b === 0)).toBe(true);
    expect(ok.allocationAmount).toBe(0n);
  });

  it('FundAllocation needs a positive amount and a recipient', () => {
    expect(() =>
      resolveProposalArgs({ ...BASE, proposalType: 'FundAllocation', allocationRecipientHex: hex(0x91) }),
    ).toThrow(/positive allocationAmount/);
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'FundAllocation', allocationAmount: '10' })).toThrow(
      /allocationRecipientHex/,
    );
    const ok = resolveProposalArgs({
      ...BASE,
      proposalType: 'FundAllocation',
      allocationAmount: '10',
      allocationRecipientHex: hex(0x91),
    });
    expect(ok.allocationAmount).toBe(10n);
  });

  it('DexMigration and WhitelistUpdate need a target', () => {
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'DexMigration' })).toThrow(/targetDexAddrHex/);
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'WhitelistUpdate' })).toThrow(/targetDexAddrHex/);
    expect(
      resolveProposalArgs({ ...BASE, proposalType: 'DexMigration', targetDexAddrHex: hex(0x92) }).proposalType,
    ).toBe(ProposalType.DexMigration);
  });

  it('holds the bond to the contract floor when one is known, and refuses zero always', () => {
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'DissolveCTO', bondAmount: '0' })).toThrow(
      /bondAmount must be positive/,
    );
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'DissolveCTO', bondAmount: '999' }, 1000n)).toThrow(
      /below the contract's minimum/,
    );
    expect(resolveProposalArgs({ ...BASE, proposalType: 'DissolveCTO', bondAmount: '1000' }, 1000n).bondAmount).toBe(
      1000n,
    );
  });

  it('refuses an unknown type by name', () => {
    expect(() => resolveProposalArgs({ ...BASE, proposalType: 'Takeover' })).toThrow(/proposalType must be one of/);
  });
});
