// venue-royalty-withdraw-placer.test.ts
//
// A creator placing a royalty-withdraw request from their browser wallet. The
// wallet is faked over CIP-30 with real bytes: its outputs arrive as CBOR, one
// of them carrying a reference script as a publishing wallet's would, it signs
// data through Lucid Evolution's CIP-8 signer, and it signs the placement with
// a real key.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CML, credentialToAddress, Data, signData } from '@lucid-evolution/lucid';
import { applyCborEncoding, DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import {
  Address,
  CborSet,
  deserializeTx,
  Ed25519PrivateKey,
  HexBlob,
  resolveTxHash,
  TransactionWitnessSet,
  toScriptRef,
  toTxUnspentOutput,
  VkeyWitness,
} from '@meshsdk/core-cst';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { scriptAddressOf } from '../reference-script.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import { VENUE_WITHDRAW_ORDER_TITLE, VenueRoyaltyWithdrawConfigSchema } from '../venue-royalty-shapes.js';
import {
  VENUE_ROYALTY_REWARD_FLOOR_LOVELACE,
  VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE,
  venueWithdrawSignatureForm,
} from '../venue-royalty-withdraw.js';
import {
  type Cip30SigningApi,
  placeVenueRoyaltyWithdraw,
  readVenuePoolByNft,
} from '../venue-royalty-withdraw-placer.js';
import type { VenuePoolUtxo } from '../venue-swap.js';

const REQUEST = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'plutus.json'), 'utf8'),
).validators.find((v: { title: string }) => v.title === VENUE_WITHDRAW_ORDER_TITLE) as { compiledCode: string };
const REQUEST_ADDRESS = scriptAddressOf(REQUEST.compiledCode, 0);

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
    raw,
    extendedHex: bytesToHex(raw.to_raw_bytes()),
    publicKeyHex: bytesToHex(raw.to_public().to_raw_bytes()),
    keyHash,
    // A wallet's usual address: its payment key, and a stake key of its own.
    address: credentialToAddress('Preprod', { type: 'Key', hash: keyHash }, { type: 'Key', hash: 'bb'.repeat(28) }),
  };
}

const CREATOR = keyFromEntropy(0x33);
const STRANGER = keyFromEntropy(0x44);

const FACTORY = 'aa'.repeat(28);
const LAUNCH = '01'.repeat(31);

function pool(): VenuePoolUtxo {
  const datum: VenuePoolConfigData = {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: 'bb'.repeat(28), name: '746f6b656e' },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_700n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 9_000_000n,
    royalty_y: 400n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(28),
    royalty_pub_key: CREATOR.publicKeyHex,
    nonce: 2n,
  };
  return { txHash: 'c1'.repeat(32), outputIndex: 0, address: 'addr_test1wpool', assets: { lovelace: 1n }, datum };
}

const PLAIN = 'd1'.repeat(32);
const PUBLISHED = 'd2'.repeat(32);

function walletOutputs(address: string): MeshUTxO[] {
  return [
    {
      input: { txHash: PLAIN, outputIndex: 0 },
      output: { address, amount: [{ unit: 'lovelace', quantity: '20000000' }] },
    },
    {
      input: { txHash: PUBLISHED, outputIndex: 0 },
      output: {
        address,
        amount: [{ unit: 'lovelace', quantity: '900000000' }],
        scriptRef: toScriptRef({ code: applyCborEncoding(REQUEST.compiledCode), version: 'V3' }).toCbor(),
      },
    },
  ];
}

/** A CIP-30 wallet holding `signer`'s outputs and signing with its key. */
function api(signer: ReturnType<typeof keyFromEntropy>) {
  const key = Ed25519PrivateKey.fromExtendedHex(signer.extendedHex);
  const submitted: string[] = [];
  const wallet: Cip30SigningApi & { submitted: string[] } = {
    submitted,
    getUtxos: vi.fn(async () => walletOutputs(signer.address).map((u) => toTxUnspentOutput(u).toCbor())),
    getChangeAddress: vi.fn(async () => Address.fromBech32(signer.address).toBytes()),
    signData: vi.fn(async (addressHex: string, payload: string) =>
      signData(addressHex, payload, signer.raw.to_bech32()),
    ),
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
  return wallet;
}

const provider = { fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS) };

