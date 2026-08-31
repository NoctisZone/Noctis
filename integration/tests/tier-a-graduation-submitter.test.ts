// Tests for tier-a-graduation-submitter.ts's TierAGraduationSubmitter — the
// two-transaction graduation flow (split after a real Preprod tx-size
// overflow) — TX1 = Graduate (bonding_curve) + SealLock (lp_escrow) in one
// tx, TX2 = StartVesting (vesting) separately, awaited between. Covers the
// real value-movement invariants this file's own header derives from each
// contract's helper functions (graduation_funds_left_curve,
// lp_seeding_output_ok) and the total_raised > 0 precondition. Same
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
import { TierAGraduationSubmitter } from '../tier-a-graduation-submitter.js';
import { type ThreadNftRole, threadNftAssetName } from '../tier-a-schemas.js';

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
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-grad-1'));
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_ASSET_NAME;
const GOVERNOR_ADDR = addrFor(fakeKeyHash(0x11));
const THREAD_POLICY = 'cc'.repeat(28);

/** The unit a real launch's state UTXO carries for one role. */
const threadNft = (role: ThreadNftRole) => THREAD_POLICY + threadNftAssetName(role, LAUNCH_ID_HEX);

function curveDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    curve_state: 'Graduated',
    total_raised: 10_000_000n,
    lp_reserve_tokens: 150_000_000n,
    staking_reserve_tokens: 250_000_000n,
    lp_seeded: false,
    staking_seeded: false,
    staking_enabled: false,
    creator_pub_key_hash: fakeKeyHash(0x22),
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function lpDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    lock_timestamp: 0n,
    lp_state: 'Unlocked',
    lp_token_amount: 150_000_000n,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function vestDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    vesting_state: 'NotStarted',
    vest_start_timestamp: 0n,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const collectFromCalls: unknown[][] = [];
  const attachCalls: unknown[][] = [];
  const payToContractCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    collectFromCalls.push(a);
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
      attachCalls.push(a);
      return builder;
    }),
  };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      payToContractCalls.push(a);
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn((...a: unknown[]) => {
    calls.complete = a;
    return Promise.resolve({
      sign: {
        withPrivateKey: () => ({
          complete: vi.fn().mockResolvedValue({
            submit: vi.fn().mockResolvedValue(nextTxHash()),
          }),
        }),
      },
    });
  });
  return { builder, calls, collectFromCalls, attachCalls, payToContractCalls };
}

let txHashCounter = 0;
function nextTxHash() {
  txHashCounter++;
  return `grad-tx-${txHashCounter}`;
}

const addressRefs = { curve: '', lp: '', vesting: '', stakingPool: '' };

/** A pool fixture datum, in the Pool-variant wrapping the real datum uses. */
function poolDatum(overrides: Record<string, unknown> = {}) {
  return {
    Pool: [
      {
        launch_id: LAUNCH_ID_HEX,
        creator_pub_key_hash: fakeKeyHash(0x22),
        thread_nft_policy: THREAD_POLICY,
        ...overrides,
      },
    ],
  };
}

interface FixtureUtxo {
  datum: unknown;
  assets: Record<string, bigint>;
  /** Opt out of the thread NFT, to describe a UTXO that genuinely lacks one. */
  noThreadNft?: boolean;
  txHash?: string;
}

/**
 * Every state UTXO a real launch has carries its role's thread NFT — that is
 * what the lookup authenticates on, and no launch has produced one without it
 * since the NFTs were introduced. Added here rather than in each fixture so a
 * test says only what it is actually about, and merged UNDER the fixture's own
 * assets so an explicit value still wins.
 */
