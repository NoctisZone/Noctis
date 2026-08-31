// Tests for tier-a-trade-history-reader.ts — the walk that turns a chain of
// script spends back into a trade feed.
//
// Two failure modes here have already happened for real, and both are silent:
// the feed still renders, it just says the wrong thing.
//
//   1. Redeemer index drift. Actions are decoded by CONSTRUCTOR INDEX, so
//      removing one variant shifts every later one down. A real SellTokens
//      then decodes as a fee claim. The indices now come from
//      redeemer-indices.ts (pinned elsewhere against the compiled blueprint)
//      and only field NAMES live in this module — asserted below.
//
//   2. Picking the wrong redeemer in a multi-script transaction. A batch
//      spends the curve alongside one order UTXO per fill, and an order's
//      ApplyOrder is constructor 0 — which, read against the curve's table,
//      decodes as ActivateCurve with no fields. Three real batches were
//      recorded that way. The walk must select by script hash.
//
// Datums are built with the real genesis builder and real Lucid encoders
// rather than hand-written hex, so a schema change breaks these honestly
// instead of leaving a fixture that agrees only with itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Constr, credentialToAddress, Data, type Data as LucidData } from '@lucid-evolution/lucid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BONDING_CURVE_REDEEMER } from '../redeemer-indices.js';
import { buildGenesisDatums } from '../tier-a-genesis-datums.js';
import {
  BONDING_CURVE_ACTIONS,
  BONDING_CURVE_TIER_B_ACTIONS,
  CURVE_FIELDS,
  TierATradeHistoryReader,
  VESTING_ACTIONS,
} from '../tier-a-trade-history-reader.js';

const blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

const CREATOR = 'aa'.repeat(28);
const BUYER = '11'.repeat(28);
const LAUNCH_ID = Buffer.from('TEST').toString('hex');

// The address is DERIVED from the script hash rather than pasted in, so the
// pair cannot drift apart and the walk's own getAddressDetails call recovers
// exactly the hash these fixtures claim.
const SCRIPT_HASH = '77'.repeat(28);
const CURVE_ADDR = credentialToAddress('Preprod', { type: 'Script', hash: SCRIPT_HASH });
const OTHER_ADDR = credentialToAddress('Preprod', { type: 'Script', hash: '99'.repeat(28) });

