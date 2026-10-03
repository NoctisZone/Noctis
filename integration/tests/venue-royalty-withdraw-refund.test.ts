// venue-royalty-withdraw-refund.test.ts
//
// A placer taking their royalty-withdraw requests back. Built against the
// compiled `withdraw_order` validator and judged by the offline evaluator
// (Scalus), so a refund that returns has been accepted by the script itself.
// The wallet holds a reference-script output, as a publishing wallet does, and
// the refund must never spend it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CML, credentialToAddress, Data } from '@lucid-evolution/lucid';
import { applyCborEncoding, type UTxO as MeshUTxO } from '@meshsdk/core';
import {
  Address,
  CborSet,
  deserializeTx,
  Ed25519PrivateKey,
  HexBlob,
  OfflineEvaluatorScalus,
  resolveTxHash,
  TransactionWitnessSet,
  toScriptRef,
  toTxUnspentOutput,
  VkeyWitness,
} from '@meshsdk/core-cst';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { scriptAddressOf } from '../reference-script.js';
import {
  VENUE_WITHDRAW_ORDER_TITLE,
  type VenueRoyaltyWithdrawConfigData,
  VenueRoyaltyWithdrawConfigSchema,
  type VenueWithdrawOrderUtxo,
} from '../venue-royalty-shapes.js';
import {
  buildVenueRoyaltyWithdrawRefund,
  readVenueRoyaltyWithdrawRequests,
  refundVenueRoyaltyWithdraws,
  VENUE_WITHDRAW_REFUND_EXECUTION_UNITS,
} from '../venue-royalty-withdraw-refund.js';
import { evaluatingProvider } from './support/takeover-chain.js';

const REQUEST_SCRIPT = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'plutus.json'), 'utf8'),
  ).validators.find((v: { title: string }) => v.title === VENUE_WITHDRAW_ORDER_TITLE) as { compiledCode: string }
).compiledCode;
const REQUEST_ADDRESS = scriptAddressOf(REQUEST_SCRIPT, 0);

function keyFromEntropy(byte: number) {
  const root = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(32).fill(byte), new Uint8Array());
  const raw = root
    .derive(1852 + 0x80000000)
    .derive(1815 + 0x80000000)
    .derive(0x80000000)
    .derive(0)
    .derive(0)
    .to_raw_key();
  const keyHash = raw.to_public().hash().to_hex();
  return {
    extendedHex: bytesToHex(raw.to_raw_bytes()),
    keyHash,
    address: credentialToAddress('Preprod', { type: 'Key', hash: keyHash }, { type: 'Key', hash: 'bb'.repeat(28) }),
  };
}

const PLACER = keyFromEntropy(0x55);
const STRANGER = keyFromEntropy(0x66);

function datum(owner: string, nftName = `10${'01'.repeat(31)}`): VenueRoyaltyWithdrawConfigData {
  return {
    withdraw_data: {
      pool_nft: { policy: 'aa'.repeat(28), name: nftName },
      withdraw_royalty_x: 9_000_000n,
      withdraw_royalty_y: 400n,
      ex_fee: 2_000_000n,
    },
    signature: 'ab'.repeat(64),
    additional_bytes: 'cd'.repeat(40),
    owner,
  };
}

function request(tag: string, owner = PLACER.keyHash, address = REQUEST_ADDRESS): VenueWithdrawOrderUtxo {
  return { txHash: tag.repeat(32), outputIndex: 0, address, assets: { lovelace: 4_000_000n }, datum: datum(owner) };
}

function onChain(r: VenueWithdrawOrderUtxo): MeshUTxO {
  return {
    input: { txHash: r.txHash, outputIndex: r.outputIndex },
    output: {
      address: r.address,
      amount: [{ unit: 'lovelace', quantity: (r.assets.lovelace ?? 0n).toString() }],
      plutusData: Data.to(r.datum, VenueRoyaltyWithdrawConfigSchema),
    },
  };
}

const PLAIN: MeshUTxO = {
  input: { txHash: 'd1'.repeat(32), outputIndex: 0 },
  output: { address: PLACER.address, amount: [{ unit: 'lovelace', quantity: '20000000' }] },
};
const PUBLISHED: MeshUTxO = {
  input: { txHash: 'd2'.repeat(32), outputIndex: 0 },
  output: {
    address: PLACER.address,
    amount: [{ unit: 'lovelace', quantity: '900000000' }],
    scriptRef: toScriptRef({ code: applyCborEncoding(REQUEST_SCRIPT), version: 'V3' }).toCbor(),
  },
};

