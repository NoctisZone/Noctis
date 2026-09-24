// ============================================================================
// Noctis Zone — NoctisSwap: adding and removing liquidity
// ============================================================================
// A deposit and a redeem are orders, like a swap: the placer pays a request to
// a script address, and an executor spends it together with the pool in a
// two-input transaction. The pool's own arms say only that liquidity moves in
// proportion to both reserves; the ORDER says what the placer is owed. This
// module mirrors both, to the unit, so a batcher proposes fills the two
// validators accept and a front end drafts requests an executor can fill.
//
//   DEPOSIT. Both assets in, LQ out. Each side buys
//       floor(deposited * liquidity / reserve)
//   LQ at the pool's ratio, and the placer receives the smaller of the two.
//   The pool takes from each side the least that pays for that LQ,
//       ceil(lq * reserve / liquidity),
//   and everything else comes back: the larger side's surplus, any rounding on
//   the smaller one, and the ADA the placer set aside so the reward output can
//   exist (`collateral_ada`). Taking the least is not generosity, it is the
//   only amount both validators agree on for every deposit: the pool accepts
//   any contribution at or above it, and the order's change rule is met
//   exactly when nothing above it is kept.
//
//   REDEEM. LQ in, both assets out:
//       floor(lq_in * reserve / liquidity)
//   of each side. The ADA the request held beyond its execution fee is the
//   collateral, and it comes back on top of the ADA side's payout.
//
// Three rules worth naming, because each has an obvious wrong version:
//
//   - **The ADA side of a deposit is what is left after the fee and the
//     collateral.** The order validator computes it that way; pricing the
//     whole lovelace balance would promise LQ the fill cannot deliver.
//   - **Reserves are net of the fee counters.** The treasury and royalty
//     balances sit in the same UTXO and belong to somebody else, exactly as
//     they do for a swap (`readVenuePoolState`).
//   - **The pool's datum does not change.** A deposit or redeem that touched a
//     counter would be refused; the successor carries the datum it found.
//
// Every NoctisSwap pool pairs ADA (`pool_x`) with a launch token (`pool_y`),
// and the planners here refuse any other shape rather than guess at one.
// ============================================================================

import { Constr, credentialToAddress, Data, type Network as LucidNetwork } from '@lucid-evolution/lucid';
import { VenueAssetShape } from './venue-pool.js';
import {
  readVenuePoolState,
  VENUE_FILL_FLOOR_LOVELACE,
  VENUE_ORDER_EXECUTION_FEE_LOVELACE,
  type VenueOrderPosition,
  type VenuePoolUtxo,
  venueUnitOf,
} from './venue-swap.js';

/** `noctisswap/orders/DepositConfig`, field for field from the venue blueprint. */
export const VenueDepositConfigShape = Data.Object({
  pool_nft: VenueAssetShape,
  x: VenueAssetShape,
  y: VenueAssetShape,
  lq: VenueAssetShape,
  ex_fee: Data.Integer(),
  reward_pkh: Data.Bytes(),
  stake_pkh: Data.Nullable(Data.Bytes()),
  collateral_ada: Data.Integer(),
});
export type VenueDepositConfigData = Data.Static<typeof VenueDepositConfigShape>;
export const VenueDepositConfigSchema = VenueDepositConfigShape as unknown as VenueDepositConfigData;

/** `noctisswap/orders/RedeemConfig`, field for field from the venue blueprint. */
export const VenueRedeemConfigShape = Data.Object({
  pool_nft: VenueAssetShape,
  x: VenueAssetShape,
  y: VenueAssetShape,
  lq: VenueAssetShape,
  ex_fee: Data.Integer(),
  reward_pkh: Data.Bytes(),
  stake_pkh: Data.Nullable(Data.Bytes()),
});
export type VenueRedeemConfigData = Data.Static<typeof VenueRedeemConfigShape>;
export const VenueRedeemConfigSchema = VenueRedeemConfigShape as unknown as VenueRedeemConfigData;

