// Tests for tier-b-curve-submitter.ts's LucidTierBCurveSubmitter — Cardano Launch's
// public bonding curve. Structurally similar to
// tier-a-curve-submitter.test.ts's coverage, but this file focuses on the
// REAL differences this module's own header documents: QUADRATIC pricing
// (not linear), FLOOR-rounded fees (not exact-equality), the shared
// balance from a DarkVeil claim), SellTokens' deliberately-non-adjacent
// constructor index 13, and the two-directional ClaimCreatorFees value
// check plus the governor-signed ClaimTreasuryFees/ClaimOpsFees this class
// adds beyond the linear curve's curve submitter. Same importOriginal partial-mock
// Lucid strategy as the other submitter tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Data: {
      ...actual.Data,
      from: vi.fn((d: unknown) => d),
      to: vi.fn((d: unknown) => d),
    },
  };
});

import { CML, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { bytesToHex, CAP_EMPTY_ROOT, CapAccumulator } from '../cap-accumulator-tree.js';
import type { BondingCurveTierBDatumData } from '../tier-a-schemas.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

/// Every fixture below starts from a curve nothing has been taken from, so the
/// accumulator is empty and each buyer proves their own empty slot — the same
/// state genesis writes. A fresh instance per call, since a submitter that
/// mutated a shared one would make the tests order-dependent.
function emptyCapState(): CapAccumulator {
  return new CapAccumulator();
}

import {
  buyCostQuadratic,
  curvePriceAtQuadratic,
  floorFeeSlice,
  LucidTierBCurveSubmitter,
  sellProceedsQuadratic,
} from '../tier-b-curve-submitter.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const REAL_EXTENDED_KEY_HEX = toHex(CML.PrivateKey.generate_ed25519extended().to_raw_bytes());
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-tier-b-1'));
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const _TOKEN_UNIT = TOKEN_POLICY + TOKEN_ASSET_NAME;
const CREATOR_KEY_HASH = fakeKeyHash(0x99);

// A real launch's state UTXO carries its thread NFT, has a transaction
// reference, and is the ONLY UTXO claiming that launch — the lookup refuses
// anything else. A fixture missing any of those describes a UTXO the chain
// cannot produce, and hides every code path that reads one.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('bondingCurveTierB', LAUNCH_ID_HEX);
const CURVE_TX_HASH = 'fe'.repeat(32);

/** What ToAddressWithData is handed as its datum argument. `Data.to` is mocked
 *  to identity in this file, so the tag arrives as the decoded object rather
 *  than CBOR — which makes the assertion read as what it means. */
interface InlineDatumArg {
  kind: string;
  value: unknown;
}

/** The tag a payout must carry to settle the curve UTXO at `fe…#index`. */
function settlesCurveInput(index: number): InlineDatumArg {
  return { kind: 'inline', value: { transaction_id: CURVE_TX_HASH, output_index: BigInt(index) } };
}

function asChainUtxos<T extends { assets?: Record<string, bigint> }>(list: T[]): T[] {
  return list.map((u, i) => ({
    txHash: CURVE_TX_HASH,
    outputIndex: i,
    ...u,
    assets: { [THREAD_UNIT]: 1n, ...(u.assets ?? {}) },
  }));
}

function baseDatum(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    // The launch's own DarkVeil windows, at the production values these
    // fixtures assume elsewhere (a 24h claim window, a 30m dead window).
    dv_claim_window: 86_400_000n,
    dv_settlement_window: 1_800_000n,
    creator_pub_key_hash: CREATOR_KEY_HASH,
    // The governor-only actions refuse a signer this launch does not name, so
    // a fixture has to name one — these tests already sign as 0x22.
    governor_pub_key_hash: fakeKeyHash(0x22),
    base_price: 10n,
    max_price: 1000n,
    curve_supply: 1000n,
    curve_state: 'Inactive',
    phase_started_at: 0n,
    tokens_sold: 0n,
    total_raised: 0n,
    creator_fees_accrued: 0n,
    platform_fees_accrued: 0n,
    wallet_cap: 500n,
    // The DarkVeil fields. A Cardano Launch datum has carried these since the claim
    // window was added; a fixture without them describes a datum the
    // validator could not decode.
    dv_allocation_root: '',
    dv_reserve_tokens: 0n,
    dv_claim_opened_at: 0n,
    claimed_bits: '',
    dv_settled: false,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    // The cumulative cap's accumulator at genesis: every slot empty, matching
    // emptyCapState() below. A submitter refuses to build against a state that
    // does not derive this, so the two have to agree.
    cap_root: bytesToHex(CAP_EMPTY_ROOT),
    ...overrides,
  };
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const payToAddressCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      calls.attachSpendingValidator = a;
      return builder;
    }),
  };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
    ToAddress: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
      return builder;
    }),
    // A settlement payout names the spend it settles, so it is built with
    // ToAddressWithData rather than ToAddress. Recorded into the same list so
    // a test can assert on the payout without caring which was used — and so
    // that a payout losing its tag shows up as a shape change here.
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
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
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('tier-b-tx-1'),
        }),
      }),
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('tier-b-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls, payToAddressCalls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
  walletAddress?: string,
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn(), fromSeed: vi.fn(), fromAPI: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(asChainUtxos(utxos)),
    wallet: () => ({
      address: vi.fn().mockResolvedValue(walletAddress ?? addrFor(fakeKeyHash(0x11))),
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return new LucidTierBCurveSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    compiledScriptCbor: '590000',
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('floorFeeSlice (Cardano Launch: floor-rounded, NOT exact-equality like the linear curve)', () => {
  it('floors non-exact divisions instead of throwing', () => {
    expect(floorFeeSlice(999n, 100n)).toBe(9n); // floor(9.99)
    expect(floorFeeSlice(1_000_000n, 60n)).toBe(6_000n);
  });
});

describe('curvePriceAtQuadratic', () => {
  it('gives what the next single token costs at that position', () => {
    // base=10, max=1000 (range 990), supply=1000: the token at position 500
    // is worth 257.5 lovelace, and a buyer pays the whole 258 — the rounding
    // resolves in the curve's favour, as it does on chain.
    const datum = {
      base_price: 10n,
      max_price: 1000n,
      curve_supply: 1000n,
    } as BondingCurveTierBDatumData;
    expect(curvePriceAtQuadratic(datum, 500n)).toBe(258n);
  });

  it('is additive over adjacent ranges, so splitting a trade changes nothing', () => {
    const datum = {
      base_price: 10n,
      max_price: 1000n,
      curve_supply: 1000n,
    } as BondingCurveTierBDatumData;
    expect(buyCostQuadratic(datum, 0n, 400n) + buyCostQuadratic(datum, 400n, 600n)).toBe(
      buyCostQuadratic(datum, 0n, 1000n),
    );
  });

  it('never pays a seller more than it charges a buyer for the same range', () => {
    const datum = {
      base_price: 10n,
      max_price: 1000n,
      curve_supply: 1000n,
    } as BondingCurveTierBDatumData;
    expect(buyCostQuadratic(datum, 300n, 200n)).toBeGreaterThanOrEqual(sellProceedsQuadratic(datum, 300n, 200n));
  });

  it('returns exactly base_price at sold=0 (start of curve)', () => {
    const datum = {
      base_price: 10n,
      max_price: 1000n,
      curve_supply: 1000n,
    } as BondingCurveTierBDatumData;
    expect(curvePriceAtQuadratic(datum, 0n)).toBe(10n);
  });

  it('returns exactly max_price at sold=curve_supply (end of curve)', () => {
    const datum = {
      base_price: 10n,
      max_price: 1000n,
      curve_supply: 1000n,
    } as BondingCurveTierBDatumData;
    expect(curvePriceAtQuadratic(datum, 1000n)).toBe(1000n);
  });

  it('grows faster than a linear curve would at the same sold fraction (real quadratic shape)', () => {
    const datum = {
      base_price: 0n,
      max_price: 1000n,
      curve_supply: 1000n,
    } as BondingCurveTierBDatumData;
    // At 50% sold, a linear curve would be at 50% price (500); quadratic is at 25% (250).
    expect(curvePriceAtQuadratic(datum, 500n)).toBe(250n);
  });
});

describe('LucidTierBCurveSubmitter.activateCurve', () => {
  it('rejects once the curve is no longer Inactive', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await expect(
      submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), Date.now()),
    ).rejects.toThrow(/Curve is not Inactive/);
  });

  // A DarkVeil launch does not go Inactive -> Active. It goes
  // Inactive -> DvClaim -> Active, and public trading may not open until the
  // claim window AND the dead window after it have both elapsed.
  const DV_CLAIM_WINDOW_MS = 86_400_000;
  const DV_SETTLEMENT_WINDOW_MS = 1_800_000;
  const OPENED_AT = 1_700_000_000_000;
  const AFTER_BOTH_WINDOWS = OPENED_AT + DV_CLAIM_WINDOW_MS + DV_SETTLEMENT_WINDOW_MS;

  function darkveilDatum(overrides: Record<string, unknown> = {}) {
    return baseDatum({
      curve_state: 'DvClaim',
      dv_reserve_tokens: 150n,
      dv_settled: true,
      dv_allocation_root: 'aa'.repeat(32),
      dv_claim_opened_at: BigInt(OPENED_AT),
      claimed_bits: '00'.repeat(8),
      ...overrides,
    });
  }

  it('activates a DarkVeil launch out of the claim window once both windows have elapsed', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: darkveilDatum(), assets: {} }]);

    await submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), AFTER_BOTH_WINDOWS);

    const payload = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(payload.value.curve_state).toBe('Active');
    // The nullifier has served its purpose and the validator requires it
    // emptied, so every public trade afterwards carries no claim state.
    expect(payload.value.claimed_bits).toBe('');
  });

  it('refuses to activate a DarkVeil launch while the claim window is still open', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: darkveilDatum(), assets: {} }]);
    await expect(
      submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), OPENED_AT + 60_000),
    ).rejects.toThrow(/claim window/i);
  });

  it('refuses to activate a DarkVeil launch in the dead window after claims close', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: darkveilDatum(), assets: {} }]);
    await expect(
      submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), OPENED_AT + DV_CLAIM_WINDOW_MS + 1),
    ).rejects.toThrow(/claim window|settlement/i);
  });

  it('refuses to activate a DarkVeil launch still sitting in Inactive', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: darkveilDatum({ curve_state: 'Inactive' }), assets: {} }]);
    await expect(
      submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), AFTER_BOTH_WINDOWS),
    ).rejects.toThrow(/activates out of the claim window, not from Inactive/);
  });

  it('sets curve_state to Active and stamps phase_started_at', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);
    await submitter.activateCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 1_700_000_000_000);
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.curve_state).toBe('Active');
    expect(payload.value.phase_started_at).toBe(1_700_000_000_000n);
  });
});

