// Tests for tier-b-graduation-submitter.ts's TierBGraduationSubmitter — a
// direct mirror of tier-a-graduation-submitter.ts's proven two-transaction
// graduation flow, targeting bonding_curve_tier_b.ak instead of
// bonding_curve.ak. This file's own header flags the one thing genuinely
// worth testing distinctly from the linear curve version: Cardano Launch's DarkVeil-
// specific datum fields (dv_allocation_root, dv_claimed,
// dv_settled) must survive Graduate's `...curveDatum` spread untouched — a
// real schema-sync bug once dropped them. Same importOriginal
// partial-mock Lucid strategy as the other submitter tests.

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
import { bytesToHex } from '../cap-accumulator-tree.js';
import { STAKE_EMPTY_ROOT } from '../stake-accumulator-tree.js';
import { type ThreadNftRole, threadNftAssetName } from '../tier-a-schemas.js';
import { TierBGraduationSubmitter } from '../tier-b-graduation-submitter.js';

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
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-grad-b-1'));
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
    // Cardano Launch-only DarkVeil fields — must survive Graduate's spread unchanged.
    dv_allocation_root: toHex(new Uint8Array(32).fill(9)),
    dv_claimed: [fakeKeyHash(0x88)],
    dv_settled: true,
    thread_nft_policy: THREAD_POLICY,
    ...overrides,
  };
}

const STAKE_EMPTY_ROOT_HEX = bytesToHex(STAKE_EMPTY_ROOT);

function poolDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    creator_pub_key_hash: fakeKeyHash(0x22),
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    thread_nft_policy: THREAD_POLICY,
    emission_per_day: 25n,
    stake_root: STAKE_EMPTY_ROOT_HEX,
    acc_reward_per_token: 0n,
    total_staked: 0n,
    unallocated: 0n,
    last_update_ms: 500n,
    exhausted_at: null,
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
  const payToContractCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    collectFromCalls.push(a);
    return builder;
  });
  builder.attach = { SpendingValidator: vi.fn((..._a: unknown[]) => builder) };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      payToContractCalls.push(a);
      return builder;
    }),
  };
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return builder;
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return builder;
  });
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
  return { builder, calls, collectFromCalls, payToContractCalls };
}

let txHashCounter = 0;
function nextTxHash() {
  txHashCounter++;
  return `grad-b-tx-${txHashCounter}`;
}

const addressRefs = { curve: '', lp: '', vesting: '', stakingPool: '' };

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
  } = {},
) {
  const awaitTx = vi.fn().mockResolvedValue(true);
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      if (address === addressRefs.curve) return Promise.resolve(asChainUtxos('bondingCurveTierB', opts.curveUtxos));
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

  const submitter = new TierBGraduationSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    bondingCurveTierBScriptCbor: '590001',
    lpEscrowScriptCbor: '590002',
    vestingScriptCbor: '590003',
    stakingPoolScriptCbor: '590004',
    bondingCurveRef: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: 'a1'.repeat(28) },
    lpEscrowRef: { txHash: 'cd'.repeat(32), outputIndex: 0, scriptHash: 'b2'.repeat(28) },
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
  });
  addressRefs.curve = (submitter as unknown as { bondingCurveAddress: string }).bondingCurveAddress;
  addressRefs.lp = (submitter as unknown as { lpEscrowAddress: string }).lpEscrowAddress;
  addressRefs.vesting = (submitter as unknown as { vestingAddress: string }).vestingAddress;
  addressRefs.stakingPool = (submitter as unknown as { stakingPoolAddress: string }).stakingPoolAddress;

  // TX1 executes through mesh-curve-spend.ts, which is tested against real
  // transaction bytes in its own file — here the execution parts are stubbed
  // so these tests assert the PLAN the submitter authors.
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

