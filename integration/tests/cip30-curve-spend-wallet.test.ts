// cip30-curve-spend-wallet.test.ts
//
// The wallet a creator connects in the browser, standing in for the platform's
// key wallet on a referenced curve spend. The CIP-30 side is faked, but with
// real bytes: UTXOs arrive as the CBOR a wallet really hands over, and the
// witness it returns is a real signature over a real transaction built by the
// real Mesh builder from the real compiled curve.
//
// Keys are derived from fixed entropy rather than a phrase: deterministic, and
// nothing seed-phrase-shaped goes in a public repository even when it controls
// nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CML, credentialToAddress } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import {
  Address,
  CborSet,
  Crypto,
  deserializeTx,
  Ed25519PrivateKey,
  HexBlob,
  resolveTxHash,
  TransactionWitnessSet,
  toTxUnspentOutput,
  VkeyWitness,
} from '@meshsdk/core-cst';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type Cip30Api, Cip30CurveSpendWallet } from '../cip30-curve-spend-wallet.js';
import { type CurveSpendPlan, MeshCurveSpender } from '../mesh-curve-spend.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}
const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);
function validator(title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} is not in plutus.json`);
  return found;
}
const TIER_B = validator('bonding_curve_tier_b.bonding_curve_tier_b.spend');

function keyFromEntropy(entropyHex: string): { extendedHex: string; keyHash: string } {
  const root = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(Buffer.from(entropyHex, 'hex')), new Uint8Array());
  const payment = root
    .derive(1852 + 0x80000000)
    .derive(1815 + 0x80000000)
    .derive(0x80000000)
    .derive(0)
    .derive(0)
    .to_raw_key();
  return {
    extendedHex: Buffer.from(payment.to_raw_bytes()).toString('hex'),
    keyHash: payment.to_public().hash().to_hex(),
  };
}

const CREATOR = keyFromEntropy('33'.repeat(32));
const CREATOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: CREATOR.keyHash });
const TOKEN_UNIT = `${'aa'.repeat(28)}42424242`;

function utxo(txHash: string, lovelace: string, extra?: Partial<MeshUTxO['output']>): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: CREATOR_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }], ...extra },
  };
}

/** A CIP-30 wallet holding `utxos`, signing with the creator's key. */
function fakeApi(utxos: MeshUTxO[] | null = [utxo('aa'.repeat(32), '500000000')]): Cip30Api & {
  signTx: ReturnType<typeof vi.fn>;
  submitTx: ReturnType<typeof vi.fn>;
} {
  const key = Ed25519PrivateKey.fromExtendedHex(CREATOR.extendedHex);
  return {
    getUtxos: vi.fn().mockResolvedValue(utxos === null ? null : utxos.map((u) => toTxUnspentOutput(u).toCbor())),
    getChangeAddress: vi.fn().mockResolvedValue(Address.fromBech32(CREATOR_ADDRESS).toBytes()),
    signTx: vi.fn(async (tx: string) => {
      const witness = new VkeyWitness(key.toPublic().hex(), key.sign(HexBlob(resolveTxHash(tx))).hex());
      const set = new TransactionWitnessSet();
      set.setVkeys(CborSet.fromCore([witness.toCore()], VkeyWitness.fromCore));
      return set.toCbor();
    }),
    submitTx: vi.fn().mockResolvedValue('submitted-by-wallet'),
  };
}

beforeAll(async () => {
  await Crypto.ready();
});

describe('reading the wallet over CIP-30', () => {
  it('turns the raw change address into the bech32 the builder wants', async () => {
    expect(await new Cip30CurveSpendWallet(fakeApi()).getChangeAddress()).toBe(CREATOR_ADDRESS);
  });

  it('decodes the UTXOs a wallet hands over as CBOR', async () => {
    const got = await new Cip30CurveSpendWallet(
      fakeApi([
        utxo('aa'.repeat(32), '7000000'),
        utxo('bb'.repeat(32), '2000000', {
          amount: [
            { unit: 'lovelace', quantity: '2000000' },
            { unit: TOKEN_UNIT, quantity: '5' },
          ],
        }),
      ]),
    ).getUtxos();
    expect(got.map((u) => u.input.txHash)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    expect(got[1]?.output.amount).toEqual([
      { unit: 'lovelace', quantity: '2000000' },
      { unit: TOKEN_UNIT, quantity: '5' },
    ]);
  });

  it('reads a wallet that reports no UTXOs as empty', async () => {
    expect(await new Cip30CurveSpendWallet(fakeApi(null)).getUtxos()).toEqual([]);
  });
});

describe('collateral', () => {
  async function collateralFrom(utxos: MeshUTxO[]) {
    const wallet = new Cip30CurveSpendWallet(fakeApi([]));
    vi.spyOn(wallet, 'getUtxos').mockResolvedValue(utxos);
    return wallet.getCollateral();
  }

  it('pledges the smallest plain output of at least 5 ADA', async () => {
    const got = await collateralFrom([
      utxo('11'.repeat(32), '9000000'),
      utxo('22'.repeat(32), '6000000'),
      utxo('33'.repeat(32), '4000000'),
      utxo('44'.repeat(32), '5500000', {
        amount: [
          { unit: 'lovelace', quantity: '5500000' },
          { unit: TOKEN_UNIT, quantity: '1' },
        ],
      }),
    ]);
    expect(got.map((u) => u.input.txHash)).toEqual(['22'.repeat(32)]);
  });

  it('never pledges an output that carries a reference script', async () => {
    const got = await collateralFrom([
      utxo('55'.repeat(32), '5000000', { scriptRef: '82025901' }),
      utxo('66'.repeat(32), '8000000'),
    ]);
    expect(got.map((u) => u.input.txHash)).toEqual(['66'.repeat(32)]);
  });

  it('says what to do when nothing qualifies', async () => {
    await expect(collateralFrom([utxo('77'.repeat(32), '3000000')])).rejects.toThrow(
      /no plain output of at least 5 ADA/,
    );
  });
});

describe('signing a spend the builder made', () => {
  /** A real referenced Cardano Launch spend, built by the real builder. */
  async function realUnsignedTx(): Promise<string> {
    const spender = new MeshCurveSpender({
      network: 'preprod',
      compiledScriptCbor: TIER_B.compiledCode,
      referenceScript: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: TIER_B.hash },
      provider: {
        fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
        evaluateTx: vi
          .fn()
          .mockResolvedValue([{ tag: 'SPEND', index: 0, budget: { mem: 2_000_000, steps: 800_000_000 } }]),
      },
    });
    const plan: CurveSpendPlan = {
      scriptUtxo: {
        txHash: 'cd'.repeat(32),
        outputIndex: 0,
        address: spender.scriptAddress,
        assets: { lovelace: 50_000_000n, [TOKEN_UNIT]: 1_000_000n },
      },
      redeemerCbor: 'd87980',
      continuing: { datumCbor: 'd87980', assets: { lovelace: 40_000_000n, [TOKEN_UNIT]: 1_000_000n } },
      payouts: [{ address: CREATOR_ADDRESS, assets: { lovelace: 10_000_000n }, datumCbor: 'd87980' }],
      requiredSignerHashes: [CREATOR.keyHash],
    };
    return spender.build(plan, {
      getChangeAddress: vi.fn().mockResolvedValue(CREATOR_ADDRESS),
      getUtxos: vi.fn().mockResolvedValue([utxo('aa'.repeat(32), '500000000')]),
      getCollateral: vi.fn().mockResolvedValue([utxo('bb'.repeat(32), '5000000')]),
      signTx: vi.fn(),
      submitTx: vi.fn(),
    });
  }

  it('asks the wallet for a partial signature, since the script input is not its to sign', async () => {
    const api = fakeApi();
    const unsigned = await realUnsignedTx();
    await new Cip30CurveSpendWallet(api).signTx(unsigned);
    expect(api.signTx).toHaveBeenCalledWith(unsigned, true);
  });

  it('adds the wallet’s witness and leaves the body as the builder left it', async () => {
    const unsigned = await realUnsignedTx();
    const signed = await new Cip30CurveSpendWallet(fakeApi()).signTx(unsigned);
    const vkeys = deserializeTx(signed).witnessSet().vkeys();
    expect(vkeys?.size()).toBe(1);
    expect([...(vkeys?.values() ?? [])][0]?.vkey()).toBe(
      Ed25519PrivateKey.fromExtendedHex(CREATOR.extendedHex).toPublic().hex(),
    );
    expect(deserializeTx(signed).body().toCbor()).toBe(deserializeTx(unsigned).body().toCbor());
    expect(deserializeTx(signed).witnessSet().redeemers()?.toCbor()).toBe(
      deserializeTx(unsigned).witnessSet().redeemers()?.toCbor(),
    );
  });

  it('submits through the wallet', async () => {
    const api = fakeApi();
    expect(await new Cip30CurveSpendWallet(api).submitTx('84a0')).toBe('submitted-by-wallet');
    expect(api.submitTx).toHaveBeenCalledWith('84a0');
  });
});
