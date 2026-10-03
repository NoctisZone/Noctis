// ============================================================================
// Noctis Zone — a takeover proposal's arguments, checked before they cost a proof
// ============================================================================
// The per-type fields a proposal must carry, held to the rules the contract
// asserts, so a bad proposal is refused before a proof is spent on it. Kept
// free of Node-only modules: the command-line action and the browser's
// proposal form both build their arguments here.
// ============================================================================

import { sha256 } from '@noble/hashes/sha2.js';
import { ProposalType } from '../contracts/midnight/compiled/cto_governance/contract/index.js';
import { cardanoKeyHashToBallotField } from './cto-wallet-field.js';

/** 32 bytes from 64 hex characters, or an error naming the field. */
function fromHex32(hex: unknown, label: string): Uint8Array {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label}: expected 64 hex characters (32 bytes), got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const PROPOSAL_TYPE_NAMES = [
  'SilenceLockTrigger',
  'FundAllocation',
  'DexMigration',
  'WhitelistUpdate',
  'DissolveCTO',
  'VestingToLp',
  'VestingToStaking',
  'VestingToTreasury',
] as const;
export type ProposalTypeName = (typeof PROPOSAL_TYPE_NAMES)[number];

export interface ProposalInput {
  proposalType: ProposalTypeName | string;
  /** 32 bytes hex; or give `description` and the SHA-256 of its UTF-8 is used. */
  descriptionHashHex?: string;
  description?: string;
  /** DexMigration / WhitelistUpdate: the target, 32 bytes hex. */
  targetDexAddrHex?: string;
  /**
   * FundAllocation: the amount, with `allocationRecipientHex`.
   * VestingToLp: the lovelace the community wallet pairs with the tokens.
   * VestingToStaking: a new pool's runway in days, or 0 to top up the
   * launch's existing pool.
   */
  allocationAmount?: string | number;
  /**
   * FundAllocation: the recipient. A Cardano Launch names a 28-byte payment
   * key hash, stored in the ballot's 32-byte field (see cto-wallet-field.ts);
   * 32 bytes are taken as they are.
   */
  allocationRecipientHex?: string;
  /** SilenceLockTrigger: the wallet the community takes over with, as `allocationRecipientHex`. */
  proposedCommunityWalletHex?: string;
  /** NIGHT atomic units, at least the contract's breakGlassBondMin. Taken from the proposer's wallet. */
  bondAmount: string | number;
}

export interface ResolvedProposal {
  proposalType: ProposalType;
  proposalTypeName: ProposalTypeName;
  descriptionHash: Uint8Array;
  targetDexAddr: Uint8Array;
  allocationAmount: bigint;
  allocationRecipient: Uint8Array;
  proposedCommunityWallet: Uint8Array;
  bondAmount: bigint;
}

/** The runway a disposition vote may give a staking pool it creates, in days. */
export const DISPOSITION_RUNWAY_MIN_DAYS = 1095n;
export const DISPOSITION_RUNWAY_MAX_DAYS = 1825n;

const ZERO32 = new Uint8Array(32);
const isZero = (b: Uint8Array) => b.every((x) => x === 0);

function optionalHex32(value: string | undefined, label: string): Uint8Array {
  if (value === undefined || value === '') return ZERO32;
  return fromHex32(value, label);
}

/** A wallet field: a Cardano payment key hash (28 bytes) is placed in it, 32 bytes are taken as they are. */
function optionalWallet(value: string | undefined, label: string): Uint8Array {
  if (value === undefined || value === '') return ZERO32;
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  return clean.length === 56 ? cardanoKeyHashToBallotField(clean, label) : fromHex32(value, label);
}

