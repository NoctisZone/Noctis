// venue-cancel-submitter.test.ts — does the transaction DECLARE the key, and
// does the money go where the order said?
//
// `Cancel -> list.has(self.extra_signatories, cfg.reward_pkh)` reads the
// transaction's REQUIRED SIGNERS, not its witnesses. A cancel that is properly
// signed but never declares the key hands the script an empty list, and it is
// refused at the node for a reason that names nothing — so the declaration is
// decoded out of the finished transaction here rather than assumed.
//
// The other half is the destination. A cancel returns the funds to the address
// the ORDER names, which was fixed when the order was written, rather than to
// whatever address the signing wallet offers at the end. The wallet below
// deliberately hands back a different address, so a cancel that used it would
// be visible.
//
// Everything is offline, against the real compiled validator. The node decides
// whether a transaction is accepted; this decides whether it means what it says.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialToAddress } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { scriptAddressOf, scriptHashOf } from '../reference-script.js';
import {
  VENUE_CANCEL_EXECUTION_UNITS,
  VenueCanceller,
  venueCancelDestination,
  venueCancelSigners,
} from '../venue-cancel-submitter.js';
import { type VenueSwapConfigData, type VenueSwapOrderUtxo, venueCancelRedeemer } from '../venue-swap.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string }>;
}
const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'plutus.json'), 'utf8'),
);
function pick(title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from the venue blueprint`);
  return found;
}
const ORDER = pick('royalty_pool/swap_order.swap_order.spend');
const ORDER_HASH = scriptHashOf(ORDER.compiledCode);
const ORDER_ADDRESS = scriptAddressOf(ORDER.compiledCode, 0);
const ORDER_REF_TX = 'a2'.repeat(32);

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const TOKEN_POLICY = 'bb'.repeat(28);
const PLACER = '0d'.repeat(28);
const OTHER_PLACER = '0e'.repeat(28);
const PLACER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: PLACER });
// Deliberately not the placer's: a cancel that used the wallet's change
// address instead of the order's own would land here and be visible.
const WALLET_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '11'.repeat(28) });

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
    stake_pkh: null,
    permitted_executors: [],
    ...over,
  };
}

function order(txHash: string, datum: VenueSwapConfigData = swapDatum()): VenueSwapOrderUtxo {
  return {
    txHash,
    outputIndex: 0,
    address: ORDER_ADDRESS,
    assets: { lovelace: datum.tradable_input + datum.ex_fee + 1_500_000n },
    datum,
  };
}

function walletUtxo(txHash: string, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: WALLET_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

function fakeWallet(over: Partial<CurveSpendWallet> = {}): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(WALLET_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), '20000000')]),
    getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), '5000000')]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('submitted-hash'),
    ...over,
  };
}

function canceller(opts: { carry?: boolean } = {}) {
  return new VenueCanceller({
    network: 'preprod',
    orderScript: opts.carry
      ? { embeddedScriptCbor: ORDER.compiledCode }
      : {
          compiledScriptCbor: ORDER.compiledCode,
          referenceScript: { txHash: ORDER_REF_TX, outputIndex: 0, scriptHash: ORDER_HASH },
        },
    provider: {
      fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
      evaluateTx: vi.fn().mockResolvedValue([{ tag: 'SPEND', index: 0, budget: VENUE_CANCEL_EXECUTION_UNITS }]),
    },
  });
}

function declaredSigners(txHex: string): string[] {
  const signers = deserializeTx(txHex).body().requiredSigners();
  return (signers?.toCore() ?? []).map(String);
}

// ---------------------------------------------------------------------------

describe('taking one order back', () => {
  it('declares the placer’s key, which is what the validator reads', async () => {
    const built = await canceller().build([order('0a'.repeat(32))], fakeWallet());
    expect(declaredSigners(built)).toContain(PLACER);
  });

  it('spends it under Cancel and not under Fill', async () => {
    const built = await canceller().build([order('0a'.repeat(32))], fakeWallet());
    const redeemers = deserializeTx(built).witnessSet().redeemers()?.values() ?? [];
    expect(redeemers).toHaveLength(1);
    expect(redeemers[0]?.data().toCbor()).toBe(venueCancelRedeemer());
  });

  it('spends the order itself', async () => {
    const built = await canceller().build([order('0a'.repeat(32))], fakeWallet());
    const inputs = deserializeTx(built).body().inputs().toCore();
    expect(inputs.map((i) => String(i.txId))).toContain('0a'.repeat(32));
  });

  it('returns the funds to the address the order names, not the wallet’s', async () => {
    const built = await canceller().build([order('0a'.repeat(32))], fakeWallet());
    const outputs = deserializeTx(built)
      .body()
      .outputs()
      .map((o) => o.toCore());
    const addresses = outputs.map((o) => String(o.address));
    expect(addresses).toContain(PLACER_ADDRESS);
    expect(addresses).not.toContain(WALLET_ADDRESS);
  });

  it('honours an explicit destination when the placer gives one', async () => {
    const elsewhere = credentialToAddress('Preprod', { type: 'Key', hash: '0f'.repeat(28) });
    const built = await canceller().build([order('0a'.repeat(32))], fakeWallet(), { toAddress: elsewhere });
    const addresses = deserializeTx(built)
      .body()
      .outputs()
      .map((o) => String(o.toCore().address));
    expect(addresses).toContain(elsewhere);
  });

  it('works with the validator carried rather than referenced', async () => {
    const built = await canceller({ carry: true }).build([order('0a'.repeat(32))], fakeWallet());
    expect(declaredSigners(built)).toContain(PLACER);
  });
});

describe('taking several back at once', () => {
  it('spends them all in one transaction, under one signature', async () => {
    // The two-input rule lives in the Fill arm; the cancel arm has no shape
    // rule at all, so a placer gets out of every stuck order for one fee.
    const orders = [order('0a'.repeat(32)), order('0b'.repeat(32)), order('0c'.repeat(32))];
    const built = await canceller().build(orders, fakeWallet());
    const inputs = deserializeTx(built).body().inputs().toCore();
    const spent = inputs.map((i) => String(i.txId));
    for (const o of orders) expect(spent).toContain(o.txHash);
    expect(declaredSigners(built)).toEqual([PLACER]);
    expect(deserializeTx(built).witnessSet().redeemers()?.values() ?? []).toHaveLength(3);
  });

  it('refuses a batch that would pay two different placers', async () => {
    const mixed = [order('0a'.repeat(32)), order('0b'.repeat(32), swapDatum({ reward_pkh: OTHER_PLACER }))];
    await expect(canceller().build(mixed, fakeWallet())).rejects.toThrow(/different addresses/);
  });

  it('refuses a batch whose orders differ only by stake key', async () => {
    // Same payment key, different reward ADDRESS — so one change output cannot
    // serve both without sending somebody's funds to the wrong place.
    const mixed = [order('0a'.repeat(32)), order('0b'.repeat(32), swapDatum({ stake_pkh: '0e'.repeat(28) }))];
    await expect(canceller().build(mixed, fakeWallet())).rejects.toThrow(/different addresses/);
  });

  it('refuses to name the same order twice', async () => {
    await expect(canceller().build([order('0a'.repeat(32)), order('0a'.repeat(32))], fakeWallet())).rejects.toThrow(
      /twice/,
    );
  });
});

describe('the orders that most need cancelling are the ones that can least pay', () => {
  // An underfunded order — the commonest reason to cancel — carries barely
  // more than the minimum an output must hold. Take its network fee out of
  // that and what is left cannot stand as an output, so the wallet has to put
  // something in. This is why a cancel offers the wallet's UTXOs to coin
  // selection where a fill must refuse them.
  const stuck = swapDatum({
    input: { policy: TOKEN_POLICY, name: '746f6b656e' },
    output: { policy: '', name: '' },
    tradable_input: 5_000_000n,
    ex_fee: 100_000n,
  });
  const tiny: VenueSwapOrderUtxo = {
    txHash: '0a'.repeat(32),
    outputIndex: 0,
    address: ORDER_ADDRESS,
    assets: { lovelace: 1_100_000n, [`${TOKEN_POLICY}746f6b656e`]: 5_000_000n },
    datum: stuck,
  };

  it('cancels it with the wallet making up the difference', async () => {
    const built = await canceller().build([tiny], fakeWallet());
    expect(declaredSigners(built)).toContain(PLACER);
    // The wallet's own UTXO is in there, which is the whole point.
    const spent = deserializeTx(built)
      .body()
      .inputs()
      .toCore()
      .map((i) => String(i.txId));
    expect(spent).toContain('11'.repeat(32));
  });

  it('cannot cancel it from an empty wallet', async () => {
    const empty = fakeWallet({ getUtxos: vi.fn().mockResolvedValue([]) });
    await expect(canceller().build([tiny], empty)).rejects.toThrow(/[Dd]eplet|[Ii]nsufficient|UTxO/);
  });

  it('needs no help for an ordinary order, which carries plenty', async () => {
    const built = await canceller().build(
      [order('0b'.repeat(32))],
      fakeWallet({ getUtxos: vi.fn().mockResolvedValue([]) }),
    );
    expect(declaredSigners(built)).toContain(PLACER);
  });
});

describe('refusing what cannot work', () => {
  it('refuses an order sitting at another address', async () => {
    const elsewhere = { ...order('0a'.repeat(32)), address: PLACER_ADDRESS };
    await expect(canceller().build([elsewhere], fakeWallet())).rejects.toThrow(/would need the validator/);
  });

  it('refuses without collateral, since a Plutus spend needs one', async () => {
    const wallet = fakeWallet({ getCollateral: vi.fn().mockResolvedValue([]) });
    await expect(canceller().build([order('0a'.repeat(32))], wallet)).rejects.toThrow(/no collateral/);
  });

  it('refuses to cancel nothing at all', () => {
    expect(() => venueCancelDestination([], 'preprod')).toThrow(/at least one order/);
  });
});

describe('working out where and who', () => {
  it('derives the destination from the order, stake key included', () => {
    expect(venueCancelDestination([order('0a'.repeat(32))], 'preprod')).toBe(PLACER_ADDRESS);
    const staked = venueCancelDestination(
      [order('0a'.repeat(32), swapDatum({ stake_pkh: '0e'.repeat(28) }))],
      'preprod',
    );
    expect(staked).not.toBe(PLACER_ADDRESS);
    expect(staked.startsWith('addr_test')).toBe(true);
  });

  it('names each distinct placer once', () => {
    expect(venueCancelSigners([order('0a'.repeat(32)), order('0b'.repeat(32))])).toEqual([PLACER]);
    expect(
      venueCancelSigners([order('0a'.repeat(32)), order('0b'.repeat(32), swapDatum({ reward_pkh: OTHER_PLACER }))]),
    ).toEqual([PLACER, OTHER_PLACER]);
  });
});
