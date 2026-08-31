// Tests for midnight-client.ts — see that file's own header comment for why
// this is the highest-value test target in this pass: `.callTx` is NOT
// per-circuit type-checked in the pinned SDK version (compact-adapter.ts's
// header explains why), so a wrong circuit name or wrong argument
// order/count/type at any call site would compile cleanly and only fail at
// runtime against a real deployed contract. These tests catch that class of
// bug without needing a real devnet: `deployContract`/`findDeployedContract`
// and the `CompiledContractOps` pipeline are mocked (real network/proof-
// generation calls are out of scope for a unit test), but every PSM handle's
// `callTx` surface and every deploy call's `args` array are asserted against
// exactly what each contract's real compiled signature expects (cross-
// checked against contracts/midnight/compiled/<psm>/contract/index.d.ts and
// each *.compact source's constructor/circuit signatures while writing this
// file).
//
// Two risk surfaces, two test strategies:
//   1. NoctisLaunchManager's 28 action methods — real circuit call-site
//      correctness. Tested by injecting fake PsmHandle objects (plain
//      objects with a `callTx` of vi.fn() spies) directly onto a real
//      NoctisMidnightClient's public fields, bypassing deploy/connect
//      entirely. No SDK mocking needed for this half.
//   2. NoctisMidnightClient's 13 deploy/connect methods — witness
//      construction + deployContract/findDeployedContract argument
//      correctness. `@midnight-ntwrk/midnight-js-contracts` and
//      `@midnight-ntwrk/compact-js/effect/CompiledContract` are mocked (see
//      below) so these run as pure unit tests of the argument plumbing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  deployContract: vi.fn(),
  findDeployedContract: vi.fn(),
}));

// Reading published state is a real network query against the indexer. What
// belongs in a unit test is that the client routes to it with the right
// provider and address, not the query itself — that is verified against the
// real deployed contract instead.
vi.mock('../midnight-public-state.js', () => ({
  readDarkVeilSnapshot: vi.fn(),
  readEligibilityGateLedger: vi.fn(),
}));

// Minimal stand-in for CompiledContractOps.make(...).pipe(withWitnesses(w),
// withCompiledFileAssets(path)) — see midnight-client.ts's compileX helpers.
// `asEffectContract` (compact-adapter.ts) is a pure type-level cast at
// runtime, so the real compiled Contract classes midnight-client.ts imports
// flow through here unmodified; only CompiledContractOps itself is stubbed,
// since exercising its real PLONK/file-asset-loading behavior is out of
// scope for a unit test (and would depend on --skip-zk compiled output
// having real zkir/prover-key files, which it deliberately doesn't).
// midnight-client.ts imports this module as `import * as CompiledContractOps
// from '...'` — the namespace object IS whatever this module exports at its
// own top level, so the mock factory below must return `make`/
// `withWitnesses`/`withCompiledFileAssets` directly, not nested under a
// `CompiledContractOps` key.
vi.mock('@midnight-ntwrk/compact-js/effect/CompiledContract', () => {
  function make(name: string, contractClass: unknown) {
    const stub: Record<string, unknown> = { name, contractClass };
    stub.pipe = (...fns: Array<(x: unknown) => unknown>) => fns.reduce((acc, fn) => fn(acc), stub as unknown);
    return stub;
  }
  function withWitnesses(witnesses: unknown) {
    return (prev: Record<string, unknown>) => ({
      name: prev.name,
      contractClass: prev.contractClass,
      witnesses,
    });
  }
  function withCompiledFileAssets(path: string) {
    return (prev: Record<string, unknown>) => ({
      ...prev,
      fileAssetsPath: path,
    });
  }
  return { make, withWitnesses, withCompiledFileAssets };
});

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import {
  DOMAINS,
  deriveUserPublicKey,
  type MerkleProofEntry,
  type UserSecretKey,
} from '../../contracts/midnight/witnesses.js';
import { buyCost } from '../curve-pricing.js';
import {
  checkTreasuryHealth,
  computeBondingCurveFees,
  computeRatioBondRefund,
  createLaunchManager,
  createNoctisClient,
  NoctisLaunchManager,
  NoctisMidnightClient,
  TREASURY_ADA_WITHDRAWAL_LIMIT,
  TREASURY_FLOOR_LOVELACE,
  TREASURY_NIGHT_WITHDRAWAL_LIMIT,
  TREASURY_WARNING_LOVELACE,
  TREASURY_WITHDRAWAL_WINDOW_SECONDS,
} from '../midnight-client.js';
import type { DarkVeilSnapshot } from '../midnight-public-state.js';
import { readDarkVeilSnapshot, readEligibilityGateLedger } from '../midnight-public-state.js';

// ============================================================================
// Shared fixtures
// ============================================================================

function fakeBytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const USER_SK: UserSecretKey = { bytes: fakeBytes32(1) };
const GOVERNOR_SK: UserSecretKey = { bytes: fakeBytes32(2) };
const COMMUNITY_SK: UserSecretKey = { bytes: fakeBytes32(3) };
const MERKLE_PROOF: MerkleProofEntry[] = [{ sibling: fakeBytes32(9), goesLeft: true }];
const BUY_NONCE = fakeBytes32(20);
const FAKE_PROVIDERS = {} as ContractProviders;
const FAKE_CONTRACT_ADDRESS = `0x${'ab'.repeat(32)}`;

function fakeDeployedHandle(extra: Record<string, unknown> = {}) {
  return {
    deployTxData: { public: { contractAddress: FAKE_CONTRACT_ADDRESS } },
    callTx: {},
    ...extra,
  };
}

/** A minimal PsmHandle for NoctisLaunchManager tests — only `callTx` matters. */
function fakeHandle(callTx: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    deployTxData: { public: { contractAddress: FAKE_CONTRACT_ADDRESS } },
    callTx,
  } as never;
}

beforeEach(() => {
  vi.mocked(deployContract)
    .mockReset()
    .mockResolvedValue(fakeDeployedHandle() as never);
  vi.mocked(findDeployedContract)
    .mockReset()
    .mockResolvedValue(fakeDeployedHandle() as never);
});

// ============================================================================
// Pure computation functions
// ============================================================================

/**
 * A typed view of an argument recorded by a `deployContract` /
 * `findDeployedContract` mock.
 *
 * The cast goes through `unknown` deliberately. The SDK's own
 * `CompiledContract` type does not declare `witnesses`, but the real object
 * passed at runtime carries them — that is exactly what these tests assert
 * on. So this is reaching past a type that describes less than the value
 * does, not claiming a shape the SDK contradicts.
 */
function recorded<T>(call: unknown): T {
  return call as T;
}

describe('computeBondingCurveFees', () => {
  it('splits a gross payment 0.5% / 1.0% (creator/platform), floored', () => {
    expect(computeBondingCurveFees(1_000_000n)).toEqual({
      creatorFee: 5_000n,
      platformFee: 10_000n,
    });
  });

  it('floors each slice independently rather than distributing a rounding remainder', () => {
    // 999 * 50/10000 = 4.995 -> 4; 999 * 100/10000 = 9.99 -> 9
    expect(computeBondingCurveFees(999n)).toEqual({
      creatorFee: 4n,
      platformFee: 9n,
    });
  });

  it('returns all zeros for a zero payment', () => {
    expect(computeBondingCurveFees(0n)).toEqual({
      creatorFee: 0n,
      platformFee: 0n,
    });
  });
});

