// mesh-curve-spend.test.ts — does the built transaction actually REFERENCE
// the validator, or does it quietly carry it after all?
//
// That is the only question worth asking here, and it cannot be answered by
// reading the builder calls: a library that ignored `spendingTxInReference`
// and embedded the script anyway would satisfy every mock assertion and
// produce a transaction over the size cap. So these tests build a real
// transaction from the real compiled curve and decode the result, checking
// that the witness set holds no script and the reference input names the
// published one.
//
// Everything is offline. The provider is a stand-in and the reference UTXO is
// invented, because what is under test is the SHAPE of the transaction rather
// than whether a node accepts it — node acceptance is what Preprod is for, and
// no structural check substitutes for it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Constr, credentialToAddress, Data } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ORDERS_PER_BATCH } from '../batch-planner.js';
import { capProofFor, hexToBytes } from '../cap-accumulator-tree.js';
import {
  type CurveSpendPlan,
  type CurveSpendWallet,
  type GraduationSpendPlan,
  MeshCurveSpender,
} from '../mesh-curve-spend.js';
import { MAX_TX_BYTES, rawScriptSize, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { capProofToPlutus } from '../tier-a-schemas.js';

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

const BUYER_KEY_HASH = '11'.repeat(28);
// A real enterprise address for that key hash. Coin selection rejects an
// address it cannot read a payment key hash out of, which a hand-typed
// bech32 string will not survive.
const WALLET_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: BUYER_KEY_HASH });
const REF_TX = 'ab'.repeat(32);
const CURVE_TX = 'cd'.repeat(32);
const TOKEN_UNIT = `${'aa'.repeat(28)}42424242`;

/** A plausible wallet UTXO — enough ada to cover a fee and change. */
function walletUtxo(txHash: string, index: number, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: index },
    output: { address: WALLET_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

function fakeWallet(): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(WALLET_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), 0, '500000000')]),
    getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), 0, '5000000')]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('submitted-hash'),
  };
}

/** Stands in for a chain provider. Execution units are fixed rather than real. */
function fakeProvider() {
  return {
    fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
    evaluateTx: vi.fn().mockResolvedValue([{ tag: 'SPEND', index: 0, budget: { mem: 2_000_000, steps: 800_000_000 } }]),
  };
}

function spender(v: { compiledCode: string; hash: string }, provider = fakeProvider()) {
  return new MeshCurveSpender({
    network: 'preprod',
    compiledScriptCbor: v.compiledCode,
    referenceScript: { txHash: REF_TX, outputIndex: 0, scriptHash: v.hash },
    provider,
  });
}

/** A buy: the curve keeps its state and its payment, the buyer gets tokens. */
function buyPlan(scriptAddress: string): CurveSpendPlan {
  return {
    scriptUtxo: {
      txHash: CURVE_TX,
      outputIndex: 0,
      address: scriptAddress,
      assets: { lovelace: 50_000_000n, [TOKEN_UNIT]: 1_000_000n },
    },
    // Shapes, not meaning: this module never interprets either, and using
    // real ones would only test the schemas a second time.
    redeemerCbor: 'd87980',
    continuing: { datumCbor: 'd87980', assets: { lovelace: 60_000_000n, [TOKEN_UNIT]: 900_000n } },
    payouts: [{ address: WALLET_ADDRESS, assets: { [TOKEN_UNIT]: 100_000n }, datumCbor: 'd87980' }],
    requiredSignerHashes: [BUYER_KEY_HASH],
  };
}

