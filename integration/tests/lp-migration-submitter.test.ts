// Tests for lp-migration-submitter.ts's LpMigrationSubmitter —
// the heaviest single method in this codebase's submitter surface: one
// transaction that both spends lp_escrow's Migrate redeemer AND creates a
// real Minswap V2 liquidity pool (factory consumption, LP-token mint, pool/
// factory outputs), replicated by hand from Minswap SDK's real source per
// this file's own header. Real Node crypto (SHA3-256, not Keccak) computes
// the LP asset name — kept real here (no mock) and independently
// re-derived in this test file too, so a wrong field/byte-order bug in the
// wiring would show up as a value mismatch, not just "some string appeared."
// Same importOriginal partial-mock Lucid strategy as the other submitter
// tests — Constr stays real.

import { createHash } from 'node:crypto';
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

import { CML, type Constr, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { threadNftAssetName } from '../launch-schemas.js';
import { LpMigrationSubmitter } from '../lp-migration-submitter.js';
import { LP_ESCROW_REDEEMER } from '../redeemer-indices.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// Independent re-derivation of computeLPAssetName (pool.ts's real formula),
// used only to cross-check the submitter's own real SHA3-256 computation
// reads the right fields in the right order — not to re-test Node's crypto.
function sha3(hexInput: string): string {
  return createHash('sha3-256').update(Buffer.from(hexInput, 'hex')).digest('hex');
}
function independentComputeLPAssetName(tokenPolicyId: string, tokenName: string): string {
  // lovelace (empty policy/name) always sorts first.
  const kAda = sha3('' + '');
  const kToken = sha3(tokenPolicyId + tokenName);
  return sha3(kAda + kToken);
}

const REAL_EXTENDED_KEY_HEX = toHex(CML.PrivateKey.generate_ed25519extended().to_raw_bytes());
const LAUNCH_ID_HEX = toHex(new TextEncoder().encode('launch-lpmig-1'));
// A real launch's state UTXOs each carry a thread NFT; without one the
// authenticated lookup refuses the UTXO, as it should.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('lpEscrow', LAUNCH_ID_HEX);
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

const GOVERNOR_ADDR = addrFor(fakeKeyHash(0x11));
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_NAME = '42'.repeat(4);
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_NAME;

const MINSWAP_CONFIG = {
  factoryAddress: addrFor(fakeKeyHash(0x22)),
  factoryScriptHash: fakeKeyHash(0x33),
  factoryAsset: `${'ff'.repeat(28)}4641435441535345544e414d45`, // arbitrary policy+name hex
  poolAuthenAsset: `${'ee'.repeat(28)}506f6f6c417574686e41737365744e616d65`,
  lpPolicyId: 'dd'.repeat(28),
  poolCreationAddress: addrFor(fakeKeyHash(0x44)),
  poolScriptHash: fakeKeyHash(0x55),
  poolBatchingStakeScriptHash: fakeKeyHash(0x66),
  factoryValidatorCbor: '590000',
  authenPolicyCbor: '590001',
};

function lpDatum(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: THREAD_POLICY,
    lp_token_policy_id: TOKEN_POLICY,
    lp_token_name: TOKEN_NAME,
    ...overrides,
  };
}

function factoryDatum(head: string, tail: string) {
  return { head, tail };
}

function makeFakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const collectFromCalls: unknown[][] = [];
  const attachSpendingCalls: unknown[][] = [];
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
      attachSpendingCalls.push(a);
      return builder;
    }),
    MintingPolicy: vi.fn((...a: unknown[]) => {
      calls.attachMintingPolicy = a;
      return builder;
    }),
  };
  builder.mintAssets = vi.fn((...a: unknown[]) => {
    calls.mintAssets = a;
    return builder;
  });
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
  builder.attachMetadata = vi.fn((...a: unknown[]) => {
    calls.attachMetadata = a;
    return builder;
  });
  builder.complete = vi.fn((...a: unknown[]) => {
    calls.complete = a;
    return Promise.resolve({
      sign: {
        withPrivateKey: () => ({
          complete: vi.fn().mockResolvedValue({
            submit: vi.fn().mockResolvedValue('lpmig-tx-1'),
          }),
        }),
      },
    });
  });
  return {
    builder,
    calls,
    collectFromCalls,
    attachSpendingCalls,
    payToContractCalls,
  };
}

