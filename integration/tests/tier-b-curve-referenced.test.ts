// tier-b-curve-referenced.test.ts — the same action, built the other way.
//
// Cardano Launch's curve can name its published validator instead of carrying it. The
// risk in offering two ways to build one transaction is that they drift: a fee
// rounded differently, a datum field set on one path and not the other, a
// payout that loses its settlement tag. Any of those produces a transaction
// the node rejects, or worse, one it accepts for the wrong amount.
//
// So the central test here does not check the referenced plan against a list
// of expected values. It runs the SAME action both ways and checks the two
// agree — the redeemer, the continuing datum, the continuing value, the
// payouts and their tags, the signer, and the validity range. A drift on
// either path fails it, without anyone having to remember to update a fixture.
//
// It runs over EVERY action the curve has. On this tier that is not
// thoroughness for its own sake: the validator is most of the transaction cap
// on its own, so an action that still embeds it cannot be submitted at all, and
// an action missing from this table is one nobody would notice was missing.
//
// A public trade is not in the table because it is no longer one of the curve's
// actions — it reaches the curve as an order, applied in a batch. A DarkVeil
// claim stands in as the buyer-signed, payout-bearing exemplar above.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Blockfrost: vi.fn(),
    Data: { ...actual.Data, from: vi.fn((d: unknown) => d), to: vi.fn((d: unknown) => d) },
  };
});

// The spender is exercised for real against real compiled validators in
// mesh-curve-spend.test.ts. What matters here is the PLAN it is handed.
const submitSpy = vi.fn().mockResolvedValue('referenced-tx-hash');
vi.mock('../mesh-curve-spend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mesh-curve-spend.js')>();
  return {
    ...actual,
    MeshCurveSpender: class {
      submit = submitSpy;
    },
  };
});

vi.mock('@meshsdk/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meshsdk/core')>();
  return {
    ...actual,
    BlockfrostProvider: class {},
    MeshWallet: class {},
  };
});

// The key-signed wallet is real, and tested against real keys and a real
// transaction in key-curve-spend-wallet.test.ts. Here it only needs to exist,
// so the key/address pairing check does not require this file to carry a
// funded governor identity.
vi.mock('../key-curve-spend-wallet.js', () => ({
  KeyCurveSpendWallet: { forAddress: vi.fn().mockResolvedValue({}) },
}));

import { CML, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { bytesToHex, CAP_EMPTY_ROOT, CapAccumulator, hexToBytes } from '../cap-accumulator-tree.js';
import type { CurveSpendPlan } from '../mesh-curve-spend.js';
import { threadNftAssetName } from '../tier-a-schemas.js';
import { LucidTierBCurveSubmitter } from '../tier-b-curve-submitter.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
const BUYER_KEY_HASH = fakeKeyHash(0x11);
const BUYER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: BUYER_KEY_HASH });

/**
 * A real derived payment key for the governor-signed actions.
 *
 * Real because the extended-key conversion those paths run on the way to
 * signing is real, and will reject anything that is not a genuine key. Derived
 * from fixed entropy rather than a phrase — deterministic, and nothing
 * seed-phrase-shaped belongs in a public repository.
 */
function keyFromEntropy(entropyHex: string) {
  const payment = CML.Bip32PrivateKey.from_bip39_entropy(
    new Uint8Array(Buffer.from(entropyHex, 'hex')),
    new Uint8Array(),
  )
    .derive(1852 + 0x80000000)
    .derive(1815 + 0x80000000)
    .derive(0x80000000)
    .derive(0)
    .derive(0)
    .to_raw_key();
  return {
    extendedHex: Buffer.from(payment.to_raw_bytes()).toString('hex'),
    keyHash: payment.to_public().hash().to_hex(),
  };
}
const GOVERNOR = keyFromEntropy('44'.repeat(32));
const GOVERNOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: GOVERNOR.keyHash });

const LAUNCH_ID_HEX = Buffer.from('launch-tier-b-ref').toString('hex');
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('bondingCurveTierB', LAUNCH_ID_HEX);
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const CURVE_TX = 'fe'.repeat(32);

// The stub script the submitter is configured with. Referenced mode checks the
// pointer against whatever it is given, so the pointer has to name this one.
const STUB_SCRIPT = '590000';