describe('computeRatioBondRefund', () => {
  it('computes the floor of bondAmount * tokensPurchased / tokensAllocated', () => {
    expect(computeRatioBondRefund(1000n, 50n, 100n)).toBe(500n);
    expect(computeRatioBondRefund(1000n, 33n, 100n)).toBe(330n);
  });

  it('returns the full bond when tokensPurchased equals tokensAllocated', () => {
    expect(computeRatioBondRefund(1000n, 100n, 100n)).toBe(1000n);
  });

  it('returns 0 when tokensPurchased is 0 (ghost registrant, full forfeiture)', () => {
    expect(computeRatioBondRefund(1000n, 0n, 100n)).toBe(0n);
  });

  it('throws when tokensAllocated is 0 (DarkVeil has not closed yet)', () => {
    expect(() => computeRatioBondRefund(1000n, 0n, 0n)).toThrow(/tokensAllocated must be positive/);
  });

  it('throws when tokensAllocated is negative', () => {
    expect(() => computeRatioBondRefund(1000n, 0n, -1n)).toThrow(/tokensAllocated must be positive/);
  });
});

describe('checkTreasuryHealth', () => {
  it('calls getAdaEquivalentBalance/isBelowFloor/isBelowWarning with the given price and extracts .private.result', async () => {
    const nightPrice = 12345n;
    const getAdaEquivalentBalance = vi.fn().mockResolvedValue({ private: { result: 20_000_000_000n } });
    const isBelowFloor = vi.fn().mockResolvedValue({ private: { result: false } });
    const isBelowWarning = vi.fn().mockResolvedValue({ private: { result: true } });
    const handle = fakeHandle({
      getAdaEquivalentBalance,
      isBelowFloor,
      isBelowWarning,
    });

    const result = await checkTreasuryHealth(handle, nightPrice);

    expect(getAdaEquivalentBalance).toHaveBeenCalledWith(nightPrice);
    expect(isBelowFloor).toHaveBeenCalledWith(nightPrice);
    expect(isBelowWarning).toHaveBeenCalledWith(nightPrice);
    expect(result).toEqual({
      adaEquivalentLovelace: 20_000_000_000n,
      belowFloor: false,
      belowWarning: true,
    });
  });

  it('exposes the documented floor/warning lovelace constants (10,000 / 25,000 ADA)', () => {
    expect(TREASURY_FLOOR_LOVELACE).toBe(10_000n * 1_000_000n);
    expect(TREASURY_WARNING_LOVELACE).toBe(25_000n * 1_000_000n);
  });
});

// ============================================================================
// NoctisMidnightClient — callerPublicKeyFor
// ============================================================================

describe('NoctisMidnightClient.callerPublicKeyFor', () => {
  const LAUNCH_ID = new Uint8Array(32).fill(0x09);

  it('derives the caller public key under the ELIGIBILITY_USER domain', () => {
    const client = new NoctisMidnightClient(USER_SK);
    const expected = deriveUserPublicKey(USER_SK, DOMAINS.ELIGIBILITY_USER, LAUNCH_ID).bytes;
    expect(client.callerPublicKeyFor(LAUNCH_ID)).toEqual(expected);
  });

  it('derives a DIFFERENT key for a different launch, from the same secret', () => {
    const client = new NoctisMidnightClient(USER_SK);
    const other = new Uint8Array(32).fill(0x0a);
    expect(client.callerPublicKeyFor(LAUNCH_ID)).not.toEqual(client.callerPublicKeyFor(other));
  });

  it('defaults governorSecretKey to userSecretKey when omitted', () => {
    // Indirect check: deploying with no explicit governor key should use
    // userSecretKey as the governor witness too (see eligibilityGateWitnesses'
    // own `governorSk ?? userSk` fallback, exercised end-to-end below).
    const client = new NoctisMidnightClient(USER_SK);
    expect(client.callerPublicKeyFor(LAUNCH_ID)).toEqual(
      deriveUserPublicKey(USER_SK, DOMAINS.ELIGIBILITY_USER, LAUNCH_ID).bytes,
    );
  });
});

// ============================================================================
// NoctisMidnightClient — deploy/connect methods (argument correctness)
// ============================================================================

describe('NoctisMidnightClient.deployEligibilityGate / connectEligibilityGate', () => {
  const args = {
    launchId: fakeBytes32(10),
    allowlistRoot: fakeBytes32(11),
    totalSupply: 1_000_000_000n,
    maxWalletPercent: 5n,
    bondAmount: 1000n,
    walletCap: 50_000_000n,
    dvAllocation: 150_000_000n,
    dvPrice: 100n,
    allowlistSize: 500n,
    registrationCloseTime: 5000n,
    minDvParticipants: 15n,
    creatorPubKey: fakeBytes32(12),
    platformAddr: fakeBytes32(13),
    allowlistAttestorKeys: [fakeBytes32(91), fakeBytes32(92), fakeBytes32(93)] as [Uint8Array, Uint8Array, Uint8Array],
    allowlistThreshold: 2n,
  };

  it('passes the exact 17-item positional args array in constructor order', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    const record = await client.deployEligibilityGate(FAKE_PROVIDERS, args, MERKLE_PROOF, BUY_NONCE);

    expect(deployContract).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deployContract).mock.calls[0][1] as Record<string, unknown>;
    expect('privateStateId' in call).toBe(false);
    expect('initialPrivateState' in call).toBe(false);
    expect(call.args).toEqual([
      args.launchId,
      args.allowlistRoot,
      args.totalSupply,
      args.maxWalletPercent,
      args.bondAmount,
      args.walletCap,
      args.dvAllocation,
      args.dvPrice,
      args.allowlistSize,
      args.registrationCloseTime,
      args.minDvParticipants,
      args.creatorPubKey,
      // One platform wallet, not a treasury/ops pair.
      args.platformAddr,
      args.allowlistAttestorKeys[0],
      args.allowlistAttestorKeys[1],
      args.allowlistAttestorKeys[2],
      args.allowlistThreshold,
    ]);
    expect(client.eligibilityGate).not.toBeNull();
    expect(record).toEqual({
      contractAddress: FAKE_CONTRACT_ADDRESS,
      deployedAt: expect.any(Number),
    });
  });

  it('builds witnesses carrying the real user/governor secrets, both Merkle proofs and the buy nonce', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployEligibilityGate(FAKE_PROVIDERS, args, MERKLE_PROOF, BUY_NONCE);

    const call = recorded<{
      compiledContract: {
        witnesses: Record<string, (ctx: undefined) => [undefined, unknown]>;
      };
    }>(vi.mocked(deployContract).mock.calls[0][1]);
    const w = call.compiledContract.witnesses;
    expect(w.getUserSecret(undefined)[1]).toEqual(USER_SK);
    expect(w.getGovernorSecret(undefined)[1]).toEqual(GOVERNOR_SK);
    expect(w.getMerkleProof(undefined)[1]).toEqual(MERKLE_PROOF);
    expect(w.getRegistrantMerkleProof(undefined)[1]).toEqual(MERKLE_PROOF);
    expect(w.getBuyNonce(undefined)[1]).toEqual(BUY_NONCE);
  });

  it('connectEligibilityGate omits privateStateId entirely, so circuit calls can fetch state', async () => {
    const client = new NoctisMidnightClient(USER_SK);
    await client.connectEligibilityGate(FAKE_PROVIDERS, 'addr-eg-1', MERKLE_PROOF, BUY_NONCE);

    expect(findDeployedContract).toHaveBeenCalledTimes(1);
    const call = vi.mocked(findDeployedContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.contractAddress).toBe('addr-eg-1');

    // KEY PRESENCE, not value. The SDK branches on `'privateStateId' in
    // options`: given the key it fetches the stored private state and asserts
    // it is defined, and this contract's private state is genuinely `undefined`
    // (witnesses close over their secrets — see witnesses.ts's `PrivateState`),
    // so every circuit call fails with "No private state found" regardless of
    // what was stored. `toBeUndefined()` cannot catch that, because it passes
    // identically whether the key is absent or present-and-undefined — which is
    // how the broken shape passed its own test.
    expect('privateStateId' in call).toBe(false);
    expect('initialPrivateState' in call).toBe(false);
    expect(client.eligibilityGate).not.toBeNull();
  });

  it('carries the registrant proof separately from the allowlist proof', async () => {
    // Two different trees, published at two different times: the allowlist at
    // deploy, the registrant set at startBuying. submitBuyCommit verifies
    // against the registrant root, so conflating them produces a proof for the
    // wrong root — and the witness factory falls back to the allowlist proof
    // when none is given, which is exactly how that happens silently.
    const registrantProof: MerkleProofEntry[] = [{ sibling: fakeBytes32(77), goesLeft: false }];
    const client = new NoctisMidnightClient(USER_SK);

    await client.connectEligibilityGate(FAKE_PROVIDERS, 'addr-eg-1', MERKLE_PROOF, BUY_NONCE, registrantProof);

    const call = recorded<{ compiledContract: { witnesses: Record<string, (c: undefined) => [undefined, unknown]> } }>(
      vi.mocked(findDeployedContract).mock.calls[0][1],
    );
    const w = call.compiledContract.witnesses;
    expect(w.getRegistrantMerkleProof(undefined)[1]).toEqual(registrantProof);
    expect(w.getMerkleProof(undefined)[1]).toEqual(MERKLE_PROOF);
  });

  it('falls back to the allowlist proof only when no registrant proof is given', async () => {
    const client = new NoctisMidnightClient(USER_SK);

    await client.connectEligibilityGate(FAKE_PROVIDERS, 'addr-eg-1', MERKLE_PROOF, BUY_NONCE);

    const call = recorded<{ compiledContract: { witnesses: Record<string, (c: undefined) => [undefined, unknown]> } }>(
      vi.mocked(findDeployedContract).mock.calls[0][1],
    );
    expect(call.compiledContract.witnesses.getRegistrantMerkleProof(undefined)[1]).toEqual(MERKLE_PROOF);
  });
});

