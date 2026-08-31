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
// possibly be current" — the set of live hashes is read from the blueprint and
// anything matching one is refused, whatever the caller asked for.

import { applyCborEncoding, type UTxO as MeshUTxO, resolveScriptHash } from '@meshsdk/core';

/** A reference-script UTXO found in the wallet, and what it holds. */
export interface FoundReferenceScript {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  /** The hash of the script it carries. */
  scriptHash: string;
  /** Whether that hash belongs to a validator in the current blueprint. */
  isCurrent: boolean;
  /** Which validator, when it is one. */
  module?: string;
}

interface BlueprintValidator {
  title: string;
  compiledCode: string;
}

/**
 * Every validator hash the current blueprint compiles to, keyed by hash.
 *
 * Derived rather than read from the blueprint's own `hash` field: the point is
 * to know what THIS build produces, and a stale recorded hash would let a live
 * script be reclaimed.
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
 * Every reference-script UTXO in a wallet, each marked current or superseded.
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
      ...(module ? { module } : {}),
    });
  }
  return found;
}

/**
 * The ones that are safe to spend.
 *
 * A script matching any validator the current blueprint compiles to is
 * refused, unconditionally. It does not matter whether a launch is presently
 * pointing at it — the next one will, and destroying it is not something a
 * later transaction can undo.
 */
export function reclaimable(found: readonly FoundReferenceScript[]): FoundReferenceScript[] {
  return found.filter((f) => !f.isCurrent);
}

/** What a reclaim would return, in total. */
export function reclaimableLovelace(found: readonly FoundReferenceScript[]): bigint {
  return reclaimable(found).reduce((acc, f) => acc + f.lovelace, 0n);
}