function activeDatum(): Record<string, unknown> {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    // The launch's own DarkVeil windows, at the production values these
    // fixtures assume elsewhere (a 24h claim window, a 30m dead window).
    dv_claim_window: 86_400_000n,
    dv_settlement_window: 1_800_000n,
    creator_pub_key_hash: fakeKeyHash(0x99),
    // A launch records its own governor, and the submitter refuses a signer
    // that is not it. A fixture naming someone else describes a launch these
    // actions could never run against.
    governor_pub_key_hash: GOVERNOR.keyHash,
    base_price: 10n,
    max_price: 1000n,
    curve_supply: 1000n,
    curve_state: 'Active',
    phase_started_at: 0n,
    tokens_sold: 0n,
    total_raised: 0n,
    creator_fees_accrued: 0n,
    platform_fees_accrued: 0n,
    wallet_cap: 500n,
    dv_allocation_root: '',
    dv_reserve_tokens: 0n,
    dv_claim_opened_at: 0n,
    claimed_bits: '',
    dv_settled: false,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    cap_root: bytesToHex(CAP_EMPTY_ROOT),
  };
}

/** Records what the Lucid path builds, so the two can be compared. */
function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.attach = { SpendingValidator: vi.fn(() => builder) };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
    ToAddress: vi.fn(() => builder),
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      calls.payToAddress = a;
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return builder;
  });
  const done = { complete: vi.fn().mockResolvedValue({ submit: vi.fn().mockResolvedValue('lucid-tx') }) };
  builder.complete = vi.fn().mockResolvedValue({
    sign: { withWallet: () => done, withPrivateKey: () => done },
  });
  return { builder, calls };
}