/** The venue blueprint titles of the two request validators. Neither takes a parameter. */
export const VENUE_DEPOSIT_ORDER_TITLE = 'royalty_pool/deposit_order.deposit_order.spend';
export const VENUE_REDEEM_ORDER_TITLE = 'royalty_pool/redeem_order.redeem_order.spend';

/**
 * `OrderAction.Apply` — the executor's arm, three positions the validator
 * resolves by number: two into `self.inputs` and one into `self.outputs`.
 *
 * The same shape as a swap's `Fill`, and the same trap: the builder SORTS
 * inputs, so these are positions after sorting, which the filler checks on
 * the finished transaction.
 */
export function venueApplyRedeemer(poolInIx: number, orderInIx: number, rewardOutIx: number): string {
  return Data.to(new Constr(0, [BigInt(poolInIx), BigInt(orderInIx), BigInt(rewardOutIx)]));
}

/** `OrderAction.Refund` — the placer taking their own request back. */
export function venueRefundRedeemer(): string {
  return Data.to(new Constr(1, []));
}

/** A deposit request as the batcher and the tracker hold one. */
export interface VenueDepositOrderUtxo {
  kind: 'deposit';
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datum: VenueDepositConfigData;
  placedAt?: VenueOrderPosition;
}

/** A redeem request as the batcher and the tracker hold one. */
export interface VenueRedeemOrderUtxo {
  kind: 'redeem';
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datum: VenueRedeemConfigData;
  placedAt?: VenueOrderPosition;
}

export type VenueLiquidityOrderUtxo = VenueDepositOrderUtxo | VenueRedeemOrderUtxo;

/** `ceil(a / b)` for a non-negative `a` and a positive `b`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a + b - 1n) / b;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function pruneZero(assets: Record<string, bigint>): Record<string, bigint> {
  return Object.fromEntries(Object.entries(assets).filter(([, quantity]) => quantity !== 0n));
}

/** The address `reward_address_ok` accepts: the placer's payment key, and their stake key or none. */
export function venueKeyAddress(rewardPkh: string, stakePkh: string | null, network: LucidNetwork): string {
  const payment = { type: 'Key' as const, hash: rewardPkh };
  if (stakePkh === null) return credentialToAddress(network, payment);
  return credentialToAddress(network, payment, { type: 'Key', hash: stakePkh });
}

/** A pool's reserves and circulating LQ, refusing a pool no deposit or redeem can price against. */
function liquidityState(pool: VenuePoolUtxo): { reservesX: bigint; reservesY: bigint; liquidity: bigint } {
  const cfg = pool.datum;
  if (venueUnitOf(cfg.pool_x) !== 'lovelace') {
    throw new Error(
      `This pool's first asset is ${venueUnitOf(cfg.pool_x)}, not ADA. Every NoctisSwap pool pairs ADA with a ` +
        'launch token, and the liquidity planners do not price any other shape.',
    );
  }
  const state = readVenuePoolState(cfg, pool.assets);
  if (state.liquidity <= 0n || state.reservesX <= 0n || state.reservesY <= 0n) {
    throw new Error(
      `This pool holds ${state.reservesX}/${state.reservesY} against ${state.liquidity} LQ. A deposit or redeem ` +
        'is priced against the reserves already there, and the pool validator refuses one when it has none.',
    );
  }
  return state;
}

/** How one deposit divides between the pool and the placer. */
export interface VenueDepositSplit {
  /** The LQ the ADA side buys at the pool's ratio — the order validator's `min_x`. */
  lqForX: bigint;
  /** The LQ the token side buys — the order validator's `min_y`. */
  lqForY: bigint;
  /** What the placer receives: the smaller of the two. */
  lq: bigint;
  /** Lovelace the pool takes: the least that pays for `lq`. */
  xIn: bigint;
  /** Tokens the pool takes: the least that pays for `lq`. */
  yIn: bigint;
  /** What comes back of each side. */
  xBack: bigint;
  yBack: bigint;
}