describe('MeshCurveSpender', () => {
  it('exposes the same script address the validator compiles to', () => {
    expect(spender(TIER_B).scriptAddress).toBe(scriptAddressOf(TIER_B.compiledCode, 0));
  });

  it('refuses a reference pointer published for a different validator', () => {
    expect(
      () =>
        new MeshCurveSpender({
          network: 'preprod',
          compiledScriptCbor: TIER_B.compiledCode,
          referenceScript: { txHash: REF_TX, outputIndex: 0, scriptHash: TIER_A.hash },
          provider: fakeProvider(),
        }),
    ).toThrow(/stale/i);
  });

  it('refuses to spend a UTXO locked by some other script', async () => {
    const s = spender(TIER_B);
    const plan = buyPlan(scriptAddressOf(TIER_A.compiledCode, 0));
    await expect(s.build(plan, fakeWallet())).rejects.toThrow(/would need the validator/i);
  });

  // A published reference script sits in an ordinary UTXO, and coin selection
  // has no idea it is special. The batcher's wallet is the one that holds
  // them, so this is the wallet where funding a transaction could destroy the
  // very script the transaction references.
  it('never funds itself by spending a reference script', async () => {
    const wallet = fakeWallet();
    const refHolder = walletUtxo('dd'.repeat(32), 0, '75000000');
    refHolder.output.scriptRef = '590000';
    // The script holder is by far the largest, so any size-led selection takes
    // it first.
    wallet.getUtxos = vi.fn().mockResolvedValue([refHolder, walletUtxo('11'.repeat(32), 0, '500000000')]);

    const s = spender(TIER_B);
    const hex = await s.build(buyPlan(s.scriptAddress), wallet);
    const inputs = deserializeTx(hex).body().inputs().toCore();
    expect(inputs.map((i) => i.txId)).not.toContain('dd'.repeat(32));
  });

  it('refuses to build without collateral, saying what is missing', async () => {
    const wallet = fakeWallet();
    wallet.getCollateral = vi.fn().mockResolvedValue([]);
    const s = spender(TIER_B);
    await expect(s.build(buyPlan(s.scriptAddress), wallet)).rejects.toThrow(/collateral/i);
  });

  // ==========================================================================
  // The claims that matter, checked against the decoded transaction
  // ==========================================================================

  for (const [tier, v] of [
    ['the linear curve', TIER_A],
    ['Cardano Launch', TIER_B],
  ] as const) {
    describe(`${tier}`, () => {
      it('leaves the validator out of the witness set entirely', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        const decoded = deserializeTx(hex);
        expect(decoded.witnessSet().plutusV3Scripts()?.size() ?? 0).toBe(0);
        expect(decoded.witnessSet().plutusV2Scripts()?.size() ?? 0).toBe(0);
        expect(decoded.witnessSet().plutusV1Scripts()?.size() ?? 0).toBe(0);
      });

      it('names the published reference script as an input', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        const refs = deserializeTx(hex).body().referenceInputs()?.toCore() ?? [];
        expect(refs.map((r) => `${r.txId}#${r.index}`)).toContain(`${REF_TX}#0`);
      });

      it('still carries the redeemer, without which the spend proves nothing', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        expect(deserializeTx(hex).witnessSet().redeemers()?.size() ?? 0).toBe(1);
      });

      it('leaves most of the transaction cap unused', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        // Referenced, the script is gone from the transaction entirely, so
        // what remains is the datum, the redeemer and the ordinary parts.
        // A real buy adds the cap proof on top of this; the headroom is what
        // makes room for it, and for a batch of them.
        expect(hex.length / 2).toBeLessThan(16_384 / 2);
      });
    });
  }

  // The comparison the whole module exists for, stated as a measurement
  // rather than left implicit.
  //
  // This claim has moved three times with the validator's size, and the
  // history is the point. It began as "an embedded Cardano Launch trade cannot
  // be built at ANY size". Reordering the curve datum so the fields a redeemer
  // rewrites sit at the front took the validator from 15,952 bytes to 13,699,
  // and a single embedded spend fitted again, so the claim was weakened to a
  // headroom one. The batcher allowlist took it back over at 16,006. Closing
  // the direct-trade arms then took 1,038 bytes off, and it fits once more.
  //
  // What has never changed is why the reference script exists. A batch spends
  // the same curve once but carries a proof PER ORDER, and an embedded script
  // is charged against the same 16,384 bytes those proofs need. The second
  // assertion is the one that matters and is the one that has held throughout.
  //
  // Both bounds are asserted rather than only the one that currently binds, so
  // the next size move corrects this comment rather than passing quietly. It
  // has now done that three times.
  it('leaves room for a batch of proofs only when the script is referenced', async () => {
    const s = spender(TIER_B);
    const referenced = (await s.build(buyPlan(s.scriptAddress), fakeWallet())).length / 2;
    const embedded = referenced + rawScriptSize(TIER_B.compiledCode);

    // A real proof, not an estimate: one walk of the 32-level cap tree, in the
    // CBOR the validator actually decodes.
    const proof = capProofToPlutus(capProofFor(hexToBytes(BUYER_KEY_HASH), []));
    const proofBytes = Data.to(new Constr(1, [proof as unknown as Data])).length / 2;
    const batchProofs = proofBytes * MAX_ORDERS_PER_BATCH;

    expect(referenced).toBeLessThan(MAX_TX_BYTES);
    expect(embedded).toBeLessThan(MAX_TX_BYTES);
    expect(referenced + batchProofs).toBeLessThan(MAX_TX_BYTES);
    expect(embedded + batchProofs).toBeGreaterThan(MAX_TX_BYTES);
  });

  it('delivers tokens with the settlement tag the validator reads', async () => {
    const s = spender(TIER_B);
    const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
    const outputs = deserializeTx(hex).body().outputs();
    const delivery = outputs.find((o) => o.toCore().value.assets?.size);
    expect(delivery).toBeDefined();
    expect(delivery?.datum()).toBeDefined();
  });

  it('tops the token-only delivery up to the minimum ada an output needs', async () => {
    const s = spender(TIER_B);
    const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
    const buyerOutputs = deserializeTx(hex)
      .body()
      .outputs()
      .map((o) => o.toCore())
      .filter((o) => o.value.assets && o.value.assets.size > 0);
    for (const out of buyerOutputs) expect(out.value.coins).toBeGreaterThan(0n);
  });

  it('signs and submits what it built', async () => {
    const wallet = fakeWallet();
    const s = spender(TIER_B);
    const hash = await s.submit(buyPlan(s.scriptAddress), wallet);
    expect(hash).toBe('submitted-hash');
    expect(wallet.signTx).toHaveBeenCalledOnce();
    expect(wallet.submitTx).toHaveBeenCalledWith('signed');
  });

  it('references the hash the validator itself compiles to', () => {
    const s = spender(TIER_B);
    expect(scriptHashOf(TIER_B.compiledCode)).toBe(TIER_B.hash);
    expect(s.scriptAddress).toContain('addr_test1');
  });
});

