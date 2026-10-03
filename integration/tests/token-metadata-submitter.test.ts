// Tests for token-metadata-submitter.ts's TokenMetadataSubmitter — the
// CIP-68 on-chain-logo feature's Lucid Evolution submitter. Structurally
// different from every other submitter in this codebase: it builds
// UNSIGNED transactions (returns CBOR for a browser wallet to sign) rather
// than signing/submitting server-side, since minting and updating are
// creator/community-wallet actions per this feature's own design (a
// platform key must never sign these). Same importOriginal partial-mock
// Lucid strategy as the other submitter tests, with one addition:
// applyParamsToScript is also stubbed, since it does real UPLC bytecode
// manipulation that needs genuinely valid compiled Plutus script bytes
// (confirmed via a probe: it throws on placeholder CBOR, unlike
// validatorToAddress/mintingPolicyToId, which just hash arbitrary bytes and
// tolerate a placeholder fine — both are kept real here).

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
    applyParamsToScript: vi.fn((script: string) => script),
  };
});

import { applyParamsToScript, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { cip68FungibleAssetName, cip68ReferenceAssetName, threadNftAssetName } from '../launch-schemas.js';
import { metadataWithLogo, TokenMetadataSubmitter, toHex } from '../token-metadata-submitter.js';

function fakeKeyHash(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(28);
}
function addrFor(hash: string): string {
  return credentialToAddress('Preprod', { type: 'Key', hash });
}

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-tokmeta-1');
const LAUNCH_ID_HEX = toHex(LAUNCH_ID_BYTES);
const BONDING_CURVE_HASH = 'bb'.repeat(28);
const CTO_GOVERNANCE_HASH = 'cc'.repeat(28);
const CTO_GOVERNANCE_NFT_POLICY = 'dd'.repeat(28);
const TOKEN_POLICY_ID = 'ee'.repeat(28);
// A real launch token is CIP-68 label 333 over its base name, and the metadata
// UTXO is found by the matching label-100 reference NFT. An unlabelled name
// would still round-trip through the derivation, but only because stripping a
// label off a name that has none leaves something consistent — it would not
// exercise the real one.
const TOKEN_BASE_NAME_HEX = toHex(new TextEncoder().encode('tok'));
const TOKEN_ASSET_NAME_HEX = cip68FungibleAssetName(TOKEN_BASE_NAME_HEX);
const REFERENCE_NFT_UNIT = TOKEN_POLICY_ID + cip68ReferenceAssetName(TOKEN_BASE_NAME_HEX);
const CURVE_ADDR = addrFor(fakeKeyHash(0x77));
const CREATOR_ADDR = addrFor(fakeKeyHash(0x11));
// One thread-NFT policy per launch, one role-tagged asset name per validator —
// CTO_GOVERNANCE_NFT_POLICY is that policy, named for the role this file
// already used it for.
const CURVE_THREAD_NFT_UNIT = CTO_GOVERNANCE_NFT_POLICY + threadNftAssetName('bondingCurveTierB', LAUNCH_ID_HEX);

/**
 * The curve UTXO token_metadata.ak reads as a reference input to derive live
 * creator authority. Only the fields the lookup itself reads matter here — the
 * validator's own use of it is not what these tests exercise.
 */
function curveDatumFields(overrides: Record<string, unknown> = {}) {
  return {
    launch_id: LAUNCH_ID_HEX,
    thread_nft_policy: CTO_GOVERNANCE_NFT_POLICY,
    ...overrides,
  };
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

/** A CIP-68 metadata map as it comes back off chain: hex keys, hex values. */
function metadataMap(name = 'Mock Token'): Map<string, unknown> {
  return new Map<string, unknown>([
    [hex('name'), hex(name)],
    [hex('description'), hex('A mock launch')],
    [hex('decimals'), 0n],
  ]);
}

/**
 * The datum is CIP-68's own shape — constructor 0 over
 * [metadata, version, extra] — so overrides target `extra` unless they name
 * one of the two outer fields.
 */
function metadataDatumFields(extraOverrides: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) {
  return {
    metadata: metadataMap(),
    version: 1n,
    extra: {
      launch_id: LAUNCH_ID_HEX,
      bonding_curve_credential: { ScriptCredential: [BONDING_CURVE_HASH] },
      token_policy_id: TOKEN_POLICY_ID,
      token_asset_name: TOKEN_ASSET_NAME_HEX,
      community_pub_key_hash: '',
      cto_triggered: false,
      cto_governance_credential: { ScriptCredential: [CTO_GOVERNANCE_HASH] },
      thread_nft_policy: CTO_GOVERNANCE_NFT_POLICY,
      metadata_revision: 1n,
      last_updated_ts: 1000n,
      ...extraOverrides,
    },
    ...outer,
  };
}

function makeFakeTxBuilder(cborResult = 'unsigned-cbor-1') {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return builder;
  });
  builder.readFrom = vi.fn((...a: unknown[]) => {
    calls.readFrom = a;
    return builder;
  });
  builder.mintAssets = vi.fn((...a: unknown[]) => {
    calls.mintAssets = a;
    return builder;
  });
  builder.attach = {
    SpendingValidator: vi.fn((...a: unknown[]) => {
      calls.attachSpendingValidator = a;
      return builder;
    }),
    MintingPolicy: vi.fn((...a: unknown[]) => {
      calls.attachMintingPolicy = a;
      return builder;
    }),
  };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      calls.payToContract = a;
      return builder;
    }),
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  builder.complete = vi.fn().mockResolvedValue({ toCBOR: () => cborResult });
  return { builder, calls };
}

