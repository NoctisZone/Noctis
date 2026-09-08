// reference-script-reclaimer.test.ts
//
// This module exists to spend reference scripts, which destroys them. That is
// correct for a superseded one and catastrophic for a live one: every launch
// pointing at it breaks, silently, with the transaction succeeding and nothing
// to undo it with.
//
// So the tests worth having are two questions. Can a live script be reclaimed,
// by any route? The live set is derived from compiled bytes rather than
// supplied, so a caller cannot ask for one by mistake or otherwise. And can a
// script this tool does not recognise be reclaimed without being asked for?
// The wallet holds scripts from more than one package, and — for a
// parameterised validator — scripts that appear in no blueprint at all, so
// "not in the blueprint" is not evidence of being dead.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCborEncoding, type UTxO as MeshUTxO } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import {
  currentScriptHashes,
  findReferenceScripts,
  reclaimable,
  reclaimableLovelace,
  refusedApprovals,
} from '../reference-script-reclaimer.js';

const blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };

const TIER_A = blueprint.validators.find((v) => v.title === 'bonding_curve.bonding_curve.spend');
const TIER_B = blueprint.validators.find((v) => v.title === 'bonding_curve_tier_b.bonding_curve_tier_b.spend');
if (!TIER_A || !TIER_B) throw new Error('blueprint is missing a curve');

const venue = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'plutus.json'), 'utf8'),
) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };
const applied = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'deployment', 'applied.json'), 'utf8'),
) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };

const SWAP_ORDER = venue.validators.find((v) => v.title === 'royalty_pool/swap_order.swap_order.spend');
const APPLIED_POOL = applied.validators.find((v) => v.title === 'royalty_pool/pool.pool.spend');
if (!SWAP_ORDER || !APPLIED_POOL) throw new Error('the venue package is missing a validator');

const ADDRESS = 'addr_test1vqv30h5jmt0ml909e385tptgfvrqqu82k5mtjzgvwu0xfrcrkkaws';

function utxo(txHash: string, lovelace: string, scriptRef?: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: {
      address: ADDRESS,
      amount: [{ unit: 'lovelace', quantity: lovelace }],
      ...(scriptRef ? { scriptRef } : {}),
    },
  };
}

/** A script that is not any validator this build produces. */
const SUPERSEDED = applyCborEncoding('590001');

describe('currentScriptHashes', () => {
  it('covers every validator in the blueprint', () => {
    const modules = new Set(blueprint.validators.map((v) => v.title.split('.')[0]));
    expect(new Set(currentScriptHashes(blueprint.validators).values())).toEqual(modules);
  });

  // Derived, not read from the blueprint's own recorded hash: the question is
  // what THIS build compiles to, and a stale recorded hash would let a live
  // script be reclaimed.
  it('agrees with the hash the blueprint recorded', () => {
    const hashes = currentScriptHashes(blueprint.validators);
    expect(hashes.has(TIER_A.hash.toLowerCase())).toBe(true);
    expect(hashes.has(TIER_B.hash.toLowerCase())).toBe(true);
  });
});

describe('findReferenceScripts', () => {
  it('ignores UTXOs that carry no script', () => {
    expect(findReferenceScripts([utxo('aa'.repeat(32), '500000000')], blueprint.validators)).toEqual([]);
  });

  it('marks a live curve as current, and names it', () => {
    const found = findReferenceScripts(
      [utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_B.compiledCode))],
      blueprint.validators,
    );
    expect(found[0]?.isCurrent).toBe(true);
    expect(found[0]?.module).toBe('bonding_curve_tier_b');
  });

  it('marks a script no validator compiles to as unrecognised', () => {
    const found = findReferenceScripts([utxo('bb'.repeat(32), '5000000', SUPERSEDED)], blueprint.validators);
    expect(found[0]?.isCurrent).toBe(false);
    expect(found[0]?.status).toBe('unrecognised');
    expect(found[0]?.module).toBeUndefined();
  });

  // The launch package and the venue are separate Aiken projects, and one
  // wallet publishes for both. Handed only one package's validators, this
  // reports the other's as unrecognised — which is why the CLI hands it every
  // package's, and why being unrecognised must not be what decides a spend.
  it('recognises a venue script only when the venue is in the set', () => {
    const held = [utxo('ee'.repeat(32), '40000000', applyCborEncoding(SWAP_ORDER.compiledCode))];
    expect(findReferenceScripts(held, blueprint.validators)[0]?.isCurrent).toBe(false);
    expect(findReferenceScripts(held, [...blueprint.validators, ...venue.validators])[0]?.isCurrent).toBe(true);
  });

  // A parameterised validator's deployed script is in no blueprint: the bytes
  // come from applying the parameter, not from compiling. The applied file is
  // what puts it in the live set.
  it('recognises an applied venue script only from the applied file', () => {
    const held = [utxo('ff'.repeat(32), '60000000', applyCborEncoding(APPLIED_POOL.compiledCode))];
    expect(findReferenceScripts(held, [...blueprint.validators, ...venue.validators])[0]?.isCurrent).toBe(false);
    expect(
      findReferenceScripts(held, [...blueprint.validators, ...venue.validators, ...applied.validators])[0]?.isCurrent,
    ).toBe(true);
  });
});

