// ============================================================================
// Noctis Zone — CTO governance actions: who makes each, and what each needs
// ============================================================================
// The pure half of cli/cto-governance-action.ts, kept apart so it can be
// tested without a wallet, a proof server or a chain. Every rule here mirrors
// one the contract enforces, so a bad call is refused before it costs a proof:
//
//   - which secret an action is made with (attestor, voter/creator/proposer,
//     or nobody in particular);
//   - the `currentTimestamp` window every circuit checks against block time;
//   - the per-type fields a proposal must carry.
// ============================================================================

import { createHash } from 'node:crypto';
import { ProposalType } from '../contracts/midnight/compiled/cto_governance/contract/index.js';
import { fromHex32 } from './eligibility-gate-deploy-args.js';

export type CtoAction =
  | 'read'
  | 'derive-keys'
  | 'publish-snapshot'
  | 'update-activity'
  | 'heartbeat'
  | 'create-proposal'
  | 'vote'
  | 'finalize'
  | 'execute'
  | 'claim-bond'
  | 'sweep-bond';

export const CTO_ACTIONS: readonly CtoAction[] = [
  'read',
  'derive-keys',
  'publish-snapshot',
  'update-activity',
  'heartbeat',
  'create-proposal',
  'vote',
  'finalize',
  'execute',
  'claim-bond',
  'sweep-bond',
];

/** Made with an attestor's secret: the contract checks the derived key against its three sealed attestor keys. */
export const ATTESTOR_ACTIONS: ReadonlySet<CtoAction> = new Set(['publish-snapshot', 'update-activity']);

/**
 * Made with a launch identity derived from a wallet seed — the creator's for
 * a heartbeat, a holder's for a vote, the proposer's to file or reclaim.
 */
export const IDENTITY_ACTIONS: ReadonlySet<CtoAction> = new Set(['heartbeat', 'create-proposal', 'vote', 'claim-bond']);

/** Anyone with a funded wallet: the contract checks state, not the caller. */
export const OPEN_ACTIONS: ReadonlySet<CtoAction> = new Set(['finalize', 'execute', 'sweep-bond']);

/** Needs no wallet and submits nothing. */
export const OFFLINE_ACTIONS: ReadonlySet<CtoAction> = new Set(['read', 'derive-keys']);

export type IdentityRequirement = 'attestor' | 'identity' | 'none';

export function identityFor(action: CtoAction): IdentityRequirement {
  if (ATTESTOR_ACTIONS.has(action)) return 'attestor';
  if (IDENTITY_ACTIONS.has(action)) return 'identity';
  return 'none';
}

export function isCtoAction(value: unknown): value is CtoAction {
  return typeof value === 'string' && (CTO_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// currentTimestamp
// ---------------------------------------------------------------------------
// Every circuit asserts blockTime >= currentTimestamp and
// blockTime <= currentTimestamp + 3600: the declared time may trail the block
// that includes it by up to an hour and may never lead it. The transaction is
// built now and included later, so the safe declaration is "now", and a
// caller-supplied value is only accepted inside a narrower window than the
// contract's, leaving room for inclusion delay.

/** Seconds a supplied timestamp may sit ahead of this machine's clock. */
export const TIMESTAMP_FUTURE_TOLERANCE_SECONDS = 60;
/** Seconds a supplied timestamp may sit behind: half the contract's hour, so inclusion delay cannot push it over. */
export const TIMESTAMP_STALE_LIMIT_SECONDS = 1800;

export function resolveCurrentTimestamp(value: string | number | undefined, nowSeconds: number): bigint {
  if (value === undefined || value === '') return BigInt(nowSeconds);
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`currentTimestamp must be POSIX seconds, got ${JSON.stringify(value)}`);
  }
  if (parsed < 0n) throw new Error(`currentTimestamp cannot be negative, got ${parsed}`);
  // Milliseconds are the one mistake this codebase has made before, twice.
  if (parsed > 100_000_000_000n) {
    throw new Error(
      `currentTimestamp ${parsed} looks like milliseconds — every Midnight timestamp is POSIX seconds (divide by 1000).`,
    );
  }
  const now = BigInt(nowSeconds);
  if (parsed > now + BigInt(TIMESTAMP_FUTURE_TOLERANCE_SECONDS)) {
    throw new Error(
      `currentTimestamp ${parsed} is in the future (now is ${now}); the contract refuses a declared time ahead of block time.`,
    );
  }
  if (parsed < now - BigInt(TIMESTAMP_STALE_LIMIT_SECONDS)) {
    throw new Error(
      `currentTimestamp ${parsed} is more than ${TIMESTAMP_STALE_LIMIT_SECONDS}s behind now (${now}). The contract accepts ` +
        'a declared time up to an hour behind block time, and inclusion can take minutes, so declare something recent.',
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const PROPOSAL_TYPE_NAMES = [
  'SilenceLockTrigger',
  'FundAllocation',
  'DexMigration',
  'WhitelistUpdate',
  'DissolveCTO',
] as const;
export type ProposalTypeName = (typeof PROPOSAL_TYPE_NAMES)[number];

export interface ProposalInput {
  proposalType: ProposalTypeName | string;
  /** 32 bytes hex; or give `description` and the SHA-256 of its UTF-8 is used. */
  descriptionHashHex?: string;
  description?: string;
  /** DexMigration / WhitelistUpdate: the target, 32 bytes hex. */
  targetDexAddrHex?: string;
  /** FundAllocation: amount and recipient. */
  allocationAmount?: string | number;
  allocationRecipientHex?: string;
  /** SilenceLockTrigger: the wallet the community takes over with. */
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

const ZERO32 = new Uint8Array(32);
const isZero = (b: Uint8Array) => b.every((x) => x === 0);

function optionalHex32(value: string | undefined, label: string): Uint8Array {
  if (value === undefined || value === '') return ZERO32;
  return fromHex32(value, label);
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
  return new Uint8Array(createHash('sha256').update(description, 'utf8').digest());
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
  const allocationRecipient = optionalHex32(input.allocationRecipientHex, 'allocationRecipientHex');
  const proposedCommunityWallet = optionalHex32(input.proposedCommunityWalletHex, 'proposedCommunityWalletHex');
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
