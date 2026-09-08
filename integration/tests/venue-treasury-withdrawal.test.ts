// venue-treasury-withdrawal.test.ts — do the two redeemers name the input the
// transaction actually ended up with, and does the pool come out whole?
//
// A collection runs two scripts over one pool, and BOTH resolve that pool by
// POSITION in an input list the builder sorts. A transaction whose inputs came
// out the other way round is still well formed: both scripts run, each against
// the wrong input, and the node reports a script exiting early without naming
// either. So there are two fixtures below differing only in which UTXO sorts
// first — a prediction that is right in one order and wrong in the other
// passes half the time, which is worse than being wrong.
//
// The other thing worth more than the rest of this file: **the top-up is not a
// cost.** A payout carrying tokens needs the protocol's minimum lovelace to
// exist, which a small ADA counter cannot always cover, so the platform adds
// the difference from its own wallet — and receives it back in the same
// output, in the same transaction. The ledger's net figure has to be blind to
// it, and one test holds the two modules to that together.
//
// Everything is offline, against the real compiled validators. The node
// decides whether a transaction is accepted; this decides what it says.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialToAddress, credentialToRewardAddress, Data } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE, venueCollectionAdvice } from '../venue-fee-ledger.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import { VENUE_POOL_ACTION, type VenuePoolUtxo, venuePoolRedeemer } from '../venue-swap.js';
import {
  planVenueTreasuryWithdrawal,
  VENUE_TREASURY_PAYOUT_FLOOR_LOVELACE,
  VENUE_TREASURY_POOL_EXECUTION_UNITS,
  VENUE_TREASURY_WITHDRAW_EXECUTION_UNITS,
  VenueTreasuryWithdrawer,
  venueFundingUtxos,
  venueTreasuryCredentialOf,
  venueTreasuryWithdrawRedeemer,
} from '../venue-treasury-withdrawal.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string }>;
}
function load(file: string): Blueprint {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', file), 'utf8'));
}
function pick(blueprint: Blueprint, title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from the venue blueprint`);
  return found;
}

// The pool as it is actually deployed, applied with its parameter. The
// treasury validator is taken from the blueprint instead: applying its own
// parameters changes its hash and therefore its reward address, and nothing
// else this file checks — the transaction's shape is the same either way.
const POOL = pick(load(join('deployment', 'applied.json')), 'royalty_pool/pool.pool.spend');
const TREASURY = pick(load('plutus.json'), 'royalty_pool/treasury.treasury.withdraw');
const POOL_HASH = scriptHashOf(POOL.compiledCode);
const TREASURY_HASH = scriptHashOf(TREASURY.compiledCode);
const POOL_ADDRESS = scriptAddressOf(POOL.compiledCode, 0);
const POOL_REF_TX = 'a1'.repeat(32);
const TREASURY_REF_TX = 'a3'.repeat(32);

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const USDM_POLICY = 'cc'.repeat(28);
const USDM = `${USDM_POLICY}55534444`;
const MAX_LQ = 0x7fffffffffffffffn;

const PLATFORM = 'ee'.repeat(28);
const PLATFORM_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: PLATFORM });
const OPS_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '11'.repeat(28) });
const REWARD_ADDRESS = credentialToRewardAddress('Preprod', { type: 'Script', hash: TREASURY_HASH });

/** The pool defers its treasury action to entry 0, written by the factory. */
const DAO_POLICY = [
  { StakingHash: [{ ScriptCredential: [TREASURY_HASH] }] },
  { StakingHash: [{ ScriptCredential: ['dd'.repeat(28)] }] },
] as unknown as VenuePoolConfigData['dao_policy'];

function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 3_000_000n,
    treasury_y: 50_000n,
    royalty_x: 10_000_000n,
    royalty_y: 500_000n,
    dao_policy: DAO_POLICY,
    treasury_address: PLATFORM,
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 7n,
    ...over,
  };
}

function pool(txHash = '0a'.repeat(32), over: Partial<VenuePoolConfigData> = {}): VenuePoolUtxo {
  return {
    txHash,
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: {
      lovelace: 20_000_000_000n,
      [TOKEN]: 200_000_000n,
      [LQ]: MAX_LQ - 1_000_000_000n,
      [POOL_NFT]: 1n,
    },
    datum: poolDatum(over),
  };
}

function walletUtxo(txHash: string, lovelace: string, extra: Array<{ unit: string; quantity: string }> = []): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: OPS_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }, ...extra] },
  };
}

function fakeWallet(over: Partial<CurveSpendWallet> = {}): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(OPS_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), '500000000')]),
    getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), '5000000')]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('submitted-hash'),
    ...over,
  };
}

function withdrawer(opts: { carry?: boolean; authority?: string | null } = {}) {
  return new VenueTreasuryWithdrawer({
    network: 'preprod',
    poolScript: opts.carry
      ? { embeddedScriptCbor: POOL.compiledCode }
      : {
          compiledScriptCbor: POOL.compiledCode,
          referenceScript: { txHash: POOL_REF_TX, outputIndex: 0, scriptHash: POOL_HASH },
        },
    treasuryScript: opts.carry
      ? { embeddedScriptCbor: TREASURY.compiledCode }
      : {
          compiledScriptCbor: TREASURY.compiledCode,
          referenceScript: { txHash: TREASURY_REF_TX, outputIndex: 0, scriptHash: TREASURY_HASH },
        },
    ...(opts.authority === null ? {} : { authorityKeyHash: opts.authority ?? PLATFORM }),
    provider: {
      fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
      evaluateTx: vi.fn().mockResolvedValue([
        { tag: 'SPEND', index: 0, budget: VENUE_TREASURY_POOL_EXECUTION_UNITS },
        { tag: 'REWARD', index: 0, budget: VENUE_TREASURY_WITHDRAW_EXECUTION_UNITS },
      ]),
    },
  });
}

function plan(poolUtxo = pool(), over: Parameters<typeof planVenueTreasuryWithdrawal>[0] | null = null) {
  return planVenueTreasuryWithdrawal({ pool: poolUtxo, network: 'preprod', ...(over ?? {}) });
}

function inputsOf(txHex: string): Array<{ txHash: string; index: number }> {
  return deserializeTx(txHex)
    .body()
    .inputs()
    .toCore()
    .map((i) => ({ txHash: String(i.txId), index: Number(i.index) }));
}

// ---------------------------------------------------------------------------

describe('planning the collection', () => {
  it('takes everything accrued to the platform by default, and nothing else', () => {
    const p = plan();
    expect(p.takeX).toBe(3_000_000n);
    expect(p.takeY).toBe(50_000n);
    expect(p.nextDatum.treasury_x).toBe(0n);
    expect(p.nextDatum.treasury_y).toBe(0n);
    // The creator's counters, the fee schedule and the nonce are untouched:
    // the pool validator pins every other field, and moving the nonce would
    // cancel a royalty claim the creator had already signed.
    expect(p.nextDatum.royalty_x).toBe(10_000_000n);
    expect(p.nextDatum.royalty_y).toBe(500_000n);
    expect(p.nextDatum.treasury_fee).toBe(100n);
    expect(p.nextDatum.nonce).toBe(7n);
  });

  it('moves the pool’s value by exactly the counter movement', () => {
    const p = plan();
    expect(p.nextAssets.lovelace).toBe(20_000_000_000n - 3_000_000n);
    expect(p.nextAssets[TOKEN]).toBe(200_000_000n - 50_000n);
    // The reserves are unchanged, which is why a collection never moves the
    // price: both counters were already outside them.
    expect(p.nextAssets[LQ]).toBe(MAX_LQ - 1_000_000_000n);
    expect(p.nextAssets[POOL_NFT]).toBe(1n);
  });

  it('pays the address the pool’s own datum names, exactly on the token side', () => {
    const p = plan();
    expect(p.payoutAddress).toBe(PLATFORM_ADDRESS);
    expect(p.payoutAssets[TOKEN]).toBe(50_000n);
    expect(p.payoutAssets.lovelace).toBe(3_000_000n);
    expect(p.topUpLovelace).toBe(0n);
  });

  it('takes a part when asked for one', () => {
    const p = plan(pool(), { pool: pool(), network: 'preprod', takeX: 1_000_000n, takeY: 0n });
    expect(p.nextDatum.treasury_x).toBe(2_000_000n);
    expect(p.nextDatum.treasury_y).toBe(50_000n);
    expect(p.payoutAssets[TOKEN]).toBeUndefined();
  });

  it('can pay to a base address, so the collected ada can be staked', () => {
    const stake = '99'.repeat(28);
    const p = plan(pool(), { pool: pool(), network: 'preprod', payoutStakePkh: stake });
    expect(p.payoutAddress).toBe(
      credentialToAddress('Preprod', { type: 'Key', hash: PLATFORM }, { type: 'Key', hash: stake }),
    );
  });
});

describe('the top-up, which is not a cost', () => {
  it('lifts a small payout to where it can exist, out of the platform’s own wallet', () => {
    const p = plan(pool('0a'.repeat(32), { treasury_x: 100n, treasury_y: 50_000n }));
    expect(p.payoutAssets.lovelace).toBe(VENUE_TREASURY_PAYOUT_FLOOR_LOVELACE);
    expect(p.topUpLovelace).toBe(VENUE_TREASURY_PAYOUT_FLOOR_LOVELACE - 100n);
    // The pool released 100 lovelace and no more. `treasury.ak` states the ada
    // side as `paid >= -delta` for exactly this: the surplus provably came
    // from the platform rather than the pool.
    expect(p.nextAssets.lovelace).toBe(20_000_000_000n - 100n);
  });

  it('leaves the ledger’s net figure untouched, because it comes straight back', () => {
    const thin = pool('0a'.repeat(32), { treasury_x: 100n, treasury_y: 50_000n });
    const advice = venueCollectionAdvice({ pool: thin });
    const p = plan(thin);
    expect(p.topUpLovelace).toBeGreaterThan(0n);
    // Net is the ada counter less the fee. The top-up appears nowhere in it.
    expect(advice.netLovelace).toBe(100n - VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
  });

  it('adds lovelace to a token-to-token payout, none of which came from the pool', () => {
    const t2t = pool('0a'.repeat(32), {
      pool_x: { policy: USDM_POLICY, name: '55534444' },
      pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
      treasury_x: 3_000n,
      treasury_y: 40_000n,
    });
    t2t.assets = { lovelace: 5_000_000n, [USDM]: 40_000_000n, [TOKEN]: 200_000_000n, [LQ]: MAX_LQ, [POOL_NFT]: 1n };
    const p = plan(t2t);
    expect(p.topUpLovelace).toBe(VENUE_TREASURY_PAYOUT_FLOOR_LOVELACE);
    expect(p.payoutAssets[USDM]).toBe(3_000n);
    expect(p.payoutAssets[TOKEN]).toBe(40_000n);
    // The pool's own lovelace is not one of its reserves here, and the pool
    // validator requires it to be untouched.
    expect(p.nextAssets.lovelace).toBe(5_000_000n);
  });
});

describe('what a plan refuses', () => {
  it('refuses a withdrawal that moves nothing', () => {
    expect(() => plan(pool(), { pool: pool(), network: 'preprod', takeX: 0n, takeY: 0n })).toThrow(/moves nothing/);
  });

  it('refuses to take more than has accrued', () => {
    expect(() => plan(pool(), { pool: pool(), network: 'preprod', takeX: 3_000_001n })).toThrow(/has accrued/);
  });

  it('refuses a negative take', () => {
    expect(() => plan(pool(), { pool: pool(), network: 'preprod', takeX: -1n })).toThrow(/non-negative/);
  });

  it('refuses a datum claiming more than the utxo holds', () => {
    const broken = pool('0a'.repeat(32), { treasury_x: 30_000_000_000n });
    expect(() => plan(broken)).toThrow(/claiming more than the UTXO carries/);
  });

  it('refuses a treasury address that is not a payment key hash', () => {
    // The factory writes this field; a pool carrying anything else there names
    // an address that cannot be paid, and no collection is possible from it.
    expect(() => plan(pool('0a'.repeat(32), { treasury_address: 'ee'.repeat(57) }))).toThrow(
      /not a 28-byte payment key hash/,
    );
  });
});

describe('reading the pool’s own treasury credential', () => {
  it('finds the script the pool defers to, which is entry zero', () => {
    expect(venueTreasuryCredentialOf(poolDatum())).toBe(TREASURY_HASH);
  });

  it('is nothing when the datum names no script there', () => {
    expect(venueTreasuryCredentialOf(poolDatum({ dao_policy: [] }))).toBeNull();
  });
});

describe('building the transaction', () => {
  it('spends the pool under action 3, the arm that defers to the treasury script', async () => {
    const built = await withdrawer().build(plan(), fakeWallet());
    const redeemers = deserializeTx(built).witnessSet().redeemers()?.values() ?? [];
    const spend = redeemers.find((r) => Number(r.tag()) === 0);
    const poolIx = inputsOf(built).findIndex((i) => i.txHash === '0a'.repeat(32));
    expect(spend?.data().toCbor()).toBe(venuePoolRedeemer(VENUE_POOL_ACTION.DAOAction, poolIx));
  });

  it('carries a withdrawal at the treasury script, which is what runs it', async () => {
    const built = await withdrawer().build(plan(), fakeWallet());
    const withdrawals = deserializeTx(built).body().withdrawals();
    // Keyed by the stake address of the script's own credential — a withdrawal
    // at anything else would run nothing, and the pool requires this one.
    expect([...(withdrawals?.keys() ?? [])].map(String)).toEqual([REWARD_ADDRESS]);
    expect([...(withdrawals?.values() ?? [])].map(String)).toEqual(['0']);
    expect(withdrawer().rewardAddress()).toBe(REWARD_ADDRESS);
    expect(withdrawer().treasuryHash()).toBe(TREASURY_HASH);
  });

  it('names the pool’s real sorted position in BOTH redeemers', async () => {
    const built = await withdrawer().build(plan(), fakeWallet());
    const poolIx = inputsOf(built).findIndex((i) => i.txHash === '0a'.repeat(32));
    const redeemers = deserializeTx(built).witnessSet().redeemers()?.values() ?? [];
    const spend = redeemers.find((r) => Number(r.tag()) === 0);
    const reward = redeemers.find((r) => Number(r.tag()) === 3);
    expect(spend?.data().toCbor()).toBe(venuePoolRedeemer(VENUE_POOL_ACTION.DAOAction, poolIx));
    expect(reward?.data().toCbor()).toBe(venueTreasuryWithdrawRedeemer(poolIx, 1));
  });

  // The pool tx hash is the only thing these two differ by: one sorts before
  // the funding UTXO's `11…`, the other after. A prediction that is right in
  // one order and wrong in the other passes half the time.
  for (const [where, poolTxHash] of [
    ['first', '0a'.repeat(32)],
    ['second', '2a'.repeat(32)],
  ] as const) {
    it(`finds the pool when it sorts ${where}`, async () => {
      const built = await withdrawer().build(plan(pool(poolTxHash)), fakeWallet());
      const inputs = inputsOf(built);
      const poolIx = inputs.findIndex((i) => i.txHash === poolTxHash);
      expect(poolIx).toBe(where === 'first' ? 0 : 1);
      const redeemers = deserializeTx(built).witnessSet().redeemers()?.values() ?? [];
      expect(
        redeemers
          .find((r) => Number(r.tag()) === 3)
          ?.data()
          .toCbor(),
      ).toBe(venueTreasuryWithdrawRedeemer(poolIx, 1));
    });
  }

  it('places the pool’s successor first and the payout second, where the redeemer says', async () => {
    const built = await withdrawer().build(plan(), fakeWallet());
    const outputs = deserializeTx(built).body().outputs();
    expect(outputs[0]?.address().toBech32()).toBe(POOL_ADDRESS);
    expect(outputs[0]?.datum()?.asInlineData()?.toCbor()).toBe(Data.to(plan().nextDatum, VenuePoolConfigSchema));
    expect(outputs[1]?.address().toBech32()).toBe(PLATFORM_ADDRESS);
  });

  it('declares the platform’s key, which is what extra_signatories reads', async () => {
    const built = await withdrawer().build(plan(), fakeWallet());
    const signers = deserializeTx(built).body().requiredSigners();
    expect((signers?.toCore() ?? []).map(String)).toContain(PLATFORM);
  });

  it('declares no signer for a script authority, which authorises by its own withdrawal', async () => {
    const built = await withdrawer({ authority: null }).build(plan(), fakeWallet());
    expect(deserializeTx(built).body().requiredSigners()?.toCore() ?? []).toHaveLength(0);
  });

  it('builds the same transaction with the validators carried instead of referenced', async () => {
    const built = await withdrawer({ carry: true }).build(plan(), fakeWallet());
    expect(inputsOf(built)).toHaveLength(2);
    expect(deserializeTx(built).body().withdrawals()).toBeDefined();
  });

  it('signs and submits', async () => {
    const wallet = fakeWallet();
    expect(await withdrawer().submit(plan(), wallet)).toBe('submitted-hash');
    expect(wallet.signTx).toHaveBeenCalledTimes(1);
  });
});

describe('what a collection actually costs', () => {
  // The ONE cost of a collection, and the figure every decision in
  // `venue-fee-ledger.ts` turns on. Pinned against a real built transaction so
  // a change to either validator, to the declared budgets, or to the
  // protocol's fee parameters fails here rather than quietly shifting what the
  // ledger advises collecting.
  it('costs one network fee on an ada pool, and the ledger’s constant covers it', async () => {
    const built = await withdrawer().build(plan(), fakeWallet());
    expect(deserializeTx(built).body().fee()).toBe(412_895n);
  });

  it('costs no more on a token-to-token pool, which is the dearer shape', async () => {
    const t2t = pool('0a'.repeat(32), {
      pool_x: { policy: USDM_POLICY, name: '55534444' },
      pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
      treasury_x: 3_000n,
      treasury_y: 40_000n,
    });
    t2t.assets = { lovelace: 5_000_000n, [USDM]: 40_000_000n, [TOKEN]: 200_000_000n, [LQ]: MAX_LQ, [POOL_NFT]: 1n };
    const built = await withdrawer().build(plan(t2t), fakeWallet());
    expect(deserializeTx(built).body().fee()).toBe(417_691n);
    expect(417_691n).toBeLessThanOrEqual(VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
  });

  it('costs more with the validators carried than referenced, which is why they are referenced', async () => {
    const referenced = deserializeTx(await withdrawer().build(plan(), fakeWallet()))
      .body()
      .fee();
    const carried = deserializeTx(await withdrawer({ carry: true }).build(plan(), fakeWallet()))
      .body()
      .fee();
    expect(carried).toBeGreaterThan(referenced);
  });
});

describe('what the builder refuses', () => {
  it('refuses a pool that defers to a different treasury script', async () => {
    // Well formed, both scripts run, and the pool never sees the withdrawal it
    // required — refused at the node for a reason naming neither.
    const stranger = pool('0a'.repeat(32), {
      dao_policy: [
        { StakingHash: [{ ScriptCredential: ['ab'.repeat(28)] }] },
      ] as unknown as VenuePoolConfigData['dao_policy'],
    });
    await expect(withdrawer().build(plan(stranger), fakeWallet())).rejects.toThrow(/defers its treasury action to/);
  });

  it('refuses a pool sitting at another validator’s address', async () => {
    const elsewhere = { ...pool(), address: OPS_ADDRESS };
    await expect(withdrawer().build(plan(elsewhere), fakeWallet())).rejects.toThrow(/would need the validator/);
  });

  it('refuses a wallet with no collateral', async () => {
    const wallet = fakeWallet({ getCollateral: vi.fn().mockResolvedValue([]) });
    await expect(withdrawer().build(plan(), wallet)).rejects.toThrow(/no collateral/);
  });

  it('says the pool cannot fund the transaction when the wallet cannot either', async () => {
    const wallet = fakeWallet({ getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), '1000000')]) });
    await expect(withdrawer().build(plan(), wallet)).rejects.toThrow(/pool cannot pay for it/);
  });
});

describe('choosing what funds the transaction', () => {
  it('never offers the collateral to funding as well, which would spend it twice', async () => {
    // The only UTXO big enough is the collateral. Left in, the builder would
    // put the same UTXO in two places in one transaction.
    const wallet = fakeWallet({
      getUtxos: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), '5000000')]),
      getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), '5000000')]),
    });
    await expect(withdrawer().build(plan(), wallet)).rejects.toThrow(/pool cannot pay for it/);
  });

  it('prefers pure-lovelace utxos, so a collection does not shuffle token holdings', () => {
    const chosen = venueFundingUtxos(
      [
        walletUtxo('01'.repeat(32), '20000000', [{ unit: TOKEN, quantity: '5' }]),
        walletUtxo('02'.repeat(32), '10000000'),
      ],
      5_000_000n,
    );
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.input.txHash).toBe('02'.repeat(32));
  });

  it('takes the largest first, so the fewest inputs meet the target', () => {
    const chosen = venueFundingUtxos(
      [walletUtxo('01'.repeat(32), '2000000'), walletUtxo('02'.repeat(32), '9000000')],
      5_000_000n,
    );
    expect(chosen.map((u) => u.input.txHash)).toEqual(['02'.repeat(32)]);
  });

  it('takes more than one when it has to', () => {
    const chosen = venueFundingUtxos(
      [walletUtxo('01'.repeat(32), '3000000'), walletUtxo('02'.repeat(32), '3000000')],
      5_000_000n,
    );
    expect(chosen).toHaveLength(2);
  });
});