// ============================================================================
// Graduation — the transaction that spends THREE contracts at once.
// ============================================================================
// Graduate (curve) + SealLock (lp_escrow) + TopUpPool (staking_pool) settle in
// one transaction, and the first two validators together are over the 16,384-
// byte cap before a single input or output joins them. These tests build the
// real transaction from the real compiled validators and decode the result:
// the curve and the escrow must be NAMED as reference inputs, only the small
// pool validator may ride in the witness set, and the whole thing must fit.
//
// The size assertion is the point. The per-script budget test
// (script-size-budget.test.ts) bounds each validator alone; nothing bounded
// the PAIR a graduation carries, and growth in either validator could push
// the combined transaction over the cap without any test noticing. Building
// the full three-contract transaction here — with datums padded LARGER than
// any real launch's — makes that regression a failing test instead of a
// failed Preprod submission.
describe('MeshCurveSpender — graduation', () => {
  const LP = validator('lp_escrow.lp_escrow.spend');
  const POOL = validator('staking_pool.staking_pool.spend');
  const LP_REF_TX = 'ef'.repeat(32);
  const LP_ADDRESS = scriptAddressOf(LP.compiledCode, 0);
  const POOL_ADDRESS = scriptAddressOf(POOL.compiledCode, 0);
  const THREAD_UNIT = `${'bb'.repeat(28)}00`;

  /** Valid CBOR of at least `bytes` bytes — padding stand-in datums so the
   *  size assertion holds for datums BIGGER than any real launch writes. */
  function paddedDatum(bytes: number): string {
    return Data.to(new Constr(0, ['aa'.repeat(bytes)]));
  }

  function graduationProvider() {
    return {
      fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
      evaluateTx: vi.fn().mockResolvedValue([
        { tag: 'SPEND', index: 0, budget: { mem: 3_000_000, steps: 1_200_000_000 } },
        { tag: 'SPEND', index: 1, budget: { mem: 2_000_000, steps: 800_000_000 } },
        { tag: 'SPEND', index: 2, budget: { mem: 1_000_000, steps: 400_000_000 } },
      ]),
    };
  }

  function graduationPlan(s: MeshCurveSpender): GraduationSpendPlan {
    return {
      scriptUtxo: {
        txHash: CURVE_TX,
        outputIndex: 0,
        address: s.scriptAddress,
        assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 6_000_000n, [THREAD_UNIT]: 1n },
      },
      redeemerCbor: Data.to(new Constr(8, [])),
      continuing: {
        // Real curve datums run a few hundred bytes; 600 is a ceiling.
        datumCbor: paddedDatum(600),
        assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_500_000n, [THREAD_UNIT]: 1n },
      },
      companionInputs: [
        {
          utxo: {
            txHash: 'ee'.repeat(32),
            outputIndex: 0,
            address: LP_ADDRESS,
            assets: { lovelace: 2_000_000n, [THREAD_UNIT]: 1n },
          },
          redeemerCbor: Data.to(new Constr(0, [1_700_000_000_000n, 10_000_000n])),
          script: {
            compiledScriptCbor: LP.compiledCode,
            referenceScript: { txHash: LP_REF_TX, outputIndex: 0, scriptHash: LP.hash },
          },
        },
        {
          utxo: {
            txHash: 'ec'.repeat(32),
            outputIndex: 0,
            address: POOL_ADDRESS,
            assets: { lovelace: 1_400_000n, [THREAD_UNIT]: 1n },
          },
          redeemerCbor: Data.to(new Constr(2, [2_500_000n])),
          script: { embeddedScriptCbor: POOL.compiledCode },
        },
      ],
      payouts: [
        {
          address: LP_ADDRESS,
          assets: { lovelace: 12_000_000n, [TOKEN_UNIT]: 2_000_000n, [THREAD_UNIT]: 1n },
          datumCbor: paddedDatum(400),
        },
        {
          address: POOL_ADDRESS,
          assets: { lovelace: 1_700_000n, [TOKEN_UNIT]: 2_500_000n, [THREAD_UNIT]: 1n },
          datumCbor: paddedDatum(300),
        },
      ],
      requiredSignerHashes: [BUYER_KEY_HASH],
      validity: { fromMs: 1_756_000_000_000, toMs: 1_756_000_480_000 },
    };
  }

  function graduationSpender() {
    return spender(TIER_A, graduationProvider());
  }

  it('carries ONLY the pool validator — the curve and the escrow are referenced', async () => {
    const s = graduationSpender();
    const hex = await s.buildGraduation(graduationPlan(s), fakeWallet());
    const decoded = deserializeTx(hex);
    expect(decoded.witnessSet().plutusV3Scripts()?.size() ?? 0).toBe(1);
    const refs = decoded.body().referenceInputs()?.toCore() ?? [];
    const named = refs.map((r) => `${r.txId}#${r.index}`);
    expect(named).toContain(`${REF_TX}#0`);
    expect(named).toContain(`${LP_REF_TX}#0`);
    expect(decoded.witnessSet().redeemers()?.size() ?? 0).toBe(3);
  });

  it('fits the whole three-contract graduation under the transaction cap', async () => {
    const s = graduationSpender();
    const hex = await s.buildGraduation(graduationPlan(s), fakeWallet());
    // Signatures land on top of this; leave room for several of them.
    expect(hex.length / 2 + 500).toBeLessThan(MAX_TX_BYTES);
    // And the same transaction with the two referenced validators carried
    // instead is over the cap — which is why they are referenced.
    const embeddedEquivalent = hex.length / 2 + rawScriptSize(TIER_A.compiledCode) + rawScriptSize(LP.compiledCode);
    expect(embeddedEquivalent).toBeGreaterThan(MAX_TX_BYTES);
  });

  it('refuses a companion pointer published for a different validator', async () => {
    const s = graduationSpender();
    const plan = graduationPlan(s);
    const lp = plan.companionInputs[0];
    if (!lp || !('referenceScript' in lp.script)) throw new Error('fixture drift');
    lp.script.referenceScript = { txHash: LP_REF_TX, outputIndex: 0, scriptHash: TIER_B.hash };
    await expect(s.buildGraduation(plan, fakeWallet())).rejects.toThrow(/stale/i);
  });

  it('refuses a companion UTXO its pointer’s validator does not lock', async () => {
    const s = graduationSpender();
    const plan = graduationPlan(s);
    const lp = plan.companionInputs[0];
    if (!lp) throw new Error('fixture drift');
    lp.utxo.address = POOL_ADDRESS;
    await expect(s.buildGraduation(plan, fakeWallet())).rejects.toThrow(/would need the validator/i);
  });

  it('refuses a graduation with no companion inputs', async () => {
    const s = graduationSpender();
    const plan = graduationPlan(s);
    plan.companionInputs = [];
    await expect(s.buildGraduation(plan, fakeWallet())).rejects.toThrow(/no companion inputs/i);
  });

  it('collects every co-signer’s witness before submitting', async () => {
    const s = graduationSpender();
    const wallet = fakeWallet();
    const order: string[] = [];
    wallet.signTx = vi.fn().mockImplementation(async () => {
      order.push('wallet');
      return 'signed-1';
    });
    const coSigner = {
      signTx: vi.fn().mockImplementation(async (hex: string) => {
        order.push(`co:${hex}`);
        return 'signed-2';
      }),
    };
    const hash = await s.submitGraduation(graduationPlan(s), wallet, [coSigner]);
    expect(hash).toBe('submitted-hash');
    expect(order).toEqual(['wallet', 'co:signed-1']);
    expect(wallet.submitTx).toHaveBeenCalledWith('signed-2');
  });
});