async function curveDatum() {
  const g = await buildGenesisDatums({
    blueprint,
    network: 'preprod' as const,
    creatorPubKeyHashHex: CREATOR,
    governorPubKeyHashHex: 'cc'.repeat(28),
    treasuryPubKeyHashHex: 'dd'.repeat(28),
    opsPubKeyHashHex: 'ee'.repeat(28),
    tokenPolicyIdHex: 'bb'.repeat(28),
    tokenBaseNameHex: LAUNCH_ID,
    tokenName: 'Test Token',
    tokenDescription: 'A launch built only to drive the history reader.',
    threadNftPolicyIdHex: 'ff'.repeat(28),
    basePrice: 3,
    maxPrice: 75,
    vestDays: 90,
    genesisTimestampMs: 1_785_000_000_000,
  });
  return { hex: g.datums.bondingCurve, launchId: g.launchIdHex ?? LAUNCH_ID };
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

interface Tx {
  hash: string;
  blockTime: number;
  /** Absent = genesis: no input at the script address, so the walk stops. */
  spends?: string;
  inlineDatum?: string;
  redeemers?: Array<{ purpose: string; script_hash: string; redeemer_data_hash: string }>;
  redeemerCbor?: Record<string, string>;
}

/**
 * A fetch that answers from a chain of transactions, keyed by URL — the same
 * endpoints walkHistory really calls, in whatever order it calls them.
 */
function chainFetch(utxos: Array<{ tx_hash: string; inline_datum: string | null }>, txs: Tx[]) {
  const byHash = new Map(txs.map((t) => [t.hash, t]));
  return vi.fn(async (url: string) => {
    if (url.includes('/utxos') && url.includes('/addresses/')) return json(utxos);

    // Readable names rather than 64 hex chars, so a failure says which
    // transaction it was on.
    const txMatch = url.match(/\/txs\/(\w+)(\/[a-z]+)?/);
    if (txMatch) {
      const tx = byHash.get(txMatch[1]);
      if (!tx) return { ok: false, status: 404, json: async () => ({}), text: async () => 'no tx' };
      if (txMatch[2] === '/utxos') {
        return json({
          inputs: tx.spends
            ? [{ address: CURVE_ADDR, tx_hash: tx.spends, output_index: 0, inline_datum: tx.inlineDatum ?? null }]
            : [{ address: OTHER_ADDR, tx_hash: 'x', output_index: 0, inline_datum: null }],
          outputs: [],
        });
      }
      if (txMatch[2] === '/redeemers') return json(tx.redeemers ?? []);
      return json({ block_time: tx.blockTime });
    }

    const datumMatch = url.match(/\/scripts\/datum\/(\w+)\/cbor/);
    if (datumMatch) {
      const owner = txs.find((t) => t.redeemerCbor?.[datumMatch[1]]);
      const cbor = owner?.redeemerCbor?.[datumMatch[1]];
      if (!cbor) return { ok: false, status: 404, json: async () => ({}), text: async () => 'no datum' };
      return json({ cbor });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

/** A redeemer as Lucid encodes it, so the decoder reads real bytes. */
const redeemerCbor = (index: number, fields: LucidData[]) => Data.to(new Constr(index, fields));

function reader(tier: 'A' | 'B' = 'A') {
  return new TierATradeHistoryReader({
    blockfrostProjectId: 'k',
    blockfrostUrl: 'https://bf.test',
    bondingCurveAddress: CURVE_ADDR,
    launchIdHex: LAUNCH_ID,
    tier,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('action tables', () => {
  it('keys every curve action by its real constructor index', () => {
    // The drift bug: these indices come from redeemer-indices.ts, which is
    // pinned against the compiled blueprint. If a table were rebuilt by hand
    // the names below would move.
    for (const [name, index] of Object.entries(BONDING_CURVE_REDEEMER)) {
      expect(BONDING_CURVE_ACTIONS[index][0]).toBe(name);
    }
  });

  it('gives every named curve action its field list', () => {
    for (const [index, [name, fields]] of Object.entries(BONDING_CURVE_ACTIONS)) {
      if (CURVE_FIELDS[name]) expect(fields).toEqual(CURVE_FIELDS[name]);
      expect(Number(index)).toBeGreaterThanOrEqual(0);
    }
  });

  it('names the token count `token_amount` across every trade action', () => {
    // One name for a count across buy, sell and DarkVeil claim, so a consumer
    // does not have to know which action it is looking at to find the amount.
    for (const action of ['BuyTokens', 'SellTokens', 'ClaimDarkVeilTokens', 'ClaimBuyback']) {
      expect(CURVE_FIELDS[action][0]).toBe('token_amount');
    }
  });

  it('keeps both Cardano curves tables separate', () => {
    // Cardano Launch's constructor order genuinely differs; a shared table would
    // mislabel one of them.
    expect(BONDING_CURVE_TIER_B_ACTIONS).not.toEqual(BONDING_CURVE_ACTIONS);
  });

  it('builds the vesting table from vesting field names', () => {
    const names = Object.values(VESTING_ACTIONS).map(([n]) => n);
    expect(names).toContain('ClaimVested');
  });
});

describe('getCurveTradeHistory', () => {
  it('returns nothing when no UTXO carries this launch id', async () => {
    vi.stubGlobal('fetch', chainFetch([], []));

    expect(await reader().getCurveTradeHistory()).toEqual([]);
  });

  it('skips a UTXO whose datum cannot be decoded rather than throwing', async () => {
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    vi.stubGlobal(
      'fetch',
      chainFetch(
        [
          { tx_hash: 'aa', inline_datum: 'deadbeef' }, // undecodable
          { tx_hash: 'bb', inline_datum: null }, // no datum at all
          { tx_hash: 'cc', inline_datum: hex }, // the real one
        ],
        [{ hash: 'cc', blockTime: 100 }],
      ),
    );

    const events = await r.getCurveTradeHistory();

    expect(events).toHaveLength(1);
    expect(events[0].txHash).toBe('cc');
  });

  it('records the genesis transaction as a Mint and stops there', async () => {
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    vi.stubGlobal(
      'fetch',
      chainFetch([{ tx_hash: 'genesis', inline_datum: hex }], [{ hash: 'genesis', blockTime: 5 }]),
    );

    const events = await r.getCurveTradeHistory();

    expect(events).toEqual([
      expect.objectContaining({ txHash: 'genesis', action: 'Mint', contract: 'bonding_curve', blockTime: 5 }),
    ]);
  });

  it('decodes a buy, prices it from the pre-trade datum, and walks to genesis', async () => {
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    const cbor = redeemerCbor(BONDING_CURVE_REDEEMER.BuyTokens, [1000n, BUYER]);
    vi.stubGlobal(
      'fetch',
      chainFetch(
        [{ tx_hash: 'buy1', inline_datum: hex }],
        [
          {
            hash: 'buy1',
            blockTime: 200,
            spends: 'genesis',
            inlineDatum: hex,
            redeemers: [{ purpose: 'spend', script_hash: SCRIPT_HASH, redeemer_data_hash: 'curveHash' }],
            redeemerCbor: { curveHash: cbor },
          },
          { hash: 'genesis', blockTime: 100 },
        ],
      ),
    );

    const events = await r.getCurveTradeHistory();

    // Ascending by block time: genesis first.
    expect(events.map((e) => e.action)).toEqual(['Mint', 'BuyTokens']);
    const buy = events[1];
    expect(buy.fields.token_amount).toBe('1000');
    expect(buy.fields.buyer_key_hash).toBe(BUYER);
    // The price is recomputed, not read — the redeemer carries no price field.
    expect(buy.fields.gross_lovelace).toBeDefined();
    expect(BigInt(buy.fields.gross_lovelace)).toBeGreaterThan(0n);
    expect(buy.isCreatorTrade).toBe(false);
  });

  it('picks the redeemer belonging to this script, not the first spend', async () => {
    // The batch bug: an order's ApplyOrder is constructor 0, which read
    // against the curve's table decodes as ActivateCurve with no fields.
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    vi.stubGlobal(
      'fetch',
      chainFetch(
        [{ tx_hash: 'batch1', inline_datum: hex }],
        [
          {
            hash: 'batch1',
            blockTime: 300,
            spends: 'genesis',
            inlineDatum: hex,
            redeemers: [
              // An unrelated order script spending in the same transaction,
              // listed FIRST.
              { purpose: 'spend', script_hash: '99'.repeat(28), redeemer_data_hash: 'order' },
              { purpose: 'spend', script_hash: SCRIPT_HASH, redeemer_data_hash: 'curve' },
            ],
            redeemerCbor: {
              order: redeemerCbor(0, []),
              curve: redeemerCbor(BONDING_CURVE_REDEEMER.BuyTokens, [500n, BUYER]),
            },
          },
          { hash: 'genesis', blockTime: 100 },
        ],
      ),
    );

    const events = await r.getCurveTradeHistory();
    const trade = events.find((e) => e.txHash === 'batch1');

    expect(trade?.action).toBe('BuyTokens');
    expect(trade?.fields.token_amount).toBe('500');
  });

  it('flags a trade made by the creator', async () => {
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    vi.stubGlobal(
      'fetch',
      chainFetch(
        [{ tx_hash: 'cbuy', inline_datum: hex }],
        [
          {
            hash: 'cbuy',
            blockTime: 200,
            spends: 'genesis',
            inlineDatum: hex,
            redeemers: [{ purpose: 'spend', script_hash: SCRIPT_HASH, redeemer_data_hash: 'curveHash' }],
            redeemerCbor: { curveHash: redeemerCbor(BONDING_CURVE_REDEEMER.BuyTokens, [10n, CREATOR]) },
          },
          { hash: 'genesis', blockTime: 100 },
        ],
      ),
    );

    const events = await r.getCurveTradeHistory();

    expect(events.find((e) => e.txHash === 'cbuy')?.isCreatorTrade).toBe(true);
  });

  it('records an event with no redeemer for this script as nothing at all', async () => {
    // A transaction that spent our UTXO but whose redeemer belongs to another
    // script contributes no event — it is not invented as Unknown.
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    vi.stubGlobal(
      'fetch',
      chainFetch(
        [{ tx_hash: 'odd', inline_datum: hex }],
        [
          {
            hash: 'odd',
            blockTime: 300,
            spends: 'genesis',
            inlineDatum: hex,
            redeemers: [{ purpose: 'spend', script_hash: '99'.repeat(28), redeemer_data_hash: 'x' }],
            redeemerCbor: { x: redeemerCbor(0, []) },
          },
          { hash: 'genesis', blockTime: 100 },
        ],
      ),
    );

    const events = await r.getCurveTradeHistory();

    expect(events.map((e) => e.txHash)).toEqual(['genesis']);
  });

  it('marks an event Unknown when the redeemer cannot be fetched', async () => {
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    vi.stubGlobal(
      'fetch',
      chainFetch(
        [{ tx_hash: 'broken', inline_datum: hex }],
        [
          {
            hash: 'broken',
            blockTime: 300,
            spends: 'genesis',
            inlineDatum: hex,
            redeemers: [{ purpose: 'spend', script_hash: SCRIPT_HASH, redeemer_data_hash: 'missing' }],
            // No redeemerCbor entry -> the datum fetch 404s.
          },
          { hash: 'genesis', blockTime: 100 },
        ],
      ),
    );

    const events = await r.getCurveTradeHistory();

    expect(events.find((e) => e.txHash === 'broken')?.action).toBe('Unknown');
  });

  it('stops at stopAtTxHash without fetching anything older', async () => {
    const { hex, launchId } = await curveDatum();
    const r = new TierATradeHistoryReader({
      blockfrostProjectId: 'k',
      blockfrostUrl: 'https://bf.test',
      bondingCurveAddress: CURVE_ADDR,
      launchIdHex: launchId,
      tier: 'A',
    });
    const f = chainFetch(
      [{ tx_hash: 'newest', inline_datum: hex }],
      [
        {
          hash: 'newest',
          blockTime: 400,
          spends: 'older',
          inlineDatum: hex,
          redeemers: [{ purpose: 'spend', script_hash: SCRIPT_HASH, redeemer_data_hash: 'curveHash' }],
          redeemerCbor: { curveHash: redeemerCbor(BONDING_CURVE_REDEEMER.BuyTokens, [1n, BUYER]) },
        },
        { hash: 'older', blockTime: 200 },
      ],
    );
    vi.stubGlobal('fetch', f);

    const events = await r.getCurveTradeHistory('older');

    expect(events.map((e) => e.txHash)).toEqual(['newest']);
    // The incremental promise: nothing older was even requested.
    expect(f.mock.calls.some((c) => (c[0] as string).includes('/txs/older'))).toBe(false);
  });
});