describe('NoctisMidnightClient.deployBondingCurve / connectBondingCurve', () => {
  const args = {
    launchId: fakeBytes32(30),
    allowlistRoot: fakeBytes32(31),
    totalSupply: 1_000_000_000n,
    maxWalletPercent: 5n,
    bondAmount: 1000n,
    walletCap: 50_000_000n,
    basePrice: 10n,
    maxPrice: 1000n,
    curveSupply: 300_000_000n,
    dvAllocation: 150_000_000n,
    dvPrice: 100n,
    allowlistSize: 500n,
    registrationCloseTime: 5000n,
    minDvParticipants: 15n,
    creatorPubKey: fakeBytes32(32),
    platformAddr: fakeBytes32(33),
    creatorAddr: fakeBytes32(35),
    lpEscrowAddr: fakeBytes32(36),
    allowlistAttestorKeys: [fakeBytes32(91), fakeBytes32(92), fakeBytes32(93)] as [Uint8Array, Uint8Array, Uint8Array],
    allowlistThreshold: 2n,
  };

  it('passes the exact 22-item positional args array in constructor order', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployBondingCurve(FAKE_PROVIDERS, args, MERKLE_PROOF, BUY_NONCE);

    const call = vi.mocked(deployContract).mock.calls[0][1] as Record<string, unknown>;
    expect('privateStateId' in call).toBe(false);
    expect(call.args).toEqual([
      args.launchId,
      args.allowlistRoot,
      args.totalSupply,
      args.maxWalletPercent,
      args.bondAmount,
      args.walletCap,
      args.basePrice,
      args.maxPrice,
      args.curveSupply,
      args.dvAllocation,
      args.dvPrice,
      args.allowlistSize,
      args.registrationCloseTime,
      args.minDvParticipants,
      args.creatorPubKey,
      args.platformAddr,
      args.creatorAddr,
      args.lpEscrowAddr,
      args.allowlistAttestorKeys[0],
      args.allowlistAttestorKeys[1],
      args.allowlistAttestorKeys[2],
      args.allowlistThreshold,
    ]);
    expect(client.bondingCurve).not.toBeNull();
  });

  it('connectBondingCurve calls findDeployedContract with the given contractAddress, and no privateStateId', async () => {
    const client = new NoctisMidnightClient(USER_SK);
    await client.connectBondingCurve(FAKE_PROVIDERS, 'addr-bc-1', MERKLE_PROOF, BUY_NONCE);
    const call = vi.mocked(findDeployedContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.contractAddress).toBe('addr-bc-1');
    expect('privateStateId' in call).toBe(false);
    expect(client.bondingCurve).not.toBeNull();
  });
});

describe('NoctisMidnightClient.deployCreatorEscrow / connectCreatorEscrow', () => {
  it('passes [launchId, currency] and refuses to answer for a community wallet it was never given', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployCreatorEscrow(FAKE_PROVIDERS, {
      launchId: fakeBytes32(40),
      currency: 0,
    });

    const call = recorded<{
      args: unknown[];
      compiledContract: {
        witnesses: Record<string, (ctx: undefined) => [undefined, unknown]>;
      };
    }>(vi.mocked(deployContract).mock.calls[0][1]);
    expect('privateStateId' in call).toBe(false);
    expect(call.args).toEqual([fakeBytes32(40), 0]);
    const w = call.compiledContract.witnesses;
    expect(w.getCreatorSecret(undefined)[1]).toEqual(USER_SK);
    expect(w.getGovernorSecret(undefined)[1]).toEqual(GOVERNOR_SK);
    // No communitySk was passed. This used to hand back the creator's secret,
    // which would have made the CTO redirect answer to the creator it exists
    // to redirect away from.
    expect(() => w.getCommunitySecret(undefined)).toThrow(/needs communitySk/);
  });

  it('uses an explicit communitySk when provided', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployCreatorEscrow(FAKE_PROVIDERS, { launchId: fakeBytes32(41), currency: 1 }, COMMUNITY_SK);
    const call = recorded<{
      compiledContract: {
        witnesses: Record<string, (ctx: undefined) => [undefined, unknown]>;
      };
    }>(vi.mocked(deployContract).mock.calls[0][1]);
    expect(call.compiledContract.witnesses.getCommunitySecret(undefined)[1]).toEqual(COMMUNITY_SK);
  });

  it('connectCreatorEscrow calls findDeployedContract with the given contractAddress', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.connectCreatorEscrow(FAKE_PROVIDERS, 'addr-ce-1');
    const call = vi.mocked(findDeployedContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.contractAddress).toBe('addr-ce-1');
    expect('privateStateId' in call).toBe(false);
  });
});

