// ============================================================================
// Noctis Zone — cto_governance.compact deploy arguments, resolved and checked
// ============================================================================
// Every refusal here mirrors an assertion the contract's own constructor
// makes, so a bad deploy is stopped before it costs a transaction — with an
// error naming the field rather than the circuit. The one thing the contract
// cannot check is derived here instead: `maxVoterCap` is a percentage of the
// supply, and Compact cannot divide, so the contract only asserts it is a
// positive fraction of `totalSupply`. A wrong absolute value would cap every
// voter for the life of the launch, so it is computed from the percentage and
// a supplied value must agree with it.
//
// The same shape as eligibility-gate-deploy-args.ts, on purpose: the deploy
// CLI, the PHP flow and the harness all assemble the same JSON.
// ============================================================================

import { fromHex32 } from './eligibility-gate-deploy-args.js';

/** CLAUDE.md `CTO_MAX_VOTER_CAP_PCT`: the per-voter weight cap, uniform for every voter. */
export const CTO_MAX_VOTER_CAP_PCT = 1;
/** CLAUDE.md `CTO_MIN_VOTER_COUNT`: distinct voters a ballot needs before quorum counts. */
export const CTO_MIN_VOTER_COUNT = 15;

export interface CtoGovernanceDeployInput {
  launchIdHex: string;
  /** Whole-token count, the same figure the eligibility gate was deployed with. */
  totalSupply: string | number;
  /** POSIX seconds. A proposal is refused until 90 days after this. */
  graduationTimestamp: string | number;
  /** Percent of total supply; defaults to CTO_MAX_VOTER_CAP_PCT. */
  maxVoterCapPercent?: number;
  /** Optional absolute cap; refused unless it equals totalSupply * percent / 100. */
  maxVoterCap?: string | number;
  /** Defaults to CTO_MIN_VOTER_COUNT. */
  minVoterCount?: number;
  /** The creator's CTO-domain public key for this launch (see derive-keys). */
  creatorPubKeyHex: string;
  /** Whether the launch already has a claimable creator balance at deploy. */
  hasClaimableBalance: boolean;
  /** Minimum bond, in NIGHT atomic units, for a proposal or a break-glass challenge. */
  breakGlassBondMin: string | number;
  /** Receives forfeited proposal bonds. */
  platformAddrHex: string;
  /** Three DISTINCT attestor keys (derive-keys prints one from a secret). */
  attestorKeysHex: [string, string, string];
  /** How many attestors must approve a snapshot or activity update: 2 or 3. */
  attestThreshold: number;
}

export interface CtoGovernanceDeployArgs {
  launchId: Uint8Array;
  totalSupply: bigint;
  graduationTimestamp: bigint;
  maxVoterCap: bigint;
  minVoterCount: bigint;
  creatorPubKey: Uint8Array;
  hasClaimableBalance: boolean;
  breakGlassBondMin: bigint;
  platformAddr: Uint8Array;
  attestorKeys: [Uint8Array, Uint8Array, Uint8Array];
  attestThreshold: bigint;
}

function toBigInt(value: string | number | undefined, label: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label}: expected a number or a numeric string, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`${label}: expected a number, got an empty string`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label}: not an integer, got ${JSON.stringify(value)}`);
  }
  if (parsed < 0n) {
    throw new Error(`${label}: must not be negative, got ${parsed}`);
  }
  return parsed;
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function resolveCtoGovernanceDeployArgs(input: CtoGovernanceDeployInput): CtoGovernanceDeployArgs {
  const launchId = fromHex32(input.launchIdHex, 'launchIdHex');
  const creatorPubKey = fromHex32(input.creatorPubKeyHex, 'creatorPubKeyHex');
  const platformAddr = fromHex32(input.platformAddrHex, 'platformAddrHex');

  if (isZero(creatorPubKey)) {
    throw new Error('creatorPubKeyHex cannot be all zero — it is what tells the creator apart from every other voter.');
  }
  if (isZero(platformAddr)) {
    throw new Error('platformAddrHex cannot be all zero — it receives forfeited proposal bonds.');
  }

  if (!Array.isArray(input.attestorKeysHex) || input.attestorKeysHex.length !== 3) {
    throw new Error('attestorKeysHex must be exactly three keys.');
  }
  const attestorKeys = input.attestorKeysHex.map((k, i) => fromHex32(k, `attestorKeysHex[${i}]`)) as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  attestorKeys.forEach((k, i) => {
    if (isZero(k)) {
      throw new Error(`attestorKeysHex[${i}] cannot be all zero — the contract rejects an empty attestor key.`);
    }
  });
  for (const [i, j] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ] as const) {
    if (sameBytes(attestorKeys[i], attestorKeys[j])) {
      throw new Error(
        `attestorKeysHex[${i}] and [${j}] are the same key. Three DISTINCT holders, or the threshold is ` +
          'decorative: one person holding two of them supplies both halves of a 2-of-3 alone.',
      );
    }
  }
  if (input.attestThreshold !== 2 && input.attestThreshold !== 3) {
    throw new Error(`attestThreshold must be 2 or 3, got ${JSON.stringify(input.attestThreshold)}`);
  }

  const totalSupply = toBigInt(input.totalSupply, 'totalSupply');
  if (totalSupply === 0n) {
    throw new Error('totalSupply must be positive.');
  }
  const graduationTimestamp = toBigInt(input.graduationTimestamp, 'graduationTimestamp');

  const percent = input.maxVoterCapPercent ?? CTO_MAX_VOTER_CAP_PCT;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error(`maxVoterCapPercent must be a whole number from 1 to 100, got ${JSON.stringify(percent)}`);
  }
  const derivedCap = (totalSupply * BigInt(percent)) / 100n;
  if (derivedCap === 0n) {
    throw new Error(
      `maxVoterCap derives to zero from totalSupply ${totalSupply} at ${percent}% — the contract refuses a zero cap.`,
    );
  }
  if (input.maxVoterCap !== undefined) {
    const supplied = toBigInt(input.maxVoterCap, 'maxVoterCap');
    if (supplied !== derivedCap) {
      throw new Error(
        `maxVoterCap ${supplied} does not equal totalSupply * maxVoterCapPercent / 100 (${derivedCap}). ` +
          'The contract only checks the cap is a positive fraction of the supply, so a wrong value would ' +
          'cap every voter for the life of the launch.',
      );
    }
  }

  const minVoterCount = input.minVoterCount ?? CTO_MIN_VOTER_COUNT;
  if (!Number.isInteger(minVoterCount) || minVoterCount < 1) {
    throw new Error(`minVoterCount must be a positive whole number, got ${JSON.stringify(minVoterCount)}`);
  }

  if (typeof input.hasClaimableBalance !== 'boolean') {
    throw new Error(`hasClaimableBalance must be true or false, got ${JSON.stringify(input.hasClaimableBalance)}`);
  }

  const breakGlassBondMin = toBigInt(input.breakGlassBondMin, 'breakGlassBondMin');
  if (breakGlassBondMin === 0n) {
    throw new Error('breakGlassBondMin must be positive — it is the floor for every proposal bond.');
  }

  return {
    launchId,
    totalSupply,
    graduationTimestamp,
    maxVoterCap: derivedCap,
    minVoterCount: BigInt(minVoterCount),
    creatorPubKey,
    hasClaimableBalance: input.hasClaimableBalance,
    breakGlassBondMin,
    platformAddr,
    attestorKeys,
    attestThreshold: BigInt(input.attestThreshold),
  };
}
