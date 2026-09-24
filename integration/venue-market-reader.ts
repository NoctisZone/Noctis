// ============================================================================
// Noctis Zone — NoctisSwap: what a venue site states about each pool
// ============================================================================
// One read answers everything a pool's public page shows, from the chain and
// nothing else: the trades since a point the caller already holds, the orders
// resting against the pool, who holds its liquidity, and who holds its token.
//
// INCREMENTAL BY DESIGN. A pool's history is a linked list walked backward
// (`venue-pool-history.ts`). A caller that remembers the newest transaction it
// has seen passes it in `since`, and only what happened after it comes back.
// The walk's own account of where it stopped says whether the answer EXTENDS
// what the caller holds or REPLACES it: a walk that met the caller's point
// extends it; a walk that reached the pool's opening instead is the whole
// history, and a walk cut short by its limit is a recent window with a gap
// behind it, which the caller must not stitch onto older trades.
//
// NOTHING HERE IS A FIGURE THE CHAIN DID NOT STATE. Volume, fees earned over a
// window, price change and bars are left to the caller, because a window is a
// presentation choice and the trades are the facts. Every amount is an
// integer in the unit it was paid in; a price is the rational the trade
// realised, never a float.
// ============================================================================

import type { Network as LucidNetwork } from '@lucid-evolution/lucid';
import type { SkippedUtxo, VenueChainProvider } from './venue-chain-reader.js';
import { readVenueLiquidityOrders, readVenuePools } from './venue-chain-reader.js';
import { venueLiquidityFillable } from './venue-liquidity.js';
import { trackVenueOrders, type VenueOrderState } from './venue-order-tracker.js';
import {
  readVenuePoolHistory,
  type VenueHistoryProvider,
  type VenuePoolEventKind,
  venueFeesEarned,
} from './venue-pool-history.js';
import { type VenueBlockProvider, venueFeedIsComplete, venueTradeSeries } from './venue-price-feed.js';
import { readVenuePoolState, venueFillSequence, venueUnitOf } from './venue-swap.js';

/** Holders of one asset, as a chain provider reports them: every address, unsorted. */
export interface VenueAssetHoldersProvider {
  getAssetAddresses(unit: string): Promise<Array<{ address: string; quantity: string }>>;
}

export interface VenueMarketDeps {
  chain: VenueChainProvider;
  history: VenueHistoryProvider;
  blocks: VenueBlockProvider;
  holders: VenueAssetHoldersProvider;
}

export interface VenueMarketArgs {
  poolAddress: string;
  orderAddress: string;
  factoryPolicyId: string;
  /** One pool by its NFT unit. Omitted, every pool under the factory. */
  poolNft?: string;
  /** Per pool NFT: the newest transaction the caller already holds. */
  since?: Record<string, string>;
  /** Per pool, the most events one read walks. Default 200. */
  maxEvents?: number;
  /** How many of the token's largest holders to return. Default 25. */
  holdersLimit?: number;
  fillCostLovelace?: bigint;
  /**
   * The deposit and redeem request addresses. Given, the queue lists resting
   * requests to add and remove liquidity beside the swap orders.
   */
  depositAddress?: string;
  redeemAddress?: string;
  /** Needed to judge a liquidity request's reward output. Preprod unless given. */
  network?: LucidNetwork;
}

export interface VenueMarketTrade {
  txHash: string;
  /** Unix seconds of the block the trade landed in. */
  time: number;
  height: number;
  /** From the taker's side, relative to ada: a buy spends ada. Null on a pool with no ada side. */
  side: 'buy' | 'sell' | null;
  inUnit: string;
  inAmount: bigint;
  outUnit: string;
  outAmount: bigint;
  /** Lovelace per token unit the trade realised, fees included, as the rational it was. */
  realisedNum: bigint;
  realisedDenom: bigint;
  /** The tradable reserves this trade left: the pool's spot price after it. */
  reservesAfter: { x: bigint; y: bigint };
}

export interface VenueMarketOrder {
  /** A swap order, or a request to add (`deposit`) or remove (`redeem`) liquidity. */
  kind: 'swap' | 'deposit' | 'redeem';
  /** `txHash#outputIndex`. */
  ref: string;
  /** Where the proceeds go: the payment key hash the order is for. */
  owner: string;
  side: 'buy' | 'sell' | null;
  inUnit: string;
  /** The amount the order offers to trade, in `inUnit`. */
  amount: bigint;
  outUnit: string;
  /** The ceiling the order pays whoever fills it, in lovelace. */
  exFee: bigint;
  state: VenueOrderState;
  reason: string;
  fillableNow: bigint;
  shortfallBps?: bigint;
  placedAtHeight?: number;
  /** A deposit's other side: the token it adds beside its ADA. */
  pairedAmount?: bigint;
}

export interface VenueMarketHolder {
  address: string;
  quantity: bigint;
}

