import { describe, expect, it } from 'vitest';
import { ProposalState, ProposalType } from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  buildVoteResultFromProposal,
  computeCtoVoteProofBundleHash,
  type MidnightProposalLike,
  toCardanoProposalType,
} from '../cto-vote-relayer.js';

function fakeBytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fakeProposal(overrides: Partial<MidnightProposalLike> = {}): MidnightProposalLike {
  return {
    proposalType: ProposalType.SilenceLockTrigger,
    state: ProposalState.Passed,
    descriptionHash: fakeBytes(1),
    yesVotes: 60_000n,
    noVotes: 10_000n,
    voterCount: 5n,
    creatorYesVotes: 0n,
    creatorNoVotes: 0n,
    startTimestamp: 1000n,
    endTimestamp: 2000n,
    allocationAmount: 0n,
    allocationRecipient: fakeBytes(2),
    targetDexAddr: fakeBytes(3),
    ...overrides,
  };
}

describe('cto-vote-relayer.ts — toCardanoProposalType', () => {
  it('maps every real Midnight ProposalType to its Cardano string literal', () => {
    expect(toCardanoProposalType(ProposalType.SilenceLockTrigger)).toBe('SilenceLockTrigger');
    expect(toCardanoProposalType(ProposalType.FundAllocation)).toBe('FundAllocation');
    expect(toCardanoProposalType(ProposalType.DexMigration)).toBe('DexMigration');
    expect(toCardanoProposalType(ProposalType.WhitelistUpdate)).toBe('WhitelistUpdate');
    expect(toCardanoProposalType(ProposalType.DissolveCTO)).toBe('DissolveCTOProposal');
    expect(toCardanoProposalType(ProposalType.VestingToLp)).toBe('VestingToLp');
    expect(toCardanoProposalType(ProposalType.VestingToStaking)).toBe('VestingToStaking');
    expect(toCardanoProposalType(ProposalType.VestingToTreasury)).toBe('VestingToTreasury');
  });
});

