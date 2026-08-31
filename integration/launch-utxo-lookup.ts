// launch-utxo-lookup.ts — one way to find a launch's own script UTXO.
//
// Every validator here is unparameterized, so all launches of a given kind
// share one script address and a UTXO's datum is authored by whoever created
// it. Selecting on the datum's `launch_id` alone therefore selects on a claim,
// not on evidence, and the shape this module replaces also returned the FIRST
// match — so a second UTXO claiming the same launch was silently ignored, and
// which of the two got used depended on the order the provider returned them.
//
// Two rules here:
//
//   1. A token only the genuine launch can hold must be present. Wave 2 put a
//      thread NFT on every singleton state UTXO precisely so a reader has
//      something to check beyond the datum; the CIP-68 reference NFT plays the
//      same part for token metadata.
//   2. If more than one UTXO matches, refuse. Refusing is the point: a caller
//      that cannot tell which UTXO is the real one must not pick one anyway.
//      A loud failure is recoverable; building against the wrong UTXO is not.
//
// Rule 1 rests on knowing which policy is the genuine one, and that answer
// cannot come from the UTXO being checked. A datum names its own policy, so a
// forger names theirs, mints a token under it, and satisfies any test derived
// from the datum alone. The expected policy id is therefore a REQUIRED
// argument, taken from the caller's own record of the launch — the platform's
// launch row, written when the launch was minted, which no on-chain actor can
// edit. Both are then checked: the token must exist under the caller's policy,
// and the datum must name that same policy, so a UTXO disagreeing with the
// record is refused rather than quietly preferred.
//
// This is deliberately not optional and has no default. A lookup that falls
// back to the datum when the caller passes nothing is the forgeable lookup
// again, reachable by omission — and omission is exactly what happens as new
// entry points get written.
//
// THREE ENTRY POINTS, ONE CORE. They differ only in how the launch's datum is
// reached and which token authenticates it — the matching and the refusal are
// shared, so an improvement to either reaches all of them at once. Each entry
// point names its authenticator explicitly rather than deriving one, because
// "what proves this UTXO is the real one" is the whole question this module
// answers and it should never be implicit.

import type { UTxO } from '@lucid-evolution/lucid';
import { Data } from '@lucid-evolution/lucid';

import { cip68BaseName, cip68ReferenceAssetName, type ThreadNftRole, threadNftAssetName } from './tier-a-schemas.js';

/** The minimum a datum must expose for this module to authenticate its UTXO. */
export interface LaunchScopedDatum {
  launch_id: string;
  thread_nft_policy: string;
}

export interface FoundLaunchUtxo<T> {
  utxo: UTxO;
  datum: T;
}

/**
 * Nothing at the address answered to this launch.
 *
 * Its own type because "not there" is legitimate for some readers — a launch
 * genuinely has no metadata UTXO before it is minted — while every other
 * failure this module raises is not. A caller that treats them alike reports
 * an absent launch when the truth is a contested one, or a network outage.
 */
export class LaunchUtxoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchUtxoNotFoundError';
  }
}

/**
 * More than one UTXO answered, and the genuine one cannot be told from the
 * rest. Never legitimate, and never to be swallowed.
 */
export class AmbiguousLaunchUtxoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousLaunchUtxoError';
  }
}

/**
 * How one kind of UTXO is recognised: where its launch datum lives, and which
 * token has to be sitting on it.
 */
interface AuthenticatorSpec<TDatum> {
  /**
   * Reaches the launch's datum from whatever the schema decoded. Returns null
   * when this UTXO is not the shape being looked for at all — a sum-type datum
   * on its other variant, for instance.
   */
  unwrap: (decoded: unknown) => TDatum | null;
  /** The launch id this datum claims. */
  launchIdOf: (datum: TDatum) => string;
  /**
   * Policy id + asset name, hex, that must be present exactly once — built
   * from the policy the CALLER expects, never from the datum.
   */
  unit: string;
  /**
   * The policy this datum claims to be authenticated by. Checked against the
   * caller's expectation, so a UTXO whose datum disagrees with the platform's
   * record is refused rather than silently skipped for the wrong reason.
   */
  claimedPolicyOf: (datum: TDatum) => string;
  /** The policy the caller expects, hex. */
  expectedPolicy: string;
  /** Names the token in the not-found error, e.g. "bondingCurve thread NFT". */
  label: string;
}

