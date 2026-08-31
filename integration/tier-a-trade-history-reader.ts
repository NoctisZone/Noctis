// ============================================================================
// Noctis Zone — Cardano Trade History Reader
// ============================================================================
// Reconstructs a launch's full real transaction history — every action ever
// taken against its bonding_curve (and vesting) script UTxOs — by walking
// the UTXO chain backward from the CURRENT UTxO to the genesis mint output.
// bonding_curve.ak's (and bonding_curve_tier_b.ak's) own design makes this
// possible: each script address is a single-threaded state machine — every
// action spends exactly the one existing UTxO for a launch and creates
// exactly one continuing one (until a terminal action like Migrate), so the
// full history is a simple linked list, walkable via each transaction's own
// real inputs (confirmed directly against real Preprod data this session:
// a real buy tx's own input at the curve address pointed at exactly the
// prior ActivateCurve tx).
//
// Real Blockfrost API shape, verified directly (not assumed) before
// building this:
//   - /txs/{hash}/utxos — real inputs (each with its own creating tx_hash)
//     and outputs for a transaction.
//   - /txs/{hash}/redeemers — real per-redeemer metadata, but only a
//     `redeemer_data_hash` (NOT the raw bytes).
//   - /scripts/datum/{hash}/cbor — the real redeemer CBOR bytes, keyed by
//     that same hash (Blockfrost indexes redeemer data alongside datums).
//   - Data.from(cborHex) with NO schema argument returns a real Constr
//     instance (confirmed via a live runtime test), letting every
//     redeemer's real constructor index + positional fields be read
//     without needing a named schema for each one.
//
// No new storage — live Blockfrost queries per call, same "platform owns
// state, cache briefly" convention Phase 2's reader already established.
// ============================================================================

import { Constr, Data, getAddressDetails } from '@lucid-evolution/lucid';
import type { CurveParams, CurveShape } from './curve-pricing.js';
import { buyCost, sellProceeds } from './curve-pricing.js';
import { BONDING_CURVE_REDEEMER, BONDING_CURVE_TIER_B_REDEEMER, VESTING_REDEEMER } from './redeemer-indices.js';
import {
  type BondingCurveDatumData,
  BondingCurveDatumSchema,
  BondingCurveTierBDatumSchema,
  type VestingDatumData,
  VestingDatumSchema,
} from './tier-a-schemas.js';

export interface TradeEvent {
  txHash: string;
  blockTime: number;
  contract: 'bonding_curve' | 'vesting';
  action: string;
  /** True only for ClaimCreatorFees and ClaimVested — actions this codebase's
   *  redeemer logic requires the CREATOR's own signature for. */
  isCreatorAction: boolean;
  /** True when an ordinary TRADE was made by the launch's creator.
   *
   *  A creator may buy on the public curve. They can never sell, so the ADA
   *  only ever goes in — but the community is entitled to see it happening,
   *  which is what this flag is for. Surface it in the trade feed, the chart
   *  and anywhere a launch's activity is summarised.
   *
   *  Distinct from `isCreatorAction`: that means "only a creator could do
   *  this", this means "a creator did an ordinary thing". */
  isCreatorTrade: boolean;
  fields: Record<string, string>;
  /**
   * The redeemer exactly as decoded, before `fields` flattened it to strings.
   *
   * `fields` is for display, and a `BatchTrades` redeemer does not survive it:
   * its one field is a LIST of orders, each with its own owner and amount, and
   * stringifying that loses every one of them. Anything reconstructing state
   * from history — the per-wallet cap totals especially — has to read this.
   */
  raw?: Constr<unknown>;
}

/**
 * What `unit_price` is multiplied by before its integer divide.
 *
 * A per-token price is a ratio of two bigints and is almost never a whole
 * number of lovelace, so dividing them directly throws the fraction away.
 * Scaling first keeps the result an integer — which is what the storage column
 * and the candle aggregation both want — while preserving six decimal places
 * of the real price.
 *
 * Anything reading `unit_price` MUST divide by this. It is exported so no
 * consumer has to hard-code the factor and quietly disagree with this file.
 */
