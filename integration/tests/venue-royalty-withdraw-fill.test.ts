// venue-royalty-withdraw-fill.test.ts
//
// A royalty withdraw built end to end against the real venue scripts: the
// pool named by reference as it is deployed, the request validator and the
// withdraw script carried, a request signed through Lucid Evolution's CIP-8
// signer, and the plan the executor derives from it.
//
// Budgets are declared the way the batch CLI declares them: the swap budget
// for the pool and the request, and the withdraw script's own, which is above
// what it measured in Aiken. So the fee these transactions compute is what a
// real fill pays, and a request's fixed fee is checked against it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CML, credentialToAddress, Data, signData } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS } from '@meshsdk/core';
import { Address, deserializeTx } from '@meshsdk/core-cst';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { MAX_TX_BYTES, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { VenueBatcher } from '../venue-batcher.js';
import type { ProviderUtxo, VenueChainProvider } from '../venue-chain-reader.js';
import {
  VENUE_FILL_EXECUTION_UNITS,
  VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE,
  VENUE_ROYALTY_WITHDRAW_EXECUTION_UNITS,
  VenueFiller,
  type VenueFillPlan,
} from '../venue-fill-submitter.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  draftVenueRoyaltyWithdraw,
  planVenueRoyaltyWithdrawFill,
  VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE,
  VENUE_ROYALTY_WITHDRAW_TITLE,
  VENUE_WITHDRAW_ORDER_TITLE,
  VenueRoyaltyWithdrawConfigSchema,
  type VenueWithdrawOrderUtxo,
  venueRoyaltyWithdrawDatum,
  venueRoyaltyWithdrawRedeemer,
  venueSignatureFromCip30,
} from '../venue-royalty-withdraw.js';
import { VENUE_POOL_ACTION, type VenuePoolUtxo, venuePoolRedeemer } from '../venue-swap.js';