function toBigInt(value: string | number | undefined, label: string): bigint {
  if (value === undefined || value === '') return 0n;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label}: not an integer, got ${JSON.stringify(value)}`);
  }
  if (parsed < 0n) throw new Error(`${label}: must not be negative, got ${parsed}`);
  return parsed;
}

/** SHA-256 of the UTF-8 text: any 32-byte commitment satisfies the contract, and this one is reproducible from the text. */
export function descriptionHashOf(description: string): Uint8Array {
  return sha256(new TextEncoder().encode(description));
}

export function resolveProposalArgs(input: ProposalInput, breakGlassBondMin?: bigint): ResolvedProposal {
  const name = input.proposalType as ProposalTypeName;
  if (!PROPOSAL_TYPE_NAMES.includes(name)) {
    throw new Error(
      `proposalType must be one of ${PROPOSAL_TYPE_NAMES.join(', ')}, got ${JSON.stringify(input.proposalType)}`,
    );
  }
  const proposalType = ProposalType[name];

  let descriptionHash: Uint8Array;
  if (input.descriptionHashHex) {
    descriptionHash = fromHex32(input.descriptionHashHex, 'descriptionHashHex');
  } else if (typeof input.description === 'string' && input.description.trim() !== '') {
    descriptionHash = descriptionHashOf(input.description);
  } else {
    throw new Error('A proposal needs descriptionHashHex, or description text to hash.');
  }

  const targetDexAddr = optionalHex32(input.targetDexAddrHex, 'targetDexAddrHex');
  const allocationRecipient = optionalWallet(input.allocationRecipientHex, 'allocationRecipientHex');
  const proposedCommunityWallet = optionalWallet(input.proposedCommunityWalletHex, 'proposedCommunityWalletHex');
  const allocationAmount = toBigInt(input.allocationAmount, 'allocationAmount');

  switch (name) {
    case 'SilenceLockTrigger':
      if (isZero(proposedCommunityWallet)) {
        throw new Error(
          'SilenceLockTrigger needs proposedCommunityWalletHex — the contract refuses an empty community wallet.',
        );
      }
      break;
    case 'FundAllocation':
      if (allocationAmount === 0n) throw new Error('FundAllocation needs a positive allocationAmount.');
      if (isZero(allocationRecipient)) {
        throw new Error('FundAllocation needs allocationRecipientHex — the contract refuses an empty recipient.');
      }
      break;
    case 'DexMigration':
    case 'WhitelistUpdate':
      if (isZero(targetDexAddr)) throw new Error(`${name} needs targetDexAddrHex.`);
      break;
    case 'DissolveCTO':
      break;
    // A takeover's second vote, held to the terms the contract asserts. That
    // a takeover holds is the contract's to check against its own state.
    case 'VestingToLp':
      if (allocationAmount === 0n) {
        throw new Error('VestingToLp needs allocationAmount: the lovelace the community wallet pairs with the tokens.');
      }
      break;
    case 'VestingToStaking':
      if (
        allocationAmount !== 0n &&
        (allocationAmount < DISPOSITION_RUNWAY_MIN_DAYS || allocationAmount > DISPOSITION_RUNWAY_MAX_DAYS)
      ) {
        throw new Error(
          `VestingToStaking's allocationAmount is a new pool's runway, ${DISPOSITION_RUNWAY_MIN_DAYS} to ` +
            `${DISPOSITION_RUNWAY_MAX_DAYS} days, or 0 to top up the launch's existing pool; got ${allocationAmount}.`,
        );
      }
      break;
    case 'VestingToTreasury':
      break;
  }

  const bondAmount = toBigInt(input.bondAmount, 'bondAmount');
  if (bondAmount === 0n) throw new Error('bondAmount must be positive — the contract takes it from the proposer.');
  if (breakGlassBondMin !== undefined && bondAmount < breakGlassBondMin) {
    throw new Error(`bondAmount ${bondAmount} is below the contract's minimum ${breakGlassBondMin}.`);
  }

  return {
    proposalType,
    proposalTypeName: name,
    descriptionHash,
    targetDexAddr,
    allocationAmount,
    allocationRecipient,
    proposedCommunityWallet,
    bondAmount,
  };
}

// ---------------------------------------------------------------------------
// The description a proposal commits to
// ---------------------------------------------------------------------------

/** What a proposal's description says, as the site stores it. */
export interface ProposalDescription {
  title: string;
  text: string;
  /** SilenceLockTrigger: the community wallet's 32-byte public key, so a takeover can install it as the pool's royalty key. */
  communityWalletPubKey?: string;
}

/**
 * The description document a proposal made in the browser commits to: JSON,
 * written in one fixed key order, so its SHA-256 is the proposal's
 * `descriptionHash` and anyone holding the text can check it.
 */
export function proposalDescriptionText(d: ProposalDescription): string {
  const title = d.title.trim();
  const text = d.text.trim();
  if (title === '') throw new Error('A proposal needs a title.');
  const doc: Record<string, unknown> = { noctis: 'cto-proposal', v: 1, title, text };
  if (d.communityWalletPubKey !== undefined) {
    const key = d.communityWalletPubKey.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('communityWalletPubKey must be a 32-byte public key in hex.');
    doc.communityWalletPubKey = key;
  }
  return JSON.stringify(doc);
}

/** A stored description read back: the document's fields, or plain text as the whole of it. */
export function readProposalDescription(stored: string): ProposalDescription {
  try {
    const doc = JSON.parse(stored) as Record<string, unknown>;
    if (doc && doc.noctis === 'cto-proposal' && typeof doc.title === 'string') {
      return {
        title: doc.title,
        text: typeof doc.text === 'string' ? doc.text : '',
        ...(typeof doc.communityWalletPubKey === 'string' ? { communityWalletPubKey: doc.communityWalletPubKey } : {}),
      };
    }
  } catch {
    // Plain text: a description made outside the browser form.
  }
  return { title: '', text: stored };
}

