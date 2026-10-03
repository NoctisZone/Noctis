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
//   - the per-type fields a proposal must carry (built in cto-proposal-args.ts,
//     which the browser's proposal form shares).
// ============================================================================

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