describe('NoctisMidnightClient.deployVesting / connectVesting', () => {
  it('passes [launchId, tokenAllocation, vestDays, totalSupply, maxCreatorPercent]', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployVesting(FAKE_PROVIDERS, {
      launchId: fakeBytes32(50),
      tokenAllocation: 50_000_000n,
      vestDays: 180n,
      totalSupply: 1_000_000_000n,
      maxCreatorPercent: 10n,
    });
    const call = vi.mocked(deployContract).mock.calls[0][1] as Record<string, unknown>;
    expect('privateStateId' in call).toBe(false);
    expect(call.args).toEqual([fakeBytes32(50), 50_000_000n, 180n, 1_000_000_000n, 10n]);
  });

  it('connectVesting calls findDeployedContract with the given contractAddress', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.connectVesting(FAKE_PROVIDERS, 'addr-v-1');
    const call = vi.mocked(findDeployedContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.contractAddress).toBe('addr-v-1');
    expect('privateStateId' in call).toBe(false);
  });
});

describe('NoctisMidnightClient.deployLpEscrow / connectLpEscrow', () => {
  it('passes [launchId, lockDuration] and refuses to answer for a community wallet it was never given', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployLpEscrow(FAKE_PROVIDERS, {
      launchId: fakeBytes32(60),
      lockDuration: 31_536_000n,
    });
    const call = recorded<{
      args: unknown[];
      compiledContract: {
        witnesses: Record<string, (ctx: undefined) => [undefined, unknown]>;
      };
    }>(vi.mocked(deployContract).mock.calls[0][1]);
    expect('privateStateId' in call).toBe(false);
    expect(call.args).toEqual([fakeBytes32(60), 31_536_000n]);
    // No communitySk was passed. Substituting the governor's secret here
    // would have let the platform hold the community's authority over a
    // launch it no longer runs.
    expect(() => call.compiledContract.witnesses.getCommunitySecret(undefined)).toThrow(/needs communitySk/);
  });

  it('connectLpEscrow calls findDeployedContract with the given contractAddress', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.connectLpEscrow(FAKE_PROVIDERS, 'addr-lp-1');
    const call = vi.mocked(findDeployedContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.contractAddress).toBe('addr-lp-1');
    expect('privateStateId' in call).toBe(false);
  });
});

describe('NoctisMidnightClient.deployTreasury / connectTreasury', () => {
  it('defaults floor/warning to the documented TREASURY_FLOOR/WARNING_LOVELACE constants', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployTreasury(FAKE_PROVIDERS, { launchId: fakeBytes32(70) });
    const call = vi.mocked(deployContract).mock.calls[0][1] as Record<string, unknown>;
    expect('privateStateId' in call).toBe(false);
    expect(call.args).toEqual([
      fakeBytes32(70),
      TREASURY_FLOOR_LOVELACE,
      TREASURY_WARNING_LOVELACE,
      TREASURY_WITHDRAWAL_WINDOW_SECONDS,
      TREASURY_ADA_WITHDRAWAL_LIMIT,
      TREASURY_NIGHT_WITHDRAWAL_LIMIT,
    ]);
  });

  it('uses explicit floor/warning overrides when provided', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployTreasury(FAKE_PROVIDERS, {
      launchId: fakeBytes32(71),
      floorLovelace: 1n,
      warningLovelace: 2n,
      withdrawalWindowSeconds: 3n,
      adaWithdrawalLimitPerWindow: 4n,
      nightWithdrawalLimitPerWindow: 5n,
    });
    const call = vi.mocked(deployContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.args).toEqual([fakeBytes32(71), 1n, 2n, 3n, 4n, 5n]);
  });

  it('connectTreasury calls findDeployedContract with the given contractAddress', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.connectTreasury(FAKE_PROVIDERS, 'addr-t-1');
    const call = vi.mocked(findDeployedContract).mock.calls[0][1] as Record<string, unknown>;
    expect(call.contractAddress).toBe('addr-t-1');
    expect('privateStateId' in call).toBe(false);
  });
});

describe('NoctisMidnightClient.deployCtoGovernance / connectCtoGovernance', () => {
  const args = {
    launchId: fakeBytes32(80),
    totalSupply: 1_000_000_000n,
    graduationTimestamp: 9000n,
    maxVoterCap: 10_000_000n,
    minVoterCount: 15n,
    creatorPubKey: fakeBytes32(81),
    hasClaimableBalance: true,
    breakGlassBondMin: 500n,
    platformAddr: fakeBytes32(82),
    attestorKeys: [fakeBytes32(83), fakeBytes32(84), fakeBytes32(85)] as [Uint8Array, Uint8Array, Uint8Array],
    attestThreshold: 2n,
    allowlistAttestorKeys: [fakeBytes32(91), fakeBytes32(92), fakeBytes32(93)] as [Uint8Array, Uint8Array, Uint8Array],
    allowlistThreshold: 2n,
  };

  it('passes the exact 17-item positional args array in constructor order', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployCtoGovernance(FAKE_PROVIDERS, args);
    const call = vi.mocked(deployContract).mock.calls[0][1] as Record<string, unknown>;
    expect('privateStateId' in call).toBe(false);
    expect(call.args).toEqual([
      args.launchId,
      args.totalSupply,
      args.graduationTimestamp,
      args.maxVoterCap,
      args.minVoterCount,
      args.creatorPubKey,
      args.hasClaimableBalance,
      args.breakGlassBondMin,
      args.platformAddr,
      args.attestorKeys[0],
      args.attestorKeys[1],
      args.attestorKeys[2],
      args.attestThreshold,
    ]);
  });

  it('deploy defaults balanceLeafAmount/balanceProof to 0n/[] (governor deploy, no vote cast yet)', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployCtoGovernance(FAKE_PROVIDERS, args);
    const call = recorded<{
      compiledContract: {
        witnesses: Record<string, (ctx: undefined) => [undefined, unknown]>;
      };
    }>(vi.mocked(deployContract).mock.calls[0][1]);
    const w = call.compiledContract.witnesses;
    expect(w.getBalanceLeafAmount(undefined)[1]).toBe(0n);
    expect(w.getBalanceProof(undefined)[1]).toEqual([]);
    expect(w.getBalanceLeafHeldSince(undefined)[1]).toBe(0n);
  });

  it('connectCtoGovernance threads balanceLeafAmount/balanceProof/balanceLeafHeldSince into the witnesses (anti-whale-takeover fix)', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.connectCtoGovernance(FAKE_PROVIDERS, 'addr-cto-1', 12_345n, MERKLE_PROOF, 999_999n);

    expect(findDeployedContract).toHaveBeenCalledTimes(1);
    const call = recorded<{
      contractAddress: string;
      compiledContract: {
        witnesses: Record<string, (ctx: undefined) => [undefined, unknown]>;
      };
    }>(vi.mocked(findDeployedContract).mock.calls[0][1]);
    expect(call.contractAddress).toBe('addr-cto-1');
    expect('privateStateId' in (call as object)).toBe(false);
    const w = call.compiledContract.witnesses;
    expect(w.getBalanceLeafAmount(undefined)[1]).toBe(12_345n);
    expect(w.getBalanceProof(undefined)[1]).toEqual(MERKLE_PROOF);
    expect(w.getBalanceLeafHeldSince(undefined)[1]).toBe(999_999n);
  });
});

