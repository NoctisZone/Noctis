// ============================================================================
// Noctis Zone — NoctisSwap: reading pools and orders off the chain
// ============================================================================
// The batcher can build a fill. This is how it finds one — and the whole
// difficulty is that **an address is not evidence**. Both venue scripts are
// unparameterised by launch, so every pool in the venue shares one address and
// every swap request shares another. Anything at all may be sitting there.
//
// The two sides need different answers, and conflating them is the mistake to
// avoid:
//
//   **A pool must be authenticated, and its own datum cannot do it.** A datum
//   names the NFT it claims to be identified by, so a forger names one they
//   minted themselves and satisfies any test derived from the datum alone —
//   the same trap `launch-utxo-lookup.ts` documents on the launch side. The
//   venue's answer is stronger than a caller-supplied policy: a genuine pool
//   NFT can only have come from the FACTORY, whose policy id is a deployment
//   fact this reader is told and no on-chain actor can influence. So a pool is
//   a UTXO holding exactly one asset under the factory's policy, tagged with
//   the pool role, whose datum names that same asset. A UTXO that merely sits
//   at the pool address is not a pool, which is exactly what the pool
//   validator itself says.
//
//   **An order needs no authentication, because it is a request.** Nobody can
//   forge a claim on somebody else's funds by writing a datum; an order can
//   only ever spend itself. What matters instead is that junk here costs the
//   batcher time and can crash a reader — so a datum that will not decode is
//   COUNTED AND REPORTED rather than thrown or silently dropped, and an order
//   naming a pool this reader does not know is set aside rather than acted on.
//
// **Nothing is skipped quietly.** Every UTXO the reader declines comes back
// with a reason. A reader that returns "3 pools" when the chain holds 4 is
// indistinguishable from a chain that holds 3, and the difference is a launch
// whose market has silently stopped trading.
//
// **Placement is read from the transaction, not inferred from the response.**
// The order fills follow is a published property of the venue, so the position
// it rests on has to be a fact rather than an artefact of how a provider
// happened to page its results. Providers do generally return address UTXOs in
// chain order; this does not rely on that.
// ============================================================================

import { Data } from '@lucid-evolution/lucid';
import { VENUE_ROLES } from './tier-a-schemas.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from './venue-pool.js';
import {
  type VenueOrderPosition,
  type VenuePoolUtxo,
  type VenueSwapConfigData,
  VenueSwapConfigSchema,
  type VenueSwapOrderUtxo,
  venueFillableAmount,
  venueFillSequence,
  venueUnitOf,
} from './venue-swap.js';

/** A UTXO as a chain provider reports one. Blockfrost's shape satisfies it. */
export interface ProviderUtxo {
  tx_hash: string;
  output_index: number;
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum: string | null;
}

/** Where a transaction sits in the chain's own record of what happened first. */
export interface ProviderTxPosition {
  block_height: number;
  index: number;
}

/**
 * What the reader needs from a chain provider.
 *
 * Deliberately two methods. `BlockfrostClient` satisfies the first directly;
 * the second is a thin wrapper over its transaction lookup, and a test
 * satisfies both with plain objects.
 */
export interface VenueChainProvider {
  getAddressUtxosAll(address: string): Promise<ProviderUtxo[]>;
  getTxPosition(txHash: string): Promise<ProviderTxPosition>;
}

/** A UTXO the reader declined, and why — never dropped without one. */
export interface SkippedUtxo {
  txHash: string;
  outputIndex: number;
  reason: string;
}

export interface VenuePoolsRead {
  pools: VenuePoolUtxo[];
  skipped: SkippedUtxo[];
}

export interface VenueOrdersRead {
  orders: VenueSwapOrderUtxo[];
  skipped: SkippedUtxo[];
}

function assetsOf(utxo: ProviderUtxo): Record<string, bigint> {
  const assets: Record<string, bigint> = {};
  for (const entry of utxo.amount) {
    assets[entry.unit] = (assets[entry.unit] ?? 0n) + BigInt(entry.quantity);
  }
  return assets;
}

/**
 * The pool NFT a UTXO carries, if it carries exactly one that the factory
 * could have minted.
 *
 * Two units under the factory's policy is not an ambiguity to resolve — the
 * factory mints one NFT per pool, so a UTXO holding two was assembled by
 * somebody, and picking either would be picking on no evidence. The LQ token
 * shares the policy and is deliberately not a candidate: it is fungible, so a
 * balance of it says nothing about identity.
 */