export interface VenueMarketPool {
  poolNft: string;
  /** `txHash#outputIndex` of the pool as it stands. */
  utxo: string;
  /** The transaction that made the pool as it stands: the `since` of the next read. */
  head: string;
  reserves: { unitX: string; x: bigint; unitY: string; y: bigint };
  /** LQ issued: the cap less what the pool still holds. */
  liquidity: bigint;
  lqUnit: string;
  /** Newest first. */
  trades: VenueMarketTrade[];
  /**
   * True when `trades` follows the caller's `since` exactly: it goes in front
   * of what the caller holds, and the caller's own completeness carries over.
   */
  extends: boolean;
  /**
   * True when `trades` alone runs back to the pool opening: it replaces what
   * the caller holds, and is the whole history.
   */
  reachedOpening: boolean;
  /**
   * Present when neither: why the walk stopped. The trades are then a recent
   * window that replaces what the caller holds, with older trades missing.
   */
  reason?: string;
  /** Events of each kind in THIS read. */
  counts: Record<VenuePoolEventKind, number>;
  /** What the counters gained over the events in THIS read. */
  earned: { treasuryX: bigint; treasuryY: bigint; royaltyX: bigint; royaltyY: bigint };
  /** Every order naming this pool, oldest placement first — the order a batcher meets them. */
  queue: VenueMarketOrder[];
  /** Holders of the pool's LQ token, the pool's own unissued supply left out. Largest first. */
  providers: VenueMarketHolder[];
  /**
   * Holders of the pool's token: how many hold any, what they hold between
   * them (every unit minted sits at some address, contracts included), and
   * the largest.
   */
  holders: { total: number; supply: bigint; top: VenueMarketHolder[] };
}

export interface VenueMarketRead {
  pools: VenueMarketPool[];
  skipped: SkippedUtxo[];
}

const LOVELACE = 'lovelace';

function emptyCounts(): Record<VenuePoolEventKind, number> {
  return { opened: 0, swap: 0, deposit: 0, redeem: 0, feeWithdrawal: 0, unclassified: 0 };
}

function largestFirst(rows: Array<{ address: string; quantity: string }>): VenueMarketHolder[] {
  return rows
    .map((row) => ({ address: row.address, quantity: BigInt(row.quantity) }))
    .filter((row) => row.quantity > 0n)
    .sort((a, b) =>
      a.quantity === b.quantity ? a.address.localeCompare(b.address) : a.quantity > b.quantity ? -1 : 1,
    );
}

/**
 * Reads what a venue site states about each pool.
 *
 * Throws on a provider failure rather than returning a partial answer: a read
 * that silently lost its trades would be stored as the pool's history.
 */