/**
 * A policy id has to be a real one before it can authenticate anything.
 *
 * An empty string concatenated with an asset name yields a unit that no UTXO
 * carries, so the lookup would report "never minted" for what is really a
 * misconfigured caller — the two failures need to stay distinguishable.
 */
function requirePolicyId(policyId: string, context: string): string {
  if (!/^[0-9a-f]{56}$/i.test(policyId)) {
    throw new Error(
      `${context} needs the launch's expected policy id (28 bytes, hex) to authenticate the UTXO it finds, got: ${JSON.stringify(policyId)}. ` +
        "It must come from the platform's own record of the launch — reading it off the datum being checked would authenticate that datum against itself.",
    );
  }
  return policyId.toLowerCase();
}

/**
 * The one UTXO at `address` that both claims `launchIdHex` and carries the
 * token proving it.
 *
 * @throws if none match, or if more than one does.
 */
function selectAuthenticatedUtxo<TDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  schema: unknown,
  spec: AuthenticatorSpec<TDatum>,
): FoundLaunchUtxo<TDatum> {
  const matches: FoundLaunchUtxo<TDatum>[] = [];

  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    let decoded: unknown;
    try {
      decoded = Data.from(utxo.datum, schema as never);
    } catch {
      continue; // not this datum shape — someone else's UTXO at a shared address
    }
    const datum = spec.unwrap(decoded);
    if (datum === null) continue;
    if (spec.launchIdOf(datum) !== launchIdHex) continue;
    // These next two OVERLAP, and the overlap is deliberate — but only one of
    // them needs to hold for the property to, so neither is described here as
    // load-bearing on its own. Rebuilding `unit` from the datum instead of the
    // caller passes every test, because the line above it has already forced
    // the two to be equal. Recorded rather than smoothed over: a reader who
    // deletes one should know the other still closes the hole, and a reader
    // who mutates one should not be surprised the suite stays green.
    //
    // What makes either sufficient is that the thread NFT is minted by a
    // policy no forger controls. Naming the real policy in a forged datum
    // gets you a token you cannot mint; minting under your own policy gets
    // you a datum that disagrees with the record.
    if (spec.claimedPolicyOf(datum).toLowerCase() !== spec.expectedPolicy) continue;
    if ((utxo.assets[spec.unit] ?? 0n) !== 1n) continue;
    matches.push({ utxo, datum });
  }

  if (matches.length === 0) {
    throw new LaunchUtxoNotFoundError(
      `No UTXO at ${address} carries launch ${launchIdHex}'s ${spec.label}. ` +
        'Either the launch was never minted, or its state UTXO has been spent.',
    );
  }
  if (matches.length > 1) {
    const refs = matches.map((m) => `${m.utxo.txHash}#${m.utxo.outputIndex}`).join(', ');
    throw new AmbiguousLaunchUtxoError(
      `${matches.length} UTXOs at ${address} claim launch ${launchIdHex}'s ${spec.label}: ${refs}. ` +
        'Refusing to guess which is genuine — exactly one is expected, so this needs investigating ' +
        'before any transaction is built against it.',
    );
  }

  const only = matches[0];
  if (!only) {
    throw new Error('unreachable: matches has exactly one element');
  }
  return only;
}

/**
 * A launch's singleton state UTXO for one of the seven thread-NFT roles.
 *
 * The asset name encodes the role and the launch, so the unit is that name
 * behind the policy the datum names.
 */
