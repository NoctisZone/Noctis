import { describe, expect, it } from 'vitest';
import {
  CtoState,
  type Ledger,
  type Proposal,
  ProposalState,
  ProposalType,
} from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import { summarizeCtoGovernance } from '../midnight-public-state.js';

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function mapOf<V>(entries: [Uint8Array, V][]) {
  const key = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const store = new Map(entries.map(([k, v]) => [key(k), [k, v] as [Uint8Array, V]]));
  return {
    isEmpty: () => store.size === 0,
    size: () => BigInt(store.size),
    member: (k: Uint8Array) => store.has(key(k)),
    lookup: (k: Uint8Array) => {
      const hit = store.get(key(k));
      if (!hit) throw new Error('lookup miss');
      return hit[1];
    },
    [Symbol.iterator]: () => store.values(),
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    proposalType: ProposalType.FundAllocation,
    proposerKey: bytes(0x10),
    descriptionHash: bytes(0x11),
    startTimestamp: 1_000n,
    endTimestamp: 260_200n,
    yesVotes: 60_000_000n,
    noVotes: 1n,
    voterCount: 15n,
    state: ProposalState.Passed,
    creatorYesVotes: 0n,
    creatorNoVotes: 0n,
    targetDexAddr: bytes(0),
    allocationAmount: 5n,
    allocationRecipient: bytes(0x12),
    proposedCommunityWallet: bytes(0),
    balanceSnapshotRoot: bytes(0x13),
    ...overrides,
  };
}

function fakeLedger(): Ledger {
  const idA = bytes(0xa1);
  const idB = bytes(0xb2);
  return {
    ctoState: CtoState.CTOTriggered,
    communityWallet: bytes(0x90),
    lastCreatorActivity: 7n,
    hasClaimableBalance: true,
    lastProposalEnd: 260_200n,
    proposals: mapOf([
      [idA, proposal()],
      [idB, proposal({ proposalType: ProposalType.SilenceLockTrigger, state: ProposalState.Executed })],
    ]),
    voteNullifiers: {
      isEmpty: () => false,
      size: () => 15n,
      member: () => false,
      [Symbol.iterator]: () => [][Symbol.iterator](),
    },
    proposalCount: 2n,
    activeProposalCount: 0n,
    balanceSnapshotRoot: bytes(0x13),
    lastSnapshotTimestamp: 500n,
    pendingSnapshotRoot: bytes(0x14),
    pendingSnapshotTimestamp: 600n,
    pendingSnapshotOpenedAt: 600n,
    snapshotRound: 3n,
    // One approval for this round, one stale from round 2.
    snapshotApprovals: mapOf([
      [bytes(0x21), 3n],
      [bytes(0x22), 2n],
    ]),
    pendingActivityTimestamp: 0n,
    pendingActivityClaimable: false,
    pendingActivityOpenedAt: 0n,
    activityRound: 0n,
    activityApprovals: mapOf([]),
    pendingCommunityWallet: bytes(0),
    pendingCommunityWalletAt: 0n,
    proposalBonds: mapOf([[idA, 1_000_000n]]),
    lastGovernorUpdateTimestamp: 0n,
    breakGlassChallenge: { challenger: bytes(0), bondAmount: 0n, challengeTimestamp: 0n, state: 0 },
  } as unknown as Ledger;
}

describe('summarizeCtoGovernance', () => {
  it("names every enum, surfaces every proposal id, and counts only this round's approvals", () => {
    const s = summarizeCtoGovernance(fakeLedger());
    expect(s.ctoState).toBe('CTOTriggered');
    expect(s.snapshotRound).toBe('3');
    expect(s.snapshotApprovalsThisRound).toBe(1);
    expect(s.balanceSnapshotRootHex).toBe('13'.repeat(32));
    expect(s.proposals.map((p) => p.proposalIdHex)).toEqual(['a1'.repeat(32), 'b2'.repeat(32)]);
    expect(s.proposals[0]).toMatchObject({
      proposalType: 'FundAllocation',
      state: 'Passed',
      yesVotes: '60000000',
      voterCount: '15',
      bond: '1000000',
    });
    expect(s.proposals[1]).toMatchObject({ proposalType: 'SilenceLockTrigger', state: 'Executed', bond: null });
  });

  it('is JSON-serialisable as is — no bigint, no byte array survives', () => {
    const s = summarizeCtoGovernance(fakeLedger());
    expect(() => JSON.stringify(s)).not.toThrow();
    const walk = (v: unknown): void => {
      if (typeof v === 'bigint' || v instanceof Uint8Array) throw new Error('raw value leaked');
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    expect(() => walk(s)).not.toThrow();
  });
});