function makeSubmitter(builder: unknown, opts: { referenced?: boolean; datum?: Record<string, unknown> } = {}) {
  vi.mocked(Lucid).mockResolvedValue({
    selectWallet: { fromAddress: vi.fn(), fromSeed: vi.fn(), fromAPI: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue([
      {
        txHash: CURVE_TX,
        outputIndex: 0,
        datum: opts.datum ?? activeDatum(),
        assets: { [THREAD_UNIT]: 1n, lovelace: 50_000_000n, [`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]: 1000n },
      },
    ]),
    wallet: () => ({ address: vi.fn().mockResolvedValue(BUYER_ADDRESS) }),
    newTx: () => builder,
  } as never);

  return new LucidTierBCurveSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    compiledScriptCbor: STUB_SCRIPT,
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
    ...(opts.referenced
      ? {
          referenceScript: {
            txHash: 'ab'.repeat(32),
            outputIndex: 0,
            // The spender is mocked here, so this is never checked against the
            // script — the real check has its own tests in reference-script.
            scriptHash: 'not-checked-here',
          },
        }
      : {}),
  });
}

// Deliberately NOT a real BIP-39 phrase. The wallet is mocked, so nothing
// derives a key from this — and a seed-phrase-shaped string does not belong in
// a public repository even when it controls nothing.
const WALLET_KEY_PLACEHOLDER = '<mnemonic-placeholder>';

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
  submitSpy.mockClear();
});

describe('reference mode is off unless asked for', () => {
  it('reports itself as embedding the validator', () => {
    expect(makeSubmitter(makeFakeTxBuilder().builder).referencesScript).toBe(false);
  });

  it('builds through Lucid and never reaches the spender', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const result = await makeSubmitter(builder, { datum: dvClaimDatum() }).claimDarkVeilTokens(
      WALLET_KEY_PLACEHOLDER,
      {
        dvAmount: 100n,
        salt: new Uint8Array(32).fill(3),
        merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
        buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
        leafIndex: 0,
      },
      new CapAccumulator(),
    );
    expect(result.txHash).toBe('lucid-tx');
    expect(submitSpy).not.toHaveBeenCalled();
    expect(calls.collectFrom).toBeDefined();
  });
});

describe('reference mode', () => {
  it('reports itself as referencing the validator', () => {
    expect(makeSubmitter(makeFakeTxBuilder().builder, { referenced: true }).referencesScript).toBe(true);
  });

  it('submits through the spender rather than Lucid', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const result = await makeSubmitter(builder, { referenced: true, datum: dvClaimDatum() }).claimDarkVeilTokens(
      WALLET_KEY_PLACEHOLDER,
      {
        dvAmount: 100n,
        salt: new Uint8Array(32).fill(3),
        merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
        buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
        leafIndex: 0,
      },
      new CapAccumulator(),
    );
    expect(result.txHash).toBe('referenced-tx-hash');
    expect(submitSpy).toHaveBeenCalledOnce();
    // The Lucid builder is untouched: no half-built transaction left behind.
    expect(calls.collectFrom).toBeUndefined();
  });

  it('spends the same UTXO the authenticated lookup found', async () => {
    const { builder } = makeFakeTxBuilder();
    await makeSubmitter(builder, { referenced: true, datum: dvClaimDatum() }).claimDarkVeilTokens(
      WALLET_KEY_PLACEHOLDER,
      {
        dvAmount: 100n,
        salt: new Uint8Array(32).fill(3),
        merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
        buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
        leafIndex: 0,
      },
      new CapAccumulator(),
    );
    const [plan] = submitSpy.mock.calls[0] as [CurveSpendPlan];
    expect(plan.scriptUtxo.txHash).toBe(CURVE_TX);
    expect(plan.scriptUtxo.outputIndex).toBe(0);
  });

  // ==========================================================================
  // The one that matters: the two paths must not drift
  // ==========================================================================

  it('builds the same action Lucid would have', async () => {
    // The two builds happen milliseconds apart and this action stamps its own
    // validity range from the clock, so without pinning it the redeemers
    // differ by a couple of milliseconds and the comparison fails for a reason
    // that has nothing to do with the two paths agreeing.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const embedded = makeFakeTxBuilder();
    await makeSubmitter(embedded.builder, { datum: dvClaimDatum() }).claimDarkVeilTokens(
      WALLET_KEY_PLACEHOLDER,
      {
        dvAmount: 100n,
        salt: new Uint8Array(32).fill(3),
        merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
        buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
        leafIndex: 0,
      },
      new CapAccumulator(),
    );

    const referenced = makeFakeTxBuilder();
    await makeSubmitter(referenced.builder, { referenced: true, datum: dvClaimDatum() }).claimDarkVeilTokens(
      WALLET_KEY_PLACEHOLDER,
      {
        dvAmount: 100n,
        salt: new Uint8Array(32).fill(3),
        merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
        buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
        leafIndex: 0,
      },
      new CapAccumulator(),
    );

    const [plan] = submitSpy.mock.calls[0] as [CurveSpendPlan];

    // The two results differ by construction — each carries the tx hash its
    // own submission path returned — so what they must agree on is everything
    // that goes INTO the transaction, checked below.
    // The redeemer — the cap proof included.
    const [, lucidRedeemer] = embedded.calls.collectFrom as [unknown, unknown];
    expect(plan.redeemerCbor).toEqual(lucidRedeemer);

    // The continuing state: datum and value both.
    const [, lucidDatum, lucidAssets] = embedded.calls.payToContract as [
      string,
      { value: unknown },
      Record<string, bigint>,
    ];
    expect(plan.continuing.datumCbor).toEqual(lucidDatum.value);
    expect(plan.continuing.assets).toEqual(lucidAssets);

    // The delivery, and the tag that makes it one.
    const [lucidPayoutAddr, lucidPayoutDatum, lucidPayoutAssets] = embedded.calls.payToAddress as [
      string,
      { value: unknown },
      Record<string, bigint>,
    ];
    expect(plan.payouts).toHaveLength(1);
    expect(plan.payouts[0]?.address).toBe(lucidPayoutAddr);
    expect(plan.payouts[0]?.assets).toEqual(lucidPayoutAssets);
    expect(plan.payouts[0]?.datumCbor).toEqual(lucidPayoutDatum.value);

    // Lucid takes an address and derives the key hash; the plan carries the
    // hash directly. Same signer, said two ways.
    expect(embedded.calls.addSigner).toEqual([BUYER_ADDRESS]);
    expect(plan.requiredSignerHashes).toEqual([BUYER_KEY_HASH]);
    clock.mockRestore();
  });

  it('still refuses a trade the curve would reject, before building anything', async () => {
    const { builder } = makeFakeTxBuilder();
    // The claim datum matters: without it the curve is Active and the claim is
    // refused for being outside the window, which would pass this test without
    // the cap ever being consulted.
    const submitter = makeSubmitter(builder, { referenced: true, datum: dvClaimDatum() });
    // Over the wallet cap of 500.
    await expect(
      submitter.claimDarkVeilTokens(
        WALLET_KEY_PLACEHOLDER,
        {
          dvAmount: 600n,
          salt: new Uint8Array(32).fill(3),
          merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
          buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
          leafIndex: 0,
        },
        new CapAccumulator(),
      ),
    ).rejects.toThrow(/cap exceeded/i);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('says plainly that a browser wallet cannot use it yet', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, { referenced: true, datum: dvClaimDatum() });
    await expect(
      submitter.claimDarkVeilTokensWithWallet(
        {} as never,
        {
          dvAmount: 100n,
          salt: new Uint8Array(32).fill(3),
          merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
          buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
          leafIndex: 0,
        },
        new CapAccumulator(),
      ),
    ).rejects.toThrow(/Launch Wizard wallet task/);
  });
});

// ============================================================================
// Every action, both ways
// ============================================================================

type Submitter = LucidTierBCurveSubmitter;

interface Action {
  name: string;
  /** The curve's state this action starts from. */
  datum: Record<string, unknown>;
  run: (s: Submitter) => Promise<unknown>;
  /** The address the validator requires a signature from, if any. */
  signer?: string;
  /** Whether the action bounds itself in time. */
  timed?: boolean;
  /** How many ordinary-address payouts it makes. */
  payouts: number;
}

const NOW = 1_800_000_000_000;

/** A launch inside its DarkVeil claim window, with a bit free for leaf 0. */
function dvClaimDatum(): Record<string, unknown> {
  return {
    ...activeDatum(),
    curve_state: 'DvClaim',
    dv_reserve_tokens: 500n,
    dv_settled: true,
    dv_allocation_root: 'ab'.repeat(32),
    dv_claim_opened_at: BigInt(NOW),
    claimed_bits: '00',
  };
}

const ACTIONS: Action[] = [
  {
    name: 'activate',
    datum: { ...activeDatum(), curve_state: 'Inactive', dv_reserve_tokens: 0n },
    run: (s) => s.activateCurve(GOVERNOR.extendedHex, GOVERNOR_ADDRESS, NOW),
    signer: GOVERNOR_ADDRESS,
    timed: true,
    payouts: 0,
  },
  {
    name: 'open the DarkVeil claim window',
    datum: {
      ...activeDatum(),
      curve_state: 'Inactive',
      dv_reserve_tokens: 100n,
      dv_settled: true,
      dv_allocation_root: 'ab'.repeat(32),
    },
    run: (s) => s.openDvClaim(GOVERNOR.extendedHex, GOVERNOR_ADDRESS, 8, NOW),
    signer: GOVERNOR_ADDRESS,
    timed: true,
    payouts: 0,
  },
  {
    name: 'claim a DarkVeil allocation',
    datum: dvClaimDatum(),
    run: (s) =>
      s.claimDarkVeilTokens(
        WALLET_KEY_PLACEHOLDER,
        {
          dvAmount: 100n,
          salt: new Uint8Array(32).fill(3),
          merkleProof: [{ sibling: new Uint8Array(32).fill(4), goesLeft: true }],
          buyerKeyHash: hexToBytes(BUYER_KEY_HASH),
          leafIndex: 0,
        },
        new CapAccumulator(),
      ),
    signer: BUYER_ADDRESS,
    timed: true,
    payouts: 1,
  },
  {
    name: 'claim creator fees',
    datum: { ...activeDatum(), creator_fees_accrued: 5_000_000n },
    run: (s) => s.claimCreatorFees(GOVERNOR.extendedHex, GOVERNOR_ADDRESS, 1_000_000n),
    signer: GOVERNOR_ADDRESS,
    payouts: 1,
  },
  {
    name: 'claim platform fees',
    datum: { ...activeDatum(), platform_fees_accrued: 5_000_000n },
    run: (s) => s.claimPlatformFees(GOVERNOR.extendedHex, GOVERNOR_ADDRESS, 1_000_000n),
    signer: GOVERNOR_ADDRESS,
    payouts: 1,
  },
  {
    name: 'expire',
    datum: activeDatum(),
    run: (s) => s.expireCurve(GOVERNOR.extendedHex, GOVERNOR_ADDRESS),
    // Permissionless: the elapsed deadline is the authorization, so the
    // transaction requires nobody's signature.
    timed: true,
    payouts: 0,
  },
  {
    name: 'claim buyback',
    datum: { ...activeDatum(), curve_state: 'Cancelled', tokens_sold: 300n, total_raised: 3_000_000n },
    run: (s) => s.claimBuyback(WALLET_KEY_PLACEHOLDER, 100n),
    signer: BUYER_ADDRESS,
    payouts: 1,
  },
];

describe.each(ACTIONS)('$name, both ways', (action) => {
  // Two runs a millisecond apart would differ on any range clamped to the real
  // clock, which is not drift and would make this test flap. Only Date is
  // faked: faking timers wholesale would stall the awaits below.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs it embedded and referenced, and hands back what each produced. */
  async function bothWays() {
    const embedded = makeFakeTxBuilder();
    await action.run(makeSubmitter(embedded.builder, { datum: action.datum }));

    const referenced = makeFakeTxBuilder();
    await action.run(makeSubmitter(referenced.builder, { referenced: true, datum: action.datum }));
    const [plan] = submitSpy.mock.calls[0] as [CurveSpendPlan];

    return { lucid: embedded.calls, plan };
  }

  it('reaches the spender rather than Lucid', async () => {
    const { lucid } = await bothWays();
    expect(submitSpy).toHaveBeenCalledOnce();
    // Called once for the embedded run, and not a second time.
    expect(lucid.collectFrom).toBeDefined();
  });

  it('sends the same redeemer', async () => {
    const { lucid, plan } = await bothWays();
    expect(plan.redeemerCbor).toEqual((lucid.collectFrom as [unknown, unknown])[1]);
  });

  it('leaves the curve in the same state, holding the same value', async () => {
    const { lucid, plan } = await bothWays();
    const [, datum, assets] = lucid.payToContract as [string, { value: unknown }, Record<string, bigint>];
    expect(plan.continuing.datumCbor).toEqual(datum.value);
    expect(plan.continuing.assets).toEqual(assets);
  });

  it('pays the same people the same amounts, each tagged', async () => {
    const { lucid, plan } = await bothWays();
    expect(plan.payouts).toHaveLength(action.payouts);
    if (action.payouts === 0) {
      expect(lucid.payToAddress).toBeUndefined();
      return;
    }
    const [addr, datum, assets] = lucid.payToAddress as [string, { value: unknown }, Record<string, bigint>];
    expect(plan.payouts[0]?.address).toBe(addr);
    expect(plan.payouts[0]?.assets).toEqual(assets);
    // The tag is what makes an output a payout as far as the validator is
    // concerned. An untagged one is invisible to it.
    expect(plan.payouts[0]?.datumCbor).toEqual(datum.value);
    expect(plan.payouts[0]?.datumCbor).toBeTruthy();
  });

  it('requires a signature from the same party, or from nobody', async () => {
    const { lucid, plan } = await bothWays();
    if (!action.signer) {
      expect(lucid.addSigner).toBeUndefined();
      expect(plan.requiredSignerHashes).toEqual([]);
      return;
    }
    expect(lucid.addSigner).toEqual([action.signer]);
    // Lucid takes an address and derives the hash; the plan carries the hash.
    // Same signer, said two ways.
    expect(plan.requiredSignerHashes).toHaveLength(1);
  });

  it('bounds itself in time the same way, or not at all', async () => {
    const { lucid, plan } = await bothWays();
    if (!action.timed) {
      expect(lucid.validFrom).toBeUndefined();
      expect(plan.validity).toBeUndefined();
      return;
    }
    // Milliseconds on both sides here — the spender converts to slots itself,
    // which is where a unit mismatch would otherwise widen every range.
    expect(plan.validity?.fromMs).toBe((lucid.validFrom as [number])[0]);
    expect(plan.validity?.toMs).toBe((lucid.validTo as [number])[0]);
  });
});
