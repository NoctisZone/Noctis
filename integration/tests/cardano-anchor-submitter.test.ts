// Tests for cardano-anchor-submitter.ts's LucidAnchorSubmitter — the
// relayer-operated Cardano tx submitter for zk_anchor.ak's AnchorCertificate
// redeemer. Same mocking strategy as darkveil-claim-submitter.test.ts: only
// Lucid Evolution's network-connecting factory and Data.from/to are swapped
// for a fake/identity passthrough (via importOriginal partial-mock); every
// other real export (Data schema builders, validatorToAddress) stays real.

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

import { Lucid } from '@lucid-evolution/lucid';
import { fromHex, LucidAnchorSubmitter, toHex } from '../cardano-anchor-submitter.js';
import { threadNftAssetName } from '../launch-schemas.js';
import type { AnchorCertificateParams } from '../zk-cert-relayer.js';

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

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
  };
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return builder;
  });
  // zk_anchor.ak validates anchor_timestamp against the transaction's own
  // validity range and caps that range's width, so the real submitter must
  // set both bounds or the transaction is rejected on-chain.
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
          submit: vi.fn().mockResolvedValue('anchor-tx-hash-1'),
        }),
      }),
    },
  });
  return { builder, calls };
}

const LAUNCH_ID_BYTES = new TextEncoder().encode('launch-anchor-1');
const LAUNCH_ID_HEX = toHex(LAUNCH_ID_BYTES);
// A real launch's state UTXOs each carry a thread NFT; without one the
// authenticated lookup refuses the UTXO, as it should.
const THREAD_POLICY = 'c0ffee'.padEnd(56, '0');
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('zkAnchor', LAUNCH_ID_HEX);
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
    cert_type: 'DarkVeilCert',
    proof_bundle_hash: toHex(fakeBytes(1)),
    proof_ipfs_cid: toHex(fakeBytes(2)),
    anchor_timestamp: 0n,
    relayer_credential_hash: toHex(fakeBytes(3)),
    governor_credential_hash: toHex(fakeBytes(4)),
    metadata_hash: toHex(fakeBytes(5)),
    ...overrides,
  };
}

function makeSubmitter(
  builder: ReturnType<typeof makeFakeTxBuilder>['builder'],
  utxos: Array<{ datum: unknown; assets: Record<string, bigint> }>,
) {
  const fakeLucid = {
    selectWallet: { fromPrivateKey: vi.fn() },
    utxosAt: vi.fn().mockResolvedValue(withThreadNft(utxos)),
    newTx: () => builder,
  };
  vi.mocked(Lucid).mockResolvedValue(fakeLucid as never);

  return {
    submitter: new LucidAnchorSubmitter({
      blockfrostProjectId: 'proj',
      blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      network: 'Preprod',
      compiledScriptCbor: '590000',
      relayerPrivateKey: 'ed25519_sk1fakefakefake',
      launchId: LAUNCH_ID_BYTES,
      threadNftPolicyId: THREAD_POLICY,
    }),
    fakeLucid,
  };
}

beforeEach(() => {
  vi.mocked(Lucid).mockReset();
});

describe('fromHex / toHex (pure helpers)', () => {
  it('round-trip a byte array', () => {
    const bytes = new Uint8Array([0x00, 0xab, 0xff]);
    expect(toHex(bytes)).toBe('00abff');
    expect(Array.from(fromHex('00abff'))).toEqual([0x00, 0xab, 0xff]);
  });
});