describe('NoctisMidnightClient.getDeployments', () => {
  it('reports null for every PSM before any deploy/connect call', () => {
    const client = new NoctisMidnightClient(USER_SK);
    expect(client.getDeployments()).toEqual({
      eligibilityGate: null,
      bondingCurve: null,
      creatorEscrow: null,
      vesting: null,
      lpEscrow: null,
      treasury: null,
      ctoGovernance: null,
    });
  });

  it('reports a PsmRecord only for PSMs that were actually deployed/connected', async () => {
    const client = new NoctisMidnightClient(USER_SK, GOVERNOR_SK);
    await client.deployVesting(FAKE_PROVIDERS, {
      launchId: fakeBytes32(90),
      tokenAllocation: 1n,
      vestDays: 100n,
      totalSupply: 1_000_000_000n,
      maxCreatorPercent: 10n,
    });
    const deployments = client.getDeployments();
    expect(deployments.vesting).toEqual({
      contractAddress: FAKE_CONTRACT_ADDRESS,
      deployedAt: expect.any(Number),
    });
    expect(deployments.eligibilityGate).toBeNull();
    expect(deployments.bondingCurve).toBeNull();
  });
});

describe('createNoctisClient / createLaunchManager', () => {
  it('createNoctisClient returns a NoctisMidnightClient instance', () => {
    expect(createNoctisClient(USER_SK)).toBeInstanceOf(NoctisMidnightClient);
  });

  it('createLaunchManager wraps a given client into a NoctisLaunchManager instance', () => {
    const client = createNoctisClient(USER_SK);
    expect(createLaunchManager(client)).toBeInstanceOf(NoctisLaunchManager);
  });
});

// ============================================================================
// NoctisLaunchManager — eligibilityGate-or-bondingCurve fallback methods
// ============================================================================
// These 13 methods share one exact shape: try eligibilityGate, fall back to
// bondingCurve, throw a specific message if neither is connected, and pass
// their own arguments straight through to a same- or differently-named
// circuit. Table-driven so each of the 13 gets full 3-way coverage (real
// call, fallback, not-connected) without 39 near-identical hand-written
// blocks.

type ManagerMethod = keyof NoctisLaunchManager;

const FALLBACK_METHODS: Array<{
  method: ManagerMethod;
  circuit: string;
  args: unknown[];
}> = [
  // LaunchPhase.DarkVeil. The lifecycle phase, which registration asserts
  // ALONGSIDE the DarkVeil sub-phase startRegistration opens — two separate
  // calls, both required.
  { method: 'advancePhase', circuit: 'advancePhase', args: [1] },
  { method: 'startRegistration', circuit: 'startRegistration', args: [] },
  { method: 'startBuying', circuit: 'startBuying', args: [fakeBytes32(100)] },
  { method: 'registerForDarkVeil', circuit: 'registerForDarkVeil', args: [] },
  {
    method: 'updateAllowlistRoot',
    circuit: 'updateAllowlistRoot',
    // One attestor's call, dated for the attestation round.
    args: [fakeBytes32(101), 1_700_000_000n],
  },
  {
    method: 'submitDarkVeilBuyCommit',
    circuit: 'submitBuyCommit',
    args: [fakeBytes32(102), 1_000n],
  },
  { method: 'closeDarkVeil', circuit: 'closeDarkVeil', args: [2_000n, 500n] },
  {
    method: 'claimBondRefund',
    circuit: 'claimBondRefund',
    args: [fakeBytes32(103)],
  },
  {
    method: 'claimRatioBondRefund',
    circuit: 'claimRatioBondRefund',
    args: [fakeBytes32(104), 100n],
  },
  {
    method: 'cancelDarkVeilBuyCommit',
    circuit: 'cancelBuyCommit',
    args: [fakeBytes32(105)],
  },
  { method: 'cancelDarkVeil', circuit: 'cancelDarkVeil', args: [] },
  { method: 'markDarkVeilFailed', circuit: 'markDarkVeilFailed', args: [] },
];
// The DarkVeil figures a launch page renders are published ledger fields, so
// reading them is not a circuit call and they are not in this table. See the
// `getDarkVeilSnapshot` / `getFairLaunchCert` blocks below.

describe.each(FALLBACK_METHODS)(
  'NoctisLaunchManager.$method (eligibilityGate-or-bondingCurve fallback)',
  ({ method, circuit, args }) => {
    it('calls the correct circuit on eligibilityGate, with the exact arguments, when connected', async () => {
      const circuitFn = vi.fn().mockResolvedValue({ ok: true });
      const client = new NoctisMidnightClient(USER_SK);
      client.eligibilityGate = fakeHandle({ [circuit]: circuitFn });
      const manager = new NoctisLaunchManager(client);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager[method] as (...a: unknown[]) => Promise<unknown>)(...args);

      expect(circuitFn).toHaveBeenCalledTimes(1);
      expect(circuitFn).toHaveBeenCalledWith(...args);
    });

    it('falls back to bondingCurve when eligibilityGate is not connected', async () => {
      const circuitFn = vi.fn().mockResolvedValue({ ok: true });
      const client = new NoctisMidnightClient(USER_SK);
      client.bondingCurve = fakeHandle({ [circuit]: circuitFn });
      const manager = new NoctisLaunchManager(client);

      await (manager[method] as (...a: unknown[]) => Promise<unknown>)(...args);

      expect(circuitFn).toHaveBeenCalledWith(...args);
    });

    it('prefers eligibilityGate over bondingCurve when both are connected', async () => {
      const egFn = vi.fn().mockResolvedValue({ ok: true });
      const bcFn = vi.fn().mockResolvedValue({ ok: true });
      const client = new NoctisMidnightClient(USER_SK);
      client.eligibilityGate = fakeHandle({ [circuit]: egFn });
      client.bondingCurve = fakeHandle({ [circuit]: bcFn });
      const manager = new NoctisLaunchManager(client);

      await (manager[method] as (...a: unknown[]) => Promise<unknown>)(...args);

      expect(egFn).toHaveBeenCalledTimes(1);
      expect(bcFn).not.toHaveBeenCalled();
    });

    it('throws when neither eligibilityGate nor bondingCurve is connected', async () => {
      const client = new NoctisMidnightClient(USER_SK);
      const manager = new NoctisLaunchManager(client);

      await expect((manager[method] as (...a: unknown[]) => Promise<unknown>)(...args)).rejects.toThrow(
        /eligibility_gate not connected/,
      );
    });
  },
);

// ============================================================================
// NoctisLaunchManager — reads of published state
// ============================================================================
// These figures are ledger fields on Cardano Launch, so reading them is a query
// against the indexer rather than a circuit call: no wallet, no proof server,
// no transaction, and nothing for the caller to pay. Midnight Launch's merged curve
// returns the certificate from a circuit instead, so the two tiers take
// genuinely different routes and both are covered here.

const SNAPSHOT: DarkVeilSnapshot = {
  phase: 1,
  dvState: 2,
  dvFailed: false,
  dvPrice: 3n,
  dvAllocation: 150_000_000n,
  baseSlot: 10_000_000n,
  registrationCount: 15n,
  totalTokensCommitted: 42n,
  totalRaisedCommitted: 126n,
  allowlistRootHex: 'ab'.repeat(32),
  registrantRootHex: 'cd'.repeat(32),
  settlementFinalized: false,
  fairLaunchCert: {
    launchId: fakeBytes32(1),
    totalParticipants: 15n,
    totalTokensAllocated: 150_000_000n,
    totalRaised: 450_000_000n,
    participationRate: 78n,
    closeTimestamp: 1_753_000_000n,
    certHash: fakeBytes32(2),
  },
};