describe('cto-vote-relayer.ts — buildVoteResultFromProposal (pure)', () => {
  it('rejects a proposal that has not finalized (still Active)', () => {
    const proposal = fakeProposal({ state: ProposalState.Active });
    expect(() => buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc')).toThrow(/has not finalized/i);
  });

  it('rejects a Pending proposal', () => {
    const proposal = fakeProposal({ state: ProposalState.Pending });
    expect(() => buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc')).toThrow(/has not finalized/i);
  });

  it('rejects an already-Executed proposal (finalization check only accepts Passed/Failed)', () => {
    const proposal = fakeProposal({ state: ProposalState.Executed });
    expect(() => buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc')).toThrow(/has not finalized/i);
  });

  it('accepts DexMigration and encodes targetDexAddr as a ScriptCredential', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.DexMigration,
      targetDexAddr: fakeBytes(7),
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.targetDexCredential).toEqual({
      ScriptCredential: [fakeBytes(7).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')],
    });
  });

  it('accepts WhitelistUpdate and encodes targetDexAddr as a ScriptCredential', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.WhitelistUpdate,
      targetDexAddr: fakeBytes(9),
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.targetDexCredential).toEqual({
      ScriptCredential: [fakeBytes(9).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')],
    });
  });

  it('accepts a Passed SilenceLockTrigger and derives outcome Passed', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.SilenceLockTrigger,
      state: ProposalState.Passed,
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.outcome).toBe('Passed');
    expect(result.params.proposalType).toBe('SilenceLockTrigger');
    expect(result.bundle.outcome).toBe('Passed');
  });

  it('accepts a Failed proposal and derives outcome Failed', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.FundAllocation,
      state: ProposalState.Failed,
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.outcome).toBe('Failed');
  });

  it('accepts DissolveCTO and maps to DissolveCTOProposal', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.DissolveCTO,
      state: ProposalState.Passed,
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.proposalType).toBe('DissolveCTOProposal');
  });

  it('carries a disposition vote through with the figure it named', () => {
    const lp = buildVoteResultFromProposal(
      fakeProposal({ proposalType: ProposalType.VestingToLp, allocationAmount: 4_500_000_000n }),
      'aa',
      'bb',
      'cc',
    );
    expect(lp.params.proposalType).toBe('VestingToLp');
    expect(lp.params.allocationAmount).toBe(4_500_000_000n);
    expect(lp.params.targetDexCredential).toBeNull();
    const runway = buildVoteResultFromProposal(
      fakeProposal({ proposalType: ProposalType.VestingToStaking, allocationAmount: 1_095n }),
      'aa',
      'bb',
      'cc',
    );
    expect(runway.params.proposalType).toBe('VestingToStaking');
    expect(runway.params.allocationAmount).toBe(1_095n);
    const treasury = buildVoteResultFromProposal(
      fakeProposal({ proposalType: ProposalType.VestingToTreasury }),
      'aa',
      'bb',
      'cc',
    );
    expect(treasury.params.proposalType).toBe('VestingToTreasury');
  });

  it('sets targetDexCredential to null for the 3 non-DEX proposal types', () => {
    for (const proposalType of [
      ProposalType.SilenceLockTrigger,
      ProposalType.FundAllocation,
      ProposalType.DissolveCTO,
    ]) {
      const proposal = fakeProposal({ proposalType });
      const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
      expect(result.params.targetDexCredential).toBeNull();
    }
  });

  it('the proof bundle hash changes when targetDexAddr differs for a DexMigration proposal', () => {
    const p1 = fakeProposal({
      proposalType: ProposalType.DexMigration,
      targetDexAddr: fakeBytes(1),
    });
    const p2 = fakeProposal({
      proposalType: ProposalType.DexMigration,
      targetDexAddr: fakeBytes(2),
    });
    const r1 = buildVoteResultFromProposal(p1, 'aa', 'bb', 'cc', 500n);
    const r2 = buildVoteResultFromProposal(p2, 'aa', 'bb', 'cc', 500n);
    expect(r1.proofBundleHash).not.toEqual(r2.proofBundleHash);
  });

  it('threads the caller-supplied launchId/proposalId/relayerCredentialHash through to the bundle and params', () => {
    const proposal = fakeProposal();
    const result = buildVoteResultFromProposal(proposal, 'deadbeef', 'cafebabe', 'facefeed');
    expect(result.bundle.proposalId).toBe('deadbeef');
    expect(result.bundle.launchId).toBe('cafebabe');
    expect(result.params.relayerCredentialHash).toBe('facefeed');
  });

  it('uses the caller-supplied anchorTimestamp when given', () => {
    const proposal = fakeProposal();
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc', 999_999n);
    expect(result.params.anchorTimestamp).toBe(999_999n);
  });

  it('the proof bundle hash is deterministic — same proposal produces the same hash', () => {
    const proposal = fakeProposal();
    const r1 = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc', 500n);
    const r2 = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc', 500n);
    expect(r1.proofBundleHash).toEqual(r2.proofBundleHash);
  });

  it('the proof bundle hash changes when vote counts differ', () => {
    const p1 = fakeProposal({ yesVotes: 1000n });
    const p2 = fakeProposal({ yesVotes: 2000n });
    const r1 = buildVoteResultFromProposal(p1, 'aa', 'bb', 'cc', 500n);
    const r2 = buildVoteResultFromProposal(p2, 'aa', 'bb', 'cc', 500n);
    expect(r1.proofBundleHash).not.toEqual(r2.proofBundleHash);
  });
});

describe('cto-vote-relayer.ts — computeCtoVoteProofBundleHash', () => {
  it('produces a real 32-byte Blake2b-256 digest', () => {
    const hash = computeCtoVoteProofBundleHash({
      launchId: 'aa',
      proposalId: 'bb',
      proposalType: 'SilenceLockTrigger',
      descriptionHash: 'cc',
      yesVotes: '100',
      noVotes: '0',
      voterCount: '1',
      creatorYesVotes: '0',
      creatorNoVotes: '0',
      outcome: 'Passed',
      startTimestamp: '0',
      endTimestamp: '1',
      targetDexAddrHex: '',
    });
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });
});