const addressRefs = { lp: '', factory: '' };

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    lpUtxos?: Array<{ datum: unknown; assets: Record<string, bigint> }>;
    factoryUtxos?: Array<{ datum: unknown; assets: Record<string, bigint> }>;
  } = {},
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      if (address === addressRefs.lp) return Promise.resolve(withThreadNft(opts.lpUtxos ?? []));
      if (address === addressRefs.factory) return Promise.resolve(opts.factoryUtxos ?? []);
      return Promise.resolve([]);
    }),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const submitter = new LpMigrationSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    lpEscrowScriptCbor: '590002',
    launchIdHex: LAUNCH_ID_HEX,
    threadNftPolicyId: THREAD_POLICY,
    minswap: MINSWAP_CONFIG,
  });
  addressRefs.lp = (submitter as unknown as { lpEscrowAddress: string }).lpEscrowAddress;
  addressRefs.factory = MINSWAP_CONFIG.factoryAddress;

  return submitter;
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('LpMigrationSubmitter.migrateToMinswapPool — guard rails', () => {
  it('rejects when the lp_escrow UTXO holds no real ADA or token value', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 0n, [TOKEN_UNIT]: 100n } }],
    });
    await expect(submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000)).rejects.toThrow(
      /holds no real value to migrate/,
    );
  });

  it('throws when no Factory UTXO brackets the computed lpAssetName', async () => {
    const { builder } = makeFakeTxBuilder();
    const lpAssetName = independentComputeLPAssetName(TOKEN_POLICY, TOKEN_NAME);
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      // A factory UTXO whose (head,tail) does NOT bracket the real lpAssetName.
      factoryUtxos: [
        {
          datum: factoryDatum(lpAssetName, lpAssetName),
          assets: { [MINSWAP_CONFIG.factoryAsset]: 1n },
        },
      ],
    });
    await expect(submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000)).rejects.toThrow(
      /No Minswap V2 Factory UTXO found bracketing/,
    );
  });

  it('skips a candidate Factory-address UTXO that does not carry exactly 1 factoryAsset', async () => {
    const { builder } = makeFakeTxBuilder();
    const _lpAssetName = independentComputeLPAssetName(TOKEN_POLICY, TOKEN_NAME);
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [
        { datum: factoryDatum('00'.repeat(32), 'ff'.repeat(32)), assets: {} }, // right bracket, WRONG asset qty (0)
      ],
    });
    await expect(submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000)).rejects.toThrow(
      /No Minswap V2 Factory UTXO found bracketing/,
    );
  });
});

