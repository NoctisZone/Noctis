// Tests for tier-a-claims-submitter.ts's TierAClaimsSubmitter — the two
// creator-facing claims (vesting.ak's ClaimVested, bonding_curve.ak's
// ClaimCreatorFees), both creator-wallet-signed (ClaimVested requires
// the creator as a real signer, closing a real "any third party could
// redirect vested tokens" gap this file's header documents). Same
// importOriginal partial-mock Lucid strategy as the other submitter tests.

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
import { PLATFORM_CHARGE_LOVELACE, TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';
import { threadNftAssetName } from '../tier-a-schemas.js';

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
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-claims-1'));
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const vestingNftUnit = THREAD_POLICY + threadNftAssetName('vesting', LAUNCH_ID_HEX);
const curveNftUnit = THREAD_POLICY + threadNftAssetName('bondingCurve', LAUNCH_ID_HEX);
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const CREATOR_ADDR = addrFor(fakeKeyHash(0x11));

function vestingDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    vesting_state: 'Vesting',
    token_allocation: 1_000_000n,
    claimed_tokens: 0n,
    vest_start_timestamp: 0n,
    vest_seconds: 31_536_000n,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    ...overrides,
  };
}

function curveDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    cto_triggered: false,
    creator_fees_accrued: 1_000_000n,
    platform_fees_accrued: 0n,
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
  // These builders now set a validity range, because the redeemers they build
  // bind their timestamp to it. Recorded like every other call so a test can
  // assert the range actually brackets the timestamp it sent.
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
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
    // A settlement payout carries the reference of the input it settles, so
    // it is built with ToAddressWithData rather than ToAddress. Recorded into
    // the same list; the datum sits at index 1 and the assets at index 2.
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      payToAddressCalls.push(a);
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({
    sign: {
      withPrivateKey: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('claims-tx-1'),
        }),
      }),
      withWallet: () => ({
        complete: vi.fn().mockResolvedValue({
          submit: vi.fn().mockResolvedValue('claims-tx-1'),
        }),
      }),
    },
  });
  return { builder, calls, payToAddressCalls };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  vestingUtxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
  curveUtxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn(), fromAPI: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      // Two distinct script addresses (vesting vs. bonding_curve) resolve
      // to different fixed CBOR, so distinguish by which of the two
      // mocked address strings is passed; anything else (e.g. a creator's
      // own wallet address, used for coin selection) gets an empty list.
      // A real UTXO always has a reference, and a settlement output is tagged
      // with it — a fixture without one describes a UTXO the chain cannot make.
      const withNft = (list: Array<{ datum: unknown; assets: Record<string, bigint> }>, unit: string) =>
        list.map((u, i) => ({
          txHash: 'fe'.repeat(32),
          outputIndex: i,
          ...u,
          assets: { [unit]: 1n, ...u.assets },
        }));
      if (address === vestingAddressRef.current) return Promise.resolve(withNft(vestingUtxos, vestingNftUnit));
      if (address === curveAddressRef.current) return Promise.resolve(withNft(curveUtxos, curveNftUnit));
      return Promise.resolve([]);
    }),
    wallet: () => ({ address: vi.fn().mockResolvedValue(CREATOR_ADDR) }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const submitter = new TierAClaimsSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    vestingScriptCbor: '590001',
    bondingCurveScriptCbor: '590002',
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
  // Real validatorToAddress output for each distinct script CBOR — capture
  // once so the utxosAt mock above can distinguish the two real addresses.
  vestingAddressRef.current = (submitter as unknown as { vestingAddress: string }).vestingAddress;
  curveAddressRef.current = (submitter as unknown as { bondingCurveAddress: string }).bondingCurveAddress;

  return { submitter, fakeLucid };
}

