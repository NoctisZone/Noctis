// venue-batcher.test.ts — does a round of fills survive its own first fill?
//
// A pool fills one order per transaction, so a round of work against one pool
// is a chain rather than a set, and the state the round was READ at is correct
// only for the first link. Everything worth testing here is a consequence:
// whether the runner prices the second fill against the pool the first one
// made, whether it notices when that pool has moved past an order's floor, and
// whether one failure takes down the chain that shares its inputs and nothing
// else.
//
// The pool below holds 20,000 ADA against 200,000,000 tokens, so spot net of
// the 1.2% fee is 0.00988 tokens per lovelace. Every floor in this file is
// stated against that number, and the fills that move it move it by a knowable
// amount — a 1,000 ADA fill is 5% of the pool and drops spot to 0.008971,
// which is what puts a 0.009 floor out of reach without touching anything
// else. That is the arithmetic these tests turn on, and it is the validators'
// own.

import { credentialToAddress, credentialToRewardAddress, Data } from '@lucid-evolution/lucid';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { mayExecute, VenueBatcher, type VenueBatcherConfig } from '../venue-batcher.js';
import type { ProviderUtxo, VenueChainProvider } from '../venue-chain-reader.js';
import type { VenueFiller, VenueFillPlan } from '../venue-fill-submitter.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import { type VenueSwapConfigData, VenueSwapConfigSchema } from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const LAUNCH_2 = '99887766554433221100aabbccddeeff00112233445566778899aabbccddee'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const POOL_NFT_2 = `${FACTORY}10${LAUNCH_2}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN = `${'bb'.repeat(28)}746f6b656e`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const ORDER_ADDRESS = 'addr_test1wq11111111111111111111111111111111111111111111111111gdvxvz';
const MAX_LQ = 0x7fffffffffffffffn;

const EXECUTOR_KEY = '11'.repeat(28);
const EXECUTOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: EXECUTOR_KEY });
const OTHER_EXECUTOR = '22'.repeat(28);

function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: 'bb'.repeat(28), name: '746f6b656e' },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(57),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
    ...over,
  };
}

function swapDatum(over: Partial<VenueSwapConfigData> = {}): VenueSwapConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    input: { policy: '', name: '' },
    output: { policy: 'bb'.repeat(28), name: '746f6b656e' },
    tradable_input: 100_000_000n,
    base_price: { num: 9n, denom: 1_000n },
    min_marginal_output: 0n,
    ex_fee: 1_500_000n,
    reward_pkh: '0d'.repeat(28),
    stake_pkh: null,
    permitted_executors: [],
    ...over,
  };
}

function poolUtxo(over: Partial<ProviderUtxo> = {}, datum = poolDatum()): ProviderUtxo {
  return {
    tx_hash: '01'.repeat(32),
    output_index: 0,
    address: POOL_ADDRESS,
    amount: [
      { unit: 'lovelace', quantity: '20000000000' },
      { unit: TOKEN, quantity: '200000000' },
      { unit: LQ, quantity: String(MAX_LQ - 1_000_000_000n) },
      { unit: POOL_NFT, quantity: '1' },
    ],
    inline_datum: Data.to(datum, VenuePoolConfigSchema),
    ...over,
  };
}