describe('placing a royalty-withdraw request from the browser', () => {
  it('pays the request its fee and reward floor, with a datum the executor will accept', async () => {
    const wallet = api(CREATOR);
    const placed = await placeVenueRoyaltyWithdraw({
      api: wallet,
      pool: pool(),
      network: 'preprod',
      requestAddress: REQUEST_ADDRESS,
      provider,
    });
    expect(wallet.submitted).toHaveLength(1);
    const tx = deserializeTx(wallet.submitted[0] ?? '');
    const out = tx.body().outputs()[0];
    expect(out?.address().toBech32()).toBe(REQUEST_ADDRESS);
    expect(out?.amount().coin()).toBe(VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE + VENUE_ROYALTY_REWARD_FLOOR_LOVELACE);
    expect(out?.amount().multiasset()?.size ?? 0).toBe(0);

    const datum = Data.from(out?.datum()?.asInlineData()?.toCbor() ?? '', VenueRoyaltyWithdrawConfigSchema);
    expect(datum.owner).toBe(CREATOR.keyHash);
    expect(datum.withdraw_data).toEqual(placed.draft.withdrawData);
    await expect(venueWithdrawSignatureForm(pool(), { datum })).resolves.toEqual({ hashed: false });
    expect(placed.txHash).toBe(resolveTxHash(wallet.submitted[0] ?? ''));
  });

  it('never spends the output that publishes a reference script, however much it holds', async () => {
    const wallet = api(CREATOR);
    await placeVenueRoyaltyWithdraw({
      api: wallet,
      pool: pool(),
      network: 'preprod',
      requestAddress: REQUEST_ADDRESS,
      provider,
    });
    const inputs = deserializeTx(wallet.submitted[0] ?? '')
      .body()
      .inputs()
      .toCore();
    expect(inputs.map((i) => i.txId)).toEqual([PLAIN]);
  });

  it('refuses a wallet whose key the pool does not pay, before anything is paid', async () => {
    const wallet = api(STRANGER);
    await expect(
      placeVenueRoyaltyWithdraw({
        api: wallet,
        pool: pool(),
        network: 'preprod',
        requestAddress: REQUEST_ADDRESS,
        provider,
      }),
    ).rejects.toThrow(/key the pool does not pay/);
    expect(wallet.submitted).toEqual([]);
    expect(wallet.signTx).not.toHaveBeenCalled();
  });

  it('refuses when the pool owes nothing, before asking the wallet anything', async () => {
    const wallet = api(CREATOR);
    const empty = pool();
    empty.datum = { ...empty.datum, royalty_x: 0n, royalty_y: 0n };
    await expect(
      placeVenueRoyaltyWithdraw({
        api: wallet,
        pool: empty,
        network: 'preprod',
        requestAddress: REQUEST_ADDRESS,
        provider,
      }),
    ).rejects.toThrow(/owes no royalty/);
    expect(wallet.signData).not.toHaveBeenCalled();
  });
});

describe('reading the pool a creator withdraws from', () => {
  const NFT_UNIT = `${FACTORY}10${LAUNCH}`;
  const asBlockfrost = (datumCbor: string) => [
    {
      tx_hash: 'c1'.repeat(32),
      output_index: 2,
      address: 'addr_test1wpool',
      amount: [
        { unit: 'lovelace', quantity: '50000000' },
        { unit: NFT_UNIT, quantity: '1' },
      ],
      inline_datum: datumCbor,
    },
  ];

  it('reads the one output holding the pool NFT, and decodes its datum', async () => {
    const get = vi.fn(async () => asBlockfrost(Data.to(pool().datum, VenuePoolConfigSchema)));
    const read = await readVenuePoolByNft(get, 'addr_test1wpool', NFT_UNIT);
    expect(get).toHaveBeenCalledWith(`addresses/addr_test1wpool/utxos/${NFT_UNIT}`);
    expect(read).toMatchObject({ txHash: 'c1'.repeat(32), outputIndex: 2, datum: pool().datum });
    expect(read.assets).toEqual({ lovelace: 50_000_000n, [NFT_UNIT]: 1n });
  });

  it('refuses when the pool cannot be found', async () => {
    await expect(readVenuePoolByNft(async () => [], 'addr_test1wpool', NFT_UNIT)).rejects.toThrow(/could not be found/);
  });

  it('refuses an output whose datum names another pool', async () => {
    const other = { ...pool().datum, pool_nft: { policy: FACTORY, name: `10${'02'.repeat(31)}` } };
    await expect(
      readVenuePoolByNft(async () => asBlockfrost(Data.to(other, VenuePoolConfigSchema)), 'addr_test1wpool', NFT_UNIT),
    ).rejects.toThrow(/names a different pool/);
  });
});