/**
 * The deposit's own arithmetic, from both validators at once.
 *
 * `depositX` is the ADA side as the order validator counts it — the request's
 * lovelace less its fee and its collateral — and `depositY` is the token it
 * holds. Pure integer arithmetic; every figure is non-negative.
 */
export function venueDepositSplit(args: {
  depositX: bigint;
  depositY: bigint;
  reservesX: bigint;
  reservesY: bigint;
  liquidity: bigint;
}): VenueDepositSplit {
  const { depositX, depositY, reservesX, reservesY, liquidity } = args;
  if (reservesX <= 0n || reservesY <= 0n || liquidity <= 0n) {
    throw new Error(
      `A deposit is priced against the pool's own reserves and liquidity, and ${reservesX}/${reservesY} against ` +
        `${liquidity} LQ gives it nothing to price against.`,
    );
  }
  if (depositX < 0n || depositY < 0n) {
    throw new Error(
      `This deposit counts ${depositX} lovelace and ${depositY} tokens. The ADA side is what the request holds ` +
        'beyond its execution fee and its collateral, and neither side can be negative.',
    );
  }
  const lqForX = (depositX * liquidity) / reservesX;
  const lqForY = (depositY * liquidity) / reservesY;
  const lq = min(lqForX, lqForY);
  const xIn = ceilDiv(lq * reservesX, liquidity);
  const yIn = ceilDiv(lq * reservesY, liquidity);
  return { lqForX, lqForY, lq, xIn, yIn, xBack: depositX - xIn, yBack: depositY - yIn };
}

/** What a redeem of `lqIn` pays out of each side: the order validator's `min_return`. */
export function venueRedeemSplit(args: { lqIn: bigint; reservesX: bigint; reservesY: bigint; liquidity: bigint }): {
  xOut: bigint;
  yOut: bigint;
} {
  const { lqIn, reservesX, reservesY, liquidity } = args;
  if (liquidity <= 0n) {
    throw new Error('A pool with no liquidity has nothing to redeem against.');
  }
  if (lqIn <= 0n || lqIn >= liquidity) {
    throw new Error(
      `This redeem hands back ${lqIn} LQ of the ${liquidity} in circulation. A redeem returns some of the ` +
        "pool's liquidity and never all of it: part of it is locked in the launch's escrow for good.",
    );
  }
  return { xOut: (lqIn * reservesX) / liquidity, yOut: (lqIn * reservesY) / liquidity };
}

/**
 * The token amount that pairs with `adaIn` at the pool's current ratio.
 *
 * Rounded UP, so the token side always buys at least as much LQ as the ADA
 * side: the ADA the placer chose is what limits the deposit, and the few
 * tokens of rounding come back in the reward. A pool that has moved by the
 * time the deposit fills simply returns more of one side — the placer is never
 * charged a ratio the pool does not hold.
 */
export function venueDepositPair(pool: VenuePoolUtxo, adaIn: bigint): bigint {
  const state = liquidityState(pool);
  if (adaIn <= 0n) throw new Error(`A deposit must add some ADA; this one adds ${adaIn}.`);
  return ceilDiv(adaIn * state.reservesY, state.reservesX);
}

/** What a placer is shown before signing a deposit request. */
export interface VenueDepositDraft {
  datum: VenueDepositConfigData;
  /** What the request carries: the two sides, the fee ceiling and the collateral. */
  assets: Record<string, bigint>;
  /** LQ expected at the pool as it stands. An estimate: the pool may move before a fill. */
  expectedLq: bigint;
  /** Of that, what comes back of each side at the pool as it stands. */
  expectedXBack: bigint;
  expectedYBack: bigint;
  /** The share of the pool the LQ is, after the deposit, in basis points. */
  shareAfterBps: bigint;
  /** The most an executor may take. A ceiling — a settled fill charges less. */
  maxExecutionFee: bigint;
  /** Lovelace the request carries in total. */
  carriedLovelace: bigint;
}