/** The second pool: the same shape, its own identity. */
function poolUtxo2(): ProviderUtxo {
  const datum = poolDatum({
    pool_nft: { policy: FACTORY, name: `10${LAUNCH_2}` },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH_2}` },
  });
  return poolUtxo(
    {
      tx_hash: '0f'.repeat(32),
      amount: [
        { unit: 'lovelace', quantity: '20000000000' },
        { unit: TOKEN, quantity: '200000000' },
        { unit: `${FACTORY}11${LAUNCH_2}`, quantity: String(MAX_LQ - 1_000_000_000n) },
        { unit: POOL_NFT_2, quantity: '1' },
      ],
    },
    datum,
  );
}

/** An order buying tokens with ada: it carries the trade, the fee, and a floor. */
function orderUtxo(txHash: string, swap: VenueSwapConfigData = swapDatum(), spareLovelace = 1_500_000n): ProviderUtxo {
  return {
    tx_hash: txHash,
    output_index: 0,
    address: ORDER_ADDRESS,
    amount: [{ unit: 'lovelace', quantity: String(swap.tradable_input + swap.ex_fee + spareLovelace) }],
    inline_datum: Data.to(swap, VenueSwapConfigSchema),
  };
}

function providerWith(
  pools: ProviderUtxo[],
  orders: ProviderUtxo[],
  positions: Record<string, { block_height: number; index: number }> = {},
): VenueChainProvider & { getTxPosition: ReturnType<typeof vi.fn> } {
  const getTxPosition = vi.fn(async (txHash: string) => positions[txHash] ?? { block_height: 1_000, index: 0 });
  return {
    getAddressUtxosAll: vi.fn(async (address: string) => (address === POOL_ADDRESS ? pools : orders)),
    getTxPosition,
  };
}

/**
 * A filler that plans for real and pretends to build.
 *
 * `makePlan` is called exactly as the real `buildSettled` calls it — once for
 * the probe and once for the fill — so the successor every assertion below
 * reads is the one `planVenueSwapFill` actually computes.
 */
function fakeFiller(behaviour: { failOnCall?: number } = {}) {
  const plans: VenueFillPlan[] = [];
  let call = 0;
  const buildSettled = vi.fn(async (makePlan: (fee: bigint) => VenueFillPlan) => {
    call += 1;
    if (behaviour.failOnCall === call) throw new Error('the node refused it');
    makePlan(0n);
    plans.push(makePlan(1_400_000n));
    return { txHex: 'ab'.repeat(8), executorFee: 1_400_000n, networkFee: 400_000n };
  });
  return { filler: { buildSettled } as unknown as VenueFiller, plans, buildSettled };
}

function fakeWallet(changeAddress = EXECUTOR_ADDRESS): CurveSpendWallet & { submitTx: ReturnType<typeof vi.fn> } {
  let submitted = 0;
  return {
    getChangeAddress: vi.fn().mockResolvedValue(changeAddress),
    getUtxos: vi.fn().mockResolvedValue([]),
    getCollateral: vi.fn().mockResolvedValue([]),
    signTx: vi.fn(async (hex: string) => `signed:${hex}`),
    submitTx: vi.fn(async () => {
      submitted += 1;
      return `${submitted}${submitted}`.padStart(2, '0').repeat(32);
    }),
  };
}

function batcher(over: Partial<VenueBatcherConfig> & Pick<VenueBatcherConfig, 'provider' | 'filler' | 'wallet'>) {
  return new VenueBatcher({
    network: 'preprod',
    poolAddress: POOL_ADDRESS,
    orderAddress: ORDER_ADDRESS,
    factoryPolicyId: FACTORY,
    minOutputLovelace: 1_000_000n,
    ...over,
  });
}

// A 1,000 ADA fill is 5% of the pool and drops spot from 0.00988 to 0.008971.
const BIG = swapDatum({ tradable_input: 1_000_000_000n, base_price: { num: 9n, denom: 1_000n } });
// Survives that move: its floor is 0.0088, and 100 ADA still realises 0.008929.
const AFTER_MOVE_OK = swapDatum({ base_price: { num: 88n, denom: 10_000n } });
// Does not: 0.009 is above the whole spot price once the big fill has landed.
const AFTER_MOVE_DEAD = swapDatum({ base_price: { num: 9n, denom: 1_000n } });

const EARLY = { block_height: 100, index: 0 };
const LATE = { block_height: 101, index: 0 };

// ---------------------------------------------------------------------------

describe('a round of fills', () => {
  it('fills what it finds, in the order the chain set', async () => {
    const orders = [orderUtxo('0b'.repeat(32), AFTER_MOVE_OK), orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)];
    const provider = providerWith([poolUtxo()], orders, {
      ['0a'.repeat(32)]: EARLY,
      ['0b'.repeat(32)]: LATE,
    });
    const { filler, plans } = fakeFiller();
    const round = await batcher({ provider, filler, wallet: fakeWallet() }).runRound();

    expect(round.filled).toBe(2);
    expect(round.failed).toBe(0);
    // Read in one order, filled in the chain's.
    expect(round.outcomes.map((o) => o.order.txHash)).toEqual(['0a'.repeat(32), '0b'.repeat(32)]);
    expect(plans.map((p) => p.order.txHash)).toEqual(['0a'.repeat(32), '0b'.repeat(32)]);
  });

  it('reports every order it read in exactly one outcome', async () => {
    const dead = swapDatum({ ex_fee: 100_000n });
    const orders = [
      orderUtxo('0a'.repeat(32), AFTER_MOVE_OK),
      orderUtxo('0b'.repeat(32), dead),
      orderUtxo('0c'.repeat(32), swapDatum({ permitted_executors: [OTHER_EXECUTOR] })),
    ];
    const provider = providerWith([poolUtxo()], orders);
    const round = await batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() }).runRound();

    expect(round.outcomes).toHaveLength(3);
    expect(new Set(round.outcomes.map((o) => o.order.txHash)).size).toBe(3);
    expect(round.outcomes.map((o) => o.status).sort()).toEqual(['declined', 'filled', 'unfillable']);
  });

  it('says why it declined a UTXO at either address', async () => {
    const provider = providerWith(
      [poolUtxo(), { ...poolUtxo({ tx_hash: '0e'.repeat(32) }), inline_datum: null }],
      [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)],
    );
    const round = await batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() }).runRound();
    expect(round.skipped).toHaveLength(1);
    expect(round.skipped[0]?.reason).toMatch(/inline datum/);
  });
});

describe('carrying the pool forward', () => {
  it('prices the second fill against the successor of the first, not the pool as read', async () => {
    const provider = providerWith(
      [poolUtxo()],
      [orderUtxo('0a'.repeat(32), BIG), orderUtxo('0b'.repeat(32), AFTER_MOVE_OK)],
      {
        ['0a'.repeat(32)]: EARLY,
        ['0b'.repeat(32)]: LATE,
      },
    );
    const { filler, plans } = fakeFiller();
    const wallet = fakeWallet();
    const round = await batcher({ provider, filler, wallet }).runRound();

    expect(round.filled).toBe(2);
    const firstTx = await wallet.submitTx.mock.results[0]?.value;
    // The first fill spends the pool as read; the second spends what it made.
    expect(plans[0]?.pool.txHash).toBe('01'.repeat(32));
    expect(plans[1]?.pool.txHash).toBe(firstTx);
    expect(plans[1]?.pool.outputIndex).toBe(0);
    // And with the value the first fill left there, not the value it started with.
    expect(plans[1]?.pool.assets.lovelace).toBe(21_000_000_000n);
    expect(plans[0]?.pool.assets.lovelace).toBe(20_000_000_000n);
  });

  it('refuses an order that the earlier fills moved out of reach', async () => {
    const provider = providerWith(
      [poolUtxo()],
      [orderUtxo('0a'.repeat(32), BIG), orderUtxo('0b'.repeat(32), AFTER_MOVE_DEAD)],
      { ['0a'.repeat(32)]: EARLY, ['0b'.repeat(32)]: LATE },
    );
    const { filler } = fakeFiller();
    const round = await batcher({ provider, filler, wallet: fakeWallet() }).runRound();

    expect(round.filled).toBe(1);
    const second = round.outcomes[1];
    expect(second?.status).toBe('unfillable');
    expect(second?.status === 'unfillable' && second.reason).toMatch(/earlier fills moved the pool/);
  });

  it('counts the fee slices the first fill left in the pool', async () => {
    // 1,000 ADA traded credits 1,000,000 to treasury_x and 10,000,000 to
    // royalty_x, which is 11,000,000 lovelace the next swap must not price.
    const provider = providerWith(
      [poolUtxo()],
      [orderUtxo('0a'.repeat(32), BIG), orderUtxo('0b'.repeat(32), AFTER_MOVE_OK)],
      {
        ['0a'.repeat(32)]: EARLY,
        ['0b'.repeat(32)]: LATE,
      },
    );
    const { filler, plans } = fakeFiller();
    await batcher({ provider, filler, wallet: fakeWallet() }).runRound();

    const carried = Data.from(plans[1]?.poolOutput.datumCbor as string, VenuePoolConfigSchema);
    expect(carried.treasury_x).toBeGreaterThan(1_000_000n);
    expect(carried.royalty_x).toBeGreaterThan(10_000_000n);
  });
});

describe('when a fill fails', () => {
  it('stops that pool and leaves the other pool alone', async () => {
    const otherPoolOrder = orderUtxo(
      '0c'.repeat(32),
      swapDatum({
        pool_nft: { policy: FACTORY, name: `10${LAUNCH_2}` },
        base_price: { num: 88n, denom: 10_000n },
      }),
    );
    const provider = providerWith(
      [poolUtxo(), poolUtxo2()],
      [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK), orderUtxo('0b'.repeat(32), AFTER_MOVE_OK), otherPoolOrder],
      { ['0a'.repeat(32)]: EARLY, ['0b'.repeat(32)]: LATE, ['0c'.repeat(32)]: { block_height: 102, index: 0 } },
    );
    const { filler } = fakeFiller({ failOnCall: 1 });
    const round = await batcher({ provider, filler, wallet: fakeWallet() }).runRound();

    expect(round.outcomes.map((o) => o.status)).toEqual(['failed', 'declined', 'filled']);
    expect(round.failed).toBe(1);
    expect(round.filled).toBe(1);
    const declined = round.outcomes[1];
    expect(declined?.status === 'declined' && declined.reason).toMatch(/unknown until the chain is read again/);
  });

  it('carries the reason the fill gave, rather than a category', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)]);
    const { filler } = fakeFiller({ failOnCall: 1 });
    const round = await batcher({ provider, filler, wallet: fakeWallet() }).runRound();
    const failed = round.outcomes[0];
    expect(failed?.status === 'failed' && failed.reason).toBe('the node refused it');
  });
});

describe('what this batcher will not take on', () => {
  it('declines an order gated to somebody else', async () => {
    const gated = swapDatum({ permitted_executors: [OTHER_EXECUTOR], base_price: { num: 88n, denom: 10_000n } });
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), gated)]);
    const { filler, buildSettled } = fakeFiller();
    const round = await batcher({ provider, filler, wallet: fakeWallet() }).runRound();

    expect(round.outcomes[0]?.status).toBe('declined');
    expect(buildSettled).not.toHaveBeenCalled();
  });

  it('fills one gated to itself, and declares the signature it needs', async () => {
    const gated = swapDatum({ permitted_executors: [EXECUTOR_KEY], base_price: { num: 88n, denom: 10_000n } });
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), gated)]);
    const { filler, plans } = fakeFiller();
    const round = await batcher({ provider, filler, wallet: fakeWallet() }).runRound();

    expect(round.filled).toBe(1);
    expect(plans[0]?.requiredSignerHashes).toEqual([EXECUTOR_KEY]);
  });

  it('declares no signer when the order names no executors', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)]);
    const { filler, plans } = fakeFiller();
    await batcher({ provider, filler, wallet: fakeWallet() }).runRound();
    expect(plans[0]?.requiredSignerHashes).toBeUndefined();
  });

  it('stops chaining a pool at the depth it is allowed', async () => {
    const low = swapDatum({ base_price: { num: 80n, denom: 10_000n } });
    const provider = providerWith(
      [poolUtxo()],
      [orderUtxo('0a'.repeat(32), low), orderUtxo('0b'.repeat(32), low), orderUtxo('0c'.repeat(32), low)],
      { ['0a'.repeat(32)]: EARLY, ['0b'.repeat(32)]: LATE, ['0c'.repeat(32)]: { block_height: 102, index: 0 } },
    );
    const { filler } = fakeFiller();
    const round = await batcher({ provider, filler, wallet: fakeWallet(), maxFillsPerPool: 2 }).runRound();

    expect(round.outcomes.map((o) => o.status)).toEqual(['filled', 'filled', 'declined']);
    const last = round.outcomes[2];
    expect(last?.status === 'declined' && last.reason).toMatch(/as deep as the chain is allowed to go/);
  });

  it('stops the round at its own limit', async () => {
    const low = swapDatum({ base_price: { num: 80n, denom: 10_000n } });
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), low), orderUtxo('0b'.repeat(32), low)], {
      ['0a'.repeat(32)]: EARLY,
      ['0b'.repeat(32)]: LATE,
    });
    const { filler } = fakeFiller();
    const round = await batcher({ provider, filler, wallet: fakeWallet(), maxFillsPerRound: 1 }).runRound();

    expect(round.outcomes.map((o) => o.status)).toEqual(['filled', 'declined']);
    const last = round.outcomes[1];
    expect(last?.status === 'declined' && last.reason).toMatch(/which is its limit/);
  });

  it('refuses to run against a wallet whose address has no payment key', async () => {
    // A reward address has a stake credential and no payment one, so nothing
    // could sign for it — and an order naming executors needs that key to know
    // whether this batcher is one of them.
    const reward = credentialToRewardAddress('Preprod', { type: 'Key', hash: EXECUTOR_KEY });
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)]);
    await expect(
      batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet(reward) }).runRound(),
    ).rejects.toThrow(/payment key hash/);
  });

  it('reads permitted executors as an allowlist, empty meaning anyone', () => {
    expect(mayExecute(swapDatum(), EXECUTOR_KEY)).toBe(true);
    expect(mayExecute(swapDatum({ permitted_executors: [EXECUTOR_KEY] }), EXECUTOR_KEY)).toBe(true);
    expect(mayExecute(swapDatum({ permitted_executors: [OTHER_EXECUTOR] }), EXECUTOR_KEY)).toBe(false);
  });
});

describe('remembering where orders were placed', () => {
  it('does not look the same transaction up twice across rounds', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)]);
    const service = batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() });
    await service.runRound();
    await service.runRound();
    expect(provider.getTxPosition).toHaveBeenCalledTimes(1);
  });

  it('looks it up again once told to forget', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)]);
    const service = batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() });
    await service.runRound();
    service.forgetPlacements();
    await service.runRound();
    expect(provider.getTxPosition).toHaveBeenCalledTimes(2);
  });

  it('forgets a transaction once no order of its is resting', async () => {
    const resting = [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)];
    const provider = providerWith([poolUtxo()], resting);
    const service = batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() });
    await service.runRound();
    // The order is gone, and a different one takes its place.
    resting.splice(0, 1, orderUtxo('0d'.repeat(32), AFTER_MOVE_OK));
    await service.runRound();
    // Then the first one comes back, and has to be looked up again.
    resting.splice(0, 1, orderUtxo('0a'.repeat(32), AFTER_MOVE_OK));
    await service.runRound();
    expect(provider.getTxPosition).toHaveBeenCalledTimes(3);
  });
});

describe('the loop', () => {
  it('keeps running after a round throws', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)]);
    let rounds = 0;
    provider.getAddressUtxosAll = vi.fn(async (address: string) => {
      if (address === POOL_ADDRESS) {
        rounds += 1;
        if (rounds === 1) throw new Error('blockfrost is down');
        return [poolUtxo()];
      }
      return [orderUtxo('0a'.repeat(32), AFTER_MOVE_OK)];
    });

    const controller = new AbortController();
    const errors: unknown[] = [];
    const seen: number[] = [];
    await batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() }).run({
      intervalMs: 1,
      signal: controller.signal,
      onError: (error) => {
        errors.push(error);
      },
      onRound: (round) => {
        seen.push(round.filled);
        controller.abort();
      },
      sleep: async () => undefined,
    });

    expect((errors[0] as Error).message).toBe('blockfrost is down');
    expect(seen).toEqual([1]);
  });

  it('stops without running when it starts aborted', async () => {
    const provider = providerWith([poolUtxo()], []);
    const controller = new AbortController();
    controller.abort();
    await batcher({ provider, filler: fakeFiller().filler, wallet: fakeWallet() }).run({
      intervalMs: 1,
      signal: controller.signal,
      sleep: async () => undefined,
    });
    expect(provider.getAddressUtxosAll).not.toHaveBeenCalled();
  });
});