describe('LucidTierBCurveSubmitter.openDvClaim', () => {
  const OPENED_AT = 1_700_000_000_000;

  function settledDatum(overrides: Record<string, unknown> = {}) {
    return baseDatum({
      curve_state: 'Inactive',
      dv_reserve_tokens: 150n,
      dv_settled: true,
      dv_allocation_root: 'aa'.repeat(32),
      ...overrides,
    });
  }

  it('moves the curve into DvClaim and stamps when the window opened', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum(), assets: {} }]);

    await submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 20, OPENED_AT);

    const payload = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(payload.value.curve_state).toBe('DvClaim');
    expect(payload.value.dv_claim_opened_at).toBe(BigInt(OPENED_AT));
  });

  it('sizes the bitmap to hold one bit per registrant, rounded up to whole bytes', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum(), assets: {} }]);

    // 20 registrants need 3 bytes (24 bits); 16 would need exactly 2.
    await submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 20, OPENED_AT);

    const payload = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(payload.value.claimed_bits).toBe('000000');
  });

  it('opens every bit clear, so no registrant can be pre-burned', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum(), assets: {} }]);

    await submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 64, OPENED_AT);

    const payload = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(payload.value.claimed_bits).toMatch(/^0+$/);
  });

  it('builds the redeemer at the constructor index the validator declares', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum(), assets: {} }]);

    await submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 20, OPENED_AT);

    const redeemer = calls.collectFrom![1] as { index: number; fields: unknown[] };
    expect(redeemer.index).toBe(14);
    expect(redeemer.fields).toEqual(['000000', BigInt(OPENED_AT)]);
  });

  it('refuses to open a window for a launch with no DarkVeil allocation', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum({ dv_reserve_tokens: 0n }), assets: {} }]);
    await expect(
      submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 20, OPENED_AT),
    ).rejects.toThrow(/DarkVeil/i);
  });

  it('refuses to open a window before the allocation root is final', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum({ dv_settled: false }), assets: {} }]);
    await expect(
      submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 20, OPENED_AT),
    ).rejects.toThrow(/root|settled/i);
  });

  it('refuses a window nobody could claim in', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum(), assets: {} }]);
    await expect(
      submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 0, OPENED_AT),
    ).rejects.toThrow(/registrant/i);
  });

  it('refuses to reopen a window that is already open', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: settledDatum({ curve_state: 'DvClaim' }), assets: {} }]);
    await expect(
      submitter.openDvClaim(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x22)), 20, OPENED_AT),
    ).rejects.toThrow(/Inactive/i);
  });
});