export function venuePoolNftOf(assets: Record<string, bigint>, factoryPolicyId: string): string | null {
  const candidates = Object.entries(assets).filter(
    ([unit, quantity]) =>
      unit.startsWith(factoryPolicyId) &&
      unit.slice(factoryPolicyId.length, factoryPolicyId.length + 2) === VENUE_ROLES.pool &&
      quantity === 1n,
  );
  return candidates.length === 1 ? (candidates[0]?.[0] ?? null) : null;
}

/**
 * Every live pool at the venue's pool address.
 *
 * `factoryPolicyId` is required and has no default, for the reason the launch
 * side's expected policy is: a reader that falls back to the datum when the
 * caller passes nothing is the forgeable reader again, reachable by omission.
 */
export async function readVenuePools(
  provider: VenueChainProvider,
  args: { poolAddress: string; factoryPolicyId: string },
): Promise<VenuePoolsRead> {
  const utxos = await provider.getAddressUtxosAll(args.poolAddress);
  const pools: VenuePoolUtxo[] = [];
  const skipped: SkippedUtxo[] = [];

  for (const utxo of utxos) {
    const at = { txHash: utxo.tx_hash, outputIndex: utxo.output_index };
    if (!utxo.inline_datum) {
      skipped.push({ ...at, reason: 'no inline datum — a pool keeps its state inline, not by hash' });
      continue;
    }
    const assets = assetsOf(utxo);
    const nft = venuePoolNftOf(assets, args.factoryPolicyId);
    if (!nft) {
      skipped.push({
        ...at,
        reason: `carries no single pool NFT under the factory policy ${args.factoryPolicyId} — sitting at the pool address is not being a pool`,
      });
      continue;
    }
    let datum: VenuePoolConfigData;
    try {
      datum = Data.from(utxo.inline_datum, VenuePoolConfigSchema);
    } catch (error) {
      skipped.push({ ...at, reason: `datum is not a pool config: ${(error as Error).message}` });
      continue;
    }
    if (venueUnitOf(datum.pool_nft) !== nft) {
      skipped.push({
        ...at,
        reason: `holds ${nft} but its datum names ${venueUnitOf(datum.pool_nft)} — the two must be the same pool`,
      });
      continue;
    }
    pools.push({ txHash: utxo.tx_hash, outputIndex: utxo.output_index, address: utxo.address, assets, datum });
  }
  return { pools, skipped };
}

/**
 * Every open swap request at the venue's order address, with the position the
 * chain accepted each one at.
 *
 * `knownPools` is what an order is checked against: a request naming a pool
 * this reader did not find is set aside rather than acted on. That is not a
 * security rule — an order can only ever spend itself — it is what keeps the
 * batcher from carrying requests nobody can fill.
 *
 * Placement is looked up per transaction and shared across orders from the
 * same one, so a batch of orders placed together costs one lookup rather than
 * several. Pass `positions` to supply what is already known and skip the
 * lookup entirely.
 *
 * `includeUnknownPools` returns those set-aside requests as orders instead. A
 * batcher never wants that — it cannot act on one — but a tracker showing a
 * placer their own orders always does, because an order naming a pool that
 * does not exist is precisely the thing its placer most needs to be told.
 */