describe('LucidAnchorSubmitter.submitAnchorCertificate', () => {
  const params: AnchorCertificateParams = {
    certType: 'FullZKCert',
    proofBundleHash: fakeBytes(10),
    proofIpfsCid: fakeBytes(11),
    metadataHash: fakeBytes(12),
    timestamp: 1_753_000_000n,
  };

  it('throws when no UTXO at the shared script address matches the configured launchId', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      { datum: baseDatum({ launch_id: 'a-different-launch' }), assets: {} },
    ]);

    await expect(submitter.submitAnchorCertificate(params, 'addr_test1relayer')).rejects.toThrow(/carries launch/);
  });

  it('skips a UTXO with no inline datum and continues scanning rather than throwing', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [
      { datum: null as never, assets: {} },
      { datum: baseDatum(), assets: { lovelace: 2_000_000n } },
    ]);

    const result = await submitter.submitAnchorCertificate(params, 'addr_test1relayer');
    expect(result.txHash).toBe('anchor-tx-hash-1');
  });

  it('builds the redeemer and new datum from the given params, preserving unrelated datum fields', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    // The thread NFT is part of what the UTXO holds, so re-locking its own
    // assets unchanged means re-locking that too.
    const existingAssets = { lovelace: 2_000_000n, [THREAD_UNIT]: 1n };
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: existingAssets }]);

    const result = await submitter.submitAnchorCertificate(params, 'addr_test1relayer');
    expect(result.txHash).toBe('anchor-tx-hash-1');

    const [utxosArg, redeemer] = calls.collectFrom as [unknown[], Record<string, unknown>];
    expect(utxosArg).toHaveLength(1);
    expect(redeemer.cert_type).toBe('FullZKCert');
    expect(redeemer.proof_bundle_hash).toBe(toHex(params.proofBundleHash));
    expect(redeemer.proof_ipfs_cid).toBe(toHex(params.proofIpfsCid));
    expect(redeemer.metadata_hash).toBe(toHex(params.metadataHash));
    expect(redeemer.timestamp).toBe(1_753_000_000n);

    const [, payload, assetsArg] = calls.payToContract as [
      string,
      { value: Record<string, unknown> },
      Record<string, bigint>,
    ];
    expect(payload.value.cert_type).toBe('FullZKCert');
    expect(payload.value.proof_bundle_hash).toBe(toHex(params.proofBundleHash));
    expect(payload.value.anchor_timestamp).toBe(1_753_000_000n);
    // Fields not touched by this update must be carried over unchanged.
    expect(payload.value.launch_id).toBe(LAUNCH_ID_HEX);
    expect(payload.value.relayer_credential_hash).toBe(toHex(fakeBytes(3)));
    expect(payload.value.governor_credential_hash).toBe(toHex(fakeBytes(4)));
    // The UTXO's own value must be re-locked unchanged (no fee/payment logic here).
    expect(assetsArg).toEqual(existingAssets);
  });

  it('adds the given relayer address as a required signer', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.submitAnchorCertificate(params, 'addr_test1specificrelayer');
    expect(calls.addSigner).toEqual(['addr_test1specificrelayer']);
  });

  it('sets a validity range around the anchor timestamp, narrow enough for the validator to accept', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.submitAnchorCertificate(params, 'addr_test1relayer');

    // zk_anchor.ak requires anchor_timestamp to fall inside the range AND the
    // range to be at most ten minutes wide. Omitting either bound, or setting
    // a wide one, makes the transaction fail on-chain — the same defect that
    // has already made other redeemers in this project unsubmittable.
    const from = calls.validFrom?.[0] as number;
    const to = calls.validTo?.[0] as number;
    const ts = Number(params.timestamp);

    expect(from).toBeLessThanOrEqual(ts);
    expect(to).toBeGreaterThanOrEqual(ts);
    expect(to - from).toBeLessThanOrEqual(600_000);
  });

  it('selects the wallet from the configured relayer private key before submitting', async () => {
    const { builder } = makeFakeTxBuilder();
    const { submitter, fakeLucid } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.submitAnchorCertificate(params, 'addr_test1relayer');
    expect(fakeLucid.selectWallet.fromPrivateKey).toHaveBeenCalledWith('ed25519_sk1fakefakefake');
  });

  it('converts a bigint timestamp param through BigInt() unchanged when already a bigint', async () => {
    const { builder, calls } = makeFakeTxBuilder();
    const { submitter } = makeSubmitter(builder, [{ datum: baseDatum(), assets: {} }]);

    await submitter.submitAnchorCertificate({ ...params, timestamp: 42n }, 'addr_test1relayer');
    const redeemer = calls.collectFrom![1] as { timestamp: bigint };
    expect(redeemer.timestamp).toBe(42n);
  });
});