function asChainUtxos(role: ThreadNftRole, utxos: FixtureUtxo[] | undefined) {
  return (utxos ?? []).map((u, i) => ({
    txHash: u.txHash ?? i.toString(16).padStart(2, '0').repeat(32),
    outputIndex: 0,
    ...u,
    assets: u.noThreadNft ? u.assets : { [threadNft(role)]: 1n, ...u.assets },
  }));
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    curveUtxos?: FixtureUtxo[];
    lpUtxos?: FixtureUtxo[];
    vestingUtxos?: FixtureUtxo[];
    stakingPoolUtxos?: FixtureUtxo[];
    /** Leave the reference pointers unset, to describe a misconfigured caller. */
    withoutRefs?: boolean;
  } = {},
) {
  const awaitTx = vi.fn().mockResolvedValue(true);
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      if (address === addressRefs.curve) return Promise.resolve(asChainUtxos('bondingCurve', opts.curveUtxos));
      if (address === addressRefs.lp) return Promise.resolve(asChainUtxos('lpEscrow', opts.lpUtxos));
      if (address === addressRefs.vesting) return Promise.resolve(asChainUtxos('vesting', opts.vestingUtxos));
      if (address === addressRefs.stakingPool)
        return Promise.resolve(asChainUtxos('stakingPool', opts.stakingPoolUtxos));
      return Promise.resolve([]);
    }),
    awaitTx,
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const refs = opts.withoutRefs
    ? {}
    : {
        bondingCurveRef: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: 'a1'.repeat(28) },
        lpEscrowRef: { txHash: 'cd'.repeat(32), outputIndex: 0, scriptHash: 'b2'.repeat(28) },
      };
  const submitter = new TierAGraduationSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    bondingCurveScriptCbor: '590001',
    lpEscrowScriptCbor: '590002',
    vestingScriptCbor: '590003',
    stakingPoolScriptCbor: '590004',
    ...refs,
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
  addressRefs.curve = (submitter as unknown as { bondingCurveAddress: string }).bondingCurveAddress;
  addressRefs.lp = (submitter as unknown as { lpEscrowAddress: string }).lpEscrowAddress;
  addressRefs.vesting = (submitter as unknown as { vestingAddress: string }).vestingAddress;
  addressRefs.stakingPool = (submitter as unknown as { stakingPoolAddress: string }).stakingPoolAddress;

  // TX1 executes through mesh-curve-spend.ts, which is tested against real
  // transaction bytes in its own file — here the execution parts are stubbed
  // so these tests assert the PLAN the submitter authors, which is where all
  // of its arithmetic and datum work lands.
  const submitGraduation = vi.fn().mockImplementation(() => Promise.resolve(nextTxHash()));
  (submitter as unknown as { meshParts: unknown }).meshParts = vi
    .fn()
    .mockResolvedValue({ spender: { submitGraduation }, wallet: {}, coSigners: [] });

  return { submitter, fakeLucid, submitGraduation };
}

/** The plan the (stubbed) spender was handed. */
function planOf(submitGraduation: ReturnType<typeof vi.fn>) {
  expect(submitGraduation).toHaveBeenCalledTimes(1);
  return submitGraduation.mock.calls[0]?.[0] as import('../mesh-curve-spend.js').GraduationSpendPlan;
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
  txHashCounter = 0;
});