interface FixtureUtxo {
  datum?: unknown;
  assets: Record<string, bigint>;
  txHash?: string;
  outputIndex?: number;
  /** Opt out of the authenticating token, to describe a UTXO that lacks it. */
  bare?: boolean;
}

/**
 * Every metadata UTXO a real launch has carries its CIP-68 reference NFT, and
 * every curve UTXO carries its thread NFT — those are what the two lookups
 * authenticate on, and the validator requires the same pair. Added here rather
 * than in each fixture so a test says only what it is about, and merged UNDER
 * the fixture's own assets so an explicit value still wins.
 */
function asChainUtxos(unit: string, utxos: FixtureUtxo[] | undefined, fallback: FixtureUtxo[]) {
  return (utxos ?? fallback).map((u, i) => ({
    txHash: u.txHash ?? i.toString(16).padStart(2, '0').repeat(32),
    outputIndex: u.outputIndex ?? 0,
    ...u,
    assets: u.bare ? u.assets : { [unit]: 1n, ...u.assets },
  }));
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  opts: {
    metadataUtxos?: FixtureUtxo[];
    curveUtxos?: FixtureUtxo[];
    creatorUtxos?: Array<{
      txHash: string;
      outputIndex: number;
      assets: Record<string, bigint>;
    }>;
    fromTxResult?: unknown;
  } = {},
) {
  const fakeLucid = {
    selectWallet: { fromAddress: vi.fn() },
    utxosAt: vi.fn().mockImplementation((address: string) => {
      if (address === addressRefs.spend)
        return Promise.resolve(asChainUtxos(REFERENCE_NFT_UNIT, opts.metadataUtxos, []));
      if (address === CURVE_ADDR)
        return Promise.resolve(
          asChainUtxos(CURVE_THREAD_NFT_UNIT, opts.curveUtxos, [
            { txHash: 'curve-tx', outputIndex: 0, assets: {}, datum: curveDatumFields() },
          ]),
        );
      if (address === CREATOR_ADDR)
        return Promise.resolve(opts.creatorUtxos ?? [{ txHash: 'aa'.repeat(32), outputIndex: 0, assets: {} }]);
      return Promise.resolve([]);
    }),
    fromTx: vi.fn().mockReturnValue(
      opts.fromTxResult ?? {
        assemble: vi.fn().mockReturnValue({
          complete: vi.fn().mockResolvedValue({
            submit: vi.fn().mockResolvedValue('final-tx-hash-1'),
          }),
        }),
      },
    ),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  const submitter = new TokenMetadataSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    spendScriptCbor: '590000',
    bondingCurveScriptHash: BONDING_CURVE_HASH,
    ctoGovernanceScriptHash: CTO_GOVERNANCE_HASH,
    threadNftPolicyId: CTO_GOVERNANCE_NFT_POLICY,
    tokenPolicyId: TOKEN_POLICY_ID,
    tokenAssetNameHex: TOKEN_ASSET_NAME_HEX,
    launchId: LAUNCH_ID_BYTES,
  });
  addressRefs.spend = (submitter as unknown as { spendAddress: string }).spendAddress;

  return { submitter, fakeLucid };
}

const addressRefs = { spend: '' };

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
  vi.mocked(applyParamsToScript).mockClear();
});

