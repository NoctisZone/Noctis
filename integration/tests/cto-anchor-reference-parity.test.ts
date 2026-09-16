// The TypeScript derivation of a CTO anchor's bundle reference agrees with the
// Aiken one, byte for byte.
//
// WHY THIS MATTERS MORE THAN A UNIT TEST
// The relayer's submitter authors the continuing datum, and `cto_governance.ak`
// checks that datum against the reference it derives itself. If the two
// derivations disagree by a single byte, every anchor this codebase builds is
// rejected on chain — and nothing in either language would say so, because each
// side is internally consistent. The literal below is pinned identically by the
// Aiken test `anchor_reference_matches_the_pinned_cross_language_value`. The two
// implementations share no code, so the literal is the only thing tying them
// together.
//
// If this test goes red, do not update the literal to match. Find which side
// moved. Changing the preimage is a deliberate act that changes both.

import { describe, expect, it } from 'vitest';
import {
  type AnchoredBallot,
  bytesToHex,
  deriveAnchorReference,
  deriveAnchorReferenceHex,
} from '../cto-anchor-reference.js';

/** The exact fixture `mock_anchor_base(1000, 1500, 1500)` builds in Aiken. */
const PINNED_BALLOT: AnchoredBallot = {
  proposalType: 'SilenceLockTrigger',
  descriptionHashHex: 'aa',
  yesVotes: 60_000n,
  noVotes: 10_000n,
  voterCount: 15n,
  creatorYesVotes: 0n,
  creatorNoVotes: 0n,
  outcome: 'Passed',
  startTimestamp: 1000n,
  endTimestamp: 1500n,
  targetDexCredential: null,
  allocationAmount: 0n,
  allocationRecipientHashHex: 'ff',
};

const PINNED_INPUT = {
  launchIdHex: '01',
  proposalCount: 0n,
  proposalIdHex: '9e',
  ballot: PINNED_BALLOT,
};

/** Pinned identically in contracts/cardano/validators/cto_governance.ak. */
const PINNED_REFERENCE = 'c04de299af23512ff11de1d4a0c5c2965f42635f4e34e5731c4fde5c63ad9277';

describe('the CTO anchor bundle reference agrees across Aiken and TypeScript', () => {
  it('derives the value the validator pins', () => {
    expect(deriveAnchorReferenceHex(PINNED_INPUT)).toBe(PINNED_REFERENCE);
  });

  it('produces 32 bytes', () => {
    expect(deriveAnchorReference(PINNED_INPUT)).toHaveLength(32);
  });
});

describe('every field the reference commits to actually changes it', () => {
  // Without these, the parity test above could pass against a derivation that
  // ignored most of its input — one literal agreeing proves the two sides match
  // on ONE ballot, not that either binds anything.
  const base = deriveAnchorReferenceHex(PINNED_INPUT);

  const variants: [string, typeof PINNED_INPUT][] = [
    ['launch id', { ...PINNED_INPUT, launchIdHex: '02' }],
    ['ballot ordinal', { ...PINNED_INPUT, proposalCount: 1n }],
    ['Midnight ballot id', { ...PINNED_INPUT, proposalIdHex: '7a' }],
    ['proposal type', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, proposalType: 'DissolveCTOProposal' } }],
    ['description hash', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, descriptionHashHex: 'ab' } }],
    ['yes votes', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, yesVotes: 60_001n } }],
    ['no votes', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, noVotes: 10_001n } }],
    ['voter count', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, voterCount: 16n } }],
    ['creator yes votes', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, creatorYesVotes: 1n } }],
    ['creator no votes', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, creatorNoVotes: 1n } }],
    ['outcome', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, outcome: 'Failed' } }],
    ['ballot start', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, startTimestamp: 1001n } }],
    ['ballot end', { ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, endTimestamp: 1501n } }],
    [
      'target DEX presence',
      {
        ...PINNED_INPUT,
        ballot: { ...PINNED_BALLOT, targetDexCredential: { kind: 'Script', hashHex: 'ff' } },
      },
    ],
  ];

  for (const [field, variant] of variants) {
    it(`changing the ${field} changes the reference`, () => {
      expect(deriveAnchorReferenceHex(variant)).not.toBe(base);
    });
  }

  it('distinguishes a key-hash credential from a script credential carrying the same bytes', () => {
    // The one-byte kind tag exists for this. Without it the two encode alike.
    const asKey = deriveAnchorReferenceHex({
      ...PINNED_INPUT,
      ballot: { ...PINNED_BALLOT, targetDexCredential: { kind: 'VerificationKey', hashHex: 'ff' } },
    });
    const asScript = deriveAnchorReferenceHex({
      ...PINNED_INPUT,
      ballot: { ...PINNED_BALLOT, targetDexCredential: { kind: 'Script', hashHex: 'ff' } },
    });
    expect(asKey).not.toBe(asScript);
  });
});

describe('the integer encoding refuses what Aiken refuses', () => {
  // Aiken's from_int_big_endian aborts on both of these. Silently truncating
  // instead would produce a reference the validator disagrees with, and the
  // transaction would fail on chain with nothing pointing here.
  it('throws on a negative value rather than encoding one', () => {
    expect(() => deriveAnchorReference({ ...PINNED_INPUT, ballot: { ...PINNED_BALLOT, yesVotes: -1n } })).toThrow(
      /negative/,
    );
  });

  it('throws on a value too wide for its field', () => {
    expect(() => deriveAnchorReference({ ...PINNED_INPUT, proposalCount: 2n ** 64n })).toThrow(
      /does not fit in 8 bytes/,
    );
  });

  it('accepts the widest value each field really allows', () => {
    expect(() => deriveAnchorReference({ ...PINNED_INPUT, proposalCount: 2n ** 64n - 1n })).not.toThrow();
  });
});

describe('hex input handling', () => {
  it('rejects an odd-length hex string instead of dropping a nibble', () => {
    expect(() => deriveAnchorReference({ ...PINNED_INPUT, launchIdHex: 'abc' })).toThrow(/odd length/);
  });

  it('rejects a non-hex string', () => {
    expect(() => deriveAnchorReference({ ...PINNED_INPUT, launchIdHex: 'zz' })).toThrow(/not a hex string/);
  });

  it('accepts an empty byte string, which Aiken hashes the same way', () => {
    expect(() => deriveAnchorReference({ ...PINNED_INPUT, launchIdHex: '' })).not.toThrow();
  });

  it('round-trips bytes to hex without losing leading zeroes', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe('000fff');
  });
});