// bonding_curve.ak, lp_escrow.ak and vesting.ak are all unparameterized, so
// every launch's UTXO of each kind sits at one shared address and anyone can
// pay another one there with any datum they care to write. Matching the datum's
// launch_id alone matched that claim.
describe('TierAGraduationSubmitter — which UTXO it graduates', () => {
  it('refuses a curve UTXO that claims the launch but carries no thread NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {}, noThreadNft: true }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* bondingCurve thread NFT/,
    );
  });

  it('graduates the genuine curve when a forged one is planted beside it', async () => {
    // A forger can mint under their own policy and name it in their own datum,
    // which satisfies any token check derived from that datum. It does not
    // satisfy one derived from the policy the platform recorded at mint, so
    // the planted UTXO is not a candidate and the real one is chosen outright.
    const { builder } = makeFakeTxBuilder();
    const planted = {
      datum: curveDatum({ thread_nft_policy: 'ee'.repeat(28) }),
      assets: { ['ee'.repeat(28) + threadNftAssetName('bondingCurve', LAUNCH_ID_HEX)]: 1n },
      noThreadNft: true,
      txHash: '22'.repeat(32),
    };
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      // Planted FIRST: the shape this replaced took the first match, and
      // provider ordering is not something an honest caller controls.
      curveUtxos: [planted, { datum: curveDatum(), assets: {}, txHash: '11'.repeat(32) }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    expect(planOf(submitGraduation).scriptUtxo.txHash).toBe('11'.repeat(32));
  });

  it('still refuses when two UTXOs both carry the genuine thread NFT', async () => {
    // Unreachable while the thread NFT policy is one-shot — which is a property
    // of that policy, not of the lookup, so the lookup keeps its own guard.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        { datum: curveDatum(), assets: {}, txHash: '11'.repeat(32) },
        { datum: curveDatum(), assets: {}, txHash: '22'.repeat(32) },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Refusing to guess/,
    );
  });

  it('refuses an LP escrow UTXO with no thread NFT, not only the curve', async () => {
    // Each of the three addresses is looked up separately, so each needs its
    // own evidence — a check that reached only the first would still leave the
    // other two selecting on a claim.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {}, noThreadNft: true }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* lpEscrow thread NFT/,
    );
  });

  it('refuses a vesting UTXO with no thread NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {}, noThreadNft: true }],
    });
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* vesting thread NFT/,
    );
  });

  it('ignores another launch’s UTXO sitting at the same address', async () => {
    const { builder } = makeFakeTxBuilder();
    const otherLaunch = toHex(new TextEncoder().encode('launch-grad-2'));
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({ launch_id: otherLaunch }),
          assets: { [THREAD_POLICY + threadNftAssetName('bondingCurve', otherLaunch)]: 1n },
          noThreadNft: true,
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* bondingCurve thread NFT/,
    );
  });
});

describe('TierAGraduationSubmitter.graduateAndSealLp — guard rails', () => {
  it('rejects when the curve is not Graduated', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ curve_state: 'Active' }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Curve is not Graduated/,
    );
  });

  it('rejects when Graduate already ran (lp_seeded or staking_seeded already true)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ lp_seeded: true }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Graduate already ran/,
    );
  });

  it('rejects when SealLock already ran (lock_timestamp already set)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum({ lock_timestamp: 12345n }), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /SealLock already ran/,
    );
  });

  it('rejects when total_raised is not positive (a heavily-net-sold curve reaching 100% should not seed a zero/negative LP)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 0n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /total_raised .* is not positive/,
    );
  });
});

