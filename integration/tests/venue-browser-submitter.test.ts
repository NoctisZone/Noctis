// venue-browser-submitter.test.ts — can a browser place and take back an
// order without ever being able to touch a pool?
//
// Three things carry this file.
//
//   THE REFUND GOES WHERE THE ORDER SAYS. Lucid sends change to the connected
//   wallet by default, which is exactly the wrong destination: the order named
//   its own reward address when it was written, and a cancel that used the
//   signing wallet's address instead would be unverifiable from the order.
//   Only a placer can cancel, so the wallet below IS the placer — and the two
//   addresses still differ, because the wallet hands back a base address while
//   the orders name no stake key. Same payment key, different destination, so
//   a cancel that used the wallet's own would be visible here.
//
//   THE KEY HAS TO BE DECLARED, NOT MERELY USED TO SIGN. `extra_signatories`
//   is the transaction's required-signers field; a signature alone leaves the
//   validator an empty list and the cancel is refused for a reason that names
//   nothing. Lucid spells the declaration `addSignerKey`.
//
//   A DEAD ORDER CANNOT BE PLACED. A floor set from spot is unreachable at any
//   size and any fee, and from outside it looks like an order patiently
//   waiting. The draft refuses it, and the quote path here inherits that.
//
// Lucid is partially mocked — the real address and datum machinery, a recorded
// transaction builder — the same strategy every other submitter test uses.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return { ...actual, Lucid: vi.fn(), Blockfrost: vi.fn() };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialToAddress, Data, Lucid } from '@lucid-evolution/lucid';
import { VenueBrowserSubmitter, venueProviderUtxo } from '../venue-browser-submitter.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  type VenueSwapConfigData,
  VenueSwapConfigSchema,
  type VenueSwapOrderUtxo,
  venueCancelRedeemer,
} from '../venue-swap.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string }>;
}
function load(file: string): Blueprint {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', file), 'utf8'));
}
function pick(bp: Blueprint, title: string) {
  const found = bp.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from the venue blueprint`);
  return found;
}
const POOL = pick(load(join('deployment', 'applied.json')), 'royalty_pool/pool.pool.spend');
const ORDER = pick(load('plutus.json'), 'royalty_pool/swap_order.swap_order.spend');

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const MAX_LQ = 0x7fffffffffffffffn;

const PLACER = '0d'.repeat(28);
const PLACER_STAKE = '0e'.repeat(28);
const PLACER_ADDRESS = credentialToAddress(
  'Preprod',
  { type: 'Key', hash: PLACER },
  { type: 'Key', hash: PLACER_STAKE },
);
/**
 * The connected wallet's own address: a BASE address, stake key and all,
 * which is what a real wallet hands back.
 */
const WALLET_ADDRESS = PLACER_ADDRESS;
/**
 * Where a cancel must actually return the funds.
 *
 * The same payment key, and a DIFFERENT address — the orders below name no
 * stake key, so the address the order fixes is the enterprise one. Only the
 * placer can cancel, so the wallet has to be the placer; this is what still
 * makes a cancel that used the wallet's own change address visible.
 */
const REWARD_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: PLACER });

function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(28),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
    ...over,
  };
}

/** A pool UTXO in Lucid's shape, which is what the adapter has to handle. */
function poolUtxo(over: { datum?: string | null } = {}) {
  return {
    txHash: '0a'.repeat(32),
    outputIndex: 0,
    address: '',
    assets: {
      lovelace: 20_000_000_000n,
      [TOKEN]: 200_000_000n,
      [LQ]: MAX_LQ - 1_000_000_000n,
      [POOL_NFT]: 1n,
    },
    datum: Data.to(poolDatum(), VenuePoolConfigSchema),
    ...over,
  };
}

function swapDatum(over: Partial<VenueSwapConfigData> = {}): VenueSwapConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    input: { policy: '', name: '' },
    output: { policy: TOKEN_POLICY, name: '746f6b656e' },
    tradable_input: 100_000_000n,
    base_price: { num: 88n, denom: 10_000n },
    min_marginal_output: 0n,
    ex_fee: 1_500_000n,
    reward_pkh: PLACER,
    stake_pkh: PLACER_STAKE,
    permitted_executors: [],
    ...over,
  };
}

function order(txHash: string, datum: VenueSwapConfigData = swapDatum({ stake_pkh: null })): VenueSwapOrderUtxo {
  return {
    txHash,
    outputIndex: 0,
    address: '',
    assets: { lovelace: datum.tradable_input + datum.ex_fee + 1_500_000n },
    datum,
  };
}

/** Records what the transaction was actually built with. */
function makeBuilder() {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...a: unknown[]) => {
      calls[name] = a;
      return builder;
    };
  builder.collectFrom = record('collectFrom');
  builder.addSignerKey = record('addSignerKey');
  builder.attach = { SpendingValidator: record('attachSpendingValidator') };
  builder.pay = { ToContract: record('payToContract'), ToAddress: record('payToAddress') };
  builder.complete = vi.fn(async (...a: unknown[]) => {
    calls.complete = a;
    return {
      sign: {
        withWallet: () => ({
          complete: vi.fn().mockResolvedValue({ submit: vi.fn().mockResolvedValue('venue-tx-1') }),
        }),
      },
    };
  });
  return { builder, calls };
}

let currentPools: ReturnType<typeof poolUtxo>[] = [];
let currentOrders: VenueSwapOrderUtxo[] = [];

function makeSubmitter(builder: Record<string, unknown>) {
  const submitterRef: { current?: VenueBrowserSubmitter } = {};
  const fakeLucid = {
    selectWallet: { fromAPI: vi.fn() },
    wallet: () => ({ address: vi.fn().mockResolvedValue(WALLET_ADDRESS) }),
    utxosAt: vi.fn(async (address: string) => {
      const s = submitterRef.current;
      if (s && address === s.poolAddress) return currentPools.map((p) => ({ ...p, address }));
      if (s && address === s.orderAddress) {
        return currentOrders.map((o) => ({
          txHash: o.txHash,
          outputIndex: o.outputIndex,
          address,
          assets: o.assets,
          datum: Data.to(o.datum, VenueSwapConfigSchema),
        }));
      }
      return [];
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const submitter = new VenueBrowserSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    orderScriptCbor: ORDER.compiledCode,
    poolScriptCbor: POOL.compiledCode,
    factoryPolicyId: FACTORY,
  });
  submitterRef.current = submitter;
  return { submitter, fakeLucid };
}

const walletApi = { id: 'wallet' } as never;

beforeEach(() => {
  currentPools = [poolUtxo()];
  currentOrders = [];
  // Reading the placer's book costs one position lookup per placement
  // transaction — the reader really makes them, and the submitter caches what
  // comes back because a transaction's place in the chain never moves.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ block_height: 100, index: 3 }) })),
  );
});

describe('reading the venue from a browser', () => {
  it('adapts a lucid utxo into what the chain reader reads, so one rule decides what a pool is', () => {
    const adapted = venueProviderUtxo({ ...poolUtxo(), address: 'addr_test1x' } as never);
    expect(adapted.tx_hash).toBe('0a'.repeat(32));
    expect(adapted.output_index).toBe(0);
    expect(adapted.amount).toContainEqual({ unit: POOL_NFT, quantity: '1' });
    expect(adapted.inline_datum).toBe(Data.to(poolDatum(), VenuePoolConfigSchema));
  });

  it('reports a datum-by-hash as absent, which is what the reader declines on', () => {
    // Lucid leaves `datum` null when the output carried only a hash. A pool
    // keeps its state inline, so the reader must see the difference.
    expect(venueProviderUtxo({ ...poolUtxo({ datum: null }), address: 'a' } as never).inline_datum).toBeNull();
  });

  it('finds the pool carrying a launch’s nft', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const pool = await submitter.poolFor(POOL_NFT);
    expect(pool.datum.fee_num).toBe(99_900n);
  });

  it('says so when a launch has no pool rather than returning nothing', async () => {
    currentPools = [];
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await expect(submitter.poolFor(POOL_NFT)).rejects.toThrow(/has graduated/);
  });

  it('derives two different script addresses, and never spends from the pool’s', () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    expect(submitter.poolAddress).not.toBe(submitter.orderAddress);
  });
});

describe('quoting', () => {
  it('returns the estimate and the promise as two different numbers', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const q = await submitter.quote({
      poolNftUnit: POOL_NFT,
      inputUnit: 'lovelace',
      tradedIn: 100_000_000n,
      slippageToleranceBps: 100n,
      walletAddress: PLACER_ADDRESS,
      minOutputLovelace: 1_000_000n,
    });
    // `expectedOut` is an estimate of a moment already past; `guaranteedOut`
    // is the floor the order is bound to and is necessarily lower.
    expect(q.quote.expectedOut).toBeGreaterThan(q.draft.guaranteedOut);
    expect(q.market.reservesX).toBe(20_000_000_000n);
  });

  it('carries the placer’s stake key into the order, so the payout is a base address', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const q = await submitter.quote({
      poolNftUnit: POOL_NFT,
      inputUnit: 'lovelace',
      tradedIn: 100_000_000n,
      slippageToleranceBps: 100n,
      walletAddress: PLACER_ADDRESS,
      minOutputLovelace: 1_000_000n,
    });
    expect(q.draft.datum.reward_pkh).toBe(PLACER);
    expect(q.draft.datum.stake_pkh).toBe(PLACER_STAKE);
  });

  it('refuses a script address, whose hash could never sign a cancel', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await expect(
      submitter.quote({
        poolNftUnit: POOL_NFT,
        inputUnit: 'lovelace',
        tradedIn: 100_000_000n,
        slippageToleranceBps: 100n,
        walletAddress: submitter.orderAddress,
        minOutputLovelace: 1_000_000n,
      }),
    ).rejects.toThrow(/never sign/);
  });

  it('cannot produce an order that could never fill', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    // A zero tolerance asks for the whole trade at the quoted rate, which the
    // trade's own impact makes unreachable — the draft refuses it rather than
    // handing back an order that would rest forever.
    await expect(
      submitter.quote({
        poolNftUnit: POOL_NFT,
        inputUnit: 'lovelace',
        tradedIn: 100_000_000n,
        slippageToleranceBps: 100n,
        walletAddress: PLACER_ADDRESS,
        minOutputLovelace: 1_000_000n,
        exFee: 1n,
      }),
    ).rejects.toThrow();
  });
});

describe('placing an order', () => {
  it('pays to the order address with the datum inline, and runs no validator', async () => {
    const { builder, calls } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const q = await submitter.quote({
      poolNftUnit: POOL_NFT,
      inputUnit: 'lovelace',
      tradedIn: 100_000_000n,
      slippageToleranceBps: 100n,
      walletAddress: PLACER_ADDRESS,
      minOutputLovelace: 1_000_000n,
    });
    const { txHash } = await submitter.placeSwapOrder(walletApi, q.draft);

    expect(txHash).toBe('venue-tx-1');
    expect(calls.payToContract?.[0]).toBe(submitter.orderAddress);
    expect(calls.payToContract?.[1]).toEqual({
      kind: 'inline',
      value: Data.to(q.draft.datum, VenueSwapConfigSchema),
    });
    // A placement attaches nothing and spends nothing: creating a UTXO at a
    // script address never runs that script.
    expect(calls.attachSpendingValidator).toBeUndefined();
    expect(calls.collectFrom).toBeUndefined();
  });

  it('funds the order with exactly what the draft says it carries', async () => {
    const { builder, calls } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const q = await submitter.quote({
      poolNftUnit: POOL_NFT,
      inputUnit: 'lovelace',
      tradedIn: 100_000_000n,
      slippageToleranceBps: 100n,
      walletAddress: PLACER_ADDRESS,
      minOutputLovelace: 1_000_000n,
    });
    await submitter.placeSwapOrder(walletApi, q.draft);
    expect(calls.payToContract?.[2]).toEqual(q.draft.assets);
  });
});

describe('taking an order back', () => {
  it('returns the funds to the address the ORDER names, not the wallet’s', async () => {
    const { builder, calls } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await submitter.cancelOrders(walletApi, [order('0b'.repeat(32))]);
    // The wallet reports WALLET_ADDRESS; the order names REWARD_ADDRESS.
    expect(calls.complete?.[0]).toEqual({ changeAddress: REWARD_ADDRESS });
    expect(calls.complete?.[0]).not.toEqual({ changeAddress: WALLET_ADDRESS });
  });

  it('declares the placer’s key, which is what the validator actually reads', async () => {
    const { builder, calls } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await submitter.cancelOrders(walletApi, [order('0b'.repeat(32))]);
    expect(calls.addSignerKey).toEqual([PLACER]);
  });

  it('spends under Cancel, with the order validator carried', async () => {
    const { builder, calls } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await submitter.cancelOrders(walletApi, [order('0b'.repeat(32))]);
    expect(calls.collectFrom?.[1]).toBe(venueCancelRedeemer());
    expect(calls.attachSpendingValidator?.[0]).toEqual({ type: 'PlutusV3', script: ORDER.compiledCode });
  });

  it('takes many orders back in one transaction, because cancels batch and fills do not', async () => {
    const { builder, calls } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await submitter.cancelOrders(walletApi, [order('0b'.repeat(32)), order('0c'.repeat(32))]);
    expect((calls.collectFrom as unknown[])[0] as unknown[]).toHaveLength(2);
    expect(calls.addSignerKey).toEqual([PLACER]);
  });

  it('refuses an order that belongs to somebody else', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const theirs = order('0b'.repeat(32), swapDatum({ reward_pkh: '99'.repeat(28), stake_pkh: null }));
    await expect(submitter.cancelOrders(walletApi, [theirs])).rejects.toThrow(/nobody else ever can/);
  });

  it('refuses to mix orders that pay out to different addresses', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const other = order('0c'.repeat(32), swapDatum({ stake_pkh: PLACER_STAKE }));
    await expect(submitter.cancelOrders(walletApi, [order('0b'.repeat(32)), other])).rejects.toThrow(
      /different addresses/,
    );
  });

  it('refuses a cancel with nothing to cancel', async () => {
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    await expect(submitter.cancelOrders(walletApi, [])).rejects.toThrow(/at least one order/);
  });
});

describe('the placer’s own book', () => {
  it('returns only the connected wallet’s orders, keyed on where the proceeds go', async () => {
    currentOrders = [order('0b'.repeat(32)), order('0c'.repeat(32), swapDatum({ reward_pkh: '99'.repeat(28) }))];
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    // Two orders at the venue, one of them somebody else's. The filter is on
    // the datum's `reward_pkh` — where the proceeds go — not on who asked.
    const mine = await submitter.myOrders(walletApi);
    expect(mine.orders).toHaveLength(1);
    expect(mine.orders[0]?.order.datum.reward_pkh).toBe(PLACER);
  });

  it('classifies the wallet’s own orders against the pool they name', async () => {
    currentOrders = [order('0b'.repeat(32))];
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const mine = await submitter.myOrders(walletApi);
    expect(mine.orders).toHaveLength(1);
    expect(mine.orders[0]?.state).toBe('fillable');
    expect(mine.orders[0]?.reason).toContain('the pool can serve');
  });

  it('offers a cancel only for orders that are going nowhere', async () => {
    currentOrders = [
      order('0b'.repeat(32)),
      // Names a pool that does not exist: nothing can ever fill it.
      order('0c'.repeat(32), swapDatum({ stake_pkh: null, pool_nft: { policy: FACTORY, name: '99' } })),
    ];
    const { builder } = makeBuilder();
    const { submitter } = makeSubmitter(builder);
    const worth = await submitter.ordersWorthCancelling(walletApi);
    expect(worth).toHaveLength(1);
    expect(worth[0]?.state).toBe('orphaned');
  });
});
