// ============================================================================
// Noctis Zone — CTO anchor: the bundle reference, derived
// ============================================================================
// The TypeScript twin of `derive_proof_bundle_hash` in
// `contracts/cardano/validators/cto_governance.ak`.
//
// WHY A TWIN EXISTS AT ALL
// `AnchorVoteResult` is open relay: anyone may anchor a finalized Midnight
// ballot on Cardano, because a platform-only relay could suppress a legitimate
// community takeover simply by never submitting. That makes every redeemer
// field the submitter's to name — which is answerable for the numbers, since
// they are checked against the launch's own deployed rules, but was not
// answerable for the bundle reference: it used to be carried into the stored
// record unexamined.
//
// The validator now derives that reference instead of accepting one, from the
// launch id and ballot ordinal in its OWN datum together with the result being
// claimed. A relayer therefore cannot present one launch's genuine reference as
// evidence for another's ballot, nor keep a reference while editing the numbers
// underneath it. But the relayer still authors the continuing datum, so its
// submitter has to reproduce the value exactly — hence this module.
//
// WHAT IT DOES NOT ESTABLISH, stated plainly: neither side proves a Midnight
// ballot happened, and no Cardano validator can. This makes the reference
// honest about which ballot it belongs to; the defences against an invented
// tally are the distinct-voter floor, the quorum and majority tests, the
// ballot-window width, the graduation gate, and the governor's challenge window.
//
// ENCODING
// Fixed-width big-endian fields, not CBOR. Reproducing a serialised record
// across two languages would mean matching an encoder's choices byte for byte —
// indefinite-length arrays, constructor tags — which is a fragile thing to owe.
// Every variable-length byte string is hashed to 32 bytes first, so no two
// different field splits can produce one preimage.
//
// `cto-anchor-reference-parity.test.ts` pins the same literal the Aiken test
// `anchor_reference_matches_the_pinned_cross_language_value` pins. The two
// implementations share no code, so that literal is what turns a silent drift
// into a red test on whichever side moved.
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';

/** Tags must match `proposal_type_tag` in cto_governance.ak. */
export const PROPOSAL_TYPE_TAG = {
  SilenceLockTrigger: 0,
  FundAllocation: 1,
  DexMigration: 2,
  WhitelistUpdate: 3,
  DissolveCTOProposal: 4,
} as const;
export type ProposalTypeName = keyof typeof PROPOSAL_TYPE_TAG;

/** Tags must match `outcome_tag` in cto_governance.ak. */
export const OUTCOME_TAG = { Passed: 0, Failed: 1 } as const;
export type OutcomeName = keyof typeof OUTCOME_TAG;

/**
 * The target DEX, exactly as `target_dex_bytes` encodes it: a one-byte kind
 * tag then a fixed 32 bytes, so an absent target and a present one can never
 * encode alike, and a key-hash credential can never encode as the script
 * credential carrying the same bytes.
 */
export type TargetDexCredential =
  | null
  | { kind: 'VerificationKey'; hashHex: string }
  | { kind: 'Script'; hashHex: string };

/** Everything the reference commits to, beyond the launch id and ordinal. */
export interface AnchoredBallot {
  proposalType: ProposalTypeName;
  descriptionHashHex: string;
  yesVotes: bigint;
  noVotes: bigint;
  voterCount: bigint;
  creatorYesVotes: bigint;
  creatorNoVotes: bigint;
  outcome: OutcomeName;
  startTimestamp: bigint;
  endTimestamp: bigint;
  targetDexCredential: TargetDexCredential;
  /** What an execution pays: 0 for every type but FundAllocation. */
  allocationAmount: bigint;
  /** Whom it pays — the FundAllocation payee, or the SilenceLockTrigger community wallet; empty otherwise. */
  allocationRecipientHashHex: string;
}

export interface AnchorReferenceInput {
  /** From the governance UTXO's own datum — not the relayer's to choose. */
  launchIdHex: string;
  /** From the same datum: this launch's ballot ordinal. */
  proposalCount: bigint;
  /** The Midnight ballot being relayed. */
  proposalIdHex: string;
  ballot: AnchoredBallot;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has an odd length (${clean.length}): ${hex}`);
  }
  if (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`not a hex string: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 32 });
}

/**
 * Mirrors Aiken's `bytearray.from_int_big_endian(value, width)`, including its
 * refusal to encode a negative value or one too wide for the field — silently
 * truncating either would produce a reference the validator does not agree
 * with, which is a far worse failure than throwing here.
 */
function intToBigEndian(value: bigint, width: number): Uint8Array {
  if (value < 0n) {
    throw new Error(`cannot encode a negative value (${value}) as big-endian bytes`);
  }
  const out = new Uint8Array(width);
  let remaining = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) {
    throw new Error(`value ${value} does not fit in ${width} bytes`);
  }
  return out;
}

function targetDexBytes(target: TargetDexCredential): Uint8Array {
  const empty = blake2b256(new Uint8Array(0));
  if (target === null) {
    return concat([new Uint8Array([0x00]), empty]);
  }
  const tag = target.kind === 'VerificationKey' ? 0x01 : 0x02;
  return concat([new Uint8Array([tag]), blake2b256(hexToBytes(target.hashHex))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The reference `cto_governance.ak` will derive for this ballot.
 *
 * Field order and widths are load-bearing — they must stay identical to
 * `derive_proof_bundle_hash`. See this module's header.
 */
export function deriveAnchorReference(input: AnchorReferenceInput): Uint8Array {
  const { launchIdHex, proposalCount, proposalIdHex, ballot } = input;
  return blake2b256(
    concat([
      blake2b256(hexToBytes(launchIdHex)),
      intToBigEndian(proposalCount, 8),
      blake2b256(hexToBytes(proposalIdHex)),
      intToBigEndian(BigInt(PROPOSAL_TYPE_TAG[ballot.proposalType]), 1),
      blake2b256(hexToBytes(ballot.descriptionHashHex)),
      intToBigEndian(ballot.yesVotes, 16),
      intToBigEndian(ballot.noVotes, 16),
      intToBigEndian(ballot.voterCount, 8),
      intToBigEndian(ballot.creatorYesVotes, 16),
      intToBigEndian(ballot.creatorNoVotes, 16),
      intToBigEndian(BigInt(OUTCOME_TAG[ballot.outcome]), 1),
      intToBigEndian(ballot.startTimestamp, 8),
      intToBigEndian(ballot.endTimestamp, 8),
      targetDexBytes(ballot.targetDexCredential),
      // The payee and amount an execution will write are part of what the
      // ballot decided, so the reference commits to both — mirrored field for
      // field from the validator's own derivation.
      intToBigEndian(ballot.allocationAmount, 16),
      blake2b256(hexToBytes(ballot.allocationRecipientHashHex)),
    ]),
  );
}

/** Hex convenience for callers building a datum field directly. */
export function deriveAnchorReferenceHex(input: AnchorReferenceInput): string {
  return bytesToHex(deriveAnchorReference(input));
}