describe('what may be spent', () => {
  // The one that matters. A live script in the same wallet, holding the same
  // amount, at the same address — everything a selection could match on is
  // identical, and only the script tells them apart.
  it('never returns a live validator, however it is mixed in', () => {
    const found = findReferenceScripts(
      [
        utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode)),
        utxo('bb'.repeat(32), '75000000', SUPERSEDED),
        utxo('cc'.repeat(32), '75000000', applyCborEncoding(TIER_B.compiledCode)),
      ],
      blueprint.validators,
    );
    const safe = reclaimable(
      found,
      found.map((f) => f.scriptHash),
    );
    expect(safe).toHaveLength(1);
    expect(safe[0]?.txHash).toBe('bb'.repeat(32));
  });

  // The one that would have destroyed a venue reference script. Publishing the
  // venue's scripts from the wallet that already holds the launch package's put
  // them in front of a tool whose idea of "dead" was "not in the blueprint I
  // read" — so the act of publishing one scheduled its own destruction, at the
  // next reclaim, with the transaction succeeding.
  it('spends nothing that was not asked for, however dead it looks', () => {
    const found = findReferenceScripts(
      [
        utxo('bb'.repeat(32), '75000000', SUPERSEDED),
        utxo('ee'.repeat(32), '40000000', applyCborEncoding(SWAP_ORDER.compiledCode)),
        utxo('ff'.repeat(32), '60000000', applyCborEncoding(APPLIED_POOL.compiledCode)),
      ],
      blueprint.validators,
    );
    expect(found.every((f) => !f.isCurrent)).toBe(true);
    expect(reclaimable(found)).toEqual([]);
    expect(reclaimableLovelace(found)).toBe(0n);
  });

  it('spends the one named and leaves its neighbours alone', () => {
    const found = findReferenceScripts(
      [
        utxo('bb'.repeat(32), '75000000', SUPERSEDED),
        utxo('ee'.repeat(32), '40000000', applyCborEncoding(SWAP_ORDER.compiledCode)),
      ],
      blueprint.validators,
    );
    const dead = found.find((f) => f.txHash === 'bb'.repeat(32));
    const safe = reclaimable(found, [dead?.scriptHash ?? '']);
    expect(safe).toHaveLength(1);
    expect(safe[0]?.txHash).toBe('bb'.repeat(32));
  });

  // Naming one does not make it spendable. The live check runs first and does
  // not consult the caller at all.
  it('refuses a live script that was explicitly named, and says why', () => {
    const found = findReferenceScripts(
      [utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode))],
      blueprint.validators,
    );
    const named = [found[0]?.scriptHash ?? ''];
    expect(reclaimable(found, named)).toEqual([]);
    expect(refusedApprovals(found, named)).toEqual([
      { scriptHash: found[0]?.scriptHash, reason: 'a current build compiles to this script (bonding_curve)' },
    ]);
  });

  it('reports a named hash the wallet does not hold', () => {
    expect(refusedApprovals([], ['99'.repeat(28)])).toEqual([
      { scriptHash: '99'.repeat(28), reason: 'no reference script with this hash is in the wallet' },
    ]);
  });

  it('returns nothing at all when every script is live', () => {
    const found = findReferenceScripts(
      [
        utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode)),
        utxo('cc'.repeat(32), '75000000', applyCborEncoding(TIER_B.compiledCode)),
      ],
      blueprint.validators,
    );
    expect(
      reclaimable(
        found,
        found.map((f) => f.scriptHash),
      ),
    ).toEqual([]);
    expect(
      reclaimableLovelace(
        found,
        found.map((f) => f.scriptHash),
      ),
    ).toBe(0n);
  });

  it('refuses every validator the blueprints hold, not only the curves', () => {
    const every = [...blueprint.validators, ...venue.validators, ...applied.validators];
    const all = every.map((v, i) =>
      utxo(i.toString(16).padStart(4, '0').repeat(16), '30000000', applyCborEncoding(v.compiledCode)),
    );
    const found = findReferenceScripts(all, every);
    expect(
      reclaimable(
        found,
        found.map((f) => f.scriptHash),
      ),
    ).toEqual([]);
  });

  it('totals only what it would actually spend', () => {
    const found = findReferenceScripts(
      [
        utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode)),
        utxo('bb'.repeat(32), '55000000', SUPERSEDED),
        utxo('dd'.repeat(32), '5000000', applyCborEncoding('590002')),
      ],
      blueprint.validators,
    );
    expect(
      reclaimableLovelace(
        found,
        found.map((f) => f.scriptHash),
      ),
    ).toBe(60_000_000n);
  });
});
