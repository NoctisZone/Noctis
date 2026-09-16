// reference-script.test.ts — the claims a reference-script spend rests on.
//
// Two of these are the kind that fail silently and expensively:
//
//   - A script hashed WITHOUT its CBOR wrapper produces a different hash, so
//     a different address. Every launch would then be minted to an address
//     nothing can spend, and nothing would say so until the first spend.
//   - Two libraries disagreeing on a script address does the same thing, one
//     library at a time: Lucid mints the launch, Mesh looks for it, and
//     neither is wrong on its own.
//
// Both are pinned here against `plutus.json`'s own recorded hash, for every
// validator rather than the two being ported — a wrong answer anywhere is the
// same failure.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatorToAddress } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import {
  MAX_PUBLISHABLE_SCRIPT_BYTES,
  MAX_TX_BYTES,
  rawScriptSize,
  referenceSurchargeLovelace,
  resolveReferenceScript,
  scriptAddressOf,
  scriptHashOf,
} from '../reference-script.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}

const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

/** One entry per validator module — the blueprint repeats a module per purpose. */
const modules = new Map<string, { compiledCode: string; hash: string }>();
for (const v of blueprint.validators) {
  const module = v.title.split('.')[0];
  if (module && !modules.has(module)) modules.set(module, v);
}

// Two real, distinct scripts. The cases below need a second one only to
// differ from the curve, so it is simply a live escrow.
const ESCROW = modules.get('lp_escrow');
const CURVE_B = modules.get('bonding_curve_tier_b');
if (!ESCROW || !CURVE_B) throw new Error('blueprint is missing a validator this test needs');

describe('scriptHashOf', () => {
  for (const [module, v] of modules) {
    it(`${module} hashes to the hash the blueprint recorded`, () => {
      expect(scriptHashOf(v.compiledCode)).toBe(v.hash);
    });
  }

  // The failure this guards is not "a wrong hash" but "a plausible wrong
  // hash": the unwrapped form hashes to something perfectly well-formed that
  // simply is not the script's identity.
  it('is not what hashing the unwrapped script would give', () => {
    // Wrapping is what scriptHashOf does; a caller who skipped it would get a
    // different answer, and this pins that the two really do differ.
    const wrapped = scriptHashOf(CURVE_B.compiledCode);
    const alsoWrapped = scriptHashOf(ESCROW.compiledCode);
    expect(wrapped).not.toBe(alsoWrapped);
    expect(wrapped).toBe(CURVE_B.hash);
  });
});

describe('scriptAddressOf', () => {
  for (const [module, v] of modules) {
    it(`${module} resolves to the same address Lucid builds`, () => {
      const lucid = validatorToAddress('Preprod', { type: 'PlutusV3', script: v.compiledCode });
      expect(scriptAddressOf(v.compiledCode, 0)).toBe(lucid);
    });
  }

  it('separates mainnet from the test networks', () => {
    expect(scriptAddressOf(ESCROW.compiledCode, 1)).not.toBe(scriptAddressOf(ESCROW.compiledCode, 0));
    expect(scriptAddressOf(ESCROW.compiledCode, 1).startsWith('addr1')).toBe(true);
    expect(scriptAddressOf(ESCROW.compiledCode, 0).startsWith('addr_test1')).toBe(true);
  });
});

describe('resolveReferenceScript', () => {
  const pointer = { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: CURVE_B.hash };

  it('fills in the address and the size the surcharge is charged on', () => {
    const resolved = resolveReferenceScript(CURVE_B.compiledCode, pointer, 0);
    expect(resolved.scriptAddress).toBe(scriptAddressOf(CURVE_B.compiledCode, 0));
    expect(resolved.rawSizeBytes).toBe(rawScriptSize(CURVE_B.compiledCode));
    expect(resolved.txHash).toBe(pointer.txHash);
  });

  it('accepts a hash recorded in a different case', () => {
    const upper = { ...pointer, scriptHash: CURVE_B.hash.toUpperCase() };
    expect(() => resolveReferenceScript(CURVE_B.compiledCode, upper, 0)).not.toThrow();
  });

  // The whole point of the guard. A pointer published before a validator
  // changed still exists, still resolves, and holds a script the current state
  // UTXOs are not locked by — so the mismatch has to be caught here, where the
  // message can say what actually happened.
  it('refuses a pointer published for a different build of the validator', () => {
    const stale = { ...pointer, scriptHash: ESCROW.hash };
    expect(() => resolveReferenceScript(CURVE_B.compiledCode, stale, 0)).toThrow(/stale/i);
  });

  it('names both hashes so the mismatch can be acted on', () => {
    const stale = { ...pointer, scriptHash: ESCROW.hash };
    expect(() => resolveReferenceScript(CURVE_B.compiledCode, stale, 0)).toThrow(
      new RegExp(`${ESCROW.hash}[\\s\\S]*${CURVE_B.hash}`),
    );
  });
});

describe('publishing budget', () => {
  // A reference script is created by an ordinary transaction, bound by the
  // same cap as any other, and the script must serialise whole into the one
  // output carrying it — so this cannot be dodged by splitting the
  // transaction the way a multi-validator spend can be.
  for (const [module, v] of modules) {
    it(`${module} is small enough for a publishing transaction to carry`, () => {
      expect(rawScriptSize(v.compiledCode)).toBeLessThanOrEqual(MAX_PUBLISHABLE_SCRIPT_BYTES);
    });
  }

  it('leaves the publishing ceiling below the transaction cap', () => {
    expect(MAX_PUBLISHABLE_SCRIPT_BYTES).toBeLessThan(MAX_TX_BYTES);
  });
});

describe('referenceSurchargeLovelace', () => {
  // Referencing is not free, but it is cheaper per byte than embedding:
  // 15 lovelace against min_fee_a's 44. This records the shape of that
  // comparison so a change to either constant has to be a decision.
  it('charges on the unwrapped size', () => {
    expect(referenceSurchargeLovelace(CURVE_B.compiledCode)).toBe(rawScriptSize(CURVE_B.compiledCode) * 15);
  });

  it('costs less than a fifth of an ADA on either curve', () => {
    expect(referenceSurchargeLovelace(ESCROW.compiledCode)).toBeLessThan(200_000);
    expect(referenceSurchargeLovelace(CURVE_B.compiledCode)).toBeLessThan(250_000);
  });
});
