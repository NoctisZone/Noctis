// reference-script-publisher.test.ts
//
// Publishing locks a real deposit and, if it goes wrong, does so silently: a script
// published at the wrong index, or one byte too large to serialise, produces a
// transaction that either fails at submission or — worse — succeeds and leaves
// a pointer nothing can spend against. These check the parts a dry run can
// establish before any ada moves.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialToAddress } from '@lucid-evolution/lucid';
import {
  applyCborEncoding,
  DEFAULT_PROTOCOL_PARAMETERS,
  getUtxoMinLovelace,
  type UTxO as MeshUTxO,
} from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { MAX_PUBLISHABLE_SCRIPT_BYTES, rawScriptSize, scriptHashOf } from '../reference-script.js';
import { publishReferenceScript, referenceOutputLovelace } from '../reference-script-publisher.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}
const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);
function validator(title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from plutus.json`);
  return found;
}
const TIER_B = validator('bonding_curve_tier_b.bonding_curve_tier_b.spend');
const TIER_A = validator('bonding_curve.bonding_curve.spend');

// The venue's parameterised validators, as they actually deploy. Their bytes
// come from `aiken blueprint apply` and appear in no blueprint, which is the
// whole reason the publisher takes bytes plus a hash rather than a title.
const applied = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'deployment', 'applied.json'), 'utf8'),
) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };
const APPLIED_POOL = applied.validators.find((v) => v.title === 'royalty_pool/pool.pool.spend');
if (!APPLIED_POOL) throw new Error('the applied venue pool is missing');

const ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '33'.repeat(28) });

function utxo(txHash: string, index: number, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: index },
    output: { address: ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

function wallet(utxos = [utxo('aa'.repeat(32), 0, '400000000')]): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(ADDRESS),
    getUtxos: vi.fn().mockResolvedValue(utxos),
    getCollateral: vi.fn().mockResolvedValue([]),
    signTx: vi.fn().mockResolvedValue('signedhex'),
    submitTx: vi.fn().mockResolvedValue('published-tx-hash'),
  };
}

const provider = {
  fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
};

function publish(v: { compiledCode: string }, opts: { dryRun?: boolean; w?: CurveSpendWallet } = {}) {
  return publishReferenceScript({
    network: 'preprod',
    compiledScriptCbor: v.compiledCode,
    label: 'curve',
    provider,
    wallet: opts.w ?? wallet(),
    dryRun: opts.dryRun,
  });
}

describe('publishReferenceScript', () => {
  it('reports the pointer a real run would produce, without submitting', async () => {
    const w = wallet();
    const result = await publish(TIER_B, { dryRun: true, w });
    expect(result.pointer.scriptHash).toBe(scriptHashOf(TIER_B.compiledCode));
    expect(result.pointer.outputIndex).toBe(0);
    expect(result.txHash).toBeUndefined();
    expect(w.submitTx).not.toHaveBeenCalled();
  });

  it('returns a pointer resolveReferenceScript will accept', async () => {
    const result = await publish(TIER_B);
    expect(result.txHash).toBe('published-tx-hash');
    expect(result.pointer).toEqual({
      txHash: 'published-tx-hash',
      outputIndex: 0,
      scriptHash: TIER_B.hash,
    });
  });

  // Output 0 is not a convention that can drift: the pointer is built before
  // the transaction is submitted, so an output ordering change would silently
  // point at the change output instead.
  it('puts the script in output 0, where the pointer says it is', async () => {
    const w = wallet();
    let built = '';
    w.signTx = vi.fn(async (hex: string) => {
      built = hex;
      return 'signedhex';
    });
    await publish(TIER_B, { w });
    const outputs = deserializeTx(built).body().outputs();
    expect(outputs[0]?.scriptRef()).toBeDefined();
    expect(outputs[1]?.scriptRef()).toBeUndefined();
  });

  it('locks the deposit and returns the rest as change', async () => {
    const w = wallet();
    let built = '';
    w.signTx = vi.fn(async (hex: string) => {
      built = hex;
      return 'signedhex';
    });
    const result = await publish(TIER_B, { w });
    const outputs = deserializeTx(built).body().outputs();
    expect(outputs[0]?.amount().coin()).toBe(referenceOutputLovelace(TIER_B.compiledCode));
    expect(result.lockedLovelace).toBe(referenceOutputLovelace(TIER_B.compiledCode));
    // 400 ada in, the deposit locked, 1.5 fee — the remainder comes back.
    expect(outputs[1]?.amount().coin()).toBe(400_000_000n - referenceOutputLovelace(TIER_B.compiledCode) - 1_500_000n);
  });

  it('publishes the wrapped script, whose hash is the one it reports', async () => {
    const w = wallet();
    let built = '';
    w.signTx = vi.fn(async (hex: string) => {
      built = hex;
      return 'signedhex';
    });
    const result = await publish(TIER_A, { w });
    const ref = deserializeTx(built).body().outputs()[0]?.scriptRef();
    expect(ref?.hash()).toBe(result.pointer.scriptHash);
    expect(result.pointer.scriptHash).toBe(TIER_A.hash);
  });

  it('reports the size the surcharge is charged on, not the wrapped size', async () => {
    const result = await publish(TIER_B, { dryRun: true });
    expect(result.rawScriptBytes).toBe(rawScriptSize(TIER_B.compiledCode));
  });

  it('builds a transaction inside the cap for both curves', async () => {
    for (const v of [TIER_A, TIER_B]) {
      const result = await publish(v, { dryRun: true });
      expect(result.unsignedBytes).toBeLessThan(16_384);
    }
  });

  // ==========================================================================
  // Refusals, all before any ada moves
  // ==========================================================================

  it('refuses a script too large for one output to carry', async () => {
    const oversized = { compiledCode: '00'.repeat(MAX_PUBLISHABLE_SCRIPT_BYTES + 1) };
    await expect(publish(oversized, { dryRun: true })).rejects.toThrow(/cannot be split across transactions/i);
  });

  it('refuses when no single UTXO covers the deposit', async () => {
    const w = wallet([utxo('bb'.repeat(32), 0, '20000000')]);
    await expect(publish(TIER_B, { w, dryRun: true })).rejects.toThrow(/does not cover/i);
  });

  it('refuses an empty wallet by name', async () => {
    const w = wallet([]);
    await expect(publish(TIER_B, { w, dryRun: true })).rejects.toThrow(/no UTXOs/i);
  });

  // Found while publishing for real: a published reference script sits in an
  // ordinary UTXO at the publishing wallet's own address, so it is a perfectly
  // valid input — and spending it destroys the script while the transaction
  // succeeds, breaking every launch pointing at it.
  it('never spends a UTXO that is holding a reference script', async () => {
    const holder = utxo('ee'.repeat(32), 0, '900000000');
    holder.output.scriptRef = '590000';
    const w = wallet([holder, utxo('ff'.repeat(32), 0, '400000000')]);
    let built = '';
    w.signTx = vi.fn(async (hex: string) => {
      built = hex;
      return 'signedhex';
    });
    await publish(TIER_B, { w });
    const inputs = deserializeTx(built).body().inputs().toCore();
    // The script holder is the LARGEST, so largest-first alone would take it.
    expect(inputs.map((i) => i.txId)).toEqual(['ff'.repeat(32)]);
  });

  it('says why a wallet of nothing but reference scripts cannot publish', async () => {
    const holder = utxo('ee'.repeat(32), 0, '900000000');
    holder.output.scriptRef = '590000';
    const w = wallet([holder]);
    await expect(publish(TIER_B, { w, dryRun: true })).rejects.toThrow(/would destroy it/i);
  });

  it('picks the largest UTXO rather than the first', async () => {
    const w = wallet([utxo('cc'.repeat(32), 0, '30000000'), utxo('dd'.repeat(32), 1, '500000000')]);
    let built = '';
    w.signTx = vi.fn(async (hex: string) => {
      built = hex;
      return 'signedhex';
    });
    await publish(TIER_B, { w });
    const inputs = deserializeTx(built).body().inputs().toCore();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.txId).toBe('dd'.repeat(32));
  });
});

describe('the deposit, which is a deposit and not a cost', () => {
  // A flat figure large enough for the biggest validator over-locks every
  // smaller one. Sizing from the script is real ada on mainnet.
  it('asks less of a smaller validator', () => {
    expect(referenceOutputLovelace(TIER_A.compiledCode)).toBeLessThan(referenceOutputLovelace(TIER_B.compiledCode));
  });

  it('clears the ledger minimum without wildly exceeding it', () => {
    for (const v of [TIER_A, TIER_B]) {
      const deposit = referenceOutputLovelace(v.compiledCode);
      const bare = getUtxoMinLovelace({
        address:
          'addr_test1qz7pgfuh7nfjaps7ywqcd2ajjftuygr2h8h8v63pqp089ncqh4ycvc329t9aspu2lcad7kt9mglxs0g6uyy44gvnl9dsk9jc6z',
        amount: [{ unit: 'lovelace', quantity: '75000000' }],
        scriptRef: applyCborEncoding(v.compiledCode),
      });
      expect(deposit).toBeGreaterThan(bare);
      // Headroom for a protocol-parameter change, not slack for uncertainty:
      // both inputs to the rule are known exactly.
      expect(deposit).toBeLessThan((bare * 110n) / 100n);
    }
  });

  it('tracks the size of what it is holding', () => {
    // Roughly 4,310 lovelace per byte, so the two curves' deposits differ by
    // about what their sizes differ by.
    const perByte =
      (referenceOutputLovelace(TIER_B.compiledCode) - referenceOutputLovelace(TIER_A.compiledCode)) /
      BigInt(rawScriptSize(TIER_B.compiledCode) - rawScriptSize(TIER_A.compiledCode));
    expect(perByte).toBeGreaterThan(4_000n);
    expect(perByte).toBeLessThan(5_000n);
  });
});

describe('publishing a script the caller brought its own hash for', () => {
  it('publishes when the bytes hash to the hash supplied with them', async () => {
    const result = await publishReferenceScript({
      network: 'preprod',
      compiledScriptCbor: APPLIED_POOL.compiledCode,
      expectedScriptHash: APPLIED_POOL.hash,
      label: APPLIED_POOL.title,
      provider,
      wallet: wallet(),
      dryRun: true,
    });
    expect(result.pointer.scriptHash).toBe(APPLIED_POOL.hash);
  });

  // The failure this exists for is silent: a wrong script publishes perfectly
  // well and simply locks the deposit at an address nothing will ever spend
  // from. So the refusal has to happen before the transaction is built, not be
  // discovered when the pointer is used.
  it('refuses, and spends nothing, when they do not', async () => {
    const w = wallet();
    await expect(
      publishReferenceScript({
        network: 'preprod',
        compiledScriptCbor: APPLIED_POOL.compiledCode,
        // One nibble out — the shape of a hash transcribed rather than derived.
        expectedScriptHash: `${APPLIED_POOL.hash.slice(0, -1)}0`,
        label: APPLIED_POOL.title,
        provider,
        wallet: w,
        dryRun: true,
      }),
    ).rejects.toThrow(/does not hash to the hash supplied with it/);
    expect(w.signTx).not.toHaveBeenCalled();
  });

  // The unapplied form is the one sitting in the blueprint, so it is the wrong
  // script most easily reached for — and it is a real, valid script, so nothing
  // downstream would object to it.
  it('refuses the unapplied form of the same validator', async () => {
    const unapplied = validator('bonding_curve.bonding_curve.spend');
    await expect(
      publishReferenceScript({
        network: 'preprod',
        compiledScriptCbor: unapplied.compiledCode,
        expectedScriptHash: APPLIED_POOL.hash,
        label: APPLIED_POOL.title,
        provider,
        wallet: wallet(),
        dryRun: true,
      }),
    ).rejects.toThrow(/does not hash to the hash supplied with it/);
  });

  it('is case-insensitive about the hash, the way every other hash here is', async () => {
    const result = await publishReferenceScript({
      network: 'preprod',
      compiledScriptCbor: APPLIED_POOL.compiledCode,
      expectedScriptHash: APPLIED_POOL.hash.toUpperCase(),
      label: APPLIED_POOL.title,
      provider,
      wallet: wallet(),
      dryRun: true,
    });
    expect(result.pointer.scriptHash).toBe(APPLIED_POOL.hash);
  });

  it('still publishes without one, which is how a blueprint script arrives', async () => {
    const result = await publishReferenceScript({
      network: 'preprod',
      compiledScriptCbor: TIER_A.compiledCode,
      label: TIER_A.title,
      provider,
      wallet: wallet(),
      dryRun: true,
    });
    expect(result.pointer.scriptHash).toBe(scriptHashOf(TIER_A.compiledCode));
  });
});