describe('TokenMetadataSubmitter.getCurrentMetadata', () => {
  it('returns null when no token_metadata UTXO exists yet (pre-mint)', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, { metadataUtxos: [] });
    await expect(submitter.getCurrentMetadata()).resolves.toBeNull();
  });

  it('returns the real live-decoded state when a metadata UTXO exists, matching the launch_id', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields({ launch_id: 'other-launch' }),
          assets: {},
        },
        {
          datum: metadataDatumFields({
            metadata_revision: 3n,
            cto_triggered: true,
          }),
          assets: {},
        },
      ],
    });

    const result = await submitter.getCurrentMetadata();
    expect(result?.launchId).toBe(LAUNCH_ID_HEX);
    expect(result?.metadataRevision).toBe('3');
    expect(result?.ctoTriggered).toBe(true);
    // The standard's own map comes back as a wallet reads it — hex keys,
    // hex-or-integer values — with nothing dropped.
    expect(result?.metadata[hex('name')]).toBe(hex('Mock Token'));
    expect(result?.metadata[hex('decimals')]).toBe('0');
    expect(result?.standardVersion).toBe('1');
  });
});

// token_metadata.ak is unparameterized, so every launch's metadata sits at one
// shared address, and paying a UTXO there runs no validator — its datum is a
// claim by whoever created it. The reference NFT is what the validator itself
// checks (carries_own_reference_nft), so it is what this reader checks too: a
// reader matching on anything looser would accept UTXOs the chain rejects, and
// display a forger's metadata as the launch's own.
describe('TokenMetadataSubmitter — which UTXO it reads and revises', () => {
  it('ignores a metadata UTXO that claims the launch but carries no reference NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {}, bare: true }],
    });
    await expect(submitter.getCurrentMetadata()).resolves.toBeNull();
  });

  it('ignores a reference NFT minted under a policy the datum does not name', async () => {
    // The name alone is not enough: CIP-68 binds the pair, and the launch
    // token's policy is a one-shot that can never mint a second one.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields(),
          assets: { ['ff'.repeat(28) + cip68ReferenceAssetName(TOKEN_BASE_NAME_HEX)]: 1n },
          bare: true,
        },
      ],
    });
    await expect(submitter.getCurrentMetadata()).resolves.toBeNull();
  });

  it('ignores the label-333 fungible token in place of the label-100 reference NFT', async () => {
    // Same policy, same base name — only the CIP-67 label differs, and every
    // holder of the token has one.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields(),
          assets: { [TOKEN_POLICY_ID + TOKEN_ASSET_NAME_HEX]: 1n },
          bare: true,
        },
      ],
    });
    await expect(submitter.getCurrentMetadata()).resolves.toBeNull();
  });

  it('reads the genuine metadata UTXO when a forged one is planted beside it', async () => {
    // The reference NFT is derived from the launch's own token identity as the
    // platform recorded it, so a datum nominating a different token policy
    // cannot vouch for itself.
    const { builder } = makeFakeTxBuilder();
    const forgerPolicy = 'ff'.repeat(28);
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields({ token_policy_id: forgerPolicy }),
          assets: { [forgerPolicy + cip68ReferenceAssetName(TOKEN_BASE_NAME_HEX)]: 1n },
          bare: true,
          txHash: '22'.repeat(32),
        },
        { datum: metadataDatumFields(), assets: {}, txHash: '11'.repeat(32) },
      ],
    });
    const metadata = await submitter.getCurrentMetadata();
    expect(metadata).not.toBeNull();
  });

  it('still refuses when two metadata UTXOs both carry the genuine reference NFT', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        { datum: metadataDatumFields(), assets: {}, txHash: '11'.repeat(32) },
        { datum: metadataDatumFields(), assets: {}, txHash: '22'.repeat(32) },
      ],
    });
    await expect(submitter.getCurrentMetadata()).rejects.toThrow(/Refusing to guess/);
  });

  it('surfaces a provider failure rather than reporting the launch unminted', async () => {
    // The other half of what a bare catch hid: a Blockfrost outage and a
    // genuinely pre-mint launch are not the same state, and rendering both as
    // "no metadata yet" makes the page confidently wrong during an outage.
    const { builder } = makeFakeTxBuilder();
    const { submitter, fakeLucid } = makeSubmitter(builder, {});
    fakeLucid.utxosAt.mockRejectedValue(new Error('Blockfrost 503'));
    await expect(submitter.getCurrentMetadata()).rejects.toThrow(/Blockfrost 503/);
  });

  it('refuses a curve reference input that carries no thread NFT', async () => {
    // The curve is only ever a reference input here, but live_curve_creator
    // requires its thread NFT — so picking the wrong one builds a transaction
    // the node rejects for a reason naming neither the launch nor the input.
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: { lovelace: 2_000_000n } }],
      curveUtxos: [{ datum: curveDatumFields(), assets: {}, bare: true }],
    });
    await expect(
      submitter.buildUpdateMetadata({
        callerAddress: CREATOR_ADDR,
        curveAddress: CURVE_ADDR,
        newMetadata: { name: 'Renamed', description: 'A mock launch', decimals: 0 },
        currentTimestamp: 1000,
      }),
    ).rejects.toThrow(/carries launch .* bondingCurveTierB thread NFT/);
  });

  it('ignores another launch’s curve sitting at the same address', async () => {
    const { builder } = makeFakeTxBuilder();
    const otherLaunch = toHex(new TextEncoder().encode('launch-tokmeta-2'));
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: { lovelace: 2_000_000n } }],
      curveUtxos: [
        {
          datum: curveDatumFields({ launch_id: otherLaunch }),
          assets: { [CTO_GOVERNANCE_NFT_POLICY + threadNftAssetName('bondingCurveTierB', otherLaunch)]: 1n },
          bare: true,
        },
      ],
    });
    await expect(
      submitter.buildUpdateMetadata({
        callerAddress: CREATOR_ADDR,
        curveAddress: CURVE_ADDR,
        newMetadata: { name: 'Renamed', description: 'A mock launch', decimals: 0 },
        currentTimestamp: 1000,
      }),
    ).rejects.toThrow(/carries launch .* bondingCurveTierB thread NFT/);
  });
});

