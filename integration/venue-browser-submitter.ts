// ============================================================================
// Noctis Zone — NoctisSwap: what a browser may do at the venue
// ============================================================================
// **The reading and pricing half of the venue is browser-safe by
// construction; the executing half is not.** That is not a coincidence and it
// is worth stating, because it decides what belongs in a bundle:
//
//   - Every module a placer needs — the pool reader, the quote engine, the
//     order tracker, the datum schemas — imports nothing but Lucid Evolution
//     and pure local code.
//   - Every module that FILLS or COLLECTS is built on Mesh, which signs with
//     keys a server holds. The widget builds alias `@meshsdk/core` to an empty
//     module for exactly that reason, and none of those modules are reachable
//     from here.
//
// So this is the placer's side of the venue, and only that: quote, place,
// look, cancel. It can never touch a pool.
//
// **Placing an order is an ordinary payment.** Creating a UTXO at a script
// address does not run that script, so a placement needs neither the order
// validator nor the pool's — it is a payment with an inline datum, and the
// browser never has to fit a validator into a transaction to make one.
//
// **Cancelling is a real script spend, and it fits.** `swap_order` compiles to
// 3,448 bytes against the 16,384-byte transaction cap, so the browser can
// carry it and the owner's exit needs no reference script, no batcher and
// nobody's cooperation. Compare the launch curve, whose Cardano Launch
// validator is 14,226 bytes and cannot be spent from a browser at all.
//
// **The refund goes where the ORDER says, not where the wallet says.** The
// destination was fixed when the order was written — `reward_pkh` and its
// optional stake key — so a cancel is verifiable from the order alone rather
// than from whatever address the signing wallet happens to hand back.
//
// **`extra_signatories` is the transaction's REQUIRED SIGNERS, not its
// witness set**, and that trap is the same here as it is server-side; it just
// has a different spelling. Lucid's `addSignerKey` is what writes the key into
// the transaction body. Signing alone leaves the script an empty list, and it
// is refused for a reason that names nothing.
//
// **A dead order cannot be placed from here.** `draftVenueSwapOrder` runs the
// fillability check against its own output and refuses a draft whose floor no
// pool state could ever meet — so the screen in front of this cannot emit an
// order that would rest forever.
// ============================================================================

import type { Assets, LucidEvolution, Network as LucidNetwork, UTxO, WalletApi } from '@lucid-evolution/lucid';
import {
  Blockfrost,
  calculateMinLovelaceFromUTxO,
  Data,
  getAddressDetails,
  Lucid,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import {
  type ProviderTxPosition,
  type ProviderUtxo,
  readVenueLiquidityOrders,
  readVenuePools,
  type VenueChainProvider,
} from './venue-chain-reader.js';
import {
  draftVenueDepositOrder,
  draftVenueRedeemOrder,
  VenueDepositConfigSchema,
  type VenueDepositDraft,
  type VenueLiquidityOrderUtxo,
  VenueRedeemConfigSchema,
  type VenueRedeemDraft,
  venueDepositPair,
  venueKeyAddress,
  venueLiquidityFillable,
  venueRefundRedeemer,
} from './venue-liquidity.js';
import {
  trackVenueOrders,
  type VenueOrderTracking,
  type VenueTrackedOrder,
  venueOrdersWorthCancelling,
} from './venue-order-tracker.js';
import {
  draftVenueSwapOrder,
  type VenueMarket,
  type VenueOrderDraft,
  type VenueQuote,
  venuePoolMarket,
} from './venue-quote.js';
import {
  type VenueOrderPosition,
  type VenuePoolUtxo,
  VenueSwapConfigSchema,
  type VenueSwapOrderUtxo,
  venueCancelRedeemer,
  venueRewardAddress,
  venueUnitOf,
} from './venue-swap.js';

export interface VenueBrowserSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /**
   * `swap_order.ak`'s compiled PlutusV3 CBOR, from the venue blueprint.
   *
   * Read server-side and inlined — a browser bundle cannot read the repo's
   * own `plutus.json`, and the address this derives is what a placement pays
   * to and a cancel spends from.
   */
  orderScriptCbor: string;
  /** `pool.ak`'s applied CBOR. Read from, and never spent from here. */
  poolScriptCbor: string;
  /** The factory policy that decides what is a pool and what merely sits there. */
  factoryPolicyId: string;
  /** What one fill costs, when an operator holds a better figure than the default. */
  fillCostLovelace?: bigint;
  /**
   * `deposit_order.ak`'s and `redeem_order.ak`'s compiled CBOR, from the venue
   * blueprint. A panel given them can add and remove liquidity; one without
   * them refuses to, by name, rather than paying to an address it derived
   * from nothing.
   */
  depositScriptCbor?: string;
  redeemScriptCbor?: string;
}