describe('LucidTierBCurveSubmitter.buyTokens', () => {
  it('rejects when the curve is not Active', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Inactive' }), assets: {} }]);
    await expect(submitter.buyTokens('mnemonic', 100n, emptyCapState())).rejects.toThrow(/Curve is not Active/);
  });

  it('rejects a tokenAmount of 0 or exceeding remaining supply', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          curve_supply: 100n,
          tokens_sold: 90n,
        }),
        assets: {},
      },
    ]);
    await expect(submitter.buyTokens('mnemonic', 0n, emptyCapState())).rejects.toThrow(/token_amount out of range/);
    await expect(submitter.buyTokens('mnemonic', 11n, emptyCapState())).rejects.toThrow(/token_amount out of range/);
  });

  it('allows the creator to buy their own curve, and blocks them from selling', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(
      builder,
      [{ datum: baseDatum({ curve_state: 'Active', tokens_sold: 500n }), assets: { lovelace: 10_000_000n } }],
      addrFor(CREATOR_KEY_HASH),
    );
    // A creator may put ADA in. They can never take it out, so there is no
    // round trip to wash-trade with, and their buys are flagged to the
    // community by the trade-history reader.
    await expect(submitter.buyTokens('mnemonic', 100n, emptyCapState())).resolves.toBeTruthy();
    await expect(submitter.sellTokens('mnemonic', 100n, emptyCapState())).rejects.toThrow(/creator cannot sell/i);
  });

  it('prices via the REAL quadratic formula at the pre-buy tokens_sold, using floor-rounded (not exact) fees', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          base_price: 10n,
          max_price: 1010n,
          curve_supply: 1000n,
          tokens_sold: 0n,
        }),
        assets: {},
      },
    ]);

    // Three tokens from a standing start: P(0)+P(1)+P(2) = 30.005 lovelace,
    // rounded up to 31. A gross this small floors every fee slice to zero and
    // the whole amount stays with the curve.
    const result = await submitter.buyTokens('mnemonic', 3n, emptyCapState());
    expect(result.grossPayment).toBe(31n);
    expect(result.avgPrice).toBe(10n);

    const redeemer = calls.collectFrom![1] as {
      index: number;
      fields: unknown[];
    };
    expect(redeemer.index).toBe(1);
    // The redeemer carries only the amount and the buyer — price and fees are
    // the contract's own computation, not a caller's claim.
    // token_amount, buyer_key_hash, then the two cumulative-cap fields.
    expect(redeemer.fields).toHaveLength(4);
    expect(redeemer.fields[0]).toBe(3n);
  });

  it('transitions curve_state to Graduated on full sell-through', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Active',
          curve_supply: 100n,
          tokens_sold: 90n,
          wallet_cap: 1000n,
        }),
        assets: {},
      },
    ]);
    await submitter.buyTokens('mnemonic', 10n, emptyCapState());
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.tokens_sold).toBe(100n);
    expect(payload.value.curve_state).toBe('Graduated');
  });
});

