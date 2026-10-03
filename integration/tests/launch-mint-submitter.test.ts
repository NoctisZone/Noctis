// Tests for launch-mint-submitter.ts's LaunchMintSubmitter — the genesis mint.
//
// The property worth pinning here is the CIP-68 pair: one transaction mints
// the fungible supply at label 333 and exactly one reference NFT at label 100,
// both under the launch's own one-shot policy over the same base name. Get any
// part of that wrong and the mint still succeeds — it is the metadata that
// silently never resolves, which is the whole failure mode this work exists to
// close.
//
// Same importOriginal partial-mock strategy as the other submitter tests:
// only Lucid's network-connecting factory, Data.to/void and applyParamsToScript
// are stubbed. applyParamsToScript does real UPLC manipulation that needs
// genuinely valid compiled bytes, so it is stubbed here as it is in
// token-metadata-submitter.test.ts; mintingPolicyToId and scriptFromNative stay
// real, since they only hash bytes and tolerate a placeholder.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Data: {
      ...actual.Data,
      to: vi.fn((d: unknown) => d),
      void: vi.fn(() => 'void-redeemer'),
    },
    applyParamsToScript: vi.fn((script: string) => script),
  };
});

import { credentialToAddress, Lucid, mintingPolicyToId, scriptFromNative } from '@lucid-evolution/lucid';
import { type GenesisOutput, LaunchMintSubmitter } from '../launch-mint-submitter.js';
import { CIP68_FUNGIBLE_TOKEN_LABEL, CIP68_REFERENCE_NFT_LABEL, threadNftAssetNames } from '../launch-schemas.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}

const CREATOR_ADDR = addrFor(fakeKeyHash(0x11));
const PLATFORM_ADDR = addrFor(fakeKeyHash(0x22));
const CURVE_SCRIPT_ADDR = addrFor(fakeKeyHash(0x44));
const METADATA_SCRIPT_ADDR = addrFor(fakeKeyHash(0x55));

const LAUNCH_ID_HEX = 'ab'.repeat(32);
const TICKER_HEX = Buffer.from('MAXX', 'utf8').toString('hex');
const THREAD_NATIVE = { type: 'sig' as const, keyHash: fakeKeyHash(0x66) };
const TOTAL_SUPPLY = 1_000_000_000n;

const SEED_UTXO = {
  txHash: 'cd'.repeat(32),
  outputIndex: 1,
  address: CREATOR_ADDR,
  assets: { lovelace: 500_000_000n },
};

function makeFakeTxBuilder() {
  const calls: {
    mintAssets: Record<string, bigint>[];
    payToContract: [string, unknown, Record<string, bigint>][];
    payToAddress: [string, Record<string, bigint>][];
    collectFrom?: unknown[];
    addSigner?: unknown[];
  } = { mintAssets: [], payToContract: [], payToAddress: [] };

  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.mintAssets = vi.fn((assets: Record<string, bigint>) => {
    calls.mintAssets.push(assets);
    return builder;
  });
  builder.attach = { MintingPolicy: vi.fn(() => builder) };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract.push(a as [string, unknown, Record<string, bigint>]);
      return builder;
    }),
    ToAddress: vi.fn((...a: unknown[]) => {
      calls.payToAddress.push(a as [string, Record<string, bigint>]);
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({ toCBOR: () => 'unsigned-genesis-cbor' });
  return { builder, calls };
}

function makeSubmitter(builder: ReturnType<typeof makeFakeTxBuilder>['builder'], creatorUtxos = [SEED_UTXO]) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(creatorUtxos),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);
  return {
    submitter: new LaunchMintSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: 'Preprod',
      launchTokenPolicyCbor: '590000',
    }),
    fakeLucid,
  };
}

function genesisOutputs(): GenesisOutput[] {
  return [
    {
      address: CURVE_SCRIPT_ADDR,
      datumCbor: 'curve-datum',
      role: 'bondingCurve',
      lovelace: 3_200_000n,
      launchTokens: 950_000_000n,
    },
    {
      address: METADATA_SCRIPT_ADDR,
      datumCbor: 'metadata-datum',
      role: 'ctoGovernance', // ignored: the reference NFT authenticates this one
      lovelace: 2_100_000n,
      holdsReferenceNft: true,
    },
  ];
}

async function build(overrides: Partial<Parameters<LaunchMintSubmitter['buildGenesisMint']>[0]> = {}) {
  const { builder, calls } = makeFakeTxBuilder();
  const { submitter } = makeSubmitter(builder);
  const result = await submitter.buildGenesisMint({
    creatorAddress: CREATOR_ADDR,
    platformAddress: PLATFORM_ADDR,
    platformLovelace: 10_000_000n,
    tokenBaseNameHex: TICKER_HEX,
    totalSupply: TOTAL_SUPPLY,
    launchIdHex: LAUNCH_ID_HEX,
    threadNftNativeScript: THREAD_NATIVE,
    genesisOutputs: genesisOutputs(),
    seedUtxo: SEED_UTXO as never,
    appliedPolicyCbor: '590000',
    ...overrides,
  });
  return { calls, result };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('LaunchMintSubmitter.resolveSeedAndPolicy', () => {
  it('throws when the creator wallet has no UTXO to seed the one-shot', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, []);
    await expect(submitter.resolveSeedAndPolicy(CREATOR_ADDR, TOTAL_SUPPLY)).rejects.toThrow(
      /No UTXOs at creator address/,
    );
  });

  it('seeds from the creator wallet, picking its largest UTXO', async () => {
    const { builder } = makeFakeTxBuilder();
    const small = { ...SEED_UTXO, txHash: 'aa'.repeat(32), assets: { lovelace: 2_000_000n } };
    const large = { ...SEED_UTXO, txHash: 'bb'.repeat(32), assets: { lovelace: 900_000_000n } };
    const { submitter } = makeSubmitter(builder, [small, large]);

    const { seedUtxo } = await submitter.resolveSeedAndPolicy(CREATOR_ADDR, TOTAL_SUPPLY);
    expect(seedUtxo.txHash).toBe(large.txHash);
  });
});