describe('TierAGraduationSubmitter.graduateAndSealLp — value movement', () => {
  it('moves lpAda + reserve tokens OUT of the curve and INTO lp_escrow, exactly, with both thread NFTs continuing (graduation_funds_left_curve / lp_seeding_output_ok)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            total_raised: 5_000_000n,
            lp_reserve_tokens: 100n,
            staking_reserve_tokens: 50n,
          }),
          assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      lpUtxos: [
        {
          datum: lpDatum({ lp_token_amount: 100n }),
          assets: { lovelace: 2_000_000n },
        },
      ],
    });

    const result = await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    expect(result.lpAda).toBe(5_000_000n);
    expect(result.lpReserveTokens).toBe(100n);
    expect(result.stakingReserveTokens).toBe(50n);
    expect(result.stakingSeeded).toBe(false);

    const plan = planOf(submitGraduation);
    expect(plan.continuing.assets.lovelace).toBe(15_000_000n); // 20,000,000 - 5,000,000
    expect(plan.continuing.assets[TOKEN_UNIT]).toBe(999_850n); // 1,000,000 - (100+50)
    // The curve's own thread NFT continues — the contract's seeding checks
    // authenticate every state output by its role's NFT, so an output built
    // from the movement amounts alone would not validate.
    expect(plan.continuing.assets[threadNft('bondingCurve')]).toBe(1n);
    const curveDatumOut = plan.continuing.datumCbor as unknown as Record<string, unknown>;
    expect(curveDatumOut.total_raised).toBe(0n);
    expect(curveDatumOut.lp_seeded).toBe(true);
    expect(curveDatumOut.staking_seeded).toBe(true);

    const lpPayout = plan.payouts[0];
    expect(lpPayout?.assets.lovelace).toBe(7_000_000n); // 2,000,000 + 5,000,000
    expect(lpPayout?.assets[TOKEN_UNIT]).toBe(100n); // exactly lp_token_amount
    expect(lpPayout?.assets[threadNft('lpEscrow')]).toBe(1n);
    const lpDatumOut = lpPayout?.datumCbor as unknown as Record<string, unknown>;
    expect(lpDatumOut.lock_timestamp).toBe(1_700_000_000n);
    expect(lpDatumOut.lp_state).toBe('Locked');
  });

  it('omits a token unit that computes to exactly zero (curve_own_output_clean / lp_own_output_clean)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            total_raised: 1n,
            lp_reserve_tokens: 100n,
            staking_reserve_tokens: 0n,
          }),
          assets: { lovelace: 10n, [TOKEN_UNIT]: 100n },
        },
      ],
      lpUtxos: [{ datum: lpDatum({ lp_token_amount: 0n }), assets: { lovelace: 0n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    const plan = planOf(submitGraduation);
    expect(plan.continuing.assets[TOKEN_UNIT]).toBeUndefined(); // 100 - 100 = 0, pruned
    expect(plan.payouts[0]?.assets[TOKEN_UNIT]).toBeUndefined(); // lp_token_amount 0, pruned
  });

  it('builds the Graduate (index 8, no fields) and SealLock (index 0, [timestamp, lpAda]) redeemers, with the timestamp inside a narrow validity range', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 42n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 999);

    const plan = planOf(submitGraduation);
    const graduateRedeemer = plan.redeemerCbor as unknown as { index: number; fields: unknown[] };
    expect(graduateRedeemer.index).toBe(8);
    expect(graduateRedeemer.fields).toEqual([]);

    const sealLockRedeemer = plan.companionInputs[0]?.redeemerCbor as unknown as {
      index: number;
      fields: unknown[];
    };
    expect(sealLockRedeemer.index).toBe(0);
    expect(sealLockRedeemer.fields).toEqual([999n, 42n]);
    // The redeemer's timestamp is bound to this range on chain, and the range
    // is capped at ten minutes wide. An absent or mismatched range would
    // otherwise pass unnoticed, which is exactly how this defect survived.
    expect(plan.validity).toBeDefined();
    expect(plan.validity?.fromMs).toBeLessThanOrEqual(999);
    expect(plan.validity?.toMs).toBeGreaterThanOrEqual(999);
    expect((plan.validity?.toMs ?? 0) - (plan.validity?.fromMs ?? 0)).toBeLessThanOrEqual(600_000);
  });

  it('spends only the curve and the LP escrow when the launch declined staking — no pool input, no required signer', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    const plan = planOf(submitGraduation);
    expect(plan.companionInputs).toHaveLength(1);
    expect('referenceScript' in plan.companionInputs[0]!.script).toBe(true);
    expect(plan.requiredSignerHashes).toEqual([]);
    expect(plan.payouts).toHaveLength(1);
  });

  it('refuses to build without both reference-script pointers', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      withoutRefs: true,
    });

    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /reference-script pointers/,
    );
  });
});