function wallet(signer = PLACER, utxos: MeshUTxO[] = [PLAIN, PUBLISHED]): CurveSpendWallet {
  return {
    getChangeAddress: async () => signer.address,
    getUtxos: async () => utxos,
    getCollateral: async () => [PLAIN],
    signTx: async (tx) => tx,
    submitTx: async () => 'submitted',
  };
}

const inputsOf = (tx: string) =>
  deserializeTx(tx)
    .body()
    .inputs()
    .toCore()
    .map((i) => `${i.txId}#${i.index}`);

describe('taking a royalty-withdraw request back', () => {
  it('is accepted by the request validator, signed for by the placer, and paid back to their wallet', async () => {
    const r = request('e1');
    const tx = await buildVenueRoyaltyWithdrawRefund([r], wallet(), {
      network: 'preprod',
      requestScriptCbor: REQUEST_SCRIPT,
      provider: evaluatingProvider([onChain(r), PLAIN, PUBLISHED]) as never,
      executionUnits: 'evaluate',
    });
    const body = deserializeTx(tx).body();
    const redeemers = deserializeTx(tx).witnessSet().redeemers()?.toCore() ?? [];
    expect(redeemers).toHaveLength(1);
    const measured = redeemers[0]?.executionUnits;
    expect(measured?.memory).toBeGreaterThan(0);
    // The declared budget the browser carries covers what the script costs.
    expect(measured?.memory).toBeLessThanOrEqual(VENUE_WITHDRAW_REFUND_EXECUTION_UNITS.mem);
    expect(measured?.steps).toBeLessThanOrEqual(VENUE_WITHDRAW_REFUND_EXECUTION_UNITS.steps);
    expect(body.requiredSigners()?.toCore()).toEqual([PLACER.keyHash]);
    expect(inputsOf(tx)).toContain(`${r.txHash}#0`);
    expect(inputsOf(tx)).not.toContain(`${PUBLISHED.input.txHash}#0`);
    const outputs = body.outputs();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.address().toBech32()).toBe(PLACER.address);
  });

  it('takes several back in one transaction, carrying the validator once', async () => {
    const a = request('e2');
    const b = request('e3');
    const tx = await buildVenueRoyaltyWithdrawRefund([a, b], wallet(), {
      network: 'preprod',
      requestScriptCbor: REQUEST_SCRIPT,
      provider: evaluatingProvider([onChain(a), onChain(b), PLAIN, PUBLISHED]) as never,
      executionUnits: 'evaluate',
    });
    const witnesses = deserializeTx(tx).witnessSet();
    expect(witnesses.redeemers()?.toCore()).toHaveLength(2);
    expect(witnesses.plutusV3Scripts()?.toCore() ?? []).toHaveLength(1);
  });

  it('passes the validator with the budget the browser declares rather than measures', async () => {
    const r = request('e4');
    const known = [onChain(r), PLAIN, PUBLISHED];
    const provider = evaluatingProvider(known);
    const tx = await buildVenueRoyaltyWithdrawRefund([r], wallet(), {
      network: 'preprod',
      requestScriptCbor: REQUEST_SCRIPT,
      provider: provider as never,
    });
    const declared = deserializeTx(tx).witnessSet().redeemers()?.toCore()[0]?.executionUnits;
    expect(declared).toEqual({
      memory: VENUE_WITHDRAW_REFUND_EXECUTION_UNITS.mem,
      steps: VENUE_WITHDRAW_REFUND_EXECUTION_UNITS.steps,
    });
    const fetcher = { fetchUTxOs: provider.fetchUTxOs, fetchProtocolParameters: provider.fetchProtocolParameters };
    const evaluated = (await new OfflineEvaluatorScalus(fetcher as never, 'preprod').evaluateTx(
      tx,
      known,
      [],
    )) as Array<{
      budget: { mem: number; steps: number };
    }>;
    expect(evaluated).toHaveLength(1);
    for (const { budget } of evaluated) {
      expect(budget.mem).toBeLessThanOrEqual(VENUE_WITHDRAW_REFUND_EXECUTION_UNITS.mem);
      expect(budget.steps).toBeLessThanOrEqual(VENUE_WITHDRAW_REFUND_EXECUTION_UNITS.steps);
    }
  });

  it('refuses a request another key placed, naming both keys, before building anything', async () => {
    const r = request('e5', STRANGER.keyHash);
    await expect(
      buildVenueRoyaltyWithdrawRefund([r], wallet(), {
        network: 'preprod',
        requestScriptCbor: REQUEST_SCRIPT,
        provider: evaluatingProvider([onChain(r), PLAIN]) as never,
      }),
    ).rejects.toThrow(new RegExp(`placed by key ${STRANGER.keyHash}.*${PLACER.keyHash}`));
  });

  it('refuses an output that is not at the request address, and a request named twice', async () => {
    const elsewhere = request('e6', PLACER.keyHash, PLACER.address);
    const cfg = {
      network: 'preprod' as const,
      requestScriptCbor: REQUEST_SCRIPT,
      provider: evaluatingProvider([]) as never,
    };
    await expect(buildVenueRoyaltyWithdrawRefund([elsewhere], wallet(), cfg)).rejects.toThrow(
      /not at the withdraw request address/,
    );
    const r = request('e7');
    await expect(buildVenueRoyaltyWithdrawRefund([r, r], wallet(), cfg)).rejects.toThrow(/names .* twice/);
    await expect(buildVenueRoyaltyWithdrawRefund([], wallet(), cfg)).rejects.toThrow(/no withdraw request/);
  });

  it('reads only the requests the owner placed, passing over outputs that are not requests', async () => {
    const mine = request('f1');
    const theirs = request('f2', STRANGER.keyHash);
    const row = (r: VenueWithdrawOrderUtxo, inline: string | null) => ({
      tx_hash: r.txHash,
      output_index: r.outputIndex,
      address: r.address,
      amount: [{ unit: 'lovelace', quantity: '4000000' }],
      inline_datum: inline,
    });
    const pages: Record<string, unknown[]> = {
      [`addresses/${REQUEST_ADDRESS}/utxos?page=1`]: [
        row(mine, Data.to(mine.datum, VenueRoyaltyWithdrawConfigSchema)),
        row(theirs, Data.to(theirs.datum, VenueRoyaltyWithdrawConfigSchema)),
        row(request('f3'), 'd87980'),
        row(request('f4'), null),
      ],
    };
    const get = vi.fn(async (path: string) => pages[path] ?? []);
    const found = await readVenueRoyaltyWithdrawRequests(get, REQUEST_ADDRESS, PLACER.keyHash);
    expect(found.map((r) => r.txHash)).toEqual([mine.txHash]);
    expect(found[0]?.datum.withdraw_data.withdraw_royalty_y).toBe(400n);
    expect(await readVenueRoyaltyWithdrawRequests(get, REQUEST_ADDRESS)).toHaveLength(2);
  });

  it('signs with the connected CIP-30 wallet and submits', async () => {
    const r = request('f5');
    const key = Ed25519PrivateKey.fromExtendedHex(PLACER.extendedHex);
    const submitted: string[] = [];
    const api = {
      getUtxos: vi.fn(async () => [PLAIN, PUBLISHED].map((u) => toTxUnspentOutput(u).toCbor())),
      getCollateral: vi.fn(async () => [toTxUnspentOutput(PLAIN).toCbor()]),
      getChangeAddress: vi.fn(async () => Address.fromBech32(PLACER.address).toBytes()),
      signTx: vi.fn(async (tx: string) => {
        const witness = new VkeyWitness(key.toPublic().hex(), key.sign(HexBlob(resolveTxHash(tx))).hex());
        const set = new TransactionWitnessSet();
        set.setVkeys(CborSet.fromCore([witness.toCore()], VkeyWitness.fromCore));
        return set.toCbor();
      }),
      submitTx: vi.fn(async (tx: string) => {
        submitted.push(tx);
        return resolveTxHash(tx);
      }),
    };
    const res = await refundVenueRoyaltyWithdraws({
      api: api as never,
      requests: [r],
      config: {
        network: 'preprod',
        requestScriptCbor: REQUEST_SCRIPT,
        provider: evaluatingProvider([onChain(r), PLAIN, PUBLISHED]) as never,
      },
    });
    expect(submitted).toHaveLength(1);
    expect(res.txHash).toBe(resolveTxHash(submitted[0] as string));
    expect(res.heldLovelace).toBe(4_000_000n);
    expect(
      deserializeTx(submitted[0] as string)
        .witnessSet()
        .vkeys()
        ?.size(),
    ).toBe(1);
  });
});