// The lookup's own properties are covered against the linear curve. What is distinct
// here is the role tag: two Cardano curves are separate validators at
// separate addresses, but they are both "the curve", and their thread NFTs
// differ only by the role byte the asset name starts with.
describe('TierBGraduationSubmitter — which UTXO it graduates', () => {
  it('refuses a curve UTXO that claims the launch but carries no thread NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {}, noThreadNft: true }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* bondingCurveTierB thread NFT/,
    );
  });

  it('does not accept the linear curve curve NFT in place of a Cardano Launch one', async () => {
    // Same policy, same launch, same 31 bytes of launch id — only the leading
    // role byte differs. A lookup that checked the policy alone would take it.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum(),
          assets: { [threadNft('bondingCurve')]: 1n },
          noThreadNft: true,
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /carries launch .* bondingCurveTierB thread NFT/,
    );
  });

  it('graduates the genuine curve when a forged one is planted beside it', async () => {
    // The forged datum names the forger's own policy, so a token check built
    // from the datum accepts it. Built from the policy the platform recorded
    // at mint, it is not a candidate at all.
    const { builder } = makeFakeTxBuilder();
    const forgerPolicy = 'ee'.repeat(28);
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [
        // Planted first, because provider ordering is not the caller's to choose.
        {
          datum: curveDatum({ thread_nft_policy: forgerPolicy }),
          assets: { [forgerPolicy + threadNftAssetName('bondingCurveTierB', LAUNCH_ID_HEX)]: 1n },
          noThreadNft: true,
          txHash: '22'.repeat(32),
        },
        { datum: curveDatum(), assets: {}, txHash: '11'.repeat(32) },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);

    expect(planOf(submitGraduation).scriptUtxo.txHash).toBe('11'.repeat(32));
  });

  it('still refuses when two UTXOs both carry the genuine thread NFT', async () => {
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
});