describe('LucidTierBCurveSubmitter.sellTokens', () => {
  it('builds the SellTokens redeemer at its deliberately-non-adjacent constructor index 13', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const sellerHash = fakeKeyHash(0x77);
    const submitter = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Active',
            base_price: 10n,
            max_price: 10n,
            curve_supply: 1000n,
            tokens_sold: 100n,
          }),
          assets: { lovelace: 10_000_000n },
        },
      ],
      addrFor(sellerHash),
    );

    await submitter.sellTokens('mnemonic', 100n, emptyCapState());
    const redeemer = calls.collectFrom![1] as { index: number };
    expect(redeemer.index).toBe(13);
  });

  it('allows total_raised to go negative on a round-trip sell (no floor)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const sellerHash = fakeKeyHash(0x88);
    const submitter = makeSubmitter(
      builder,
      [
        {
          datum: baseDatum({
            curve_state: 'Active',
            base_price: 100n,
            max_price: 100n,
            curve_supply: 1000n,
            tokens_sold: 10n,
            total_raised: 50n,
          }),
          assets: { lovelace: 10_000_000n },
        },
      ],
      addrFor(sellerHash),
    );

    await submitter.sellTokens('mnemonic', 10n, emptyCapState());
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.total_raised).toBe(-950n); // 50 - (100*10)
  });
});