/**
 * A deposit request against one pool, ready to sign.
 *
 * `collateralAda` is the ADA the reward output needs to exist: it comes back
 * to the placer in full, so sizing it from the ledger's rule for an output
 * holding the LQ and the token costs nothing. `exFee` defaults to what one
 * swap fill has been measured to need, with the same margin, and anything a
 * fill does not use is returned in the reward.
 */
export function draftVenueDepositOrder(args: {
  pool: VenuePoolUtxo;
  adaIn: bigint;
  tokenIn: bigint;
  rewardPkh: string;
  stakePkh?: string;
  collateralAda: bigint;
  exFee?: bigint;
  fillCostLovelace?: bigint;
}): VenueDepositDraft {
  const { pool } = args;
  const cfg = pool.datum;
  const state = liquidityState(pool);
  const exFee = args.exFee ?? VENUE_ORDER_EXECUTION_FEE_LOVELACE;
  const fillCost = args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE;
  if (exFee < fillCost) {
    throw new Error(
      `An execution fee of ${exFee} lovelace does not cover one fill (${fillCost}). A request that cannot pay ` +
        'for its own fill can never be filled, only refunded.',
    );
  }
  if (args.collateralAda <= 0n) {
    throw new Error('A deposit needs ADA set aside for the output that carries the LQ back; this one sets none.');
  }
  if (args.adaIn <= 0n || args.tokenIn <= 0n) {
    throw new Error(
      `A deposit adds both sides of the pool; this one adds ${args.adaIn} lovelace and ${args.tokenIn} tokens.`,
    );
  }
  const split = venueDepositSplit({
    depositX: args.adaIn,
    depositY: args.tokenIn,
    reservesX: state.reservesX,
    reservesY: state.reservesY,
    liquidity: state.liquidity,
  });
  if (split.lq <= 0n) {
    throw new Error(
      'This deposit is too small to buy a single LQ token at the pool as it stands. Add more of the smaller side.',
    );
  }
  const yUnit = venueUnitOf(cfg.pool_y);
  const carriedLovelace = args.adaIn + exFee + args.collateralAda;
  return {
    datum: {
      pool_nft: cfg.pool_nft,
      x: cfg.pool_x,
      y: cfg.pool_y,
      lq: cfg.pool_lq,
      ex_fee: exFee,
      reward_pkh: args.rewardPkh,
      stake_pkh: args.stakePkh ?? null,
      collateral_ada: args.collateralAda,
    },
    assets: { lovelace: carriedLovelace, [yUnit]: args.tokenIn },
    expectedLq: split.lq,
    expectedXBack: split.xBack,
    expectedYBack: split.yBack,
    shareAfterBps: (split.lq * 10_000n) / (state.liquidity + split.lq),
    maxExecutionFee: exFee,
    carriedLovelace,
  };
}

/** What a placer is shown before signing a redeem request. */
export interface VenueRedeemDraft {
  datum: VenueRedeemConfigData;
  assets: Record<string, bigint>;
  /** What each side pays out at the pool as it stands. An estimate. */
  expectedXOut: bigint;
  expectedYOut: bigint;
  maxExecutionFee: bigint;
  carriedLovelace: bigint;
}

/**
 * A redeem request against one pool, ready to sign.
 *
 * `collateralAda` is ADA the request carries beyond its fee, so the output
 * that pays the token side out can exist; the validator derives it as the
 * request's lovelace less the fee, and it comes back to the placer in full.
 */
