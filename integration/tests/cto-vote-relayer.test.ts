import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { ProposalState, ProposalType } from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import { CtoGovernanceDatumSchema } from '../cardano-cto-anchor-submitter.js';
import {
  anchoredBallotOf,
  buildVoteResultFromProposal,
  computeCtoVoteProofBundleHash,
  type MidnightProposalLike,
  midnightSecondsToCardanoMs,
  toCardanoProposalType,
} from '../cto-vote-relayer.js';
import { cardanoKeyHashToBallotField, cardanoScriptHashToBallotField } from '../cto-wallet-field.js';
import { buildGenesisDatums } from '../tier-a-genesis-datums.js';
import { BLUEPRINT } from './support/takeover-chain.js';

function fakeBytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const COMMUNITY = 'c2'.repeat(28);
/** A DEX vote's target: a 28-byte script hash, filled with one byte. */
const dexField = (fill: number) => cardanoScriptHashToBallotField(fill.toString(16).padStart(2, '0').repeat(28));
const RECIPIENT = 'a2'.repeat(28);

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
    allocationRecipient: cardanoKeyHashToBallotField(RECIPIENT),
    proposedCommunityWallet: cardanoKeyHashToBallotField(COMMUNITY),
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

  it('records a proposal already executed on Midnight as passed, since only a passed one can be', () => {
    const proposal = fakeProposal({ state: ProposalState.Executed });
    expect(buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc').params.outcome).toBe('Passed');
  });

  it('accepts DexMigration and records its target as the 28-byte script hash the field carries', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.DexMigration,
      targetDexAddr: dexField(7),
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.targetDexCredential).toEqual({ ScriptCredential: ['07'.repeat(28)] });
  });

  it('accepts WhitelistUpdate and records its target as the 28-byte script hash the field carries', () => {
    const proposal = fakeProposal({
      proposalType: ProposalType.WhitelistUpdate,
      targetDexAddr: dexField(9),
    });
    const result = buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc');
    expect(result.params.targetDexCredential).toEqual({ ScriptCredential: ['09'.repeat(28)] });
  });

  it('refuses a DEX target field that does not hold a Cardano script hash, rather than record 32 bytes as one', () => {
    for (const proposalType of [ProposalType.DexMigration, ProposalType.WhitelistUpdate]) {
      const proposal = fakeProposal({ proposalType, targetDexAddr: fakeBytes(7) });
      expect(() => buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc')).toThrow(
        /targetDexAddr does not hold a Cardano script hash/,
      );
    }
  });

  it('ignores the DEX field on every other type, whatever it holds', () => {
    const proposal = fakeProposal({ proposalType: ProposalType.SilenceLockTrigger, targetDexAddr: fakeBytes(7) });
    expect(buildVoteResultFromProposal(proposal, 'aa', 'bb', 'cc').params.targetDexCredential).toBeNull();
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
      targetDexAddr: dexField(1),
    });
    const p2 = fakeProposal({
      proposalType: ProposalType.DexMigration,
      targetDexAddr: dexField(2),
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

describe('cto-vote-relayer.ts — the ballot window crosses from seconds to milliseconds', () => {
  // A real ballot: Midnight stamps it in POSIX seconds, 72 hours wide.
  const START_S = 1_790_000_000n;
  const END_S = START_S + 259_200n;

  it('anchors the window in milliseconds and keeps the Midnight seconds in the bundle', () => {
    const result = buildVoteResultFromProposal(
      fakeProposal({ startTimestamp: START_S, endTimestamp: END_S }),
      'aa',
      'bb',
      'cc',
    );
    expect(result.params.startTimestamp).toBe(1_790_000_000_000n);
    expect(result.params.endTimestamp).toBe(1_790_259_200_000n);
    expect(result.bundle.startTimestamp).toBe('1790000000');
    expect(result.bundle.endTimestamp).toBe('1790259200');
  });

  it('describes a window exactly as wide as the one a launch records at mint', async () => {
    const genesis = await buildGenesisDatums({
      blueprint: BLUEPRINT as never,
      network: 'preprod',
      tier: 'B',
      creatorPubKeyHashHex: '11'.repeat(28),
      governorPubKeyHashHex: '22'.repeat(28),
      bondPayoutPubKeyHashHex: '44'.repeat(28),
      tokenPolicyIdHex: 'bb'.repeat(28),
      tokenBaseNameHex: Buffer.from('WIDTH').toString('hex'),
      tokenName: 'Width',
      tokenDescription: 'A launch whose ballot window is measured.',
      threadNftPolicyIdHex: 'a1'.repeat(28),
      poolNftPolicyIdHex: 'a2'.repeat(28),
      basePrice: 3,
      maxPrice: 75,
      creatorAllocPct: 5,
      vestDays: 180,
      genesisTimestampMs: 1_785_000_000_000,
    });
    const record = Data.from(genesis.datums.ctoGovernance, CtoGovernanceDatumSchema);
    const { params } = buildVoteResultFromProposal(
      fakeProposal({ startTimestamp: START_S, endTimestamp: END_S }),
      'aa',
      'bb',
      'cc',
    );
    // Both sides in milliseconds: the record compares this window with the
    // graduation time and the cooldown, which are.
    expect(record.ballot_duration).toBe(259_200_000n);
    expect(params.endTimestamp - params.startTimestamp).toBe(record.ballot_duration);
  });

  it('refuses a time already at millisecond scale rather than scaling it twice', () => {
    expect(() => midnightSecondsToCardanoMs(1_790_000_000_000n)).toThrow(/not a Midnight ballot time/);
    expect(() =>
      buildVoteResultFromProposal(
        fakeProposal({ startTimestamp: 1_790_000_000_000n, endTimestamp: 1_790_259_200_000n }),
        'aa',
        'bb',
        'cc',
      ),
    ).toThrow(/not a Midnight ballot time/);
  });
});

describe('cto-vote-relayer.ts — whom an execution pays', () => {
  it('takes a takeover community wallet from the field the proposal pinned it in', () => {
    const ballot = anchoredBallotOf(fakeProposal({ proposalType: ProposalType.SilenceLockTrigger }), 'aa');
    expect(ballot.allocationRecipientHashHex).toBe(COMMUNITY);
  });

  it('takes a fund allocation recipient from its own field', () => {
    const ballot = anchoredBallotOf(
      fakeProposal({ proposalType: ProposalType.FundAllocation, allocationAmount: 5n }),
      'aa',
    );
    expect(ballot.allocationRecipientHashHex).toBe(RECIPIENT);
  });

  it('names no payee for a type whose execution pays nobody', () => {
    for (const proposalType of [
      ProposalType.DissolveCTO,
      ProposalType.VestingToLp,
      ProposalType.VestingToStaking,
      ProposalType.VestingToTreasury,
    ]) {
      expect(anchoredBallotOf(fakeProposal({ proposalType }), 'aa').allocationRecipientHashHex).toBe('');
    }
  });

  it('refuses a wallet field that does not hold a Cardano key hash', () => {
    const full = new Uint8Array(32).fill(0xc2);
    expect(() =>
      anchoredBallotOf(
        fakeProposal({ proposalType: ProposalType.SilenceLockTrigger, proposedCommunityWallet: full }),
        'aa',
      ),
    ).toThrow(/does not hold a Cardano payment key hash/);
  });
});
