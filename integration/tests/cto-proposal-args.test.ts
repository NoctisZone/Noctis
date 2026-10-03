import { describe, expect, it } from 'vitest';
import {
  BROWSER_PROPOSAL_TYPES,
  CTO_WINDOWS,
  descriptionHashOf,
  PROPOSAL_TYPE_NAMES,
  type ProposalGateState,
  proposalDescriptionText,
  proposalOpening,
  readProposalDescription,
} from '../cto-proposal-args.js';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('descriptionHashOf', () => {
  // Vectors from Python's hashlib.sha256 over the UTF-8 text.
  it('is SHA-256 of the UTF-8 text', () => {
    expect(toHex(descriptionHashOf('Dissolve'))).toBe(
      '8bb135de011f7811ca340e2e84e83a7728450c69cb8708016a1a356c9e424a95',
    );
    expect(toHex(descriptionHashOf('Übergabe ✓'))).toBe(
      '0220ffdd4771df9d219f4722843b2485ad673ff05d39d840d9f9c2e3bd7a3a63',
    );
  });
});

describe('proposalDescriptionText', () => {
  const KEY = 'a5'.repeat(32);

  it('writes one fixed document, so its hash is reproducible', () => {
    const text = proposalDescriptionText({
      title: ' Hand JINX to its holders ',
      text: 'The creator has been silent since June.\n',
      communityWalletPubKey: KEY.toUpperCase(),
    });
    expect(text).toBe(
      `{"noctis":"cto-proposal","v":1,"title":"Hand JINX to its holders","text":"The creator has been silent since June.","communityWalletPubKey":"${KEY}"}`,
    );
    expect(toHex(descriptionHashOf(text))).toBe('b119e2d7e07516ec2c266df2e4e078722e82771118bac937fd58de94b01057d9');
  });

  it('carries no key unless one is given, and refuses a malformed one', () => {
    expect(proposalDescriptionText({ title: 'Dissolve', text: '' })).toBe(
      '{"noctis":"cto-proposal","v":1,"title":"Dissolve","text":""}',
    );
    expect(() => proposalDescriptionText({ title: 'x', text: '', communityWalletPubKey: 'a5'.repeat(31) })).toThrow(
      /32-byte/,
    );
    expect(() => proposalDescriptionText({ title: '  ', text: 'x' })).toThrow(/title/);
  });

  it('reads back what it wrote, and plain text as the whole of it', () => {
    const doc = proposalDescriptionText({ title: 'T', text: 'body', communityWalletPubKey: KEY });
    expect(readProposalDescription(doc)).toEqual({ title: 'T', text: 'body', communityWalletPubKey: KEY });
    expect(readProposalDescription('Dissolve the takeover')).toEqual({ title: '', text: 'Dissolve the takeover' });
    expect(readProposalDescription('{"title":"not ours"}')).toEqual({ title: '', text: '{"title":"not ours"}' });
  });
});

describe('proposalOpening', () => {
  const DAY = 86_400n;
  const NOW = 1_800_000_000n;
  const base: ProposalGateState = {
    ctoState: 'PreCTO',
    hasClaimableBalance: true,
    lastCreatorActivity: NOW - 100n * DAY,
    lastProposalEnd: 0n,
    activeProposalCount: 0n,
    lastSnapshotTimestamp: NOW - DAY,
    balanceSnapshotRootHex: 'ab'.repeat(32),
  };
  const taken = { ...base, ctoState: 'CTOTriggered' };

  it('opens a takeover vote on a silent launch with fees to recover', () => {
    expect(proposalOpening(base, 'SilenceLockTrigger', NOW)).toEqual({ open: true });
  });

  it('opens every other browser type only after a takeover', () => {
    for (const t of BROWSER_PROPOSAL_TYPES.filter((x) => x !== 'SilenceLockTrigger')) {
      expect(proposalOpening(base, t, NOW).open).toBe(false);
      expect(proposalOpening(taken, t, NOW)).toEqual({ open: true });
    }
    expect(proposalOpening(taken, 'SilenceLockTrigger', NOW).open).toBe(false);
    expect(proposalOpening({ ...base, ctoState: 'CTODissolved' }, 'SilenceLockTrigger', NOW).open).toBe(false);
  });

  it('offers every type, the two DEX types included, now that their target is carried as a script hash', () => {
    expect([...BROWSER_PROPOSAL_TYPES].sort()).toEqual([...PROPOSAL_TYPE_NAMES].sort());
  });

  it('waits for a snapshot to exist', () => {
    const r = proposalOpening({ ...base, balanceSnapshotRootHex: '00'.repeat(32) }, 'SilenceLockTrigger', NOW);
    expect(r).toMatchObject({ open: false, reason: expect.stringMatching(/snapshot/) });
  });

  it('lets only a takeover vote rest on a snapshot past 90 days', () => {
    const at = (age: bigint) => ({ ...base, lastSnapshotTimestamp: NOW - age });
    expect(proposalOpening(at(CTO_WINDOWS.maxSnapshotAge), 'SilenceLockTrigger', NOW)).toEqual({ open: true });
    const mid = proposalOpening(at(CTO_WINDOWS.maxSnapshotAge + 1n), 'SilenceLockTrigger', NOW);
    expect(mid).toMatchObject({
      open: false,
      fromSeconds: NOW - CTO_WINDOWS.maxSnapshotAge - 1n + CTO_WINDOWS.staleSnapshotGrace,
    });
    expect(proposalOpening(at(CTO_WINDOWS.staleSnapshotGrace), 'SilenceLockTrigger', NOW)).toEqual({ open: true });
    const other = proposalOpening(
      { ...at(CTO_WINDOWS.staleSnapshotGrace), ctoState: 'CTOTriggered' },
      'DissolveCTO',
      NOW,
    );
    expect(other).toMatchObject({ open: false });
    expect('fromSeconds' in other).toBe(false);
  });

  it('waits 90 days after graduation, to the second', () => {
    const grad = NOW - CTO_WINDOWS.postGraduation;
    expect(proposalOpening(base, 'SilenceLockTrigger', NOW, grad)).toEqual({ open: true });
    expect(proposalOpening(base, 'SilenceLockTrigger', NOW, grad + 1n)).toMatchObject({
      open: false,
      fromSeconds: NOW + 1n,
    });
  });

  it('waits out the cooldown after the last ballot, to the second', () => {
    const end = NOW - CTO_WINDOWS.cooldown;
    expect(proposalOpening({ ...base, lastProposalEnd: end }, 'SilenceLockTrigger', NOW)).toEqual({ open: true });
    expect(proposalOpening({ ...base, lastProposalEnd: end + 1n }, 'SilenceLockTrigger', NOW)).toMatchObject({
      open: false,
      fromSeconds: NOW + 1n,
    });
  });

  it('runs one ballot at a time', () => {
    expect(proposalOpening({ ...base, activeProposalCount: 1n }, 'SilenceLockTrigger', NOW).open).toBe(false);
  });

  it('needs 90 days of creator silence and fees to recover', () => {
    const recent = { ...base, lastCreatorActivity: NOW - CTO_WINDOWS.silence + 1n };
    expect(proposalOpening(recent, 'SilenceLockTrigger', NOW)).toMatchObject({ open: false, fromSeconds: NOW + 1n });
    expect(proposalOpening({ ...base, hasClaimableBalance: false }, 'SilenceLockTrigger', NOW).open).toBe(false);
  });
});