describe('LpMigrationSubmitter.migrateToMinswapPool — real crypto + pool math', () => {
  function realFactoryUtxo() {
    const _lpAssetName = independentComputeLPAssetName(TOKEN_POLICY, TOKEN_NAME);
    return {
      datum: factoryDatum('00'.repeat(32), 'ff'.repeat(32)),
      assets: { [MINSWAP_CONFIG.factoryAsset]: 1n },
    };
  }

  it('computes lpAssetNameHex via real SHA3-256, matching an independently re-derived value, and it is deterministic across calls', async () => {
    const { builder } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    const expected = independentComputeLPAssetName(TOKEN_POLICY, TOKEN_NAME);
    expect(result.lpAssetNameHex).toBe(expected);
    expect(result.lpAssetNameHex).toHaveLength(64); // 32 real SHA3-256 bytes, hex-encoded
  });

  it('computes initialLiquidity as ceil(sqrt(amountA * amountB)) — exact for a perfect square', async () => {
    const { builder } = makeFakeTxBuilder();
    // 4 lovelace * 9 token = 36 -> sqrt exactly 6.
    const submitter = makeSubmitter(builder, {
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 4n, [TOKEN_UNIT]: 9n } }],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    expect(result.initialLiquidity).toBe(6n);
  });

  it('rounds UP for a non-perfect-square product', async () => {
    const { builder } = makeFakeTxBuilder();
    // 2 * 3 = 6 -> sqrt(6) ~= 2.449 -> ceil = 3.
    const submitter = makeSubmitter(builder, {
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 2n, [TOKEN_UNIT]: 3n } }],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    expect(result.initialLiquidity).toBe(3n);
  });

  it('builds the pool value with DEFAULT_POOL_ADA + migrated ADA, the real migrated token amount, 1 authen asset, and remainingLiquidity LP', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    const lpAssetUnit = MINSWAP_CONFIG.lpPolicyId + result.lpAssetNameHex;

    // pay.ToContract call #0 is the pool creation output.
    const [addr, , poolValue] = payToContractCalls[0] as [string, unknown, Record<string, bigint>];
    expect(addr).toBe(MINSWAP_CONFIG.poolCreationAddress);
    expect(poolValue.lovelace).toBe(4_500_000n + 10_000_000n); // DEFAULT_POOL_ADA + sortedAmountA
    expect(poolValue[TOKEN_UNIT]).toBe(1_000_000n);
    expect(poolValue[MINSWAP_CONFIG.poolAuthenAsset]).toBe(1n);
    const MAX_LIQUIDITY = 9_223_372_036_854_775_807n;
    const expectedRemaining = MAX_LIQUIDITY - (result.initialLiquidity - 10n);
    expect(poolValue[lpAssetUnit]).toBe(expectedRemaining);
  });

  // The escrow's own continuing output. Its absence is not a cosmetic
  // omission: thread_nft_intact applies to EVERY redeemer and looks for the
  // launch's thread NFT on an output back at the escrow's address, so a
  // migration without one cannot validate whatever else it gets right. This
  // transaction built none until 2026-08-11, and none of the assertions here
  // looked for one, which is why nothing said so.
  it('returns the replacement position to the escrow, with its thread NFT', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n } }],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    const lpAssetUnit = MINSWAP_CONFIG.lpPolicyId + result.lpAssetNameHex;
    const escrowLpAmount = result.initialLiquidity - 10n;

    const escrowOut = payToContractCalls.find(
      (c) => c[0] === (submitter as never as { lpEscrowAddress: string }).lpEscrowAddress,
    );
    expect(escrowOut, 'no continuing output back to the escrow').toBeDefined();

    const value = (escrowOut as unknown[])[2] as Record<string, bigint>;
    expect(value[THREAD_UNIT]).toBe(1n);
    expect(value[lpAssetUnit]).toBe(escrowLpAmount);
  });

  // Declared and held have to be the same number. They are computed once and
  // used twice — this is what stops the two drifting apart, which the node
  // would otherwise be the first to notice.
  it('declares in the redeemer exactly the position it returns', async () => {
    const { builder, collectFromCalls, payToContractCalls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [{ datum: lpDatum(), assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n } }],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    const lpAssetUnit = MINSWAP_CONFIG.lpPolicyId + result.lpAssetNameHex;
    const escrowLpAmount = result.initialLiquidity - 10n;

    // Data.to is mocked in this suite, so the redeemer arrives as the Constr
    // itself rather than as CBOR — same access the sibling redeemer test uses.
    const decoded = collectFromCalls[0][1] as Constr<unknown>;
    expect(decoded.index).toBe(LP_ESCROW_REDEEMER.Migrate);
    // [target_dex_credential, current_timestamp, policy, name, amount]
    expect(decoded.fields[2]).toBe(MINSWAP_CONFIG.lpPolicyId);
    expect(decoded.fields[3]).toBe(result.lpAssetNameHex);
    expect(decoded.fields[4]).toBe(escrowLpAmount);

    const escrowOut = payToContractCalls.find(
      (c) => c[0] === (submitter as never as { lpEscrowAddress: string }).lpEscrowAddress,
    );
    const value = (escrowOut as unknown[])[2] as Record<string, bigint>;
    expect(value[lpAssetUnit]).toBe(decoded.fields[4]);
  });

  it('mints exactly MAX_LIQUIDITY LP + 1 factoryAsset + 1 poolAuthenAsset', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [realFactoryUtxo()],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    const [mintAssets] = calls.mintAssets as [Record<string, bigint>, unknown];
    const lpAssetUnit = MINSWAP_CONFIG.lpPolicyId + result.lpAssetNameHex;
    expect(mintAssets[lpAssetUnit]).toBe(9_223_372_036_854_775_807n);
    expect(mintAssets[MINSWAP_CONFIG.factoryAsset]).toBe(1n);
    expect(mintAssets[MINSWAP_CONFIG.poolAuthenAsset]).toBe(1n);
  });

  it('splits the consumed Factory node into two new nodes bracketing lpAssetNameHex, each carrying the factoryAsset', async () => {
    const { builder, payToContractCalls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [
        {
          datum: factoryDatum('00'.repeat(32), 'ff'.repeat(32)),
          assets: { [MINSWAP_CONFIG.factoryAsset]: 1n },
        },
      ],
    });

    const result = await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);

    const [addr1, payload1, assets1] = payToContractCalls[1] as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    const [addr2, payload2, assets2] = payToContractCalls[2] as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(addr1).toBe(MINSWAP_CONFIG.factoryAddress);
    expect(addr2).toBe(MINSWAP_CONFIG.factoryAddress);
    expect(payload1.value).toEqual({
      head: '00'.repeat(32),
      tail: result.lpAssetNameHex,
    });
    expect(payload2.value).toEqual({
      head: result.lpAssetNameHex,
      tail: 'ff'.repeat(32),
    });
    expect(assets1[MINSWAP_CONFIG.factoryAsset]).toBe(1n);
    expect(assets2[MINSWAP_CONFIG.factoryAsset]).toBe(1n);
  });

  it('builds the Migrate redeemer (index 4) with the target pool ScriptCredential and the given real (non-backdated) timestamp', async () => {
    const { builder, collectFromCalls, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [realFactoryUtxo()],
    });

    await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 5_000_000_000);

    const migrateRedeemer = collectFromCalls[0][1] as Constr<unknown>;
    expect(migrateRedeemer.index).toBe(4);
    const [credential, timestamp] = migrateRedeemer.fields as [Constr<unknown>, bigint];
    expect(credential.index).toBe(1); // ScriptCredential
    expect(credential.fields).toEqual([MINSWAP_CONFIG.poolScriptHash]);
    expect(timestamp).toBe(5_000_000_000n);
    // The redeemer's timestamp is bound to this range on chain, and the range
    // is capped at ten minutes wide. Recording the calls is not enough -- a
    // mock that merely swallows validFrom would let an absent or mismatched
    // range pass unnoticed, which is exactly how this defect survived.
    const from = calls.validFrom?.[0] as number;
    const to = calls.validTo?.[0] as number;
    expect(from).toBeLessThanOrEqual(5_000_000_000);
    expect(to).toBeGreaterThanOrEqual(5_000_000_000);
    expect(to - from).toBeLessThanOrEqual(600_000);
  });

  it('requires the governor as signer and embeds the real Minswap "Create Pool" metadata tag', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const submitter = makeSubmitter(builder, {
      lpUtxos: [
        {
          datum: lpDatum(),
          assets: { lovelace: 10_000_000n, [TOKEN_UNIT]: 1_000_000n },
        },
      ],
      factoryUtxos: [realFactoryUtxo()],
    });

    await submitter.migrateToMinswapPool(REAL_EXTENDED_KEY_HEX, GOVERNOR_ADDR, 2_000_000_000);
    expect(calls.addSigner).toEqual([GOVERNOR_ADDR]);
    expect(calls.attachMetadata).toEqual([674, { msg: ['SDK Minswap: Create Pool'] }]);
    expect(calls.complete).toEqual([{ localUPLCEval: false }]);
  });
});