interface Validator {
  title: string;
  compiledCode: string;
  hash: string;
  parameters?: Array<{ value: string }>;
}
function load(file: string): Validator[] {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', file), 'utf8'))
    .validators;
}
function pick(list: Validator[], title: string): Validator {
  const found = list.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from the venue blueprint`);
  return found;
}

const APPLIED = load(join('deployment', 'applied.json'));
const POOL = pick(APPLIED, 'royalty_pool/pool.pool.spend');
const ROYALTY = pick(APPLIED, VENUE_ROYALTY_WITHDRAW_TITLE);
const REQUEST = pick(load('plutus.json'), VENUE_WITHDRAW_ORDER_TITLE);
const POOL_ADDRESS = scriptAddressOf(POOL.compiledCode, 0);
const REQUEST_ADDRESS = scriptAddressOf(REQUEST.compiledCode, 0);

const UNITS = VENUE_FILL_EXECUTION_UNITS;

const EXECUTOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '11'.repeat(28) });
const PLATFORM_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '12'.repeat(28) });

const root = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(32).fill(0x33), new Uint8Array());
const CREATOR_KEY = root
  .derive(1852 + 0x80000000)
  .derive(1815 + 0x80000000)
  .derive(0x80000000)
  .derive(0)
  .derive(0)
  .to_raw_key();
const CREATOR_PUB = bytesToHex(CREATOR_KEY.to_public().to_raw_bytes());
const CREATOR_PKH = CREATOR_KEY.to_public().hash().to_hex();
const CREATOR_WALLET_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: CREATOR_PKH });

const TOKEN = { policy: 'bb'.repeat(28), name: '746f6b656e' };
// Shaped as the factory mints them, so the batcher's pool reader accepts the pool.
const FACTORY = 'aa'.repeat(28);
const LAUNCH = '01'.repeat(31);
const NFT = { policy: FACTORY, name: `10${LAUNCH}` };
const LQ = { policy: FACTORY, name: `11${LAUNCH}` };
const TOKEN_UNIT = TOKEN.policy + TOKEN.name;

function pool(nonce = 7n): VenuePoolUtxo {
  const datum: VenuePoolConfigData = {
    pool_nft: NFT,
    pool_x: { policy: '', name: '' },
    pool_y: TOKEN,
    pool_lq: LQ,
    fee_num: 99_700n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 12_000_000n,
    royalty_y: 3_000n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(28),
    royalty_pub_key: CREATOR_PUB,
    nonce,
  };
  return {
    txHash: 'b1'.repeat(32),
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: {
      lovelace: 20_000_000_000n,
      [TOKEN_UNIT]: 200_000_000n,
      [NFT.policy + NFT.name]: 1n,
      [LQ.policy + LQ.name]: 9_000_000n,
    },
    datum,
  };
}

async function request(p: VenuePoolUtxo, txHash = 'b2'.repeat(32), takeX?: bigint): Promise<VenueWithdrawOrderUtxo> {
  const draft = draftVenueRoyaltyWithdraw({
    pool: p,
    network: 'Preprod',
    // A partial request takes ADA only, so two of them compete for nothing but the nonce.
    ...(takeX !== undefined ? { takeX, takeY: 0n } : {}),
  });
  const signed = signData(
    Address.fromBech32(CREATOR_WALLET_ADDRESS).toBytes(),
    draft.payloadHex,
    CREATOR_KEY.to_bech32(),
  );
  const sig = await venueSignatureFromCip30(signed, draft.payloadHex);
  return {
    txHash,
    outputIndex: 0,
    address: REQUEST_ADDRESS,
    assets: { lovelace: draft.requestLovelace },
    datum: venueRoyaltyWithdrawDatum(draft, sig, CREATOR_PKH),
  };
}

function wallet(): CurveSpendWallet {
  const utxo = (txHash: string, lovelace: string) => ({
    input: { txHash, outputIndex: 0 },
    output: { address: EXECUTOR_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  });
  return {
    getChangeAddress: vi.fn().mockResolvedValue(EXECUTOR_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([]),
    getCollateral: vi.fn().mockResolvedValue([utxo('c1'.repeat(32), '5000000')]),
    signTx: vi.fn(),
    submitTx: vi.fn(),
  };
}

function filler(): VenueFiller {
  return new VenueFiller({
    network: 'preprod',
    poolScript: {
      compiledScriptCbor: POOL.compiledCode,
      referenceScript: { txHash: 'a1'.repeat(32), outputIndex: 0, scriptHash: POOL.hash },
    },
    orderScript: { embeddedScriptCbor: REQUEST.compiledCode },
    withdrawScript: { embeddedScriptCbor: REQUEST.compiledCode },
    royaltyWithdrawScript: { embeddedScriptCbor: ROYALTY.compiledCode },
    provider: { fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS) },
    executionUnits: UNITS,
  });
}

async function plan(): Promise<VenueFillPlan> {
  const p = pool();
  const r = await request(p);
  const fill = await planVenueRoyaltyWithdrawFill({
    pool: p,
    request: r,
    network: 'Preprod',
    minOutputLovelace: 1_000_000n,
  });
  return {
    kind: 'withdraw',
    pool: { txHash: p.txHash, outputIndex: p.outputIndex, address: p.address, assets: p.assets },
    order: { txHash: r.txHash, outputIndex: r.outputIndex, address: r.address, assets: r.assets },
    poolOutput: { address: p.address, assets: fill.poolAssets, datumCbor: fill.nextDatumCbor },
    successorOutput: fill.reward,
    royaltySignatureHashed: fill.hashed,
  };
}

describe('the scripts a withdraw runs', () => {
  it('uses the withdraw script applied with this request validator, as deployed', () => {
    expect(ROYALTY.parameters?.[0]?.value).toContain(scriptHashOf(REQUEST.compiledCode));
    expect(scriptHashOf(ROYALTY.compiledCode)).toBe(ROYALTY.hash);
  });

  it('draws from the withdraw script at the reward address that has to be registered', () => {
    expect(filler().royaltyWithdrawRewardAddress()).toBe(
      'stake_test17zmv44mftm74mjkfavs6jmyydgfkq4lhrrzwvysys2huexsl52mn9',
    );
  });
});

describe('building a withdraw fill', () => {
  it('spends the pool under action 4 and the request under Apply, and draws zero from the withdraw script', async () => {
    const tx = deserializeTx(await filler().build(await plan(), wallet(), PLATFORM_ADDRESS));
    const body = tx.body();

    // Pool b1… sorts before request b2…, so the pool is input 0.
    const inputs = body.inputs().toCore();
    expect(inputs.map((i) => `${i.txId}#${i.index}`)).toEqual([`${'b1'.repeat(32)}#0`, `${'b2'.repeat(32)}#0`]);

    const withdrawals = body.withdrawals();
    expect(withdrawals?.size).toBe(1);
    expect([...(withdrawals?.values() ?? [])]).toEqual([0n]);

    const redeemers = tx.witnessSet().redeemers()?.toCore() ?? [];
    const data = redeemers.map((r) => ({ purpose: r.purpose, index: r.index }));
    expect(data).toEqual(
      expect.arrayContaining([
        { purpose: 'spend', index: 0 },
        { purpose: 'spend', index: 1 },
        { purpose: 'withdrawal', index: 0 },
      ]),
    );
    const withdrawal = redeemers.find((r) => r.purpose === 'withdrawal');
    expect(withdrawal?.executionUnits).toEqual({
      memory: VENUE_ROYALTY_WITHDRAW_EXECUTION_UNITS.mem,
      steps: VENUE_ROYALTY_WITHDRAW_EXECUTION_UNITS.steps,
    });
    const cbor = tx.witnessSet().redeemers()?.toCbor() ?? '';
    expect(cbor).toContain(venuePoolRedeemer(VENUE_POOL_ACTION.WithdrawRoyalty, 0));
    expect(cbor).toContain(venueRoyaltyWithdrawRedeemer(0, 1, false));
  });

  it('pays the pool, then the creator, then the executor exactly the fee less the network fee', async () => {
    const tx = deserializeTx(await filler().build(await plan(), wallet(), PLATFORM_ADDRESS));
    const outputs = tx.body().outputs();
    expect(outputs).toHaveLength(3);
    expect(outputs[0]?.address().toBech32()).toBe(POOL_ADDRESS);
    expect(outputs[1]?.address().toBech32()).toBe(credentialToAddress('Preprod', { type: 'Key', hash: CREATOR_PKH }));
    expect(outputs[1]?.amount().coin()).toBe(12_000_000n + 2_000_000n);
    expect(outputs[2]?.address().toBech32()).toBe(PLATFORM_ADDRESS);
    const fee = tx.body().fee();
    expect(outputs[2]?.amount().coin()).toBe(VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE - fee);
  });

  it('leaves the executor a legal output from a 2 ADA fee, at the budgets a batch declares', async () => {
    const hex = await filler().build(await plan(), wallet(), PLATFORM_ADDRESS);
    const fee = deserializeTx(hex).body().fee();
    expect(VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE - fee).toBeGreaterThanOrEqual(VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE);
    expect(hex.length / 2).toBeLessThan(MAX_TX_BYTES);
  });

  it('refuses a withdraw plan that does not state the signature form', async () => {
    const { royaltySignatureHashed: _, ...incomplete } = await plan();
    await expect(filler().build(incomplete, wallet(), PLATFORM_ADDRESS)).rejects.toThrow(
      /must say whether the creator signed the payload or its hash/,
    );
  });

  it('refuses a withdraw when it was not given the withdraw script', async () => {
    const bare = new VenueFiller({
      network: 'preprod',
      poolScript: { embeddedScriptCbor: POOL.compiledCode },
      orderScript: { embeddedScriptCbor: REQUEST.compiledCode },
      withdrawScript: { embeddedScriptCbor: REQUEST.compiledCode },
      provider: { fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS) },
      executionUnits: UNITS,
    });
    await expect(bare.build(await plan(), wallet(), PLATFORM_ADDRESS)).rejects.toThrow(/royalty-withdraw script/);
  });
});