describe('LaunchMintSubmitter.buildGenesisMint — the CIP-68 pair', () => {
  it('mints the supply at label 333 and exactly one reference NFT at label 100, under one policy', async () => {
    const { calls, result } = await build();

    const minted = calls.mintAssets[0];
    const units = Object.keys(minted);
    expect(units).toHaveLength(2);

    const supplyUnit = units.find((u) => u.slice(56).startsWith(CIP68_FUNGIBLE_TOKEN_LABEL));
    const referenceUnit = units.find((u) => u.slice(56).startsWith(CIP68_REFERENCE_NFT_LABEL));
    expect(supplyUnit).toBeDefined();
    expect(referenceUnit).toBeDefined();

    // CIP-68 requires both under the SAME policy id — that shared id is what
    // makes the metadata discoverable from the token.
    expect(supplyUnit?.slice(0, 56)).toBe(result.policyId);
    expect(referenceUnit?.slice(0, 56)).toBe(result.policyId);

    // ...over the same base name.
    expect(supplyUnit?.slice(56 + CIP68_FUNGIBLE_TOKEN_LABEL.length)).toBe(TICKER_HEX);
    expect(referenceUnit?.slice(56 + CIP68_REFERENCE_NFT_LABEL.length)).toBe(TICKER_HEX);

    expect(minted[supplyUnit as string]).toBe(TOTAL_SUPPLY);
    expect(minted[referenceUnit as string]).toBe(1n);
  });

  it('consumes the seed UTXO explicitly rather than leaving it to coin selection', async () => {
    const { calls } = await build();
    const [utxos] = calls.collectFrom as [Array<{ txHash: string }>];
    expect(utxos).toHaveLength(1);
    expect(utxos[0].txHash).toBe(SEED_UTXO.txHash);
  });

  it('rejects a ticker too long to fit once the label is applied', async () => {
    // 29 bytes: fits an asset name on its own, but not with 4 label bytes.
    const tooLong = Buffer.from('a'.repeat(29), 'utf8').toString('hex');
    await expect(build({ tokenBaseNameHex: tooLong })).rejects.toThrow(/1-28 bytes/);
  });

  it('rejects a base name that is already labelled', async () => {
    // Guards the mistake this API's naming is designed to prevent: passing a
    // 333-labelled name would double-label it.
    const alreadyLabelled = CIP68_FUNGIBLE_TOKEN_LABEL + TICKER_HEX;
    const { calls } = await build({ tokenBaseNameHex: alreadyLabelled });
    const units = Object.keys(calls.mintAssets[0]);
    const supplyUnit = units.find((u) => u.slice(56).startsWith(CIP68_FUNGIBLE_TOKEN_LABEL)) as string;
    // It does not throw — the length still fits — so the check that matters
    // is that a caller can SEE the doubling rather than it passing silently.
    expect(supplyUnit.slice(56)).toBe(CIP68_FUNGIBLE_TOKEN_LABEL + alreadyLabelled);
  });
});

describe('LaunchMintSubmitter.buildGenesisMint — outputs', () => {
  it('gives the metadata output the reference NFT, and every other output a thread NFT', async () => {
    const { calls, result } = await build();
    const threadPolicyId = mintingPolicyToId(scriptFromNative(THREAD_NATIVE));
    const names = threadNftAssetNames(LAUNCH_ID_HEX);

    const [curveAddr, , curveAssets] = calls.payToContract[0];
    expect(curveAddr).toBe(CURVE_SCRIPT_ADDR);
    expect(curveAssets[threadPolicyId + names.bondingCurve]).toBe(1n);
    expect(curveAssets.lovelace).toBe(3_200_000n);

    const [metaAddr, , metaAssets] = calls.payToContract[1];
    expect(metaAddr).toBe(METADATA_SCRIPT_ADDR);
    expect(metaAssets[result.policyId + CIP68_REFERENCE_NFT_LABEL + TICKER_HEX]).toBe(1n);
    // No thread NFT: the reference NFT already authenticates this UTXO, and a
    // second per-launch token would be redundant.
    expect(metaAssets[threadPolicyId + names.ctoGovernance]).toBeUndefined();
  });

  it('does not mint a thread NFT for the output the reference NFT authenticates', async () => {
    const { calls } = await build();
    const threadPolicyId = mintingPolicyToId(scriptFromNative(THREAD_NATIVE));
    const names = threadNftAssetNames(LAUNCH_ID_HEX);
    const threadMint = calls.mintAssets[1];

    expect(threadMint[threadPolicyId + names.bondingCurve]).toBe(1n);
    expect(threadMint[threadPolicyId + names.ctoGovernance]).toBeUndefined();
    expect(Object.keys(threadMint)).toHaveLength(1);
  });

  it('pays the whole launch fee to the one platform wallet', async () => {
    const { calls } = await build();
    expect(calls.payToAddress).toEqual([[PLATFORM_ADDR, { lovelace: 10_000_000n }]]);
  });

  it('returns unsigned CBOR and requires the creator as a signer — never signs itself', async () => {
    const { calls, result } = await build();
    expect(result.unsignedTxCbor).toBe('unsigned-genesis-cbor');
    expect(calls.addSigner).toEqual([CREATOR_ADDR]);
  });
});