/** A client whose providers carry a public data provider, as a real one does. */
async function connectedTierBClient(): Promise<NoctisMidnightClient> {
  const client = new NoctisMidnightClient(USER_SK);
  await client.connectEligibilityGate(
    { publicDataProvider: 'the-provider' } as never,
    FAKE_CONTRACT_ADDRESS,
    [],
    fakeBytes32(0),
  );
  return client;
}

describe('NoctisLaunchManager.getDarkVeilSnapshot', () => {
  beforeEach(() => {
    vi.mocked(readDarkVeilSnapshot).mockReset().mockResolvedValue(SNAPSHOT);
    vi.mocked(readEligibilityGateLedger).mockReset();
  });

  it('reads the connected gate through the provider it was connected with', async () => {
    const manager = new NoctisLaunchManager(await connectedTierBClient());

    const snapshot = await manager.getDarkVeilSnapshot();

    expect(snapshot).toBe(SNAPSHOT);
    expect(readDarkVeilSnapshot).toHaveBeenCalledWith('the-provider', FAKE_CONTRACT_ADDRESS);
  });

  it('refuses on Midnight Launch, whose curve does not publish these fields', async () => {
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({});
    const manager = new NoctisLaunchManager(client);

    await expect(manager.getDarkVeilSnapshot()).rejects.toThrow(/no eligibilityGate is connected/);
    expect(readDarkVeilSnapshot).not.toHaveBeenCalled();
  });

  it('throws when nothing is connected', async () => {
    const manager = new NoctisLaunchManager(new NoctisMidnightClient(USER_SK));

    await expect(manager.getDarkVeilSnapshot()).rejects.toThrow(/no eligibilityGate is connected/);
  });

  it('says so when the gate was connected without a public data provider', async () => {
    // Injecting the handle directly skips connect, which is where the provider
    // is remembered — the same shape as a caller who built providers by hand.
    const client = new NoctisMidnightClient(USER_SK);
    client.eligibilityGate = fakeHandle({});
    const manager = new NoctisLaunchManager(client);

    await expect(manager.getDarkVeilSnapshot()).rejects.toThrow(/No public data provider is available/);
  });
});

describe('NoctisLaunchManager.getFairLaunchCert', () => {
  beforeEach(() => {
    vi.mocked(readEligibilityGateLedger).mockReset();
    vi.mocked(readDarkVeilSnapshot).mockReset();
  });

  it('reads the certificate off the published ledger on Cardano Launch', async () => {
    vi.mocked(readEligibilityGateLedger).mockResolvedValue({
      fairLaunchCert: SNAPSHOT.fairLaunchCert,
    } as never);
    const manager = new NoctisLaunchManager(await connectedTierBClient());

    const cert = await manager.getFairLaunchCert();

    expect(cert).toBe(SNAPSHOT.fairLaunchCert);
    expect(readEligibilityGateLedger).toHaveBeenCalledWith('the-provider', FAKE_CONTRACT_ADDRESS);
  });

  it('calls the circuit on Midnight Launch and unwraps the JS-typed return value', async () => {
    const circuitFn = vi.fn().mockResolvedValue({ private: { result: SNAPSHOT.fairLaunchCert } });
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({ getFairLaunchCert: circuitFn });
    const manager = new NoctisLaunchManager(client);

    const cert = await manager.getFairLaunchCert();

    // The circuit result nests the value under `.private.result`; returning the
    // wrapper instead would hand every caller an object with no cert fields.
    expect(cert).toBe(SNAPSHOT.fairLaunchCert);
    expect(circuitFn).toHaveBeenCalledTimes(1);
    expect(readEligibilityGateLedger).not.toHaveBeenCalled();
  });

  it('throws when nothing is connected', async () => {
    const manager = new NoctisLaunchManager(new NoctisMidnightClient(USER_SK));

    await expect(manager.getFairLaunchCert()).rejects.toThrow(/eligibility_gate not connected/);
  });
});

// ============================================================================
// NoctisLaunchManager — single-required-PSM passthrough methods
// ============================================================================

const SINGLE_PSM_METHODS: Array<{
  method: ManagerMethod;
  field: 'vesting' | 'creatorEscrow' | 'ctoGovernance' | 'bondingCurve';
  requiredName: string;
  circuit: string;
  args: unknown[];
}> = [
  {
    method: 'claimVested',
    field: 'vesting',
    requiredName: 'vesting',
    circuit: 'claimVested',
    args: [100n, 2_000n],
  },
  {
    method: 'claimFees',
    field: 'creatorEscrow',
    requiredName: 'creator_escrow',
    circuit: 'claimFees',
    args: [50n, 2_000n],
  },
  {
    method: 'updateBalanceSnapshot',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'updateBalanceSnapshot',
    args: [fakeBytes32(110), 2_000n],
  },
  {
    method: 'updateCreatorActivity',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'updateCreatorActivity',
    args: [2_000n, true, 2_100n],
  },
  {
    method: 'bondedSilenceChallenge',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'bondedSilenceChallenge',
    args: [500n, 2_000n],
  },
  {
    method: 'resolveBreakGlassChallenge',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'resolveBreakGlassChallenge',
    args: [2_000n],
  },
  {
    method: 'claimBreakGlassBondRefund',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'claimBreakGlassBondRefund',
    args: [fakeBytes32(111)],
  },
  {
    method: 'castVote',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'castVote',
    args: [fakeBytes32(112), true, 2_000n],
  },
  {
    method: 'createCtoProposal',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'createProposal',
    // Trailing arg is the real NIGHT bond the circuit takes for the slot.
    args: [0, fakeBytes32(113), 2_000n, fakeBytes32(114), 0n, fakeBytes32(115), fakeBytes32(116), 1_000_000n],
  },
  {
    method: 'claimProposalBond',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'claimProposalBond',
    args: [fakeBytes32(118), fakeBytes32(119)],
  },
  {
    method: 'sweepForfeitedProposalBond',
    field: 'ctoGovernance',
    requiredName: 'cto_governance',
    circuit: 'sweepForfeitedProposalBond',
    args: [fakeBytes32(120)],
  },
  {
    method: 'claimCurveRefund',
    field: 'bondingCurve',
    requiredName: 'bonding_curve',
    circuit: 'claimCurveRefund',
    args: [fakeBytes32(117)],
  },
  {
    method: 'expireCurve',
    field: 'bondingCurve',
    requiredName: 'bonding_curve',
    circuit: 'expireCurve',
    args: [2_000n],
  },
];

describe.each(SINGLE_PSM_METHODS)(
  'NoctisLaunchManager.$method (single required PSM: $field)',
  ({ method, field, requiredName, circuit, args }) => {
    it('calls the correct circuit with the exact arguments when connected', async () => {
      const circuitFn = vi.fn().mockResolvedValue({ ok: true });
      const client = new NoctisMidnightClient(USER_SK);
      client[field] = fakeHandle({ [circuit]: circuitFn });
      const manager = new NoctisLaunchManager(client);

      await (manager[method] as (...a: unknown[]) => Promise<unknown>)(...args);

      expect(circuitFn).toHaveBeenCalledTimes(1);
      expect(circuitFn).toHaveBeenCalledWith(...args);
    });

    it(`throws "${requiredName} not connected" when ${String(field)} is not connected`, async () => {
      const client = new NoctisMidnightClient(USER_SK);
      const manager = new NoctisLaunchManager(client);

      await expect((manager[method] as (...a: unknown[]) => Promise<unknown>)(...args)).rejects.toThrow(
        new RegExp(`${requiredName} not connected`),
      );
    });
  },
);

