// key-curve-spend-wallet.test.ts
//
// This wallet has two jobs and both fail quietly when they fail.
//
// It signs with a key the platform's custody hands it, for an address the
// caller names separately — and if those two do not correspond, everything
// builds, submits, and is rejected by the node for a missing signature that
// names neither. So the pairing is checked before anything is built, and that
// check is what most of these tests are about.
//
// It also attaches a witness to a transaction someone else built, and the body
// that reaches the node has to be the body the builder costed — it carries a
// script-data hash over the redeemers, and a body whose bytes moved under it is
// rejected without the signature being mentioned at all. The transaction here
// is a REAL one, built by the real Mesh builder from a real compiled validator,
// so that is measured rather than asserted.
//
// Worth knowing before trusting it too far: reconstructing the transaction
// instead of adding to it passes these same tests, because this serialisation
// library round-trips the body byte-for-byte. So the body checks below pin the
// PROPERTY, and would catch a change that moved those bytes — they do not
// establish that adding a witness is the only way to hold it.
//
// Keys are derived from fixed entropy rather than a phrase: deterministic, and
// nothing seed-phrase-shaped goes in a public repository even when it controls
// nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CML, credentialToAddress } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { Crypto, deserializeTx } from '@meshsdk/core-cst';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { KeyCurveSpendWallet, type KeyWalletProvider } from '../key-curve-spend-wallet.js';
import { type CurveSpendPlan, MeshCurveSpender } from '../mesh-curve-spend.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}
const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);
// Same lookup helper as mesh-curve-spend.test.ts: returning the validator
// gives TIER_B a non-optional type at the declaration, which a bare find()
// plus a throw does not — TypeScript will not carry that narrowing into a
// hoisted function declaration, so every use inside one stays optional.
function validator(title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from plutus.json`);
  return found;
}

const TIER_B = validator('bonding_curve_tier_b.bonding_curve_tier_b.spend');

/** A real derived payment key, at the same path the platform's custody uses. */
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

const SIGNER = keyFromEntropy('11'.repeat(32));
const STRANGER = keyFromEntropy('22'.repeat(32));
const SIGNER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: SIGNER.keyHash });
const SCRIPT_ADDRESS = credentialToAddress('Preprod', { type: 'Script', hash: '33'.repeat(28) });

function utxo(txHash: string, lovelace: string, extra?: Partial<MeshUTxO['output']>): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: SIGNER_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }], ...extra },
  };
}

function provider(utxos: MeshUTxO[] = [utxo('aa'.repeat(32), '500000000')]): KeyWalletProvider {
  return {
    fetchAddressUTxOs: vi.fn().mockResolvedValue(utxos),
    submitTx: vi.fn().mockResolvedValue('submitted'),
  };
}

beforeAll(async () => {
  await Crypto.ready();
});

describe('the key must belong to the address', () => {
  it('accepts a key that signs for the address given', async () => {
    const wallet = await KeyCurveSpendWallet.forAddress({
      address: SIGNER_ADDRESS,
      privateKeyExtendedHex: SIGNER.extendedHex,
      provider: provider(),
    });
    expect(await wallet.getChangeAddress()).toBe(SIGNER_ADDRESS);
  });

  // The one that earns its keep: both halves are individually valid, and only
  // comparing them catches it.
  it('refuses a valid key for someone else’s address, naming both', async () => {
    await expect(
      KeyCurveSpendWallet.forAddress({
        address: SIGNER_ADDRESS,
        privateKeyExtendedHex: STRANGER.extendedHex,
        provider: provider(),
      }),
    ).rejects.toThrow(new RegExp(`${STRANGER.keyHash}[\\s\\S]*${SIGNER.keyHash}`));
  });

  it('refuses a script address, which cannot sign for anything', async () => {
    await expect(
      KeyCurveSpendWallet.forAddress({
        address: SCRIPT_ADDRESS,
        privateKeyExtendedHex: SIGNER.extendedHex,
        provider: provider(),
      }),
    ).rejects.toThrow(/no payment key hash/i);
  });

  // A 32-byte non-extended key is the plausible wrong thing to be handed.
  it('refuses a key that is not 64 bytes, saying how long it was', async () => {
    await expect(
      KeyCurveSpendWallet.forAddress({
        address: SIGNER_ADDRESS,
        privateKeyExtendedHex: SIGNER.extendedHex.slice(0, 64),
        provider: provider(),
      }),
    ).rejects.toThrow(/64-byte extended private key/i);
  });
});

describe('collateral', () => {
  async function collateralFrom(utxos: MeshUTxO[]) {
    const wallet = await KeyCurveSpendWallet.forAddress({
      address: SIGNER_ADDRESS,
      privateKeyExtendedHex: SIGNER.extendedHex,
      provider: provider(utxos),
    });
    return wallet.getCollateral();
  }

  it('takes the smallest that clears the floor, not the largest', async () => {
    const got = await collateralFrom([
      utxo('aa'.repeat(32), '900000000'),
      utxo('bb'.repeat(32), '6000000'),
      utxo('cc'.repeat(32), '50000000'),
    ]);
    expect(got.map((u) => u.input.txHash)).toEqual(['bb'.repeat(32)]);
  });

  it('will not offer a UTXO carrying tokens — Plutus collateral must be pure ada', async () => {
    const withToken = utxo('dd'.repeat(32), '90000000');
    withToken.output.amount.push({ unit: `${'ab'.repeat(28)}4e4f43`, quantity: '5' });
    expect(await collateralFrom([withToken])).toEqual([]);
  });

  it('will not offer one below the floor', async () => {
    expect(await collateralFrom([utxo('ee'.repeat(32), '4999999')])).toEqual([]);
  });

  // Collateral is only consumed when a script fails — which is exactly the
  // case worth surviving. A reference script lost that way breaks every launch
  // pointing at it, and this wallet belongs to the one account that holds them.
  it('never offers a reference script, pure ada though it is', async () => {
    const refHolder = utxo('ff'.repeat(32), '75000000', { scriptRef: '590000' });
    expect(await collateralFrom([refHolder])).toEqual([]);
    // And still finds a real one alongside it.
    const got = await collateralFrom([refHolder, utxo('11'.repeat(32), '80000000')]);
    expect(got.map((u) => u.input.txHash)).toEqual(['11'.repeat(32)]);
  });
});

describe('signing a transaction someone else built', () => {
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
    const tokenUnit = `${'aa'.repeat(28)}42424242`;
    const plan: CurveSpendPlan = {
      scriptUtxo: {
        txHash: 'cd'.repeat(32),
        outputIndex: 0,
        address: spender.scriptAddress,
        assets: { lovelace: 50_000_000n, [tokenUnit]: 1_000_000n },
      },
      redeemerCbor: 'd87980',
      continuing: { datumCbor: 'd87980', assets: { lovelace: 60_000_000n, [tokenUnit]: 900_000n } },
      payouts: [{ address: SIGNER_ADDRESS, assets: { [tokenUnit]: 100_000n }, datumCbor: 'd87980' }],
      requiredSignerHashes: [SIGNER.keyHash],
    };
    return spender.build(plan, {
      getChangeAddress: vi.fn().mockResolvedValue(SIGNER_ADDRESS),
      getUtxos: vi.fn().mockResolvedValue([utxo('aa'.repeat(32), '500000000')]),
      getCollateral: vi.fn().mockResolvedValue([utxo('bb'.repeat(32), '5000000')]),
      signTx: vi.fn(),
      submitTx: vi.fn(),
    });
  }

  async function signer() {
    return KeyCurveSpendWallet.forAddress({
      address: SIGNER_ADDRESS,
      privateKeyExtendedHex: SIGNER.extendedHex,
      provider: provider(),
    });
  }

  it('adds exactly one witness, and it is this key’s', async () => {
    const unsigned = await realUnsignedTx();
    expect(deserializeTx(unsigned).witnessSet().vkeys()?.size() ?? 0).toBe(0);

    const signed = await (await signer()).signTx(unsigned);
    const vkeys = deserializeTx(signed).witnessSet().vkeys();
    expect(vkeys?.size()).toBe(1);
    expect([...(vkeys?.values() ?? [])][0]?.vkey()).toBe(
      // The public key of the extended key, as the ledger records it.
      Buffer.from(
        CML.PrivateKey.from_extended_bytes(new Uint8Array(Buffer.from(SIGNER.extendedHex, 'hex')))
          .to_public()
          .to_raw_bytes(),
      ).toString('hex'),
    );
  });

  // The property the node actually checks — see this file's header for what
  // this does and does not establish.
  it('leaves the body byte-for-byte as the builder left it', async () => {
    const unsigned = await realUnsignedTx();
    const signed = await (await signer()).signTx(unsigned);
    expect(deserializeTx(signed).body().toCbor()).toBe(deserializeTx(unsigned).body().toCbor());
  });

  it('does not disturb the redeemers the spend proves itself with', async () => {
    const unsigned = await realUnsignedTx();
    const signed = await (await signer()).signTx(unsigned);
    expect(deserializeTx(signed).witnessSet().redeemers()?.toCbor()).toBe(
      deserializeTx(unsigned).witnessSet().redeemers()?.toCbor(),
    );
  });

  it('submits through the provider it was given', async () => {
    const p = provider();
    const wallet = await KeyCurveSpendWallet.forAddress({
      address: SIGNER_ADDRESS,
      privateKeyExtendedHex: SIGNER.extendedHex,
      provider: p,
    });
    expect(await wallet.submitTx('deadbeef')).toBe('submitted');
    expect(p.submitTx).toHaveBeenCalledWith('deadbeef');
  });
});