describe('LucidTierBCurveSubmitter.claimCreatorFees (two-directional value check)', () => {
  it('rejects a platformClaimFeeLovelace below the on-chain floor', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ creator_fees_accrued: 1_000_000n }), assets: {} }]);
    await expect(
      submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, addrFor(CREATOR_KEY_HASH), 100n, 199_999n),
    ).rejects.toThrow(/below the on-chain floor/);
  });

  it('defaults platformClaimFeeLovelace to the minimum floor when omitted', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ creator_fees_accrued: 1_000_000n }), assets: {} }]);
    await submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, addrFor(CREATOR_KEY_HASH), 100n);
    const redeemer = calls.collectFrom![1] as { fields: unknown[] };
    expect(redeemer.fields[1]).toBe(200_000n);
  });

  it('rejects an amount exceeding accrued creator fees', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ creator_fees_accrued: 100n }), assets: {} }]);
    await expect(
      submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, addrFor(CREATOR_KEY_HASH), 101n, 200_000n),
    ).rejects.toThrow(/exceeds creator_fees_accrued/);
  });

  it('splits the platform claim fee 40% ops / 60% treasury and moves amount OUT while platformClaimFee moves IN', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ creator_fees_accrued: 1_000_000n }),
        assets: { lovelace: 5_000_000n },
      },
    ]);

    await submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, addrFor(CREATOR_KEY_HASH), 500_000n, 200_001n);

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.creator_fees_accrued).toBe(500_000n);
    // No split any more: the whole claim fee accrues to the one platform line.
    expect(payload.value.platform_fees_accrued).toBe(200_001n);
    const assetsArg = calls.payToContract![2] as Record<string, bigint>;
    expect(assetsArg.lovelace).toBe(5_000_000n - 500_000n + 200_001n);
  });

  it('claimCreatorFeesWithWallet signs via fromAPI/withWallet instead of a decrypted extended key', async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'creator-wallet' };
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ creator_fees_accrued: 1_000_000n }), assets: {} }]);
    await expect(submitter.claimCreatorFeesWithWallet(walletApi as never, 100n, 200_000n)).resolves.toEqual({
      txHash: 'tier-b-tx-1',
    });
  });
});