// Mutable refs populated by makeSubmitter() before any utxosAt call happens.
const vestingAddressRef = { current: '' };
const curveAddressRef = { current: '' };

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('TierAClaimsSubmitter.readVestingDatum / readCurveDatum', () => {
  it('reads the vesting datum matching the configured launchIdHex', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: vestingDatum({ claimed_tokens: 500n }), assets: {} }], []);
    const result = await submitter.readVestingDatum();
    expect(result.claimed_tokens).toBe(500n);
  });

  it('reads the curve datum matching the configured launchIdHex', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [],
      [{ datum: curveDatum({ creator_fees_accrued: 777n }), assets: {} }],
    );
    const result = await submitter.readCurveDatum();
    expect(result.creator_fees_accrued).toBe(777n);
  });
});

describe('TierAClaimsSubmitter.claimVested', () => {
  it('rejects when vesting is not in the Vesting state', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [{ datum: vestingDatum({ vesting_state: 'FullyClaimed' }), assets: {} }],
      [],
    );
    await expect(submitter.claimVested(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, 1000)).rejects.toThrow(
      /not in the Vesting state/,
    );
  });

  it('transitions to FullyClaimed exactly when claimed_tokens reaches token_allocation', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: vestingDatum({
            token_allocation: 1000n,
            claimed_tokens: 900n,
          }),
          assets: { [`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]: 100n },
        },
      ],
      [],
    );

    await submitter.claimVested(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, 1000);

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.claimed_tokens).toBe(1000n);
    expect(payload.value.vesting_state).toBe('FullyClaimed');
  });

  it('stays in Vesting state when a partial claim does not reach full allocation', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: vestingDatum({
            token_allocation: 1000n,
            claimed_tokens: 100n,
          }),
          assets: { [`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]: 900n },
        },
      ],
      [],
    );

    await submitter.claimVested(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 200n, 1000);
    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.claimed_tokens).toBe(300n);
    expect(payload.value.vesting_state).toBe('Vesting');
  });

  it('prunes a token unit whose continuing balance computes to exactly zero (no explicit-zero ledger entries)', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: vestingDatum({ token_allocation: 100n, claimed_tokens: 0n }),
          assets: {
            lovelace: 2_000_000n,
            [`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]: 100n,
          },
        },
      ],
      [],
    );

    await submitter.claimVested(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, 1000);
    const [, , assetsArg] = calls.payToContract as [string, unknown, Record<string, bigint>];
    expect(assetsArg[`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]).toBeUndefined();
    expect(assetsArg.lovelace).toBe(2_000_000n);
  });

  it('pays the claimed tokens to the creator and requires the creator as signer', async () => {
    const { builder, calls, payToAddressCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [
        {
          datum: vestingDatum(),
          assets: { [`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]: 100n },
        },
      ],
      [],
    );

    await submitter.claimVested(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, 1000);
    expect(calls.addSigner).toEqual([CREATOR_ADDR]);
    const [addr, , assets] = payToAddressCalls[0] as [string, unknown, Record<string, bigint>];
    expect(addr).toBe(CREATOR_ADDR);
    expect(assets[`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]).toBe(100n);
    // The redeemer's timestamp is bound to this range on chain, and the range
    // is capped at ten minutes wide. Recording the calls is not enough -- a
    // mock that merely swallows validFrom would let an absent or mismatched
    // range pass unnoticed, which is exactly how this defect survived.
    const from = calls.validFrom?.[0] as number;
    const to = calls.validTo?.[0] as number;
    expect(from).toBeLessThanOrEqual(1000);
    expect(to).toBeGreaterThanOrEqual(1000);
    expect(to - from).toBeLessThanOrEqual(600_000);
  });

  it('claimVestedWithWallet signs via selectWallet.fromAPI + sign.withWallet', async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'creator-wallet' };
    const { submitter, fakeLucid } = makeSubmitter(
      builder,
      [
        {
          datum: vestingDatum(),
          assets: { [`${TOKEN_POLICY}${TOKEN_ASSET_NAME}`]: 100n },
        },
      ],
      [],
    );

    await submitter.claimVestedWithWallet(walletApi as never, 100n, 1000);
    expect(fakeLucid.selectWallet.fromAPI).toHaveBeenCalledWith(walletApi);
  });
});

