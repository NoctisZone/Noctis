// Tests for tier-b-graduation-submitter.ts's TierBGraduationSubmitter.
//
// A Cardano Launch graduation opens a NoctisSwap pool, so one transaction has
// to satisfy four validators at once and the factory names two of its outputs
// BY INDEX. These tests assert the PLAN the submitter authors — the value on
// each of the four outputs, the datum the factory will rebuild and compare
// against, the mint, and the output indices the redeemer carries. What they
// deliberately do not assert is that the built transaction really puts those
// outputs where the plan says: that is a fact about the transaction builder,
// and mesh-curve-spend.test.ts checks it against real transaction bytes.
//
// Two things here have bitten for real and are pinned by name: Cardano
// Launch's DarkVeil fields (dv_allocation_root / dv_claimed / dv_settled)
// must survive Graduate's spread untouched, and the staking pool's opening
// datum must be stamped with the validity range's LOWER BOUND rather than the
// seal timestamp, because that is the clock the pool itself reads.
//
// Same importOriginal partial-mock Lucid strategy as the other submitter
// tests: `Data.to` is the identity, so a datum or redeemer reaches the plan as
// the object that was built rather than as CBOR.

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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CML, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { bytesToHex } from '../cap-accumulator-tree.js';
import { scriptHashOf } from '../reference-script.js';
import { STAKE_EMPTY_ROOT } from '../stake-accumulator-tree.js';
import { type ThreadNftRole, threadNftAssetName } from '../tier-a-schemas.js';
import { TierBGraduationSubmitter } from '../tier-b-graduation-submitter.js';
import { blake2b224Hex, VENUE_MAX_LQ_CAP, type VenueFactoryParameters, venueAssetName } from '../venue-pool.js';

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

// ---------------------------------------------------------------------------
// The venue, as a graduation has to be told about it.
//
// The factory's bytes are the real compiled `pool_mint`, UNAPPLIED — the
// applied form does not exist until its nine parameters are chosen, and what
// these tests need from it is a script that really hashes to a policy id.
// Everything the datum is built from comes from `VENUE` below, which is what
// the deployment record will hold.
// ---------------------------------------------------------------------------
const venueBlueprint: { validators: Array<{ title: string; compiledCode: string }> } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'plutus.json'), 'utf8'),
);
const FACTORY_CBOR = venueBlueprint.validators.find((v) => v.title === 'royalty_pool/pool_mint.pool_mint.mint')
  ?.compiledCode as string;
