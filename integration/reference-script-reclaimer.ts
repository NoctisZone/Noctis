// ============================================================================
// Noctis Zone — reclaiming superseded reference scripts
// ============================================================================
// A published reference script locks a deposit — 56 ada for the linear curve curve,
// 73 for Cardano Launch — and every change to a validator strands the one published
// before it. The hash moves, so the address moves, so the old script points at
// a validator nothing is locked by any more. The deposit is still there, and
// still ours.
//
// Reclaiming is an ordinary payment: the reference output sits at the
// publishing wallet's own address, so spending it needs nothing but that
// wallet's signature. What makes it worth a tool rather than a one-off script
// is the thing it must never do.
//
// **Spending a reference script destroys it.** That is the point here, and it
// is also the catastrophe if the wrong one is chosen: every launch pointing at
// a live script would break, silently, with the transaction succeeding. So the
// rule is not "spend the ones I was told to" but "spend only what cannot
// possibly be current" — the set of live hashes is read from the compiled
// bytes of every package the platform builds, and anything matching one is
// refused, whatever the caller asked for.
//
// **A script is only spent when it is BOTH not live AND named by the
// operator.** Absence from the live set is not evidence a script is ours to
// destroy: a wallet holds whatever was published from it, which now includes
// more than one package's validators and, for a parameterised validator, a
// script that appears in no blueprint at all because its bytes are produced by
// applying a parameter rather than by compiling. Treating "unrecognised" as
// "garbage" would make publishing a second package's script the act that
// schedules its own destruction. So an unrecognised script is reported and
// left alone, and reclaiming one is a deliberate instruction naming its hash.

import { applyCborEncoding, type UTxO as MeshUTxO, resolveScriptHash } from '@meshsdk/core';

/** What is known about a reference script the wallet holds. */
export type ReferenceScriptStatus =
  /** A validator some current build compiles to. Never spendable. */
  | 'current'
  /** Not current, and not recognised. Reported; spent only when named. */
  | 'unrecognised';

/** A reference-script UTXO found in the wallet, and what it holds. */
export interface FoundReferenceScript {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  /** The hash of the script it carries. */
  scriptHash: string;
  /** Whether that hash belongs to a validator some current build compiles to. */
  isCurrent: boolean;
  status: ReferenceScriptStatus;
  /** Which validator, when it is one. */
  module?: string;
}

interface BlueprintValidator {
  title: string;
  compiledCode: string;
}

/**
 * Every validator hash the current builds compile to, keyed by hash.
 *
 * Derived rather than read from a blueprint's own `hash` field: the point is
 * to know what THIS build produces, and a stale recorded hash would let a live
 * script be reclaimed. Pass the validators of every package the wallet has
 * published from — the launch package and the venue are separate blueprints,
 * and a hash missing from this set is one the tool cannot vouch for.
 */
export function currentScriptHashes(validators: readonly BlueprintValidator[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of validators) {
    const module = v.title.split('.')[0];
    if (!module) continue;
    out.set(resolveScriptHash(applyCborEncoding(v.compiledCode), 'V3').toLowerCase(), module);
  }
  return out;
}

function lovelaceOf(utxo: MeshUTxO): bigint {
  const entry = utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '');
  return BigInt(entry?.quantity ?? '0');
}

/**
 * Every reference-script UTXO in a wallet, each marked current or unrecognised.
 *
 * Reports rather than decides, so a caller can show the operator what is about
 * to happen before anything moves.
 */
export function findReferenceScripts(
  utxos: readonly MeshUTxO[],
  validators: readonly BlueprintValidator[],
): FoundReferenceScript[] {
  const live = currentScriptHashes(validators);
  const found: FoundReferenceScript[] = [];
  for (const u of utxos) {
    const ref = u.output.scriptRef;
    if (!ref) continue;
    // The wallet reports the script as stored, which is the wrapped form —
    // the same form the hash is taken over.
    const hash = resolveScriptHash(ref, 'V3').toLowerCase();
    const module = live.get(hash);
    found.push({
      txHash: u.input.txHash,
      outputIndex: u.input.outputIndex,
      lovelace: lovelaceOf(u),
      scriptHash: hash,
      isCurrent: module !== undefined,
      status: module !== undefined ? 'current' : 'unrecognised',
      ...(module ? { module } : {}),
    });
  }
  return found;
}

/**
 * The ones that are safe to spend, out of the ones the operator named.
 *
 * Two independent conditions, and both must hold. A script matching any
 * validator a current build compiles to is refused unconditionally — it does
 * not matter whether a launch is presently pointing at it, because the next
 * one will, and destroying it is not something a later transaction can undo.
 * And a script nobody named is left alone, because the wallet holds scripts
 * from more than one package and from parameterised validators that appear in
 * no blueprint, so not recognising one says nothing about whether it is dead.
 *
 * `approvedHashes` is therefore a list of hashes read off a listing, never a
 * shortcut past the first condition: naming a live hash does not spend it.
 */
export function reclaimable(
  found: readonly FoundReferenceScript[],
  approvedHashes: readonly string[] = [],
): FoundReferenceScript[] {
  const approved = new Set(approvedHashes.map((h) => h.trim().toLowerCase()));
  return found.filter((f) => !f.isCurrent && approved.has(f.scriptHash));
}

/** What a reclaim would return, in total. */
export function reclaimableLovelace(
  found: readonly FoundReferenceScript[],
  approvedHashes: readonly string[] = [],
): bigint {
  return reclaimable(found, approvedHashes).reduce((acc, f) => acc + f.lovelace, 0n);
}

/**
 * Hashes the operator named that this tool will not spend, and why.
 *
 * Asking for a live script is the mistake worth reporting rather than
 * silently dropping: it means the caller believes something dead that is not.
 */
export function refusedApprovals(
  found: readonly FoundReferenceScript[],
  approvedHashes: readonly string[],
): Array<{ scriptHash: string; reason: string }> {
  const byHash = new Map(found.map((f) => [f.scriptHash, f]));
  const out: Array<{ scriptHash: string; reason: string }> = [];
  for (const raw of approvedHashes) {
    const hash = raw.trim().toLowerCase();
    const f = byHash.get(hash);
    if (!f) {
      out.push({ scriptHash: hash, reason: 'no reference script with this hash is in the wallet' });
    } else if (f.isCurrent) {
      out.push({ scriptHash: hash, reason: `a current build compiles to this script (${f.module})` });
    }
  }
  return out;
}