describe('TierBGraduationSubmitter.graduateAndSealLp — guard rails (same as the linear curve)', () => {
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

  it('rejects when Graduate already ran, and when total_raised is not positive', async () => {
    const { builder: b1 } = makeFakeTxBuilder();
    const { submitter: s1 } = makeSubmitter(b1, {
      curveUtxos: [{ datum: curveDatum({ lp_seeded: true }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(s1.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /Graduate already ran/,
    );

    const { builder: b2 } = makeFakeTxBuilder();
    const { submitter: s2 } = makeSubmitter(b2, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 0n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await expect(s2.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /total_raised .* is not positive/,
    );
  });
});

describe('TierBGraduationSubmitter.graduateAndSealLp — Cardano Launch DarkVeil field preservation', () => {
  it('carries dv_allocation_root/dv_claimed/dv_settled through Graduate unchanged', async () => {
    const { builder } = makeFakeTxBuilder();
    const dvRoot = toHex(new Uint8Array(32).fill(42));
    const dvClaimed = [fakeKeyHash(0x11), fakeKeyHash(0x22)];
    const _identityPurchases = [[fakeKeyHash(0x33), 12345n]];
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({
            dv_allocation_root: dvRoot,
            dv_claimed: dvClaimed,
            dv_settled: true,
          }),
          assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const curvePayload = planOf(submitGraduation).continuing.datumCbor as unknown as Record<string, unknown>;
    expect(curvePayload.dv_allocation_root).toBe(dvRoot);
    expect(curvePayload.dv_claimed).toEqual(dvClaimed);
    expect(curvePayload.dv_settled).toBe(true);
    // The 3 fields Graduate DOES change:
    expect(curvePayload.total_raised).toBe(0n);
    expect(curvePayload.lp_seeded).toBe(true);
    expect(curvePayload.staking_seeded).toBe(true);
  });
});

describe('TierBGraduationSubmitter — SealLock/StartVesting are bound to a real validity range', () => {
  // lp_escrow.ak's SealLock and vesting.ak's StartVesting each bind their
  // timestamp through interval.contains(self.validity_range, ...), so a
  // builder that sets no range cannot satisfy either. This mirror shipped
  // without one, and stamped lock_timestamp from a seconds-scale value —
  // which is_lock_expired then adds an ms-scale lock_duration to. Both
  // halves are asserted here: the range exists and brackets the value, and
  // the value written into the datum is the one that was bracketed.
  const SEAL_MS = 1_775_000_000_000;

  it('SealLock: sets a range that brackets lock_timestamp, no wider than the cap', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, SEAL_MS);

    const plan = planOf(submitGraduation);
    expect(plan.validity?.fromMs).toBeLessThanOrEqual(SEAL_MS);
    expect(plan.validity?.toMs).toBeGreaterThanOrEqual(SEAL_MS);
    // max_validity_range_width in lp_escrow.ak, as a literal — expressing it
    // via the submitter's own 240_000 would scale with the bug it guards.
    expect((plan.validity?.toMs ?? 0) - (plan.validity?.fromMs ?? 0)).toBeLessThanOrEqual(600_000);

    const sealedDatum = plan.payouts[0]?.datumCbor as unknown as Record<string, unknown>;
    expect(sealedDatum.lock_timestamp).toBe(BigInt(SEAL_MS));
  });

  it('StartVesting: sets a range that brackets vest_start_timestamp', async () => {
    const { builder, calls, payToContractCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });

    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, SEAL_MS);

    const from = calls.validFrom?.[0] as number;
    const to = calls.validTo?.[0] as number;
    expect(from).toBeLessThanOrEqual(SEAL_MS);
    expect(to).toBeGreaterThanOrEqual(SEAL_MS);
    expect(to - from).toBeLessThanOrEqual(600_000);

    const vestedDatum = (payToContractCalls[0] as [string, { value: Record<string, unknown> }, unknown])[1].value;
    expect(vestedDatum.vest_start_timestamp).toBe(BigInt(SEAL_MS));
  });
});

describe('TierBGraduationSubmitter.graduateAndSealLp — value movement + redeemers', () => {
  it('moves lpAda + reserve tokens OUT of the curve and INTO lp_escrow exactly, redeemer indices 8/0', async () => {
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
    const plan = planOf(submitGraduation);
    expect(plan.continuing.assets.lovelace).toBe(15_000_000n);
    expect(plan.continuing.assets[TOKEN_UNIT]).toBe(999_850n);
    // The curve's thread NFT continues — the seeding checks authenticate
    // every state output by its role's NFT.
    expect(plan.continuing.assets[threadNft('bondingCurveTierB')]).toBe(1n);
    const lpPayout = plan.payouts[0];
    expect(lpPayout?.assets.lovelace).toBe(7_000_000n);
    expect(lpPayout?.assets[TOKEN_UNIT]).toBe(100n);
    expect(lpPayout?.assets[threadNft('lpEscrow')]).toBe(1n);

    expect((plan.redeemerCbor as unknown as { index: number }).index).toBe(8);
    expect((plan.companionInputs[0]?.redeemerCbor as unknown as { index: number } | undefined)?.index).toBe(0);
  });

  it('references the LP escrow validator and requires no signer on a staking-declined launch', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
    });
    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000);
    const plan = planOf(submitGraduation);
    expect(plan.companionInputs).toHaveLength(1);
    expect(plan.companionInputs[0] && 'referenceScript' in plan.companionInputs[0].script).toBe(true);
    expect(plan.requiredSignerHashes).toEqual([]);
  });
});

describe('TierBGraduationSubmitter.startVesting (shared vesting.ak)', () => {
  it('rejects when vesting is not NotStarted', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }],
    });
    await expect(submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /StartVesting already ran/,
    );
  });

  it('transitions to Vesting and stamps vest_start_timestamp', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      vestingUtxos: [{ datum: vestDatum(), assets: {} }],
    });
    await submitter.startVesting(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);
    const [, payload] = payToContractCalls[0] as [string, { value: Record<string, unknown> }];
    expect(payload.value.vesting_state).toBe('Vesting');
    expect(payload.value.vest_start_timestamp).toBe(1_700_000_000n);
  });
});