const FACTORY_POLICY = scriptHashOf(FACTORY_CBOR);
const CREATOR_PUB_KEY = 'c1'.repeat(32);
const VENUE: VenueFactoryParameters = {
  threadNftPolicy: THREAD_POLICY,
  poolValidatorHash: '0a'.repeat(28),
  redirectValidatorHash: '0e'.repeat(28),
  treasuryValidatorHash: '0c'.repeat(28),
  treasuryAddressHex: '0f'.repeat(29),
  feeNum: 99_900n,
  treasuryFee: 100n,
  royaltyFee: 1_000n,
  initialLq: 1_000_000_000n,
};
const POOL_NFT_UNIT = FACTORY_POLICY + venueAssetName('pool', LAUNCH_ID_HEX);
const LQ_UNIT = FACTORY_POLICY + venueAssetName('lq', LAUNCH_ID_HEX);

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
    // The factory this launch was minted against. Graduate looks for a pool
    // output carrying an NFT under exactly this policy.
    pool_nft_policy: FACTORY_POLICY,
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
    // The position is the venue pool's LQ token, and all three fields were
    // fixed at genesis: SealLock's equality check never rewrites them.
    lp_token_policy_id: FACTORY_POLICY,
    lp_token_name: venueAssetName('lq', LAUNCH_ID_HEX),
    lp_token_amount: VENUE.initialLq,
    fee_recipient_pub_key_hash: blake2b224Hex(CREATOR_PUB_KEY),
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
    venue: { factoryScriptCbor: FACTORY_CBOR, parameters: VENUE },
    creatorRoyaltyPubKeyHex: CREATOR_PUB_KEY,
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
  it('empties the raise and both reserves out of the curve, redeemer indices 8/0', async () => {
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
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
    });

    const result = await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    expect(result.lpAda).toBe(5_000_000n);
    const plan = planOf(submitGraduation);
    expect(plan.continuing.assets.lovelace).toBe(15_000_000n);
    expect(plan.continuing.assets[TOKEN_UNIT]).toBe(999_850n);
    // The curve's thread NFT continues — the seeding checks authenticate
    // every state output by its role's NFT.
    expect(plan.continuing.assets[threadNft('bondingCurveTierB')]).toBe(1n);

    expect((plan.redeemerCbor as unknown as { index: number }).index).toBe(8);
    expect((plan.companionInputs[0]?.redeemerCbor as unknown as { index: number } | undefined)?.index).toBe(0);
  });

  // The escrow's lovelace is the one figure on this path that CANNOT move:
  // `lp_value_received` compares the sealed output's lovelace with the input's
  // plus `seeded_ada`, and `seeded_ada` is zero because the raise went to the
  // pool. Both halves are asserted, because a submitter that sent the raise to
  // the pool AND declared it in the redeemer would build a transaction that
  // looks right and fails on an equality nothing names.
  it('seals the escrow with the LQ position alone, its lovelace untouched', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({ total_raised: 5_000_000n, lp_reserve_tokens: 100n, staking_reserve_tokens: 0n }),
          assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const plan = planOf(submitGraduation);
    const escrow = plan.payouts[0];
    expect(escrow?.assets.lovelace).toBe(2_000_000n);
    expect(escrow?.assets[LQ_UNIT]).toBe(VENUE.initialLq);
    expect(escrow?.assets[threadNft('lpEscrow')]).toBe(1n);
    // Three assets exactly — `lp_own_output_clean` allows no more.
    expect(Object.keys(escrow?.assets ?? {})).toHaveLength(3);
    // The launch token does NOT go to the escrow any more.
    expect(escrow?.assets[TOKEN_UNIT]).toBeUndefined();

    const sealLock = plan.companionInputs[0]?.redeemerCbor as unknown as { fields: unknown[] };
    expect(sealLock.fields[1]).toBe(0n);
  });

  it('opens the pool with the whole raise, the exact reserve, and four assets', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [
        {
          datum: curveDatum({ total_raised: 5_000_000n, lp_reserve_tokens: 100n, staking_reserve_tokens: 0n }),
          assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const pool = planOf(submitGraduation).payouts[1];
    expect(pool?.assets.lovelace).toBe(5_000_000n);
    expect(pool?.assets[TOKEN_UNIT]).toBe(100n);
    expect(pool?.assets[POOL_NFT_UNIT]).toBe(1n);
    // The pool keeps every LQ the escrow does not, so circulating liquidity
    // reads back as exactly the escrowed position.
    expect(pool?.assets[LQ_UNIT]).toBe(VENUE_MAX_LQ_CAP - VENUE.initialLq);
    expect(Object.keys(pool?.assets ?? {})).toHaveLength(4);
    // A bare script address: the factory refuses a stake part, so nobody can
    // delegate the pool's ADA for the pool's whole life.
    expect(pool?.address).toBe(credentialToAddress('Preprod', { type: 'Script', hash: VENUE.poolValidatorHash }));
  });

  it("writes the factory's own expected datum, counters and nonce at zero", async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n } }],
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const datum = planOf(submitGraduation).payouts[1]?.datumCbor as unknown as Record<string, unknown>;
    expect(datum.pool_nft).toEqual({ policy: FACTORY_POLICY, name: venueAssetName('pool', LAUNCH_ID_HEX) });
    expect(datum.pool_x).toEqual({ policy: '', name: '' });
    expect(datum.pool_y).toEqual({ policy: TOKEN_POLICY, name: TOKEN_ASSET_NAME });
    expect(datum.pool_lq).toEqual({ policy: FACTORY_POLICY, name: venueAssetName('lq', LAUNCH_ID_HEX) });
    expect(datum.fee_num).toBe(99_900n);
    expect(datum.treasury_fee).toBe(100n);
    expect(datum.royalty_fee).toBe(1_000n);
    expect([datum.treasury_x, datum.treasury_y, datum.royalty_x, datum.royalty_y, datum.nonce]).toEqual([
      0n,
      0n,
      0n,
      0n,
      0n,
    ]);
    // Treasury first, redirect second. The pool reads its treasury authority
    // from entry 0 and its governance authority from entry 1, so swapping
    // them lets either action be authorised by the other's script.
    expect(datum.dao_policy).toEqual([
      { StakingHash: [{ ScriptCredential: [VENUE.treasuryValidatorHash] }] },
      { StakingHash: [{ ScriptCredential: [VENUE.redirectValidatorHash] }] },
    ]);
    expect(datum.royalty_pub_key).toBe(CREATOR_PUB_KEY);
  });

  it('mints one pool NFT and the whole LQ supply, naming both outputs by index', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, submitGraduation } = makeSubmitter(builder, {
      curveUtxos: [{ datum: curveDatum(), assets: { lovelace: 20_000_000n, [TOKEN_UNIT]: 1_000_000n } }],
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
    });

    await submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000);

    const plan = planOf(submitGraduation);
    expect(plan.mint?.assets).toEqual([
      { assetNameHex: venueAssetName('pool', LAUNCH_ID_HEX), quantity: 1n },
      { assetNameHex: venueAssetName('lq', LAUNCH_ID_HEX), quantity: VENUE_MAX_LQ_CAP },
    ]);
    const create = plan.mint?.redeemerCbor as unknown as { index: number; fields: unknown[] };
    expect(create.index).toBe(0);
    // launch id, pool_out_ix, escrow_out_ix — and the indices must match where
    // the payouts above actually sit.
    expect(create.fields).toEqual([LAUNCH_ID_HEX, 2n, 1n]);
    expect(plan.expectedOutputs).toEqual([
      { index: 1, unit: LQ_UNIT, quantity: VENUE.initialLq },
      { index: 2, unit: POOL_NFT_UNIT, quantity: 1n },
    ]);
  });

  // Each of these is a rule some validator enforces with a message that names
  // neither the field nor the reason. Catching them at build time is the
  // difference between "this launch cannot graduate onto this factory" and an
  // opaque evaluation failure on a transaction that cost real fees to build.
  describe('the pre-flight checks', () => {
    const cases: [string, { curve?: Record<string, unknown>; lp?: Record<string, unknown> }, RegExp][] = [
      [
        'the launch was minted against a different factory',
        { curve: { pool_nft_policy: 'ab'.repeat(28) } },
        /minted against factory/,
      ],
      ['there is no launch-token reserve to open with', { curve: { lp_reserve_tokens: 0n } }, /lp_reserve_tokens is 0/],
      [
        'the escrow names a position this factory does not mint',
        { lp: { lp_token_amount: 7n } },
        /cannot graduate onto this factory/,
      ],
      [
        'the escrow names some other policy entirely',
        { lp: { lp_token_policy_id: 'ab'.repeat(28) } },
        /cannot graduate onto this factory/,
      ],
      [
        'the creator key does not hash to the recorded recipient',
        { lp: { fee_recipient_pub_key_hash: 'ee'.repeat(28) } },
        /does not hash to the fee recipient/,
      ],
    ];
    for (const [name, overrides, message] of cases) {
      it(`refuses when ${name}`, async () => {
        const { builder } = makeFakeTxBuilder();
        const { submitter } = makeSubmitter(builder, {
          curveUtxos: [{ datum: curveDatum(overrides.curve ?? {}), assets: { lovelace: 20_000_000n } }],
          lpUtxos: [{ datum: lpDatum(overrides.lp ?? {}), assets: { lovelace: 2_000_000n } }],
        });
        await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000)).rejects.toThrow(
          message,
        );
      });
    }

    it('refuses when the escrow already holds something a sealed output has no room for', async () => {
      const { builder } = makeFakeTxBuilder();
      const { submitter } = makeSubmitter(builder, {
        curveUtxos: [{ datum: curveDatum(), assets: { lovelace: 20_000_000n } }],
        lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n, [TOKEN_UNIT]: 5n } }],
      });
      await expect(submitter.graduateAndSealLp(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 1_700_000_000)).rejects.toThrow(
        /holds 3 assets/,
      );
    });
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
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2_000_000n } }],
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

    // Index 2, after the escrow (0) and the venue pool (1) — the staking
    // pool joins the payouts last, which is what keeps the two the factory
    // names by number where the factory expects them.
    const poolPayout = plan.payouts[2]!;
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