export async function readVenueSwapOrders(
  provider: VenueChainProvider,
  args: {
    orderAddress: string;
    /** Pool NFT units the batcher knows about, from `readVenuePools`. */
    knownPools: readonly string[];
    /** Placements already known, keyed by transaction hash. */
    positions?: Map<string, VenueOrderPosition>;
    /** Return orders naming an unfound pool rather than setting them aside. */
    includeUnknownPools?: boolean;
  },
): Promise<VenueOrdersRead> {
  const utxos = await provider.getAddressUtxosAll(args.orderAddress);
  const known = new Set(args.knownPools);
  const positions = args.positions ?? new Map<string, VenueOrderPosition>();
  const orders: VenueSwapOrderUtxo[] = [];
  const skipped: SkippedUtxo[] = [];

  for (const utxo of utxos) {
    const at = { txHash: utxo.tx_hash, outputIndex: utxo.output_index };
    if (!utxo.inline_datum) {
      skipped.push({ ...at, reason: 'no inline datum — an order states its terms inline, not by hash' });
      continue;
    }
    let datum: VenueSwapConfigData;
    try {
      datum = Data.from(utxo.inline_datum, VenueSwapConfigSchema);
    } catch (error) {
      skipped.push({ ...at, reason: `datum is not a swap request: ${(error as Error).message}` });
      continue;
    }
    const nft = venueUnitOf(datum.pool_nft);
    if (!known.has(nft) && !args.includeUnknownPools) {
      skipped.push({ ...at, reason: `names pool ${nft}, which is not one of the pools this reader found` });
      continue;
    }
    if (!positions.has(utxo.tx_hash)) {
      const position = await provider.getTxPosition(utxo.tx_hash);
      positions.set(utxo.tx_hash, { blockHeight: position.block_height, txIndexInBlock: position.index });
    }
    orders.push({
      txHash: utxo.tx_hash,
      outputIndex: utxo.output_index,
      address: utxo.address,
      assets: assetsOf(utxo),
      datum,
      placedAt: positions.get(utxo.tx_hash),
    });
  }
  return { orders, skipped };
}

/** One piece of work: an order, the pool it meets, and how much of it fills. */
export interface VenueFillCandidate {
  order: VenueSwapOrderUtxo;
  pool: VenuePoolUtxo;
  /** The most of the order this pool can serve at the order's own floor. */
  traded: bigint;
}

/** An order that cannot be filled right now, and the reason nobody can. */
export interface VenueUnfillableOrder {
  order: VenueSwapOrderUtxo;
  reason: string;
}

export interface VenueFillRound {
  /** Work, in the order the chain accepted the orders. */
  candidates: VenueFillCandidate[];
  /** Orders no executor can fill as things stand, each with why. */
  unfillable: VenueUnfillableOrder[];
  /** Everything the reader declined on the way, pools and orders alike. */
  skipped: SkippedUtxo[];
}

/**
 * Everything fillable right now, in the order it must be filled in.
 *
 * This is the batcher's whole decision, and it deliberately contains no
 * discretion: pools and orders are read, orders are sequenced by where the
 * chain accepted them, and each is either fillable or not. What comes back is
 * a list to work down, not a set to choose from.
 *
 * **The pool state here is the state before any of it runs.** Fills against
 * one pool chain — each spends the output the last one made — so a caller
 * working down this list must carry the successor of each fill forward rather
 * than re-using the pool as read. The first candidate for a pool is correct as
 * given; every later one is priced against a pool that has since moved.
 */
export async function readVenueFillRound(
  provider: VenueChainProvider,
  args: {
    poolAddress: string;
    orderAddress: string;
    factoryPolicyId: string;
    /** What one fill costs; `VENUE_FILL_FLOOR_LOVELACE` unless measured again. */
    fillCostLovelace?: bigint;
    positions?: Map<string, VenueOrderPosition>;
  },
): Promise<VenueFillRound> {
  const poolsRead = await readVenuePools(provider, args);
  const byNft = new Map(poolsRead.pools.map((pool) => [venueUnitOf(pool.datum.pool_nft), pool]));
  const ordersRead = await readVenueSwapOrders(provider, {
    orderAddress: args.orderAddress,
    knownPools: [...byNft.keys()],
    positions: args.positions,
  });

  const candidates: VenueFillCandidate[] = [];
  const unfillable: VenueUnfillableOrder[] = [];

  for (const order of venueFillSequence(ordersRead.orders)) {
    const pool = byNft.get(venueUnitOf(order.datum.pool_nft));
    /* c8 ignore next 4 -- the reader already set aside orders naming no known pool. */
    if (!pool) {
      unfillable.push({ order, reason: 'names a pool this round did not read' });
      continue;
    }
    const answer = venueFillableAmount({ pool, order, fillCostLovelace: args.fillCostLovelace });
    if (!answer.fillable) {
      unfillable.push({
        order,
        reason:
          answer.largest === 0n
            ? 'nothing clears its price floor at this pool — either the pool has moved, or the floor leaves no room for the order\u2019s own effect on the price'
            : `the pool can serve ${answer.largest} of it and the fee only funds a fill of ${answer.smallestFundable} or more`,
      });
      continue;
    }
    candidates.push({ order, pool, traded: answer.largest });
  }

  return { candidates, unfillable, skipped: [...poolsRead.skipped, ...ordersRead.skipped] };
}