describe('TierBGraduationSubmitter.graduate (sequencing convenience wrapper)', () => {
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

    expect(fakeLucid.awaitTx).toHaveBeenCalledWith('grad-b-tx-1');
    expect(result.graduateSealLockTxHash).toBe('grad-b-tx-1');
    expect(result.startVestingTxHash).toBe('grad-b-tx-2');
    expect(result.lpAda).toBe(777n);
  });

  it("wraps a TX2 failure with TX1's hash", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum({ total_raised: 1n }), assets: {} }],
      lpUtxos: [{ datum: lpDatum(), assets: {} }],
      vestingUtxos: [{ datum: vestDatum({ vesting_state: 'Vesting' }), assets: {} }], // makes step2 fail
    });

    await expect(submitter.graduate(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1000)).rejects.toThrow(
      /graduateAndSealLp succeeded \(txHash: grad-b-tx-1\) but startVesting failed/,
    );
  });
});

describe('TierBGraduationSubmitter — staking-enabled launches', () => {
  // The quadratic curve seeds a staking pool exactly as the linear one does,
  // and until this suite existed that whole path had no test here at all.
  const stakingCurve = () =>
    curveDatum({
      staking_enabled: true,
      staking_reserve_tokens: 250n,
      lp_reserve_tokens: 100n,
      total_raised: 5_000_000n,
      creator_pub_key_hash: fakeKeyHash(0x22),
    });

  it('opens the pool on the clock BOTH contracts read, not the one that centres the window', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: stakingCurve(), assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000n } }],
      lpUtxos: [{ datum: lpDatum({ lp_token_amount: 100n }), assets: { lovelace: 2_000_000n } }],
      stakingPoolUtxos: [{ datum: poolDatum(), assets: { lovelace: 1_200_000n } }],
    });

    // Deliberately not a whole second, and deliberately not the value the pool
    // will be pinned to.
    const sealAt = 1_700_000_000_777;
    const result = await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, sealAt);
    expect(result.stakingSeeded).toBe(true);

    const plan = planOf(submitGraduation);
    const poolInput = plan.companionInputs[1]!;
    const topUp = poolInput.redeemerCbor as unknown as { index: number; fields: unknown[] };
    expect(topUp.index).toBe(3); // STAKING_POOL_REDEEMER.TopUpPool
    expect(topUp.fields).toEqual([250n]);
    // TopUpPool is permissionless — funding a pool needs nobody's approval.
    expect(plan.requiredSignerHashes).toEqual([]);

    const poolPayout = plan.payouts[1]!;
    expect(poolPayout.assets[TOKEN_UNIT]).toBe(250n);
    expect(poolPayout.assets[threadNft('stakingPool')]).toBe(1n);

    const opened = poolPayout.datumCbor as unknown as Record<string, unknown>;
    expect(opened.unallocated).toBe(250n);
    // The pool takes its own `now` from the validity range's LOWER bound and
    // pins this field to exactly that, while the curve only asks that the
    // timestamp fall inside the range. One value satisfies both, and it is
    // not the wall clock the window is centred on.
    const expectedNow = BigInt(Math.floor((sealAt - 240_000) / 1000) * 1000);
    expect(expectedNow).toBe(1_699_999_760_000n);
    expect(opened.last_update_ms).toBe(expectedNow);
    expect(BigInt(Math.floor((plan.validity?.fromMs ?? 0) / 1000) * 1000)).toBe(expectedNow);
    expect(opened.last_update_ms).not.toBe(BigInt(sealAt));

    // The rate is fixed at launch creation: funding extends the runway rather
    // than accelerating payouts.
    expect(opened.emission_per_day).toBe(25n);
    expect(opened.acc_reward_per_token).toBe(0n);
    expect(opened.exhausted_at).toBeNull();
    expect(plan.continuing.assets[TOKEN_UNIT]).toBe(650n); // 1,000 - (100 + 250)
  });
});