describe('TokenMetadataSubmitter.buildUpdateMetadata', () => {
  it('throws when the caller has no UTXOs', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {} }],
      creatorUtxos: [],
    });
    await expect(
      submitter.buildUpdateMetadata({
        callerAddress: CREATOR_ADDR,
        curveAddress: CURVE_ADDR,
        newMetadata: { name: 'Anything', description: 'Anything' },
        currentTimestamp: 1000,
      }),
    ).rejects.toThrow(/No UTXOs found at caller address/);
  });

  it('writes the new metadata map, increments the revision, and preserves every field under extra', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [
        {
          datum: metadataDatumFields({
            metadata_revision: 4n,
            community_pub_key_hash: fakeKeyHash(0x99),
            cto_triggered: true,
          }),
          assets: { lovelace: 2_000_000n },
        },
      ],
    });

    await submitter.buildUpdateMetadata({
      callerAddress: CREATOR_ADDR,
      curveAddress: CURVE_ADDR,
      newMetadata: { name: 'Renamed', description: 'New copy', ticker: 'TOK', decimals: 0 },
      currentTimestamp: 2_000_000_000,
    });

    const [, payload, assetsArg] = calls.payToContract as [
      string,
      { value: { metadata: Map<string, unknown>; version: bigint; extra: Record<string, unknown> } },
      Record<string, bigint>,
    ];
    expect(payload.value.metadata.get(hex('name'))).toBe(hex('Renamed'));
    expect(payload.value.metadata.get(hex('description'))).toBe(hex('New copy'));
    expect(payload.value.metadata.get(hex('decimals'))).toBe(0n);
    // CIP-68's standard version is not a revision counter and must not move.
    expect(payload.value.version).toBe(1n);
    expect(payload.value.extra.metadata_revision).toBe(5n);
    expect(payload.value.extra.last_updated_ts).toBe(2_000_000_000n);
    expect(payload.value.extra.community_pub_key_hash).toBe(fakeKeyHash(0x99));
    expect(payload.value.extra.cto_triggered).toBe(true);
    expect(payload.value.extra.bonding_curve_credential).toEqual({
      ScriptCredential: [BONDING_CURVE_HASH],
    });
    // The metadata UTXO's own value is re-locked unchanged — the reference
    // NFT stays put, which the validator requires on both sides.
    expect(assetsArg).toEqual({ lovelace: 2_000_000n, [REFERENCE_NFT_UNIT]: 1n });
  });

  it('rejects metadata missing a field the 333 sub-standard requires', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {} }],
    });

    await expect(
      submitter.buildUpdateMetadata({
        callerAddress: CREATOR_ADDR,
        curveAddress: CURVE_ADDR,
        newMetadata: { name: 'No description', description: '' },
        currentTimestamp: 1000,
      }),
    ).rejects.toThrow(/requires a non-empty description/);
  });

  it('builds the UpdateMetadata redeemer carrying the same map it writes, and reads the curve as a reference input', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, {
      metadataUtxos: [{ datum: metadataDatumFields(), assets: {} }],
    });

    await submitter.buildUpdateMetadata({
      callerAddress: CREATOR_ADDR,
      curveAddress: CURVE_ADDR,
      newMetadata: { name: 'Redeemed', description: 'Copy' },
      currentTimestamp: 1_800_000_000,
    });

    const redeemer = calls.collectFrom![1] as {
      new_metadata: Map<string, unknown>;
      current_timestamp: bigint;
    };
    // The validator compares the continuing datum against the redeemer, so
    // the two must carry the identical map.
    const [, payload] = calls.payToContract as [string, { value: { metadata: Map<string, unknown> } }];
    expect(redeemer.new_metadata).toEqual(payload.value.metadata);
    expect(redeemer.new_metadata.get(hex('name'))).toBe(hex('Redeemed'));
    expect(redeemer.current_timestamp).toBe(1_800_000_000n);
    expect(calls.readFrom).toBeDefined();
    expect(calls.addSigner).toEqual([CREATOR_ADDR]);
  });
});