export async function readVenueMarket(deps: VenueMarketDeps, args: VenueMarketArgs): Promise<VenueMarketRead> {
  const maxEvents = args.maxEvents ?? 200;
  const holdersLimit = args.holdersLimit ?? 25;
  if (maxEvents < 1) throw new Error('maxEvents must be at least 1.');
  if (holdersLimit < 0) throw new Error('holdersLimit cannot be negative.');

  const poolsRead = await readVenuePools(deps.chain, {
    poolAddress: args.poolAddress,
    factoryPolicyId: args.factoryPolicyId,
  });
  const wanted = poolsRead.pools.filter(
    (pool) => args.poolNft === undefined || venueUnitOf(pool.datum.pool_nft) === args.poolNft,
  );

  // The whole book once, then grouped: every order at the venue is one read.
  const tracking = await trackVenueOrders(deps.chain, {
    poolAddress: args.poolAddress,
    orderAddress: args.orderAddress,
    factoryPolicyId: args.factoryPolicyId,
    ...(args.fillCostLovelace !== undefined ? { fillCostLovelace: args.fillCostLovelace } : {}),
  });
  const requests =
    args.depositAddress || args.redeemAddress
      ? await readVenueLiquidityOrders(deps.chain, {
          ...(args.depositAddress ? { depositAddress: args.depositAddress } : {}),
          ...(args.redeemAddress ? { redeemAddress: args.redeemAddress } : {}),
          knownPools: poolsRead.pools.map((pool) => venueUnitOf(pool.datum.pool_nft)),
          includeUnknownPools: true,
        })
      : { orders: [], skipped: [] };

  const pools: VenueMarketPool[] = [];
  for (const pool of wanted) {
    const poolNft = venueUnitOf(pool.datum.pool_nft);
    const since = args.since?.[poolNft];

    const history = await readVenuePoolHistory(deps.history, {
      pool,
      factoryPolicyId: args.factoryPolicyId,
      ...(since ? { stopAtTxHash: since } : {}),
      maxEvents,
    });
    const series = await venueTradeSeries(history, deps.blocks);

    const counts = emptyCounts();
    for (const event of history.events) counts[event.kind] += 1;

    const unitX = venueUnitOf(pool.datum.pool_x);
    const unitY = venueUnitOf(pool.datum.pool_y);
    const state = readVenuePoolState(pool.datum, pool.assets);
    const lqUnit = venueUnitOf(pool.datum.pool_lq);
    const tokenUnit = unitX === LOVELACE ? unitY : unitX;

    // Swap orders and liquidity requests, as one queue in the order the chain
    // accepted them — the order a batcher meets them in.
    const swapRows = tracking.orders
      .filter((tracked) => venueUnitOf(tracked.order.datum.pool_nft) === poolNft)
      .map((tracked) => {
        const inUnit = venueUnitOf(tracked.order.datum.input);
        const outUnit = venueUnitOf(tracked.order.datum.output);
        const row: VenueMarketOrder = {
          kind: 'swap',
          ref: `${tracked.order.txHash}#${tracked.order.outputIndex}`,
          owner: tracked.order.datum.reward_pkh,
          side: inUnit === LOVELACE ? 'buy' : outUnit === LOVELACE ? 'sell' : null,
          inUnit,
          amount: tracked.order.datum.tradable_input,
          outUnit,
          exFee: tracked.order.datum.ex_fee,
          state: tracked.state,
          reason: tracked.reason,
          fillableNow: tracked.fillableNow,
          ...(tracked.shortfallBps !== undefined ? { shortfallBps: tracked.shortfallBps } : {}),
          ...(tracked.order.placedAt ? { placedAtHeight: tracked.order.placedAt.blockHeight } : {}),
        };
        return { outputIndex: tracked.order.outputIndex, placedAt: tracked.order.placedAt, row };
      });
    const requestRows = requests.orders
      .filter((request) => venueUnitOf(request.datum.pool_nft) === poolNft)
      .map((request) => {
        const answer = venueLiquidityFillable({
          pool,
          order: request,
          network: args.network ?? 'Preprod',
          minOutputLovelace: 1_000_000n,
          ...(args.fillCostLovelace !== undefined ? { fillCostLovelace: args.fillCostLovelace } : {}),
        });
        const deposit = request.kind === 'deposit';
        const lovelace = request.assets[LOVELACE] ?? 0n;
        const amount = deposit
          ? lovelace - request.datum.ex_fee - (request.kind === 'deposit' ? request.datum.collateral_ada : 0n)
          : (request.assets[lqUnit] ?? 0n);
        const row: VenueMarketOrder = {
          kind: request.kind,
          ref: `${request.txHash}#${request.outputIndex}`,
          owner: request.datum.reward_pkh,
          side: null,
          inUnit: deposit ? LOVELACE : lqUnit,
          amount,
          outUnit: deposit ? lqUnit : LOVELACE,
          exFee: request.datum.ex_fee,
          state: answer.fillable ? 'fillable' : 'unfundable',
          reason: answer.fillable ? 'waiting for a batcher: a request fills at the pool’s ratio' : answer.reason,
          fillableNow: answer.fillable ? amount : 0n,
          ...(request.placedAt ? { placedAtHeight: request.placedAt.blockHeight } : {}),
          ...(deposit ? { pairedAmount: request.assets[tokenUnit] ?? 0n } : {}),
        };
        return { outputIndex: request.outputIndex, placedAt: request.placedAt, row };
      });
    const queue: VenueMarketOrder[] = venueFillSequence([...swapRows, ...requestRows]).map((entry) => entry.row);

    const lqHolders = largestFirst(await deps.holders.getAssetAddresses(lqUnit)).filter(
      (row) => row.address !== pool.address,
    );
    const tokenHolders = largestFirst(await deps.holders.getAssetAddresses(tokenUnit));

    // A walk that met the caller's point extends what it holds. One that
    // reached the opening is the whole history. One cut short is a recent
    // window: it replaces what is held, and says why older trades are missing.
    const extendsHeld = history.stoppedBy === 'stopAtTxHash';
    const reason =
      extendsHeld || history.reachedGenesis
        ? undefined
        : (venueFeedIsComplete(history).reason ??
          'The walk stopped before the pool opening, so older trades are not included.');

    pools.push({
      poolNft,
      utxo: `${pool.txHash}#${pool.outputIndex}`,
      head: pool.txHash,
      reserves: { unitX, x: state.reservesX, unitY, y: state.reservesY },
      liquidity: state.liquidity,
      lqUnit,
      trades: series
        .slice()
        .reverse()
        .map((trade) => ({
          txHash: trade.txHash,
          time: trade.block.timeSeconds,
          height: trade.block.height,
          side: trade.side,
          inUnit: trade.inUnit,
          inAmount: trade.inAmount,
          outUnit: trade.outUnit,
          outAmount: trade.outAmount,
          realisedNum: trade.realised.num,
          realisedDenom: trade.realised.denom,
          reservesAfter: { x: trade.reservesAfter.x, y: trade.reservesAfter.y },
        })),
      extends: extendsHeld,
      reachedOpening: history.reachedGenesis,
      ...(reason ? { reason } : {}),
      counts,
      earned: venueFeesEarned(history),
      queue,
      providers: lqHolders,
      holders: {
        total: tokenHolders.length,
        supply: tokenHolders.reduce((sum, row) => sum + row.quantity, 0n),
        top: tokenHolders.slice(0, holdersLimit),
      },
    });
  }

  return { pools, skipped: [...poolsRead.skipped, ...tracking.skipped, ...requests.skipped] };
}
