// Tests for darkveil-claim-submitter.ts's LucidDarkVeilClaimSubmitter — the
// real Cardano tx submitter for Cardano Launch's buyer-initiated ClaimDarkVeilTokens.
// This is real money movement (the buyer pays gross_payment for their
// DarkVeil allocation) gated by several distinct security checks (the
// creator-self-claim block, double-claim prevention, the 5% wallet cap,
// curve-state gating) that all live inline in one method, not as separately
// exported pure functions — so this test exercises them through the real
// method, with Lucid Evolution's own `Lucid()` factory and `Data.from/to`
// replaced (via importOriginal partial-mock) so no live Blockfrost/Cardano
// connection or real PlutusData CBOR round-trip is needed. Every other
// export from @lucid-evolution/lucid (Data.Object/Enum/Bytes/etc., Constr,
// toUnit, validatorToAddress, CredentialSchema) stays REAL — only the
// network-connecting factory and the two encode/decode entry points are
// swapped for an identity passthrough, so this test verifies OUR business
// logic (state checks, fee math, datum transition, redeemer args), not
// Lucid's own encoding correctness (a separate, mature library's concern).

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

import { credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { bytesToHex, CAP_EMPTY_ROOT, CapAccumulator } from '../cap-accumulator-tree.js';
import { feeFloor, fromHex, LucidDarkVeilClaimSubmitter, toHex } from '../darkveil-claim-submitter.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

/// Every fixture here starts from a curve nothing has been taken from, so the
/// accumulator is empty and the claimant proves their own empty slot — the
/// same state genesis writes.
function emptyCapState(): CapAccumulator {
  return new CapAccumulator();
}

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

// A claim is signed by the buyer, and the validator asks for exactly the key
// the leaf was built from — so the wallet's address has to be one that key
// controls, not a placeholder string. A payment key hash is 28 bytes; the
// 32-byte `fakeBytes` shape used elsewhere here is not one.
const BUYER_KEY_HASH = new Uint8Array(28).fill(0x77);
const BUYER_ADDRESS = credentialToAddress('Preprod', {
  type: 'Key',
  hash: Buffer.from(BUYER_KEY_HASH).toString('hex'),
});

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
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
      calls.payToAddress = a;
      return builder;
    }),
    // A settlement payout names the spend it settles, so it is built with
    // ToAddressWithData rather than ToAddress. Recorded under the same key so
    // a test can assert on the payout without caring which was used — and so
    // that a payout losing its tag shows up as a shape change here.
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
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('real-tx-hash-1'),
        }),
      }),
    },
  });
  return { builder, calls };
}

const CURVE_ADDR_UTXO_ASSETS = {
  lovelace: 5_000_000n,
  [`${'aa'.repeat(28)}${'42'.repeat(4)}`]: 1_000_000n,
};
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch1');
const LAUNCH_ID_HEX = toHex(LAUNCH_ID_BYTES);
// A real launch's state UTXOs each carry a thread NFT; without one the
// authenticated lookup refuses the UTXO, as it should.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('bondingCurveTierB', LAUNCH_ID_HEX);
// A real UTXO always has a reference, and settlement outputs are tagged with
// it — a fixture without one describes a UTXO the chain cannot produce, and
// hides every code path that reads it.
const withThreadNft = <T extends { assets?: Record<string, bigint> }>(list: T[]): T[] =>
  list.map((u, i) => ({
    txHash: 'fe'.repeat(32),
    outputIndex: i,
    ...u,
    assets: { [THREAD_UNIT]: 1n, ...(u.assets ?? {}) },
  }));

function baseDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    // The launch's own DarkVeil windows, at the production values these
    // fixtures assume elsewhere (a 24h claim window, a 30m dead window).
    dv_claim_window: 86_400_000n,
    dv_settlement_window: 1_800_000n,
    creator_pub_key_hash: 'creatorkeyhash',
    governor_pub_key_hash: 'govkeyhash',
    base_price: 100n,
    max_price: 1000n,
    curve_supply: 1_000_000n,
    curve_state: 'DvClaim',
    phase_started_at: 0n,
    tokens_sold: 0n,
    total_raised: 0n,
    creator_fees_accrued: 0n,
    platform_fees_accrued: 0n,
    wallet_cap: 50_000n,
    dv_allocation_root: 'root',
    dv_reserve_tokens: 150_000n,
    // Opened "now" so every test sits inside the 24h window.
    dv_claim_opened_at: BigInt(Date.now()),
    claimed_bits: '00',
    dv_settled: true,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    lp_escrow_credential: {},
    lp_reserve_tokens: 0n,
    lp_seeded: false,
    community_pub_key_hash: 'community',
    cto_triggered: false,
    staking_enabled: false,
    staking_pool_credential: {},
    staking_reserve_tokens: 0n,
    staking_seeded: false,
    // The cumulative cap's accumulator at genesis: every slot empty, matching
    // emptyCapState() below.
    cap_root: bytesToHex(CAP_EMPTY_ROOT),
    ...overrides,
  };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
) {
  const fakeLucid = {
    selectWallet: { fromAPI: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(withThreadNft(utxos)),
    wallet: () => ({ address: vi.fn().mockResolvedValue(BUYER_ADDRESS) }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return new LucidDarkVeilClaimSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    compiledScriptCbor: '590000', // arbitrary — validatorToAddress just needs valid-ish script CBOR
    launchId: LAUNCH_ID_BYTES,
    threadNftPolicyId: THREAD_POLICY,
  });
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('feeFloor / toHex / fromHex (pure helpers)', () => {
  it('feeFloor computes the floor of grossPayment * bps / 10000, matching verify_fee_slice', () => {
    expect(feeFloor(1_000_000n, 100n)).toBe(10_000n); // 1.0%
    expect(feeFloor(999n, 60n)).toBe(5n); // floors, doesn't round
  });

  it('toHex/fromHex round-trip a byte array', () => {
    const bytes = new Uint8Array([0x00, 0xab, 0xff]);
    expect(toHex(bytes)).toBe('00abff');
    expect(Array.from(fromHex('00abff'))).toEqual([0x00, 0xab, 0xff]);
  });
});

describe('LucidDarkVeilClaimSubmitter.claimDarkVeilTokens — guard rails', () => {
  it('rejects when the curve is not in the DarkVeil claim window', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ curve_state: 'Active' }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 100n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/not in the DarkVeil claim window/);
  });

  it('rejects a wallet that has already claimed (double-claim prevention)', async () => {
    const { builder } = makeFakeTxBuilder();
    const buyerKeyHash = BUYER_KEY_HASH;
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ claimed_bits: '80' }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 100n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/already claimed/);
  });

  it('blocks the creator from claiming their own launch', async () => {
    const { builder } = makeFakeTxBuilder();
    const creatorKeyHash = fakeBytes(3);
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ creator_pub_key_hash: toHex(creatorKeyHash) }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 100n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: creatorKeyHash,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/creator cannot claim/);
  });

  it('rejects a dvAmount of 0 or exceeding remaining supply', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ curve_supply: 1000n, tokens_sold: 900n }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 0n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/dvAmount out of range/);
    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 101n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/dvAmount out of range/);
  });

  it('rejects a claim larger than the per-transaction cap', async () => {
    // The cap bounds one transaction; the curve keeps no per-wallet history
    // to accumulate against. A DarkVeil allocation is fixed at DV close and
    // normally sits well under it.
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ wallet_cap: 5n }), assets: CURVE_ADDR_UTXO_ASSETS },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 10n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/Cumulative cap exceeded/);
  });

  it('throws when no curve UTXO matches the configured launchId', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ launch_id: 'a-different-launch' }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 10n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/carries launch/);
  });
});