function providerUtxo(
  utxo: { txHash: string; outputIndex: number; address: string; assets: Record<string, bigint> },
  datumCbor: string,
): ProviderUtxo {
  return {
    tx_hash: utxo.txHash,
    output_index: utxo.outputIndex,
    address: utxo.address,
    amount: Object.entries(utxo.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
    inline_datum: datumCbor,
  };
}

function chain(
  p: VenuePoolUtxo,
  requests: VenueWithdrawOrderUtxo[],
): VenueChainProvider & {
  getAddressUtxosAll: ReturnType<typeof vi.fn>;
} {
  const byAddress: Record<string, ProviderUtxo[]> = {
    [POOL_ADDRESS]: [providerUtxo(p, Data.to(p.datum, VenuePoolConfigSchema))],
    [REQUEST_ADDRESS]: requests.map((r) => providerUtxo(r, Data.to(r.datum, VenueRoyaltyWithdrawConfigSchema))),
  };
  let height = 100;
  return {
    getAddressUtxosAll: vi.fn(async (address: string) => byAddress[address] ?? []),
    getTxPosition: vi.fn(async () => {
      height += 1;
      return { block_height: height, index: 0 };
    }),
  };
}

function batcher(provider: VenueChainProvider, opts: { withdraws: boolean }) {
  let n = 0;
  const executor: CurveSpendWallet = {
    ...wallet(),
    signTx: vi.fn(async (hex: string) => hex),
    submitTx: vi.fn(async () => {
      n += 1;
      return `${n}`.padStart(2, '0').repeat(32);
    }),
  };
  return new VenueBatcher({
    provider,
    filler: filler(),
    wallet: executor,
    network: 'preprod',
    poolAddress: POOL_ADDRESS,
    orderAddress: 'addr_test1wnoorders',
    ...(opts.withdraws ? { withdrawAddress: REQUEST_ADDRESS } : {}),
    factoryPolicyId: FACTORY,
    minOutputLovelace: 1_000_000n,
    executorPayoutAddress: PLATFORM_ADDRESS,
  });
}

describe('a batcher round with royalty withdraws in it', () => {
  it('reads a request off the chain and fills it, building the real transaction', async () => {
    const p = pool();
    const round = await batcher(chain(p, [await request(p)]), { withdraws: true }).runRound();
    expect(round.withdrawOutcomes).toHaveLength(1);
    const [outcome] = round.withdrawOutcomes;
    expect(outcome?.status).toBe('filled');
    if (outcome?.status === 'filled') {
      expect(outcome.exFeeTaken).toBe(VENUE_ROYALTY_WITHDRAW_EX_FEE_LOVELACE);
      expect(outcome.networkFee).toBeGreaterThan(0n);
    }
    expect(round.filled).toBe(1);
  });

  it('fills the first of two requests signed at the same nonce and reports the second unfillable', async () => {
    const p = pool();
    const first = await request(p, 'b2'.repeat(32), 1_000_000n);
    const second = await request(p, 'b3'.repeat(32), 2_000_000n);
    const round = await batcher(chain(p, [first, second]), { withdraws: true }).runRound();
    expect(round.withdrawOutcomes.map((o) => o.status)).toEqual(['filled', 'unfillable']);
    const late = round.withdrawOutcomes[1];
    expect(late?.status === 'unfillable' && late.reason).toMatch(/at nonce 8.*only be refunded/s);
  });

  it('reports a request signed before the pool moved on as unfillable, and builds nothing', async () => {
    const signedAt = pool(7n);
    const round = await batcher(chain(pool(8n), [await request(signedAt)]), { withdraws: true }).runRound();
    expect(round.withdrawOutcomes[0]?.status).toBe('unfillable');
    expect(round.filled).toBe(0);
    expect(round.failed).toBe(0);
  });

  it('does not look for withdraw requests unless it is told to fill them', async () => {
    const p = pool();
    const provider = chain(p, [await request(p)]);
    const round = await batcher(provider, { withdraws: false }).runRound();
    expect(round.withdrawOutcomes).toEqual([]);
    expect(provider.getAddressUtxosAll).not.toHaveBeenCalledWith(REQUEST_ADDRESS);
  });
});