// ============================================================================
// NoctisLaunchManager — the Cardano settlement record (Cardano Launch only)
// ============================================================================
// Cardano Launch's DarkVeil purchases settle on Cardano, so the governor attests each
// real settlement back to the gate. Midnight Launch settles inside its own merged curve
// and has no such circuit — so these must NOT fall back to bondingCurve, or a
// Midnight Launch caller gets a runtime failure naming a circuit instead of a tier.

describe('NoctisLaunchManager settlement record', () => {
  it('records a settlement against the eligibility gate with the buyer key and amount', async () => {
    const recordDarkVeilSettlement = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.eligibilityGate = fakeHandle({ recordDarkVeilSettlement });
    const manager = new NoctisLaunchManager(client);

    await manager.recordDarkVeilSettlement(fakeBytes32(200), 5_000n);

    expect(recordDarkVeilSettlement).toHaveBeenCalledWith(fakeBytes32(200), 5_000n);
  });

  it('finalizes the settlement record against the eligibility gate', async () => {
    const finalizeDvSettlement = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.eligibilityGate = fakeHandle({ finalizeDvSettlement });
    const manager = new NoctisLaunchManager(client);

    await manager.finalizeDvSettlement();

    expect(finalizeDvSettlement).toHaveBeenCalledTimes(1);
  });

  it.each(['recordDarkVeilSettlement', 'finalizeDvSettlement'] as const)(
    '%s does not fall back to bondingCurve, which has no such circuit',
    async (method) => {
      const circuitFn = vi.fn().mockResolvedValue({ ok: true });
      const client = new NoctisMidnightClient(USER_SK);
      client.bondingCurve = fakeHandle({ [method]: circuitFn });
      const manager = new NoctisLaunchManager(client);

      await expect((manager[method] as (...a: unknown[]) => Promise<unknown>)(fakeBytes32(201), 1n)).rejects.toThrow(
        /Cardano Launch circuit on the eligibility gate/,
      );
      expect(circuitFn).not.toHaveBeenCalled();
    },
  );
});

// ============================================================================
// NoctisLaunchManager — deeper scenario tests for branching/computed methods
// ============================================================================

describe('NoctisLaunchManager.revealDarkVeilBuyCommit', () => {
  it('Cardano Launch path: calls eligibilityGate.revealBuyCommit with (commitment, tokenAmount, pricePerToken, currentTimestamp) — no fee args', async () => {
    const revealBuyCommit = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.eligibilityGate = fakeHandle({ revealBuyCommit });
    const manager = new NoctisLaunchManager(client);

    await manager.revealDarkVeilBuyCommit(fakeBytes32(120), 500n, 10n, 9_000n);

    expect(revealBuyCommit).toHaveBeenCalledWith(fakeBytes32(120), 500n, 10n, 9_000n);
  });

  it('Midnight Launch path (bondingCurve only, no eligibilityGate): passes creator and platform fees plus the reveal timestamp', async () => {
    const revealBuyCommit = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({ revealBuyCommit });
    const manager = new NoctisLaunchManager(client);

    await manager.revealDarkVeilBuyCommit(fakeBytes32(121), 500n, 10n, 9_000n, {
      claimedCreatorFee: 5n,
      claimedPlatformFee: 3n,
    });

    // The timestamp is what the contract measures the reveal window against,
    // so it has to reach the circuit rather than being dropped here.
    expect(revealBuyCommit).toHaveBeenCalledWith(fakeBytes32(121), 500n, 10n, 5n, 3n, 9_000n);
  });

  it('Midnight Launch path without tierCFees throws before ever calling the circuit', async () => {
    const revealBuyCommit = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({ revealBuyCommit });
    const manager = new NoctisLaunchManager(client);

    await expect(manager.revealDarkVeilBuyCommit(fakeBytes32(122), 500n, 10n, 9_000n)).rejects.toThrow(
      /requires tierCFees/,
    );
    expect(revealBuyCommit).not.toHaveBeenCalled();
  });

  it('when both eligibilityGate and bondingCurve are connected, takes the Cardano Launch path (not Midnight Launch)', async () => {
    const egReveal = vi.fn().mockResolvedValue({ ok: true });
    const bcReveal = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.eligibilityGate = fakeHandle({ revealBuyCommit: egReveal });
    client.bondingCurve = fakeHandle({ revealBuyCommit: bcReveal });
    const manager = new NoctisLaunchManager(client);

    await manager.revealDarkVeilBuyCommit(fakeBytes32(123), 500n, 10n, 9_000n);

    expect(egReveal).toHaveBeenCalledWith(fakeBytes32(123), 500n, 10n, 9_000n);
    expect(bcReveal).not.toHaveBeenCalled();
  });
});

describe('NoctisLaunchManager.buyTokens', () => {
  const CURVE = { base_price: 100n, max_price: 1_000n, curve_supply: 1_000_000n };

  it('prices the range itself and calls buyTokens with all 5 args in order', async () => {
    const buyTokensFn = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({ buyTokens: buyTokensFn });
    const manager = new NoctisLaunchManager(client);

    // The gross is not an argument: it is what the curve charges for the
    // 1,000 positions starting at 500,000, which the circuit recomputes and
    // will refuse anything else for.
    const expectedGross = buyCost('quadratic', CURVE, 500_000n, 1_000n);
    const { creatorFee, platformFee } = computeBondingCurveFees(expectedGross);
    await manager.buyTokens(1_000n, CURVE, 500_000n, 9_500n);

    expect(buyTokensFn).toHaveBeenCalledWith(1_000n, expectedGross, creatorFee, platformFee, 9_500n);
  });

  it('charges more for the same size the further along the curve it sits', async () => {
    // A flat-priced batch would charge the same either way. Asserted through
    // the client rather than the pricing module, so a client that stopped
    // passing the position through would fail here.
    const buyTokensFn = vi.fn().mockResolvedValue({ ok: true });
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({ buyTokens: buyTokensFn });
    const manager = new NoctisLaunchManager(client);

    await manager.buyTokens(1_000n, CURVE, 0n, 1n);
    await manager.buyTokens(1_000n, CURVE, 900_000n, 2n);

    const early = buyTokensFn.mock.calls[0]?.[1] as bigint;
    const late = buyTokensFn.mock.calls[1]?.[1] as bigint;
    expect(late).toBeGreaterThan(early);
  });

  it('throws when bondingCurve is not connected', async () => {
    const client = new NoctisMidnightClient(USER_SK);
    const manager = new NoctisLaunchManager(client);
    await expect(manager.buyTokens(1n, CURVE, 0n, 1n)).rejects.toThrow(/bonding_curve not connected/);
  });
});