describe('LucidTierBCurveSubmitter.claimPlatformFees (governor-signed, single-direction)', () => {
  it('claimPlatformFees rejects amount exceeding platform_fees_accrued, and uses redeemer index 4', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ platform_fees_accrued: 50n }), assets: {} }]);
    await expect(submitter.claimPlatformFees(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)), 51n)).rejects.toThrow(
      /exceeds platform_fees_accrued/,
    );
  });

  it('claimPlatformFees pays out and decrements platform_fees_accrued, redeemer index 4', async () => {
    const { builder, calls, payToAddressCalls } = makeFakeTxBuilder();
    const governorAddr = addrFor(fakeKeyHash(0x22));
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ platform_fees_accrued: 1000n }),
        assets: { lovelace: 5_000_000n },
      },
    ]);

    await submitter.claimPlatformFees(REAL_EXTENDED_KEY_HEX, governorAddr, 400n);

    const redeemer = calls.collectFrom![1] as {
      index: number;
      fields: unknown[];
    };
    expect(redeemer.index).toBe(4);
    expect(redeemer.fields).toEqual([400n]);
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.platform_fees_accrued).toBe(600n);
    const assetsArg = calls.payToContract![2] as Record<string, bigint>;
    expect(assetsArg.lovelace).toBe(4_999_600n); // 5,000,000 - 400
    const [addr, datum, payoutAssets] = payToAddressCalls[0] as [string, InlineDatumArg, Record<string, bigint>];
    expect(addr).toBe(governorAddr);
    expect(payoutAssets.lovelace).toBe(400n);
    // The payout names the spend it settles. Without the tag the validator
    // does not see a payout at all, so this is not decoration.
    expect(datum).toEqual(settlesCurveInput(0));
  });
});

describe('LucidTierBCurveSubmitter.expireCurve', () => {
  it('rejects a curve that is neither Active nor Inactive', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Cancelled' }), assets: {} }]);
    await expect(submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)))).rejects.toThrow(
      /Curve is Cancelled/,
    );
  });

  it('refuses a curve inside the DarkVeil claim window, which the validator refuses too', async () => {
    // Not stranded: ActivateCurve out of DvClaim is permissionless once the
    // windows pass. Expiring it would cancel allocations registrants have
    // already paid bonds for.
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'DvClaim' }), assets: {} }]);
    await expect(submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)))).rejects.toThrow(
      /Curve is DvClaim/,
    );
  });

  it('expires a curve that was minted and never activated', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Inactive' }), assets: {} }]);
    await submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)));
    const payload = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(payload.value.curve_state).toBe('Cancelled');
  });

  it('sets curve_state to Cancelled and requires no signer at all (permissionless)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await submitter.expireCurve(REAL_EXTENDED_KEY_HEX, addrFor(fakeKeyHash(0x11)));
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.curve_state).toBe('Cancelled');
    expect(calls.addSigner).toBeUndefined();
  });
});

describe('LucidTierBCurveSubmitter.claimBuyback', () => {
  it('rejects when the curve is not Cancelled', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [{ datum: baseDatum({ curve_state: 'Active' }), assets: {} }]);
    await expect(submitter.claimBuyback('mnemonic', 10n)).rejects.toThrow(/Curve is not Cancelled/);
  });

  it('floors effectiveTotalRaised at 0 when total_raised is negative', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Cancelled',
          tokens_sold: 100n,
          total_raised: -500n,
        }),
        assets: { lovelace: 10_000_000n },
      },
    ]);
    const result = await submitter.claimBuyback('mnemonic', 10n);
    expect(result.share).toBe(0n);
  });

  it('computes a real proportional share (redeemer index 7)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_state: 'Cancelled',
          tokens_sold: 100n,
          total_raised: 1000n,
        }),
        assets: { lovelace: 10_000_000n },
      },
    ]);
    const result = await submitter.claimBuyback('mnemonic', 25n);
    expect(result.share).toBe(250n);
    const redeemer = calls.collectFrom![1] as { index: number };
    expect(redeemer.index).toBe(7);
  });
});