describe('TierAGraduationSubmitter — staking-enabled launches', () => {
  const stakingCurve = () =>
    curveDatum({
      staking_enabled: true,
      staking_reserve_tokens: 250n,
      lp_reserve_tokens: 100n,
      total_raised: 5_000_000n,
      creator_pub_key_hash: fakeKeyHash(0x22),
    });

  it('refuses to graduate without the creator signer — the pool seeding spend is creator-signed', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: stakingCurve(), assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000n } }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      stakingPoolUtxos: [{ datum: poolDatum(), assets: { lovelace: 1_200_000n } }],
    });

    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(/creator/i);
  });

  it('seeds the pool through TopUpPool: pool input carried, reserve tokens + NFT in its output, datum verbatim, creator as required signer', async () => {
    const { builder } = makeFakeTxBuilder();
    const poolFixtureDatum = poolDatum();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: stakingCurve(), assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000n } }],
      lpUtxos: [{ datum: lpDatum({ lp_token_amount: 100n }), assets: { lovelace: 2_000_000n } }],
      stakingPoolUtxos: [{ datum: poolFixtureDatum, assets: { lovelace: 1_200_000n } }],
    });

    const result = await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000, {
      address: addrFor(fakeKeyHash(0x22)),
      privateKeyExtendedHex: REAL_EXTENDED_KEY_HEX,
    });
    expect(result.stakingSeeded).toBe(true);

    const plan = planOf(submitGraduation);
    expect(plan.companionInputs).toHaveLength(2);

    const poolInput = plan.companionInputs[1]!;
    expect('embeddedScriptCbor' in poolInput.script).toBe(true);
    const topUp = poolInput.redeemerCbor as unknown as { index: number; fields: unknown[] };
    expect(topUp.index).toBe(2); // STAKING_POOL_REDEEMER.TopUpPool
    expect(topUp.fields).toEqual([250n]);

    const poolPayout = plan.payouts[1]!;
    expect(poolPayout.assets[TOKEN_UNIT]).toBe(250n); // exactly staking_reserve_tokens
    expect(poolPayout.assets[threadNft('stakingPool')]).toBe(1n);
    // TopUpPool requires the continuing datum unchanged — the input's own
    // datum is reused verbatim, never re-encoded.
    expect(poolPayout.datumCbor).toBe(poolFixtureDatum as never);
    // The pool gains a second asset, which raises its min-ada floor — the
    // output tops the lovelace up rather than risking a below-minimum output.
    expect(poolPayout.assets.lovelace).toBeGreaterThan(1_200_000n);

    expect(plan.requiredSignerHashes).toEqual([fakeKeyHash(0x22)]);

    // And the curve side still balances: both reserves leave it.
    expect(plan.continuing.assets[TOKEN_UNIT]).toBe(650n); // 1,000 - (100+250)
  });
});

describe('TierAGraduationSubmitter.startVesting', () => {
  it('rejects when vesting is not NotStarted', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }],
    });
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /StartVesting already ran/,
    );
  });

  it('transitions to Vesting and stamps vest_start_timestamp (POSIX seconds)', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });

    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const [, payload] = payToContractCalls[0] as [string, { value: Record<string, unknown> }];
    expect(payload.value.vesting_state).toBe('Vesting');
    expect(payload.value.vest_start_timestamp).toBe(1_700_000_000n);
  });

  it("re-locks the vesting UTXO's own assets unchanged (StartVesting has no value-movement check at all)", async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const existingAssets = { lovelace: 2_000_000n, [TOKEN_UNIT]: 500n };
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: existingAssets }],
    });

    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);
    const [, , assetsArg] = payToContractCalls[0] as [string, unknown, Record<string, bigint>];
    // By value, not identity. The old assertion was `toBe(existingAssets)`,
    // which held only because the fixture object was handed straight back —
    // it would have passed just as well against a builder that never read the
    // UTXO. The thread NFT belongs in the expectation for the same reason it
    // belongs on the UTXO: re-locking "its own assets" has to carry it, or
    // the next lookup finds nothing.
    expect(assetsArg).toStrictEqual({ ...existingAssets, [threadNft('vesting')]: 1n });
  });

  it('requires the governor as signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });
    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);
    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
  });
});

describe('TierAGraduationSubmitter.graduate (sequencing convenience wrapper)', () => {
  it("runs graduateAndSealLp then awaits TX1 before starting TX2, returning both hashes and step1's figures", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, fakeLucid } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            total_raised: 777n,
            lp_reserve_tokens: 10n,
            staking_reserve_tokens: 5n,
          }),
          assets: {},
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });

    const result = await submitter.graduate(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    expect(fakeLucid.awaitTx).toHaveBeenCalledWith('grad-tx-1');
    expect(result.graduateSealLockTxHash).toBe('grad-tx-1');
    expect(result.startVestingTxHash).toBe('grad-tx-2');
    expect(result.lpAda).toBe(777n);
    expect(result.lpReserveTokens).toBe(10n);
    expect(result.stakingReserveTokens).toBe(5n);
  });

  it("wraps a TX2 failure with TX1's hash so a caller can retry only startVesting, not re-run graduate()", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 1n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      vestingUtxos: [{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }], // makes step2 fail
    });

    await expect(submitter.graduate(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /graduateAndSealLp succeeded \(txHash: grad-tx-1\) but startVesting failed.*Retry with startVesting\(\) directly/s,
    );
  });
});