export function selectLaunchUtxo<T extends LaunchScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  role: ThreadNftRole,
  schema: unknown,
  expectedThreadNftPolicy: string,
): FoundLaunchUtxo<T> {
  const policy = requirePolicyId(expectedThreadNftPolicy, `selectLaunchUtxo(${role})`);
  const assetName = threadNftAssetName(role, launchIdHex);
  return selectAuthenticatedUtxo<T>(utxos, address, launchIdHex, schema, {
    unwrap: (decoded) => decoded as T,
    launchIdOf: (datum) => datum.launch_id,
    claimedPolicyOf: (datum) => datum.thread_nft_policy,
    expectedPolicy: policy,
    unit: policy + assetName,
    label: `${role} thread NFT`,
  });
}

/**
 * A launch's staking pool UTXO.
 *
 * The datum is a single shape now. It used to be a sum type sharing this
 * address with per-stake `Position` UTXOs, and the unwrapping that needed is
 * gone with them: positions became entries under a Merkle root in the pool's
 * own datum, because once the validator computes what a position is owed, a
 * datum anyone can author is an authorization rather than a hint.
 *
 * So the only thing at this address is pools, one per launch, and the thread
 * NFT is what says which launch a given one belongs to.
 */
export function selectStakingPoolUtxo<T extends LaunchScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  schema: unknown,
  expectedThreadNftPolicy: string,
): FoundLaunchUtxo<T> {
  const policy = requirePolicyId(expectedThreadNftPolicy, 'selectStakingPoolUtxo');
  const assetName = threadNftAssetName('stakingPool', launchIdHex);
  return selectAuthenticatedUtxo<T>(utxos, address, launchIdHex, schema, {
    unwrap: (decoded) => decoded as T,
    launchIdOf: (datum) => datum.launch_id,
    claimedPolicyOf: (datum) => datum.thread_nft_policy,
    expectedPolicy: policy,
    unit: policy + assetName,
    label: 'stakingPool thread NFT',
  });
}

/** What token_metadata.ak's own datum exposes to a reader authenticating it. */
export interface Cip68ScopedDatum {
  extra: {
    launch_id: string;
    token_policy_id: string;
    token_asset_name: string;
  };
}

/**
 * A launch's CIP-68 reference NFT UTXO — its on-chain token metadata.
 *
 * Authenticated by the reference NFT rather than by a thread NFT: token
 * metadata is not one of the seven roles, and it does not need to be. The
 * reference NFT can only exist because launch_token_policy minted it in the
 * launch's genesis transaction, and that policy is a one-shot, so exactly one
 * of these exists per launch forever. This mirrors `carries_own_reference_nft`
 * in token_metadata.ak, which derives the same pair the same way — a reader
 * that checked anything else would accept UTXOs the validator rejects.
 */
export function selectCip68MetadataUtxo<T extends Cip68ScopedDatum>(
  utxos: UTxO[],
  address: string,
  launchIdHex: string,
  schema: unknown,
  expectedTokenPolicyId: string,
  expectedTokenAssetName: string,
): FoundLaunchUtxo<T> {
  const policy = requirePolicyId(expectedTokenPolicyId, 'selectCip68MetadataUtxo');
  if (!expectedTokenAssetName) {
    throw new Error(
      "selectCip68MetadataUtxo needs the launch's expected token asset name to derive the reference NFT it looks for.",
    );
  }
  // The fungible token and its reference NFT share one base name behind
  // different CIP-67 labels, so the reference name is the launch's own
  // (fungible) name relabelled. Derived from the caller's record, so the
  // datum cannot nominate which token vouches for it.
  const referenceName = cip68ReferenceAssetName(cip68BaseName(expectedTokenAssetName));
  return selectAuthenticatedUtxo<T>(utxos, address, launchIdHex, schema, {
    unwrap: (decoded) => decoded as T,
    launchIdOf: (datum) => datum.extra.launch_id,
    claimedPolicyOf: (datum) => datum.extra.token_policy_id,
    expectedPolicy: policy,
    unit: policy + referenceName,
    label: 'CIP-68 reference NFT',
  });
}