export const UNIT_PRICE_SCALE = 1_000_000n;

interface BlockfrostConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function bf<T>(config: BlockfrostConfig, path: string): Promise<T> {
  const res = await fetch(`${config.blockfrostUrl}${path}`, {
    headers: { project_id: config.blockfrostProjectId },
  });
  if (!res.ok) {
    throw new Error(`Blockfrost ${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface BfTxUtxos {
  // `inline_datum` on an INPUT is the datum of the UTXO being spent — the
  // curve's state as it stood BEFORE this transaction. Confirmed present and
  // required in Blockfrost's own OpenAPI schema for /txs/{hash}/utxos, not
  // assumed. It is what lets a trade's executed price be recomputed below.
  inputs: Array<{ address: string; tx_hash: string; output_index: number; inline_datum: string | null }>;
  outputs: Array<{ address: string; inline_datum: string | null }>;
}

/**
 * Recomputes what a trade actually cost, from the curve state it executed
 * against.
 *
 * The redeemer names an amount and a buyer, nothing more: the validator
 * derives the charge itself, so there is no price field to read back. The
 * honest reconstruction is therefore to run the same range formula over the
 * pre-trade datum — the same inputs the contract had, giving the same answer,
 * to the lovelace.
 *
 * Returns lovelace figures for the whole trade, and a per-token price in
 * MICRO-lovelace (see UNIT_PRICE_SCALE). `unit_price` is an AVERAGE: every
 * token in a batch is priced where it sits on the curve, so a large buy has
 * no single price.
 */
function pricedFields(
  shape: CurveShape,
  preDatum: CurveParams & { tokens_sold: bigint; creator_pub_key_hash: string },
  action: string,
  tokenAmount: bigint,
): Record<string, string> {
  if (tokenAmount <= 0n) return {};
  let gross: bigint;
  if (action === 'BuyTokens') {
    gross = buyCost(shape, preDatum, preDatum.tokens_sold, tokenAmount);
  } else if (action === 'SellTokens') {
    const fromSold = preDatum.tokens_sold - tokenAmount;
    if (fromSold < 0n) return {};
    gross = sellProceeds(shape, preDatum, fromSold, tokenAmount);
  } else if (action === 'ClaimDarkVeilTokens') {
    // Flat DarkVeil price, not a point on the curve — see the redeemer's own
    // note in bonding_curve_tier_b.ak.
    gross = tokenAmount * preDatum.base_price;
  } else {
    return {};
  }
  return {
    gross_lovelace: gross.toString(),
    // MICRO-lovelace per token, not lovelace. Both operands are bigint, so a
    // plain `gross / tokenAmount` is INTEGER division: a real price of 4.1849
    // lovelace/token came back as `4`, and every consumer downstream — the
    // stored column, the candles, the chart — faithfully carried that 4.
    //
    // On a curve whose whole public phase moves between roughly 4 and 75
    // lovelace, one-lovelace resolution is not a rounding detail: early
    // trading collapses to two or three distinct values and the chart draws a
    // staircase instead of a curve.
    //
    // Scaling before the divide keeps this an integer (so the column stays
    // BIGINT and the candle aggregation keeps working on plain integers) while
    // carrying six more decimal places. Every reader divides by
    // UNIT_PRICE_SCALE to get lovelace, or by UNIT_PRICE_SCALE * 1e6 for ADA.
    unit_price: ((gross * UNIT_PRICE_SCALE) / tokenAmount).toString(),
  };
}

interface BfRedeemer {
  purpose: string;
  script_hash: string;
  redeemer_data_hash: string;
}

// ============================================================================
// Redeemer decoding
// ============================================================================
// A redeemer arrives as a constructor INDEX. These used to be written out as
// index -> name maps, and they drifted: merging the treasury and ops fee
// claims into one removed an index, so from that point on every later
// variant sat one lower than the map said. A real SellTokens decoded as
// `ClaimOpsFees`, a real ClaimBuyback as `ExpireCurve`, and `BatchTrades`
// was not known at all — which silently mislabelled the trade feed and fed
// the CTO creator-activity check the wrong actions.
//
// So the indices are no longer written here. They come from
// ./redeemer-indices.ts, which a test pins against the compiled blueprint in
// both directions, and only the FIELD NAMES live below — keyed by the
// constructor's own name, so an unrecognised action decodes with positional
// names rather than borrowing another action's meaning.

/** Field names per constructor, by name. Anything absent decodes positionally. */
export const CURVE_FIELDS: Record<string, string[]> = {
  ActivateCurve: ['current_timestamp'],
  BuyTokens: ['token_amount', 'buyer_key_hash'],
  // `token_amount` rather than `dv_amount` so a count is found under one
  // name across all three trade actions.
  ClaimDarkVeilTokens: ['token_amount', 'salt', 'merkle_proof', 'buyer_key_hash'],
  ClaimCreatorFees: ['amount', 'platform_claim_fee'],
  ClaimPlatformFees: ['amount'],
  SellTokens: ['token_amount', 'seller_key_hash'],
  ExpireCurve: ['current_timestamp'],
  ClaimBuyback: ['token_amount', 'buyer_key_hash'],
  TriggerCTO: ['community_pub_key_hash'],
  AnchorDvAllocationRoot: ['dv_allocation_root'],
  OpenDvClaim: ['claimed_bits', 'current_timestamp'],
  BatchTrades: ['orders', 'batcher_key_hash'],
};

export const VESTING_FIELDS: Record<string, string[]> = {
  StartVesting: ['start_timestamp'],
  ClaimVested: ['claim_amount', 'current_timestamp'],
  TriggerCTO: ['community_treasury_wallet'],
};

/** Turns a name-keyed table into the index -> [name, fields] the decoder uses. */
function actionsFor(
  indices: Readonly<Record<string, number>>,
  fields: Record<string, string[]>,
): Record<number, [string, string[]]> {
  const out: Record<number, [string, string[]]> = {};
  for (const [name, index] of Object.entries(indices)) {
    out[index] = [name, fields[name] ?? []];
  }
  return out;
}

export const BONDING_CURVE_ACTIONS = actionsFor(BONDING_CURVE_REDEEMER, CURVE_FIELDS);
export const BONDING_CURVE_TIER_B_ACTIONS = actionsFor(BONDING_CURVE_TIER_B_REDEEMER, CURVE_FIELDS);
export const VESTING_ACTIONS = actionsFor(VESTING_REDEEMER, VESTING_FIELDS);

const CREATOR_ACTIONS = new Set(['ClaimCreatorFees', 'ClaimVested']);

function decodeRedeemerFields(constrValue: unknown, fieldNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(constrValue instanceof Constr)) return out;
  constrValue.fields.forEach((f: unknown, i: number) => {
    const name = fieldNames[i] ?? `field${i}`;
    out[name] = typeof f === 'bigint' ? f.toString() : String(f);
  });
  return out;
}

/**
 * Walks one script address's UTXO chain backward from a known starting
 * transaction to the genesis mint, decoding each transaction's own
 * redeemer along the way (skipping the genesis tx itself, which has no
 * redeemer — it's a mint, not a script spend).
 */
async function walkHistory(
  config: BlockfrostConfig,
  scriptAddress: string,
  startTxHash: string,
  contract: 'bonding_curve' | 'vesting',
  actionTable: Record<number, [string, string[]]>,
  /** Curve shape and datum schema for recomputing each trade's executed
   *  price. Omit for vesting, which has no price. */
  pricing: { shape: CurveShape; datumSchema: unknown } | undefined,
  /** Incremental-cache support: stop walking (without re-fetching) as soon
   *  as this tx is reached — everything from there backward is assumed
   *  already known to the caller. Omit to walk all the way to genesis. */
  stopAtTxHash?: string,
): Promise<TradeEvent[]> {
  const events: TradeEvent[] = [];
  // Which script's redeemer to read, in a transaction that may run several.
  const ownScriptHash = getAddressDetails(scriptAddress).paymentCredential?.hash;
  let currentTxHash: string | null = startTxHash;
  const seen = new Set<string>();

  while (currentTxHash && currentTxHash !== stopAtTxHash && !seen.has(currentTxHash)) {
    seen.add(currentTxHash);
    const txHash: string = currentTxHash;

    const [txMeta, utxos] = await Promise.all([
      bf<{ block_time: number }>(config, `/txs/${txHash}`),
      bf<BfTxUtxos>(config, `/txs/${txHash}/utxos`),
    ]);

    const ownInput = utxos.inputs.find((i) => i.address === scriptAddress);

    if (ownInput) {
      // This tx spent an existing UTXO at our address — decode its redeemer.
      try {
        const redeemers = await bf<BfRedeemer[]>(config, `/txs/${txHash}/redeemers`);
        // The redeemer belonging to THIS script, not merely the first spend in
        // the transaction. A batch spends the curve alongside one order UTXO
        // per fill, so "the first spend" is usually an order — and an order's
        // `ApplyOrder` is constructor 0, which read against the curve's table
        // decodes as `ActivateCurve`. Three real batches were being recorded
        // that way, with no fields and no trace of what they actually did.
        const ownRedeemer = redeemers.find((r) => r.purpose === 'spend' && r.script_hash === ownScriptHash);
        if (ownRedeemer) {
          const { cbor } = await bf<{ cbor: string }>(config, `/scripts/datum/${ownRedeemer.redeemer_data_hash}/cbor`);
          const decoded = Data.from(cbor);
          const [action, fieldNames] = actionTable[(decoded as Constr<unknown>).index] ?? ['Unknown', []];
          const fields = decodeRedeemerFields(decoded, fieldNames);
          let isCreatorTrade = false;
          if (pricing && ownInput.inline_datum && fields.token_amount !== undefined) {
            try {
              const preDatum = Data.from<CurveParams & { tokens_sold: bigint; creator_pub_key_hash: string }>(
                ownInput.inline_datum,
                pricing.datumSchema as never,
              );
              Object.assign(fields, pricedFields(pricing.shape, preDatum, action, BigInt(fields.token_amount)));
              const trader = fields.buyer_key_hash ?? fields.seller_key_hash;
              if (trader && trader === preDatum.creator_pub_key_hash) isCreatorTrade = true;
            } catch {
              // An undecodable pre-state leaves the event without a price
              // rather than carrying a guessed one.
            }
          }
          events.push({
            txHash,
            blockTime: txMeta.block_time,
            contract,
            action,
            isCreatorAction: CREATOR_ACTIONS.has(action),
            isCreatorTrade,
            fields,
            ...(decoded instanceof Constr ? { raw: decoded } : {}),
          });
        }
      } catch {
        events.push({
          txHash,
          blockTime: txMeta.block_time,
          contract,
          action: 'Unknown',
          isCreatorAction: false,
          isCreatorTrade: false,
          fields: {},
        });
      }
      currentTxHash = ownInput.tx_hash;
    } else {
      // No input at our address — this tx is the genesis (mint).
      events.push({
        txHash,
        blockTime: txMeta.block_time,
        contract,
        action: 'Mint',
        isCreatorAction: false,
        isCreatorTrade: false,
        fields: {},
      });
      currentTxHash = null;
    }
  }

  return events;
}

export interface TierATradeHistoryConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  bondingCurveAddress: string;
  /** the linear curve only (vesting.ak) — omit for Cardano Launch (bonding_curve_tier_b.ak
   *  has no vesting counterpart; both launch types vesting lives on Midnight). Only
   *  getTradeHistory() (both contracts) needs this; getCurveTradeHistory()
   *  (the trade/chart consumer) never touches it. */
  vestingAddress?: string;
  launchIdHex: string;
  /** Cardano Launch's bonding_curve_tier_b.ak has a different datum shape AND a
   *  different redeemer constructor order than the linear curve's bonding_curve.ak
   *  (see BONDING_CURVE_TIER_B_ACTIONS's own header note) — only affects
   *  getCurveTradeHistory(); getTradeHistory() (the linear curve + vesting) is
   *  unaffected. Defaults to 'A' for backward compatibility with existing
   *  callers. */
  tier?: 'A' | 'B';
}

export class TierATradeHistoryReader {
  constructor(private config: TierATradeHistoryConfig) {}

  async getTradeHistory(): Promise<TradeEvent[]> {
    const bfConfig = {
      blockfrostProjectId: this.config.blockfrostProjectId,
      blockfrostUrl: this.config.blockfrostUrl,
    };

    const [curveUtxos, vestingUtxos] = await Promise.all([
      bf<
        Array<{
          tx_hash: string;
          output_index: number;
          inline_datum: string | null;
        }>
      >(bfConfig, `/addresses/${this.config.bondingCurveAddress}/utxos`),
      this.config.vestingAddress
        ? bf<
            Array<{
              tx_hash: string;
              output_index: number;
              inline_datum: string | null;
            }>
          >(bfConfig, `/addresses/${this.config.vestingAddress}/utxos`)
        : Promise.resolve([]),
    ]);

    const findOwn = (
      utxos: Array<{ tx_hash: string; inline_datum: string | null }>,
      schema: unknown,
    ): string | null => {
      for (const u of utxos) {
        if (!u.inline_datum) continue;
        try {
          const decoded = Data.from<{ launch_id: string }>(u.inline_datum, schema as never);
          if (decoded.launch_id === this.config.launchIdHex) return u.tx_hash;
        } catch {}
      }
      return null;
    };

    const curveStartTx = findOwn(curveUtxos, BondingCurveDatumSchema);
    const vestingStartTx = findOwn(vestingUtxos, VestingDatumSchema);

    const [curveEvents, vestingEvents] = await Promise.all([
      curveStartTx
        ? walkHistory(bfConfig, this.config.bondingCurveAddress, curveStartTx, 'bonding_curve', BONDING_CURVE_ACTIONS, {
            shape: 'linear',
            datumSchema: BondingCurveDatumSchema,
          })
        : Promise.resolve([]),
      vestingStartTx && this.config.vestingAddress
        ? walkHistory(bfConfig, this.config.vestingAddress, vestingStartTx, 'vesting', VESTING_ACTIONS, undefined)
        : Promise.resolve([]),
    ]);

    return [...curveEvents, ...vestingEvents].sort((a, b) => a.blockTime - b.blockTime);
  }

  /**
   * Bonding-curve-only history, for trade/chart consumers (BuyTokens/
   * ClaimBuyback only — vesting has nothing price-relevant to chart).
   * Supports incremental walking: pass the newest tx_hash already cached
   * by the caller as `stopAtTxHash` to only fetch what's new since then,
   * ascending-sorted (oldest of the NEW events first) so the caller can
   * simply append the result to its existing cached list.
   */
  async getCurveTradeHistory(stopAtTxHash?: string): Promise<TradeEvent[]> {
    const bfConfig = {
      blockfrostProjectId: this.config.blockfrostProjectId,
      blockfrostUrl: this.config.blockfrostUrl,
    };
    const isTierB = this.config.tier === 'B';
    const datumSchema = isTierB ? BondingCurveTierBDatumSchema : BondingCurveDatumSchema;
    const actionTable = isTierB ? BONDING_CURVE_TIER_B_ACTIONS : BONDING_CURVE_ACTIONS;

    const curveUtxos = await bf<Array<{ tx_hash: string; inline_datum: string | null }>>(
      bfConfig,
      `/addresses/${this.config.bondingCurveAddress}/utxos`,
    );

    let curveStartTx: string | null = null;
    for (const u of curveUtxos) {
      if (!u.inline_datum) continue;
      try {
        const decoded = Data.from<{ launch_id: string }>(u.inline_datum, datumSchema as never);
        if (decoded.launch_id === this.config.launchIdHex) {
          curveStartTx = u.tx_hash;
          break;
        }
      } catch {}
    }

    if (!curveStartTx) return [];

    const events = await walkHistory(
      bfConfig,
      this.config.bondingCurveAddress,
      curveStartTx,
      'bonding_curve',
      actionTable,
      { shape: isTierB ? 'quadratic' : 'linear', datumSchema },
      stopAtTxHash,
    );
    return events.sort((a, b) => a.blockTime - b.blockTime);
  }
}

export type { BondingCurveDatumData, VestingDatumData };