describe('LucidDarkVeilClaimSubmitter.claimDarkVeilTokens — happy path', () => {
  it('computes gross payment at the flat base_price, floors both fee slices, and builds the tx with the correct redeemer/datum/payouts', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const buyerKeyHash = BUYER_KEY_HASH;
    const buyerKeyHashHex = toHex(buyerKeyHash);
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_supply: 1000n,
          tokens_sold: 0n,
          base_price: 100n,
          wallet_cap: 1000n,
        }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    const result = await submitter.claimDarkVeilTokens(
      {} as never,
      {
        dvAmount: 10n,
        salt: fakeBytes(9),
        merkleProof: [{ sibling: fakeBytes(11), goesLeft: true }],
        leafIndex: 0,
        buyerKeyHash,
      },
      emptyCapState(),
    );

    expect(result.txHash).toBe('real-tx-hash-1');

    // grossPayment = 10 * 100 = 1000; fees = 1.0%/0.6%/0.4% floored = 10/6/4
    const redeemer = calls.collectFrom![1] as {
      index: number;
      fields: unknown[];
    };
    expect(redeemer.index).toBe(2); // ClaimDarkVeilTokens constructor index
    expect(redeemer.fields[0]).toBe(10n); // dvAmount
    // The redeemer carries the allocation proof and the claimant — the fee
    // split is the contract's own computation, not a caller's claim.
    // dv_amount, salt, merkle_proof, buyer_key_hash, leaf_index,
    // current_timestamp, then the two cumulative-cap fields. Note the TWO
    // proofs: the allocation under dv_allocation_root, and the running total
    // under cap_root.
    expect(redeemer.fields).toHaveLength(8);
    expect(redeemer.fields[3]).toBe(buyerKeyHashHex); // buyerKeyHash
    expect(redeemer.fields[4]).toBe(0n); // leafIndex — selects this claimant's bit
    // current_timestamp, which the validator binds to the tx validity range
    // and checks against the 24-hour window.
    expect(typeof redeemer.fields[5]).toBe('bigint');
    const validFrom = calls.validFrom![0] as number;
    const validTo = calls.validTo![0] as number;
    expect(Number(redeemer.fields[5])).toBeGreaterThanOrEqual(validFrom);
    expect(Number(redeemer.fields[5])).toBeLessThanOrEqual(validTo);
    // Well inside the validator's own max_validity_range_width of 600_000 ms.
    expect(validTo - validFrom).toBeLessThan(600_000);

    const newDatum = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(newDatum.value.tokens_sold).toBe(10n);
    // gross 1000; creator 0.5% = 5, platform 1.0% = 10, so 15 in fees.
    expect(newDatum.value.total_raised).toBe(985n);
    expect(newDatum.value.creator_fees_accrued).toBe(5n);
    expect(newDatum.value.platform_fees_accrued).toBe(10n);
    expect(newDatum.value.claimed_bits).toBe('80');
    // A claim never moves the state: it settles inside the window and leaves
    // opening the public curve to ActivateCurve.
    expect(newDatum.value.curve_state).toBe('DvClaim');

    const buyerPayout = calls.payToAddress as unknown[];
    expect(buyerPayout[0]).toBe(BUYER_ADDRESS);
    // The delivery names the spend it settles. Without the tag the validator
    // does not see a delivery at all, so this is not decoration.
    expect(buyerPayout[1]).toEqual({
      kind: 'inline',
      value: { transaction_id: 'fe'.repeat(32), output_index: 0n },
    });
    expect((buyerPayout[2] as Record<string, bigint>)[`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]).toBe(10n);
  });

  it('never graduates the curve, and never settles past the DarkVeil allocation', async () => {
    // A claim is bounded by dv_reserve_tokens, which is strictly less than
    // curve_supply, so it cannot sell a curve through however large it is.
    // Graduation is the public curve's business alone.
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          curve_supply: 100n,
          dv_reserve_tokens: 100n,
          tokens_sold: 90n,
          wallet_cap: 100n,
        }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await submitter.claimDarkVeilTokens(
      {} as never,
      {
        dvAmount: 10n,
        salt: fakeBytes(1),
        merkleProof: [],
        leafIndex: 0,
        buyerKeyHash: BUYER_KEY_HASH,
      },
      emptyCapState(),
    );

    const newDatum = calls.payToContract![1] as { value: Record<string, unknown> };
    expect(newDatum.value.tokens_sold).toBe(100n);
    expect(newDatum.value.curve_state).toBe('DvClaim');

    // One token past the allocation is refused, even though curve_supply has
    // room for it.
    const { builder: b2 } = makeFakeTxBuilder();
    const s2 = makeSubmitter(b2, [
      {
        datum: baseDatum({ dv_reserve_tokens: 5n, wallet_cap: 100n }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);
    await expect(
      s2.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 6n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/exceed the DarkVeil allocation/);
  });

  it('refuses a claim once the 24-hour window has closed', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({
          // Opened just over 24 hours ago.
          dv_claim_opened_at: BigInt(Date.now()) - 86_400_001n,
        }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 10n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 0,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/claim window closed/);
  });

  it('refuses a leaf index outside the bitmap it was sized for', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, [
      { datum: baseDatum({ claimed_bits: '00' }), assets: CURVE_ADDR_UTXO_ASSETS },
    ]);

    await expect(
      submitter.claimDarkVeilTokens(
        {} as never,
        {
          dvAmount: 10n,
          salt: fakeBytes(1),
          merkleProof: [],
          leafIndex: 8,
          buyerKeyHash: BUYER_KEY_HASH,
        },
        emptyCapState(),
      ),
    ).rejects.toThrow(/out of range/);
  });

  it("signs with the buyer's own wallet API via selectWallet.fromAPI, not a fixed relayer key", async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'buyer-wallet-api' };
    const submitter = makeSubmitter(builder, [
      {
        datum: baseDatum({ wallet_cap: 1000n }),
        assets: CURVE_ADDR_UTXO_ASSETS,
      },
    ]);

    await submitter.claimDarkVeilTokens(
      walletApi as never,
      {
        dvAmount: 1n,
        salt: fakeBytes(1),
        merkleProof: [],
        leafIndex: 0,
        buyerKeyHash: BUYER_KEY_HASH,
      },
      emptyCapState(),
    );

    const fakeLucid = await vi.mocked(Lucid).mock.results[0].value;
    expect(fakeLucid.selectWallet.fromAPI).toHaveBeenCalledWith(walletApi);
  });
});