describe('TokenMetadataSubmitter.finalizeAndSubmit', () => {
  it('assembles the unsigned tx with the given witness set and submits it', async () => {
    const { builder } = makeFakeTxBuilder();
    const assembleFn = vi.fn().mockReturnValue({
      complete: vi.fn().mockResolvedValue({
        submit: vi.fn().mockResolvedValue('final-tx-hash-2'),
      }),
    });
    const { submitter, fakeLucid } = makeSubmitter(builder, {
      fromTxResult: { assemble: assembleFn },
    });

    const result = await submitter.finalizeAndSubmit('unsigned-cbor-x', 'witness-cbor-y');

    expect(fakeLucid.fromTx).toHaveBeenCalledWith('unsigned-cbor-x');
    expect(assembleFn).toHaveBeenCalledWith(['witness-cbor-y']);
    expect(result.txHash).toBe('final-tx-hash-2');
  });
});

describe('metadataWithLogo', () => {
  const hex = (v: string) => Buffer.from(v, 'utf8').toString('hex');
  const current = {
    [hex('name')]: hex('Agent Jinx'),
    [hex('description')]: hex('A launch whose description runs past sixty-four bytes, as real ones do.'),
    [hex('ticker')]: hex('JINX'),
    [hex('url')]: hex('https://example.com'),
    [hex('decimals')]: '0',
    [hex('logo')]: hex('ipfs://bafyold'),
  };
  // A site-hosted image: 72 bytes, past the 64-byte chunk a datum string is
  // split into, which is the case a site without IPFS pinning produces.
  const SITE_LOGO = 'https://noctis.zone/wp-content/uploads/2026/09/agent-jinx-logo-512x512.png';

  it('keeps every other field and replaces only the logo', () => {
    expect(SITE_LOGO.length).toBeGreaterThan(64);
    expect(metadataWithLogo(current, SITE_LOGO)).toEqual({
      name: 'Agent Jinx',
      description: 'A launch whose description runs past sixty-four bytes, as real ones do.',
      ticker: 'JINX',
      url: 'https://example.com',
      decimals: 0,
      logo: SITE_LOGO,
    });
  });

  it('takes an ipfs URI as well as an https one', () => {
    expect(metadataWithLogo(current, 'ipfs://bafynew').logo).toBe('ipfs://bafynew');
  });

  it('leaves out optional fields the launch never set', () => {
    const bare = { [hex('name')]: hex('X'), [hex('description')]: hex('Y') };
    expect(metadataWithLogo(bare, 'ipfs://bafy')).toEqual({ name: 'X', description: 'Y', logo: 'ipfs://bafy' });
  });

  it('refuses a URI a wallet would not render, or one that is not a URI at all', () => {
    for (const bad of ['http://plain.example/logo.png', 'javascript:alert(1)', 'bafybare', '']) {
      expect(() => metadataWithLogo(current, bad)).toThrow(/https:\/\/ or ipfs:\/\//);
    }
  });

  it('refuses to drop a field this platform did not write', () => {
    expect(() => metadataWithLogo({ ...current, [hex('website')]: hex('x') }, SITE_LOGO)).toThrow(/website/);
  });
});