describe('TierAClaimsSubmitter.claimCreatorFees', () => {
  it('rejects once the CTO has been triggered (fees now route to community wallet)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [], [{ datum: curveDatum({ cto_triggered: true }), assets: {} }]);
    await expect(
      submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, PLATFORM_CHARGE_LOVELACE),
    ).rejects.toThrow(/CTO has been triggered/);
  });

  it('rejects a claim amount exceeding accrued creator fees', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [],
      [{ datum: curveDatum({ creator_fees_accrued: 100n }), assets: {} }],
    );
    await expect(
      submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 101n, PLATFORM_CHARGE_LOVELACE),
    ).rejects.toThrow(/exceeds accrued creator fees/);
  });

  it('rejects a platformClaimFeeLovelace one lovelace below the charge the contract enforces', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [], [{ datum: curveDatum(), assets: {} }]);
    await expect(
      submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, PLATFORM_CHARGE_LOVELACE - 1n),
    ).rejects.toThrow(/below the charge the contract/);
  });

  it('accepts a platformClaimFeeLovelace exactly at the charge', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [], [{ datum: curveDatum(), assets: {} }]);
    await expect(
      submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, PLATFORM_CHARGE_LOVELACE),
    ).resolves.toEqual({
      txHash: 'claims-tx-1',
    });
  });

  it('accrues the whole platform claim fee to the single platform line and moves it INTO the curve while amount moves OUT', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(
      builder,
      [],
      [
        {
          datum: curveDatum({
            creator_fees_accrued: 1_000_000n,
            platform_fees_accrued: 0n,
          }),
          assets: { lovelace: 5_000_000n },
        },
      ],
    );

    await submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 500_000n, PLATFORM_CHARGE_LOVELACE + 1n); // one above the charge, odd to test remainder

    const payload = calls.payToContract![1] as {
      value: Record<string, unknown>;
    };
    expect(payload.value.creator_fees_accrued).toBe(500_000n); // 1,000,000 - 500,000 claimed
    // No split any more: the whole claim fee accrues to the one platform line.
    expect(payload.value.platform_fees_accrued).toBe(PLATFORM_CHARGE_LOVELACE + 1n);

    const assetsArg = calls.payToContract![2] as Record<string, bigint>;
    // lovelace: existing 5,000,000 - amount(500,000) + platformClaimFee(200,001)
    expect(assetsArg.lovelace).toBe(5_000_000n - 500_000n + (PLATFORM_CHARGE_LOVELACE + 1n));
  });

  it('pays the claimed amount to the creator and requires the creator as signer', async () => {
    const { builder, calls, payToAddressCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [], [{ datum: curveDatum(), assets: {} }]);

    await submitter.claimCreatorFees(REAL_EXTENDED_KEY_HEX, CREATOR_ADDR, 100n, PLATFORM_CHARGE_LOVELACE);
    expect(calls.addSigner).toEqual([CREATOR_ADDR]);
    const [addr, , assets] = payToAddressCalls[0] as [string, unknown, Record<string, bigint>];
    expect(addr).toBe(CREATOR_ADDR);
    expect(assets.lovelace).toBe(100n);
  });

  it('claimCreatorFeesWithWallet signs via selectWallet.fromAPI', async () => {
    const { builder } = makeFakeTxBuilder();
    const walletApi = { __marker: 'creator-wallet' };
    const { submitter, fakeLucid } = makeSubmitter(builder, [], [{ datum: curveDatum(), assets: {} }]);

    await submitter.claimCreatorFeesWithWallet(walletApi as never, 100n, PLATFORM_CHARGE_LOVELACE);
    expect(fakeLucid.selectWallet.fromAPI).toHaveBeenCalledWith(walletApi);
  });
});