/** One of the placer's own deposit or redeem requests, and whether it can fill. */
export interface VenueTrackedLiquidityRequest {
  request: VenueLiquidityOrderUtxo;
  /** `fillable` waits only for a batcher; the other two never fill and should be refunded. */
  state: 'fillable' | 'unfundable' | 'orphaned';
  reason: string;
}

/**
 * A Lucid UTXO in the shape the chain reader reads.
 *
 * The adapter exists so the browser and the batcher agree on what a pool is —
 * `readVenuePools` is the one rule, and it stays the one rule rather than
 * being reimplemented against a second UTXO shape. Lucid puts an inline
 * datum's CBOR in `datum`; a datum-by-hash leaves it null, and the reader
 * declines that with its own reason.
 */
export function venueProviderUtxo(utxo: UTxO): ProviderUtxo {
  return {
    tx_hash: utxo.txHash,
    output_index: utxo.outputIndex,
    address: utxo.address,
    amount: Object.entries(utxo.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
    inline_datum: utxo.datum ?? null,
  };
}

/**
 * The payment key hash an order may name as its placer, or a refusal.
 *
 * **It has to be a KEY, and a script hash is not one.** `swap_order.ak`'s
 * cancel arm asks whether `reward_pkh` is in `extra_signatories`, and a script
 * hash can never appear there — so an order naming one could be placed, would
 * be nobody's to take back, and would rest forever. An address carries a
 * payment credential either way, which is why checking only that a hash exists
 * is not enough.
 */
export function venuePlacerKeyHash(address: string): string {
  const credential = getAddressDetails(address).paymentCredential;
  if (!credential) {
    throw new Error(`${address} carries no payment credential, so it can neither place nor hold an order.`);
  }
  if (credential.type !== 'Key') {
    throw new Error(
      `${address} is a script address. An order names the key that may take it back, and a script hash can ` +
        "never sign — an order naming one would be nobody's to cancel.",
    );
  }
  return credential.hash;
}

/** What a placer is offered for one pool, and the order it would sign. */
export interface VenueBrowserQuote {
  market: VenueMarket;
  quote: VenueQuote;
  draft: VenueOrderDraft;
}

/** The placer's side of the venue, from a browser. */
/**
 * The ledger's `coinsPerUtxoByte`, 4310 since Babbage on every Cardano
 * network. Held here rather than fetched: a quote must not depend on a
 * parameters request through the site's proxy, and the margin below covers a
 * small future change while the placer gets the ADA back in any case.
 */
const COINS_PER_UTXO_BYTE = 4310n;

/**
 * The least ADA the ledger lets a reward output carry when it holds `unit`.
 *
 * An order that buys a token is settled by an output holding that token, and
 * the ledger prices an output by its size, so the ADA the order carries for it
 * has to clear that figure or the fill is refused at submission — which is
 * how every ADA-to-token order once failed against a one-ADA carry (2026-09-23).
 * Sized for the largest amount the unit could hold, so the answer stands
 * whatever the fill delivers; the placer receives the ADA back in that same
 * output, so erring high costs nothing.
 */
/**
 * The least ADA the ledger lets a liquidity reward carry: an output holding
 * every unit named, each at the largest amount it could hold.
 *
 * A deposit's reward holds the LQ and, when the pool has moved, some of the
 * token back; a redeem's holds the token side. The placer sets this aside and
 * receives all of it back in that output, so sizing it high costs nothing,
 * while sizing it low makes a request no executor can fill.
 */
export function minimumForLiquidityReward(coinsPerUtxoByte: bigint, address: string, units: readonly string[]): bigint {
  const assets: Record<string, bigint> = { lovelace: 5_000_000n };
  for (const unit of units) {
    if (unit !== 'lovelace') assets[unit] = 2n ** 63n;
  }
  const minimum = calculateMinLovelaceFromUTxO(coinsPerUtxoByte, {
    txHash: '0'.repeat(64),
    outputIndex: 0,
    address,
    assets,
  });
  return minimum + 50_000n;
}

export function minimumForRewardOutput(coinsPerUtxoByte: bigint, address: string, unit: string): bigint {
  if (unit === 'lovelace') return 0n;
  const minimum = calculateMinLovelaceFromUTxO(coinsPerUtxoByte, {
    txHash: '0'.repeat(64),
    outputIndex: 0,
    address,
    assets: { lovelace: 5_000_000n, [unit]: 2n ** 63n },
  });
  return minimum + 50_000n;
}

export class VenueBrowserSubmitter {
  readonly orderAddress: string;
  readonly poolAddress: string;
  /** Where deposit and redeem requests are paid, when this panel was given their validators. */
  readonly depositAddress: string | null;
  readonly redeemAddress: string | null;
  private readonly lucidPromise: Promise<LucidEvolution>;
  /** Placement positions already looked up. Fixed once on chain, so kept. */
  private readonly placements = new Map<string, VenueOrderPosition>();

  constructor(private readonly config: VenueBrowserSubmitterConfig) {
    this.orderAddress = validatorToAddress(config.network, {
      type: 'PlutusV3',
      script: config.orderScriptCbor,
    });
    this.poolAddress = validatorToAddress(config.network, {
      type: 'PlutusV3',
      script: config.poolScriptCbor,
    });
    this.depositAddress = config.depositScriptCbor
      ? validatorToAddress(config.network, { type: 'PlutusV3', script: config.depositScriptCbor })
      : null;
    this.redeemAddress = config.redeemScriptCbor
      ? validatorToAddress(config.network, { type: 'PlutusV3', script: config.redeemScriptCbor })
      : null;
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs; a later await still sees the
    // rejection. Same note the curve's own submitter carries.
    this.lucidPromise.catch(() => {});
  }

  /**
   * The chain reader's provider, backed by Lucid and Blockfrost.
   *
   * `getTxPosition` is a real request and the reader really makes them: one
   * per distinct placement transaction it has not been given a position for.
   * That is what `placements` below is for — a transaction's block height and
   * index are fixed the moment it is on chain, so caching them is
   * unconditionally safe, and a placer re-opening their own book pays for
   * nothing they have already looked up.
   */
  private provider(lucid: LucidEvolution): VenueChainProvider {
    const { blockfrostUrl, blockfrostProjectId } = this.config;
    return {
      getAddressUtxosAll: async (address: string) => (await lucid.utxosAt(address)).map(venueProviderUtxo),
      getTxPosition: async (txHash: string): Promise<ProviderTxPosition> => {
        const response = await fetch(`${blockfrostUrl}/txs/${txHash}`, {
          headers: { project_id: blockfrostProjectId },
        });
        if (!response.ok) {
          throw new Error(`Blockfrost could not place transaction ${txHash}: ${response.status}.`);
        }
        const body = (await response.json()) as { block_height: number; index: number };
        return { block_height: body.block_height, index: body.index };
      },
    };
  }

  /** Every pool at the venue, authenticated by the factory's own policy. */
  async pools(): Promise<VenuePoolUtxo[]> {
    const lucid = await this.lucidPromise;
    const read = await readVenuePools(this.provider(lucid), {
      poolAddress: this.poolAddress,
      factoryPolicyId: this.config.factoryPolicyId,
    });
    return read.pools;
  }

  /** The pool carrying one launch's NFT, or a refusal naming what was asked for. */
  async poolFor(poolNftUnit: string): Promise<VenuePoolUtxo> {
    const pools = await this.pools();
    const found = pools.find((pool) => venueUnitOf(pool.datum.pool_nft) === poolNftUnit);
    if (!found) {
      throw new Error(
        `No pool carrying ${poolNftUnit} is live at ${this.poolAddress}. A launch has a pool only once it ` +
          'has graduated.',
      );
    }
    return found;
  }

  /**
   * What a trade would get, and the order that would ask for it.
   *
   * Returns both figures the screen has to keep apart: `quote.expectedOut` is
   * an estimate of a moment that has already passed, and
   * `draft.guaranteedOut` is the floor the order is actually bound to.
   */
  async quote(args: {
    poolNftUnit: string;
    inputUnit: string;
    tradedIn: bigint;
    slippageToleranceBps: bigint;
    walletAddress: string;
    permittedExecutors?: string[];
    minOutputLovelace: bigint;
    exFee?: bigint;
  }): Promise<VenueBrowserQuote> {
    const pool = await this.poolFor(args.poolNftUnit);
    const details = getAddressDetails(args.walletAddress);
    const rewardPkh = venuePlacerKeyHash(args.walletAddress);
    // The output that settles a token purchase has a ledger minimum of its
    // own; the order carries whichever is larger, the caller's figure or that.
    const market = venuePoolMarket(pool);
    const outputUnit = args.inputUnit === market.unitX ? market.unitY : market.unitX;
    const ledgerMinimum = minimumForRewardOutput(COINS_PER_UTXO_BYTE, args.walletAddress, outputUnit);
    const minOutputLovelace = args.minOutputLovelace > ledgerMinimum ? args.minOutputLovelace : ledgerMinimum;

    const draft = draftVenueSwapOrder({
      pool,
      inputUnit: args.inputUnit,
      tradedIn: args.tradedIn,
      slippageToleranceBps: args.slippageToleranceBps,
      rewardPkh,
      ...(details.stakeCredential?.hash ? { stakePkh: details.stakeCredential.hash } : {}),
      ...(args.permittedExecutors ? { permittedExecutors: args.permittedExecutors } : {}),
      minOutputLovelace,
      ...(args.exFee !== undefined ? { exFee: args.exFee } : {}),
      ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
    });

    return {
      market,
      quote: draft.quote,
      draft,
    };
  }

  /**
   * Places the order. An ordinary payment — no validator runs.
   *
   * The draft is re-checked rather than trusted: a quote taken a minute ago
   * describes a pool that has moved, and the one thing that must not reach the
   * chain is an order whose floor is unreachable at any pool state.
   */
  async placeSwapOrder(walletApi: WalletApi, draft: VenueOrderDraft): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);

    const assets: Assets = { ...draft.assets };
    const tx = await lucid
      .newTx()
      .pay.ToContract(this.orderAddress, { kind: 'inline', value: Data.to(draft.datum, VenueSwapConfigSchema) }, assets)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  /**
   * The connected wallet's own orders, each classified against its pool.
   *
   * Filtered on `reward_pkh`, which is where the proceeds go and therefore
   * whose order it is — not on who happened to submit the placement.
   */
  async myOrders(walletApi: WalletApi): Promise<VenueOrderTracking> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const address = await lucid.wallet().address();
    const owner = venuePlacerKeyHash(address);

    return trackVenueOrders(this.provider(lucid), {
      poolAddress: this.poolAddress,
      orderAddress: this.orderAddress,
      factoryPolicyId: this.config.factoryPolicyId,
      owner,
      positions: this.placements,
      ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
    });
  }

  /** The orders a placer should be offered a cancel for, worst first. */
  async ordersWorthCancelling(walletApi: WalletApi): Promise<VenueTrackedOrder[]> {
    return venueOrdersWorthCancelling(await this.myOrders(walletApi));
  }

  /**
   * A deposit, priced at the pool as it stands, and the request that asks for it.
   *
   * `tokenIn` defaults to what the pool's ratio pairs with `adaIn`, rounded up,
   * so the ADA the placer chose is what limits the deposit and any rounding
   * comes back. A pool that moves before the fill returns more of one side;
   * the placer is never charged a ratio the pool does not hold.
   */
  async quoteDeposit(args: {
    poolNftUnit: string;
    adaIn: bigint;
    tokenIn?: bigint;
    walletAddress: string;
    exFee?: bigint;
  }): Promise<{ market: VenueMarket; tokenIn: bigint; draft: VenueDepositDraft }> {
    if (!this.depositAddress) {
      throw new Error('This panel was not given the deposit validator, so it cannot add liquidity.');
    }
    const pool = await this.poolFor(args.poolNftUnit);
    const details = getAddressDetails(args.walletAddress);
    const rewardPkh = venuePlacerKeyHash(args.walletAddress);
    const tokenIn = args.tokenIn ?? venueDepositPair(pool, args.adaIn);
    const market = venuePoolMarket(pool);
    const collateralAda = minimumForLiquidityReward(COINS_PER_UTXO_BYTE, args.walletAddress, [
      venueUnitOf(pool.datum.pool_lq),
      venueUnitOf(pool.datum.pool_y),
    ]);
    const draft = draftVenueDepositOrder({
      pool,
      adaIn: args.adaIn,
      tokenIn,
      rewardPkh,
      ...(details.stakeCredential?.hash ? { stakePkh: details.stakeCredential.hash } : {}),
      collateralAda,
      ...(args.exFee !== undefined ? { exFee: args.exFee } : {}),
      ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
    });
    return { market, tokenIn, draft };
  }

  /** A redeem of `lqIn`, priced at the pool as it stands, and the request that asks for it. */
  async quoteRedeem(args: {
    poolNftUnit: string;
    lqIn: bigint;
    walletAddress: string;
    exFee?: bigint;
  }): Promise<{ market: VenueMarket; draft: VenueRedeemDraft }> {
    if (!this.redeemAddress) {
      throw new Error('This panel was not given the redeem validator, so it cannot remove liquidity.');
    }
    const pool = await this.poolFor(args.poolNftUnit);
    const details = getAddressDetails(args.walletAddress);
    const rewardPkh = venuePlacerKeyHash(args.walletAddress);
    const market = venuePoolMarket(pool);
    const collateralAda = minimumForLiquidityReward(COINS_PER_UTXO_BYTE, args.walletAddress, [
      venueUnitOf(pool.datum.pool_y),
    ]);
    const draft = draftVenueRedeemOrder({
      pool,
      lqIn: args.lqIn,
      rewardPkh,
      ...(details.stakeCredential?.hash ? { stakePkh: details.stakeCredential.hash } : {}),
      collateralAda,
      ...(args.exFee !== undefined ? { exFee: args.exFee } : {}),
      ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
    });
    return { market, draft };
  }

  /** How much of one unit the connected wallet holds, read through the wallet library. */
  async walletUnitBalance(walletApi: WalletApi, unit: string): Promise<bigint> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    let held = 0n;
    for (const utxo of await lucid.wallet().getUtxos()) held += utxo.assets[unit] ?? 0n;
    return held;
  }

  /** Places a deposit request. An ordinary payment — no validator runs. */
  async placeDeposit(walletApi: WalletApi, draft: VenueDepositDraft): Promise<{ txHash: string }> {
    if (!this.depositAddress) {
      throw new Error('This panel was not given the deposit validator, so it cannot add liquidity.');
    }
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const tx = await lucid
      .newTx()
      .pay.ToContract(this.depositAddress, { kind: 'inline', value: Data.to(draft.datum, VenueDepositConfigSchema) }, {
        ...draft.assets,
      } as Assets)
      .complete();
    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  /** Places a redeem request. An ordinary payment — no validator runs. */
  async placeRedeem(walletApi: WalletApi, draft: VenueRedeemDraft): Promise<{ txHash: string }> {
    if (!this.redeemAddress) {
      throw new Error('This panel was not given the redeem validator, so it cannot remove liquidity.');
    }
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const tx = await lucid
      .newTx()
      .pay.ToContract(this.redeemAddress, { kind: 'inline', value: Data.to(draft.datum, VenueRedeemConfigSchema) }, {
        ...draft.assets,
      } as Assets)
      .complete();
    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  /**
   * The connected wallet's own deposit and redeem requests, each with whether
   * it can fill. Unlike a swap there is no price to wait for, so a request
   * that cannot fill now never will, and the reason says why.
   */
  async myLiquidityRequests(walletApi: WalletApi): Promise<VenueTrackedLiquidityRequest[]> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const owner = venuePlacerKeyHash(await lucid.wallet().address());
    const provider = this.provider(lucid);
    const pools = await readVenuePools(provider, {
      poolAddress: this.poolAddress,
      factoryPolicyId: this.config.factoryPolicyId,
    });
    const byNft = new Map(pools.pools.map((pool) => [venueUnitOf(pool.datum.pool_nft), pool]));
    const read = await readVenueLiquidityOrders(provider, {
      ...(this.depositAddress ? { depositAddress: this.depositAddress } : {}),
      ...(this.redeemAddress ? { redeemAddress: this.redeemAddress } : {}),
      knownPools: [...byNft.keys()],
      positions: this.placements,
      includeUnknownPools: true,
    });
    return read.orders
      .filter((request) => request.datum.reward_pkh === owner)
      .map((request): VenueTrackedLiquidityRequest => {
        const pool = byNft.get(venueUnitOf(request.datum.pool_nft));
        if (!pool) {
          return {
            request,
            state: 'orphaned',
            reason: 'names a pool the venue does not hold, so nothing can ever fill it',
          };
        }
        const answer = venueLiquidityFillable({
          pool,
          order: request,
          network: this.config.network,
          minOutputLovelace: 1_000_000n,
          ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
        });
        return answer.fillable
          ? { request, state: 'fillable', reason: 'waiting for the batcher' }
          : { request, state: 'unfundable', reason: answer.reason };
      });
  }

  /**
   * Takes the placer's own deposit and redeem requests back, in one
   * transaction. `Refund` asks only for the placer's signature, so requests of
   * both kinds leave together, to the address they name.
   */
  async refundLiquidityRequests(
    walletApi: WalletApi,
    requests: readonly VenueLiquidityOrderUtxo[],
  ): Promise<{ txHash: string }> {
    if (requests.length === 0) {
      throw new Error('A refund needs at least one request to take back.');
    }
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const owner = venuePlacerKeyHash(await lucid.wallet().address());

    const destinations = new Set(
      requests.map((r) => venueKeyAddress(r.datum.reward_pkh, r.datum.stake_pkh, this.config.network)),
    );
    if (destinations.size > 1) {
      throw new Error(
        `These ${requests.length} requests pay out to ${destinations.size} different addresses, and one ` +
          'transaction returns them to one place. Refund each group sharing a reward address on its own.',
      );
    }
    for (const request of requests) {
      if (request.datum.reward_pkh !== owner) {
        throw new Error(
          `Request ${request.txHash}#${request.outputIndex} belongs to ${request.datum.reward_pkh}, not to the ` +
            'connected wallet. Only its placer can take it back.',
        );
      }
    }

    const utxos: UTxO[] = requests.map((request) => ({
      txHash: request.txHash,
      outputIndex: request.outputIndex,
      address: request.address,
      assets: { ...request.assets },
      datum:
        request.kind === 'deposit'
          ? Data.to(request.datum, VenueDepositConfigSchema)
          : Data.to(request.datum, VenueRedeemConfigSchema),
    }));

    let tx = lucid.newTx().collectFrom(utxos, venueRefundRedeemer());
    if (requests.some((r) => r.kind === 'deposit')) {
      if (!this.config.depositScriptCbor) throw new Error('This panel was not given the deposit validator.');
      tx = tx.attach.SpendingValidator({ type: 'PlutusV3', script: this.config.depositScriptCbor });
    }
    if (requests.some((r) => r.kind === 'redeem')) {
      if (!this.config.redeemScriptCbor) throw new Error('This panel was not given the redeem validator.');
      tx = tx.attach.SpendingValidator({ type: 'PlutusV3', script: this.config.redeemScriptCbor });
    }
    const built = await tx
      // The REQUIRED SIGNERS field, which is what `Refund` reads.
      .addSignerKey(owner)
      .complete({ changeAddress: [...destinations][0] as string });
    const signed = await built.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  /**
   * Takes the placer's own orders back, in one transaction.
   *
   * Cancels batch and fills cannot: the two-input rule lives inside the order
   * validator's `Fill` arm, and its cancel arm has no shape rule at all. So a
   * placer holding ten orders that can no longer fill gets out of all ten for
   * one network fee and one signature.
   */
  async cancelOrders(walletApi: WalletApi, orders: readonly VenueSwapOrderUtxo[]): Promise<{ txHash: string }> {
    if (orders.length === 0) {
      throw new Error('A cancel needs at least one order to take back.');
    }
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const address = await lucid.wallet().address();
    const owner = venuePlacerKeyHash(address);

    const destinations = new Set(orders.map((order) => venueRewardAddress(order.datum, this.config.network)));
    if (destinations.size > 1) {
      throw new Error(
        `These ${orders.length} orders pay out to ${destinations.size} different addresses, and one ` +
          'transaction returns them to one place. Cancel each group sharing a reward address on its own.',
      );
    }
    for (const order of orders) {
      if (order.datum.reward_pkh !== owner) {
        throw new Error(
          `Order ${order.txHash}#${order.outputIndex} belongs to ${order.datum.reward_pkh}, not to the ` +
            'connected wallet. Only its placer can take it back, and nobody else ever can.',
        );
      }
    }

    const utxos: UTxO[] = orders.map((order) => ({
      txHash: order.txHash,
      outputIndex: order.outputIndex,
      address: order.address,
      assets: { ...order.assets },
      datum: Data.to(order.datum, VenueSwapConfigSchema),
    }));

    const tx = await lucid
      .newTx()
      .collectFrom(utxos, venueCancelRedeemer())
      .attach.SpendingValidator({ type: 'PlutusV3', script: this.config.orderScriptCbor })
      // The transaction's REQUIRED SIGNERS field, which is what the validator
      // reads — a signature alone leaves `extra_signatories` empty.
      .addSignerKey(owner)
      // Everything leaves to the address the ORDERS name, fixed when they were
      // written rather than chosen now.
      .complete({ changeAddress: [...destinations][0] as string });

    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }
}