export function draftVenueRedeemOrder(args: {
  pool: VenuePoolUtxo;
  lqIn: bigint;
  rewardPkh: string;
  stakePkh?: string;
  collateralAda: bigint;
  exFee?: bigint;
  fillCostLovelace?: bigint;
}): VenueRedeemDraft {
  const { pool } = args;
  const cfg = pool.datum;
  const state = liquidityState(pool);
  const exFee = args.exFee ?? VENUE_ORDER_EXECUTION_FEE_LOVELACE;
  const fillCost = args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE;
  if (exFee < fillCost) {
    throw new Error(
      `An execution fee of ${exFee} lovelace does not cover one fill (${fillCost}). A request that cannot pay ` +
        'for its own fill can never be filled, only refunded.',
    );
  }
  if (args.collateralAda <= 0n) {
    throw new Error('A redeem needs ADA set aside for the output that pays it out; this one sets none.');
  }
  const out = venueRedeemSplit({
    lqIn: args.lqIn,
    reservesX: state.reservesX,
    reservesY: state.reservesY,
    liquidity: state.liquidity,
  });
  if (out.xOut <= 0n && out.yOut <= 0n) {
    throw new Error('This redeem is too small to pay out anything at the pool as it stands.');
  }
  const carriedLovelace = exFee + args.collateralAda;
  return {
    datum: {
      pool_nft: cfg.pool_nft,
      x: cfg.pool_x,
      y: cfg.pool_y,
      lq: cfg.pool_lq,
      ex_fee: exFee,
      reward_pkh: args.rewardPkh,
      stake_pkh: args.stakePkh ?? null,
    },
    assets: { lovelace: carriedLovelace, [venueUnitOf(cfg.pool_lq)]: args.lqIn },
    expectedXOut: out.xOut,
    expectedYOut: out.yOut,
    maxExecutionFee: exFee,
    carriedLovelace,
  };
}

/** Everything one liquidity fill moves, ready to build a transaction from. */
export interface VenueLiquidityFill {
  kind: 'deposit' | 'redeem';
  /** LQ the pool released (a deposit) or took back (a redeem). */
  lq: bigint;
  /** What the pool's ADA and token reserves moved by: positive in, negative out. */
  xDelta: bigint;
  yDelta: bigint;
  /** The lovelace the executor keeps from this fill. */
  exFeeTaken: bigint;
  /** The pool's successor value. Its datum is the one it had. */
  poolAssets: Record<string, bigint>;
  /** The placer's reward output. */
  reward: { address: string; assets: Record<string, bigint> };
}

/** The checks both kinds share: the pool named, its assets, the request's contents and the fee. */
function checkRequest(
  pool: VenuePoolUtxo,
  order: VenueLiquidityOrderUtxo,
  executorFee: bigint | undefined,
  fillCostLovelace: bigint | undefined,
): bigint {
  const cfg = pool.datum;
  const req = order.datum;
  if (venueUnitOf(req.pool_nft) !== venueUnitOf(cfg.pool_nft)) {
    throw new Error(
      `This request names pool NFT ${venueUnitOf(req.pool_nft)} and this pool carries ` +
        `${venueUnitOf(cfg.pool_nft)}. A request can only ever be filled against the pool it named.`,
    );
  }
  for (const [field, a, b] of [
    ['x', req.x, cfg.pool_x],
    ['y', req.y, cfg.pool_y],
    ['lq', req.lq, cfg.pool_lq],
  ] as const) {
    if (venueUnitOf(a) !== venueUnitOf(b)) {
      throw new Error(
        `This request's ${field} is ${venueUnitOf(a)} and the pool's is ${venueUnitOf(b)}. The order validator ` +
          'refuses a request whose assets are not the pool’s own.',
      );
    }
  }
  const named = new Set(
    order.kind === 'deposit' ? ['lovelace', venueUnitOf(req.x), venueUnitOf(req.y)] : ['lovelace', venueUnitOf(req.lq)],
  );
  const stray = Object.entries(order.assets).find(([unit, quantity]) => quantity !== 0n && !named.has(unit));
  if (stray) {
    throw new Error(
      `This request also holds ${stray[1]} of ${stray[0]}, which it does not name. The order validator refuses a ` +
        'request carrying anything but its own assets and ADA, so it can only be refunded.',
    );
  }
  if (fillCostLovelace !== undefined && req.ex_fee < fillCostLovelace) {
    throw new Error(
      `This request allows ${req.ex_fee} lovelace for its execution and a fill costs ${fillCostLovelace}. It can ` +
        'never be filled, only refunded by its placer.',
    );
  }
  const exFeeTaken = executorFee ?? req.ex_fee;
  if (exFeeTaken < 0n || exFeeTaken > req.ex_fee) {
    throw new Error(
      `This fill takes ${exFeeTaken} lovelace of execution fee where the request allows at most ${req.ex_fee}.`,
    );
  }
  return exFeeTaken;
}