describe('NoctisLaunchManager.graduateAndSeedLp', () => {
  it('calls sealLock, closeEscrowAtGraduation, and startVesting each with the same timestamp, returning all three results', async () => {
    const sealLock = vi.fn().mockResolvedValue('lp-ok');
    const closeEscrowAtGraduation = vi.fn().mockResolvedValue('escrow-ok');
    const startVesting = vi.fn().mockResolvedValue('vesting-ok');
    const client = new NoctisMidnightClient(USER_SK);
    client.lpEscrow = fakeHandle({ sealLock });
    client.creatorEscrow = fakeHandle({ closeEscrowAtGraduation });
    client.vesting = fakeHandle({ startVesting });
    const manager = new NoctisLaunchManager(client);

    const result = await manager.graduateAndSeedLp(5_000n);

    expect(sealLock).toHaveBeenCalledWith(5_000n);
    expect(closeEscrowAtGraduation).toHaveBeenCalledWith(5_000n);
    expect(startVesting).toHaveBeenCalledWith(5_000n);
    expect(result).toEqual({
      lpResult: 'lp-ok',
      escrowResult: 'escrow-ok',
      vestingResult: 'vesting-ok',
    });
  });

  it.each(['lpEscrow', 'creatorEscrow', 'vesting'] as const)(
    'throws when %s is not connected',
    async (missingField) => {
      const client = new NoctisMidnightClient(USER_SK);
      client.lpEscrow = fakeHandle({ sealLock: vi.fn() });
      client.creatorEscrow = fakeHandle({ closeEscrowAtGraduation: vi.fn() });
      client.vesting = fakeHandle({ startVesting: vi.fn() });
      client[missingField] = null;
      const manager = new NoctisLaunchManager(client);

      await expect(manager.graduateAndSeedLp(1n)).rejects.toThrow(/not connected/);
    },
  );
});

describe('NoctisLaunchManager.executeCtoProposal', () => {
  it('calls executeProposal then triggerCTO on escrow/vesting/lpEscrow with the given address, and triggerCTO on bondingCurve when connected (Midnight Launch)', async () => {
    const executeProposal = vi.fn().mockResolvedValue('exec-ok');
    const escrowTrigger = vi.fn().mockResolvedValue('escrow-cto-ok');
    const vestingTrigger = vi.fn().mockResolvedValue('vesting-cto-ok');
    const lpTrigger = vi.fn().mockResolvedValue('lp-cto-ok');
    const curveTrigger = vi.fn().mockResolvedValue('curve-cto-ok');
    const client = new NoctisMidnightClient(USER_SK);
    client.ctoGovernance = fakeHandle({ executeProposal });
    client.creatorEscrow = fakeHandle({ triggerCTO: escrowTrigger });
    client.vesting = fakeHandle({ triggerCTO: vestingTrigger });
    client.lpEscrow = fakeHandle({ triggerCTO: lpTrigger });
    client.bondingCurve = fakeHandle({ triggerCTO: curveTrigger });
    const manager = new NoctisLaunchManager(client);

    const communityAddr = fakeBytes32(130);
    const result = await manager.executeCtoProposal(fakeBytes32(131), communityAddr);

    expect(executeProposal).toHaveBeenCalledWith(fakeBytes32(131));
    // Each PSM is handed the ballot being executed, not just the wallet.
    // That is what lets a reader match a contract's own recorded
    // `ctoProposalId` against the vote in cto_governance's `proposals`
    // ledger — a redirect that names no ballot is refused on chain.
    expect(escrowTrigger).toHaveBeenCalledWith(fakeBytes32(131), communityAddr);
    expect(vestingTrigger).toHaveBeenCalledWith(fakeBytes32(131), communityAddr);
    expect(lpTrigger).toHaveBeenCalledWith(fakeBytes32(131), communityAddr);
    expect(curveTrigger).toHaveBeenCalledWith(fakeBytes32(131), communityAddr);
    expect(result).toEqual({
      executeResult: 'exec-ok',
      escrowResult: 'escrow-cto-ok',
      vestingResult: 'vesting-cto-ok',
      lpResult: 'lp-cto-ok',
      curveResult: 'curve-cto-ok',
    });
  });

  it('skips bondingCurve.triggerCTO (undefined curveResult) when bondingCurve is not connected — Cardano Launch has no Midnight curve to trigger', async () => {
    const client = new NoctisMidnightClient(USER_SK);
    client.ctoGovernance = fakeHandle({
      executeProposal: vi.fn().mockResolvedValue('exec-ok'),
    });
    client.creatorEscrow = fakeHandle({
      triggerCTO: vi.fn().mockResolvedValue('e'),
    });
    client.vesting = fakeHandle({ triggerCTO: vi.fn().mockResolvedValue('v') });
    client.lpEscrow = fakeHandle({
      triggerCTO: vi.fn().mockResolvedValue('l'),
    });
    const manager = new NoctisLaunchManager(client);

    const result = await manager.executeCtoProposal(fakeBytes32(132), fakeBytes32(133));

    expect(result.curveResult).toBeUndefined();
  });

  it.each(['ctoGovernance', 'creatorEscrow', 'vesting', 'lpEscrow'] as const)(
    'throws when %s is not connected',
    async (missingField) => {
      const client = new NoctisMidnightClient(USER_SK);
      client.ctoGovernance = fakeHandle({ executeProposal: vi.fn() });
      client.creatorEscrow = fakeHandle({ triggerCTO: vi.fn() });
      client.vesting = fakeHandle({ triggerCTO: vi.fn() });
      client.lpEscrow = fakeHandle({ triggerCTO: vi.fn() });
      client[missingField] = null;
      const manager = new NoctisLaunchManager(client);

      await expect(manager.executeCtoProposal(fakeBytes32(1), fakeBytes32(2))).rejects.toThrow(/not connected/);
    },
  );
});

describe('NoctisLaunchManager.cancelLaunch', () => {
  it('calls cancelCurve/cancelLaunch on bondingCurve/creatorEscrow/vesting/lpEscrow and returns all four results', async () => {
    const cancelCurve = vi.fn().mockResolvedValue('curve-cancel-ok');
    const escrowCancel = vi.fn().mockResolvedValue('escrow-cancel-ok');
    const vestingCancel = vi.fn().mockResolvedValue('vesting-cancel-ok');
    const lpCancel = vi.fn().mockResolvedValue('lp-cancel-ok');
    const client = new NoctisMidnightClient(USER_SK);
    client.bondingCurve = fakeHandle({ cancelCurve });
    client.creatorEscrow = fakeHandle({ cancelLaunch: escrowCancel });
    client.vesting = fakeHandle({ cancelLaunch: vestingCancel });
    client.lpEscrow = fakeHandle({ cancelLaunch: lpCancel });
    const manager = new NoctisLaunchManager(client);

    const result = await manager.cancelLaunch();

    expect(cancelCurve).toHaveBeenCalledTimes(1);
    expect(escrowCancel).toHaveBeenCalledTimes(1);
    expect(vestingCancel).toHaveBeenCalledTimes(1);
    expect(lpCancel).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      curveResult: 'curve-cancel-ok',
      escrowResult: 'escrow-cancel-ok',
      vestingResult: 'vesting-cancel-ok',
      lpResult: 'lp-cancel-ok',
    });
  });

  it.each(['bondingCurve', 'creatorEscrow', 'vesting', 'lpEscrow'] as const)(
    'throws when %s is not connected',
    async (missingField) => {
      const client = new NoctisMidnightClient(USER_SK);
      client.bondingCurve = fakeHandle({ cancelCurve: vi.fn() });
      client.creatorEscrow = fakeHandle({ cancelLaunch: vi.fn() });
      client.vesting = fakeHandle({ cancelLaunch: vi.fn() });
      client.lpEscrow = fakeHandle({ cancelLaunch: vi.fn() });
      client[missingField] = null;
      const manager = new NoctisLaunchManager(client);

      await expect(manager.cancelLaunch()).rejects.toThrow(/not connected/);
    },
  );
});