// ---------------------------------------------------------------------------
// Whether a proposal may be filed now
// ---------------------------------------------------------------------------
// The contract's own gates, in its own order, so the form says why it is
// closed before a proof is spent finding out. The contract still decides.

/** The contract's windows, in seconds (cto_governance.compact's constructor). */
export const CTO_WINDOWS = {
  silence: 7_776_000n,
  cooldown: 7_776_000n,
  postGraduation: 7_776_000n,
  maxSnapshotAge: 2_592_000n,
  staleSnapshotGrace: 7_776_000n,
} as const;

/**
 * The types the browser offers: a takeover, and the votes a community acts on
 * once it holds one. DexMigration and WhitelistUpdate are filed from the
 * command-line action.
 */
export const BROWSER_PROPOSAL_TYPES = [
  'SilenceLockTrigger',
  'FundAllocation',
  'DissolveCTO',
  'VestingToLp',
  'VestingToStaking',
  'VestingToTreasury',
] as const satisfies readonly ProposalTypeName[];

export interface ProposalGateState {
  ctoState: string;
  hasClaimableBalance: boolean;
  /** Seconds, like every time on the Midnight ballot. */
  lastCreatorActivity: bigint;
  lastProposalEnd: bigint;
  activeProposalCount: bigint;
  lastSnapshotTimestamp: bigint;
  balanceSnapshotRootHex: string;
}

export type ProposalOpening = { open: true } | { open: false; reason: string; fromSeconds?: bigint };

/** Whether a proposal of this type may be filed at `nowSeconds`, and if not, why and from when. */
export function proposalOpening(
  state: ProposalGateState,
  type: ProposalTypeName,
  nowSeconds: bigint,
  graduationSeconds?: bigint,
): ProposalOpening {
  if (/^0*$/.test(state.balanceSnapshotRootHex)) {
    return { open: false, reason: 'No balance snapshot has been published for this launch yet.' };
  }
  const age = nowSeconds - state.lastSnapshotTimestamp;
  if (age > CTO_WINDOWS.maxSnapshotAge) {
    if (type !== 'SilenceLockTrigger') {
      return { open: false, reason: 'The balance snapshot is more than 30 days old; this vote waits for a fresh one.' };
    }
    if (age < CTO_WINDOWS.staleSnapshotGrace) {
      // Past 90 days a takeover vote may rest on the last snapshot, so a
      // launch whose snapshots stopped still has a way to its community.
      return {
        open: false,
        reason: 'The balance snapshot is more than 30 days old; a takeover vote waits for a fresh one, or for 90 days.',
        fromSeconds: state.lastSnapshotTimestamp + CTO_WINDOWS.staleSnapshotGrace,
      };
    }
  }
  if (graduationSeconds !== undefined && nowSeconds < graduationSeconds + CTO_WINDOWS.postGraduation) {
    return {
      open: false,
      reason: 'A launch takes proposals from 90 days after it graduates.',
      fromSeconds: graduationSeconds + CTO_WINDOWS.postGraduation,
    };
  }
  if (state.lastProposalEnd > 0n && nowSeconds < state.lastProposalEnd + CTO_WINDOWS.cooldown) {
    return {
      open: false,
      reason: 'The 90-day cooldown after the last ballot is still running.',
      fromSeconds: state.lastProposalEnd + CTO_WINDOWS.cooldown,
    };
  }
  if (state.activeProposalCount > 0n) {
    return { open: false, reason: 'A ballot is already open; a launch runs one at a time.' };
  }
  if (type === 'SilenceLockTrigger') {
    if (state.ctoState !== 'PreCTO') {
      return { open: false, reason: 'A takeover vote is only for a launch that has not been taken over.' };
    }
    if (nowSeconds < state.lastCreatorActivity + CTO_WINDOWS.silence) {
      return {
        open: false,
        reason: 'The creator has not been silent for 90 days.',
        fromSeconds: state.lastCreatorActivity + CTO_WINDOWS.silence,
      };
    }
    if (!state.hasClaimableBalance) {
      return { open: false, reason: 'The launch has no unclaimed creator fees, so a takeover would recover nothing.' };
    }
    return { open: true };
  }
  if (state.ctoState !== 'CTOTriggered') {
    return { open: false, reason: 'This vote is for a launch the community has taken over.' };
  }
  return { open: true };
}