/**
 * Prices one deposit fill and lays out both sides of it.
 *
 * `executorFee` is what the executor keeps, at most the request's `ex_fee`;
 * the rest of the fee comes back to the placer in the reward.
 */
export function planVenueDepositFill(args: {
  pool: VenuePoolUtxo;
  order: VenueDepositOrderUtxo;
  network: LucidNetwork;
  executorFee?: bigint;
  minOutputLovelace: bigint;
  fillCostLovelace?: bigint;
}): VenueLiquidityFill {
  const { pool, order } = args;
  const req = order.datum;
  const exFeeTaken = checkRequest(pool, order, args.executorFee, args.fillCostLovelace);
  const state = liquidityState(pool);
  const xUnit = venueUnitOf(req.x);
  const yUnit = venueUnitOf(req.y);
  const lqUnit = venueUnitOf(req.lq);

  const heldLovelace = order.assets[xUnit] ?? 0n;
  const depositX = heldLovelace - req.ex_fee - req.collateral_ada;
  if (depositX < 0n || req.collateral_ada < 0n) {
    throw new Error(
      `This request holds ${heldLovelace} lovelace against a fee of ${req.ex_fee} and collateral of ` +
        `${req.collateral_ada}, which leaves nothing for the ADA side of the deposit.`,
    );
  }
  const split = venueDepositSplit({
    depositX,
    depositY: order.assets[yUnit] ?? 0n,
    reservesX: state.reservesX,
    reservesY: state.reservesY,
    liquidity: state.liquidity,
  });
  if (split.lq <= 0n) {
    throw new Error(
      'At the pool as it stands this deposit buys no LQ at all, and the pool refuses a deposit that moves no ' +
        'liquidity. Its placer can refund it.',
    );
  }

  const poolAssets = { ...pool.assets };
  poolAssets[xUnit] = (poolAssets[xUnit] ?? 0n) + split.xIn;
  poolAssets[yUnit] = (poolAssets[yUnit] ?? 0n) + split.yIn;
  poolAssets[lqUnit] = (poolAssets[lqUnit] ?? 0n) - split.lq;

  const rewardLovelace = req.collateral_ada + split.xBack + (req.ex_fee - exFeeTaken);
  if (rewardLovelace < args.minOutputLovelace) {
    throw new Error(
      `The reward would carry ${rewardLovelace} lovelace, under the ${args.minOutputLovelace} an output must hold. ` +
        'The request set too little aside for the output that returns its LQ; it can only be refunded.',
    );
  }
  const reward = pruneZero({ lovelace: rewardLovelace, [lqUnit]: split.lq, [yUnit]: split.yBack });

  return {
    kind: 'deposit',
    lq: split.lq,
    xDelta: split.xIn,
    yDelta: split.yIn,
    exFeeTaken,
    poolAssets: pruneZero(poolAssets),
    reward: { address: venueKeyAddress(req.reward_pkh, req.stake_pkh, args.network), assets: reward },
  };
}

/** Prices one redeem fill and lays out both sides of it. */
export function planVenueRedeemFill(args: {
  pool: VenuePoolUtxo;
  order: VenueRedeemOrderUtxo;
  network: LucidNetwork;
  executorFee?: bigint;
  minOutputLovelace: bigint;
  fillCostLovelace?: bigint;
}): VenueLiquidityFill {
  const { pool, order } = args;
  const req = order.datum;
  const exFeeTaken = checkRequest(pool, order, args.executorFee, args.fillCostLovelace);
  const state = liquidityState(pool);
  const xUnit = venueUnitOf(req.x);
  const yUnit = venueUnitOf(req.y);
  const lqUnit = venueUnitOf(req.lq);

  const lqIn = order.assets[lqUnit] ?? 0n;
  const collateral = (order.assets.lovelace ?? 0n) - req.ex_fee;
  if (collateral < 0n) {
    throw new Error(
      `This request holds ${order.assets.lovelace ?? 0n} lovelace against a fee of ${req.ex_fee}. It cannot pay ` +
        'for its own fill; its placer can refund it.',
    );
  }
  const out = venueRedeemSplit({
    lqIn,
    reservesX: state.reservesX,
    reservesY: state.reservesY,
    liquidity: state.liquidity,
  });

  const poolAssets = { ...pool.assets };
  poolAssets[xUnit] = (poolAssets[xUnit] ?? 0n) - out.xOut;
  poolAssets[yUnit] = (poolAssets[yUnit] ?? 0n) - out.yOut;
  poolAssets[lqUnit] = (poolAssets[lqUnit] ?? 0n) + lqIn;

  const rewardLovelace = out.xOut + collateral + (req.ex_fee - exFeeTaken);
  if (rewardLovelace < args.minOutputLovelace) {
    throw new Error(
      `The reward would carry ${rewardLovelace} lovelace, under the ${args.minOutputLovelace} an output must hold. ` +
        'The request set too little aside; it can only be refunded.',
    );
  }
  const reward = pruneZero({ lovelace: rewardLovelace, [yUnit]: out.yOut });

  return {
    kind: 'redeem',
    lq: lqIn,
    xDelta: -out.xOut,
    yDelta: -out.yOut,
    exFeeTaken,
    poolAssets: pruneZero(poolAssets),
    reward: { address: venueKeyAddress(req.reward_pkh, req.stake_pkh, args.network), assets: reward },
  };
}

/** Plans whichever kind of fill the request is. */
export function planVenueLiquidityFill(args: {
  pool: VenuePoolUtxo;
  order: VenueLiquidityOrderUtxo;
  network: LucidNetwork;
  executorFee?: bigint;
  minOutputLovelace: bigint;
  fillCostLovelace?: bigint;
}): VenueLiquidityFill {
  return args.order.kind === 'deposit'
    ? planVenueDepositFill({ ...args, order: args.order })
    : planVenueRedeemFill({ ...args, order: args.order });
}

/**
 * Whether anyone can fill a request against a pool right now, and if not, why.
 *
 * Unlike a swap there is no price floor to wait for: a deposit or redeem fills
 * at the pool's ratio whenever it is. So a request is either fillable or it
 * never will be — its fee is below a fill's cost, it names something the pool
 * is not, or it moves no liquidity — and the reason says which.
 */
export function venueLiquidityFillable(args: {
  pool: VenuePoolUtxo;
  order: VenueLiquidityOrderUtxo;
  network: LucidNetwork;
  minOutputLovelace: bigint;
  fillCostLovelace?: bigint;
}): { fillable: true } | { fillable: false; reason: string } {
  try {
    planVenueLiquidityFill({
      ...args,
      fillCostLovelace: args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE,
      // Planned at the cheapest fill a settled build could charge, which is
      // the question: could any executor fill this at all.
      executorFee: args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE,
    });
    return { fillable: true };
  } catch (error) {
    return { fillable: false, reason: (error as Error).message };
  }
}
