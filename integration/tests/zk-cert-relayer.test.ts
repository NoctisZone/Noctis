// Tests for zk-cert-relayer.ts — the ZK Fair Launch Certificate
// relayer: fetches the cert from Midnight, assembles + Blake2b-256 hashes
// the proof bundle, pins it to IPFS, then anchors the hashes on Cardano.
// No Lucid mocking needed here — this file has no Cardano tx-building of
// its own (that's cardano-anchor-submitter.ts, tested separately); it only
// depends on pluggable IpfsPinner/CardanoTxSubmitter interfaces and a
// NoctisLaunchManager, all faked directly. Blake2b-256 (@noble/hashes) is
// real and untouched — tested for determinism and canonicalization-order-
// independence rather than re-verifying the hash algorithm itself.

import { describe, expect, it, vi } from 'vitest';
import type { NoctisLaunchManager } from '../midnight-client.js';
import {
  assembleProofBundle,
  type CardanoTxSubmitter,
  computeMetadataHash,
  computeProofBundleHash,
  type FairLaunchCert,
  type IpfsPinner,
  type ProofBundle,
  relayCertificate,
} from '../zk-cert-relayer.js';

function fakeBytes(fill: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

/** The 32-byte root a Cardano Launch certificate has to commit to. */
function dvRoot(fill = 7): Uint8Array {
  return fakeBytes(fill);
}

function baseCert(overrides: Partial<FairLaunchCert> = {}): FairLaunchCert {
  return {
    launchId: fakeBytes(1),
    totalParticipants: 42n,
    totalTokensAllocated: 150_000_000n,
    totalRaised: 25_000_000n,
    // A bigint, matching what the compiled contract really returns for a
    // Compact numeric field. A number here would make every test below pass
    // against a shape the chain never produces.
    participationRate: 78n,
    closeTimestamp: 1_753_000_000n,
    certHash: fakeBytes(2),
    ...overrides,
  };
}

describe('assembleProofBundle', () => {
  it('hex-encodes byte fields and stringifies bigints (bigints do not survive JSON.stringify)', () => {
    const cert = baseCert();
    const bundle = assembleProofBundle(cert, 'B', dvRoot());
    expect(bundle.launchId).toBe('01'.repeat(32));
    expect(bundle.certHash).toBe('02'.repeat(32));
    expect(bundle.totalParticipants).toBe('42');
    expect(bundle.totalTokensAllocated).toBe('150000000');
    expect(bundle.totalRaised).toBe('25000000');
    expect(bundle.closeTimestamp).toBe('1753000000');
    expect(bundle.participationRate).toBe(78);
    expect(bundle.tier).toBe('B');
  });

  it('narrows participationRate to a JSON-serialisable number, so the bundle can be hashed at all', () => {
    // The certificate's numeric fields all arrive as bigints, and JSON.stringify
    // throws on one. Hashing the assembled bundle is what proves this field was
    // really narrowed rather than carried through as a bigint.
    const bundle = assembleProofBundle(baseCert(), 'B', dvRoot());
    expect(typeof bundle.participationRate).toBe('number');
    expect(() => computeProofBundleHash(bundle)).not.toThrow();
  });

  it('refuses a participationRate outside the Uint<8> range the certificate declares', () => {
    expect(() => assembleProofBundle(baseCert({ participationRate: 256n }), 'B', dvRoot())).toThrow(/Uint<8> range/);
    expect(() => assembleProofBundle(baseCert({ participationRate: -1n }), 'B', dvRoot())).toThrow(/Uint<8> range/);
  });

  it('sets tier to FullZKCert-eligible "C" when passed', () => {
    expect(assembleProofBundle(baseCert(), 'C').tier).toBe('C');
  });

  it('carries the DarkVeil allocation root a Cardano Launch certificate settles against', () => {
    expect(assembleProofBundle(baseCert(), 'B', dvRoot()).dvAllocationRoot).toBe('07'.repeat(32));
  });

  it('REFUSES a Cardano Launch bundle with no allocation root — the certificate would commit to no distribution', () => {
    expect(() => assembleProofBundle(baseCert(), 'B')).toThrow(/without the DarkVeil allocation root/);
  });

  it('refuses a Cardano Launch allocation root that is not 32 bytes, rather than hashing a truncated one', () => {
    expect(() => assembleProofBundle(baseCert(), 'B', new Uint8Array(31).fill(7))).toThrow(/got 31 bytes/);
  });

  it('leaves the root empty on Midnight Launch, where every registrant gets the same baseSlot', () => {
    expect(assembleProofBundle(baseCert(), 'C').dvAllocationRoot).toBe('');
  });

  it('refuses a root on Midnight Launch rather than silently binding one that gates nothing', () => {
    expect(() => assembleProofBundle(baseCert(), 'C', dvRoot())).toThrow(/no DarkVeil allocation root to bind/);
  });
});

describe('computeProofBundleHash', () => {
  it('produces a real 32-byte Blake2b-256 digest', () => {
    const hash = computeProofBundleHash(assembleProofBundle(baseCert(), 'B', dvRoot()));
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  it('is deterministic — the same bundle hashes to the same value every time', () => {
    const bundle = assembleProofBundle(baseCert(), 'B', dvRoot());
    const h1 = computeProofBundleHash(bundle);
    const h2 = computeProofBundleHash(bundle);
    expect(Array.from(h1)).toEqual(Array.from(h2));
  });

  it("is insensitive to the JS object's own key insertion order (canonicalization fixes real key order)", () => {
    const cert = baseCert();
    const bundleA = assembleProofBundle(cert, 'B', dvRoot());
    // Same values, deliberately different property insertion order.
    const bundleB: ProofBundle = {
      certHash: bundleA.certHash,
      // Deliberately not last, though canonicalization puts it last — this
      // test is worth nothing if the literal happens to match the real order.
      dvAllocationRoot: bundleA.dvAllocationRoot,
      closeTimestamp: bundleA.closeTimestamp,
      tier: bundleA.tier,
      launchId: bundleA.launchId,
      totalRaised: bundleA.totalRaised,
      participationRate: bundleA.participationRate,
      totalTokensAllocated: bundleA.totalTokensAllocated,
      totalParticipants: bundleA.totalParticipants,
    };
    expect(Array.from(computeProofBundleHash(bundleA))).toEqual(Array.from(computeProofBundleHash(bundleB)));
  });

  it('produces a DIFFERENT hash when any field differs (real sensitivity, not a constant)', () => {
    const h1 = computeProofBundleHash(assembleProofBundle(baseCert(), 'B', dvRoot()));
    const h2 = computeProofBundleHash(assembleProofBundle(baseCert({ totalRaised: 25_000_001n }), 'B', dvRoot()));
    expect(Array.from(h1)).not.toEqual(Array.from(h2));
  });

  it('changes when the allocation root changes, on identical cert figures — the point of binding it', () => {
    // Same participants, same tokens, same raise. Only the distribution
    // differs, which is precisely what the aggregates cannot express and what
    // this field exists to commit to.
    const cert = baseCert();
    const h1 = computeProofBundleHash(assembleProofBundle(cert, 'B', dvRoot(7)));
    const h2 = computeProofBundleHash(assembleProofBundle(cert, 'B', dvRoot(8)));
    expect(Array.from(h1)).not.toEqual(Array.from(h2));
  });

  it('produces a different hash for Cardano Launch vs Midnight Launch of the SAME cert data (tier is part of the hashed content)', () => {
    const cert = baseCert();
    const hB = computeProofBundleHash(assembleProofBundle(cert, 'B', dvRoot()));
    const hC = computeProofBundleHash(assembleProofBundle(cert, 'C'));
    expect(Array.from(hB)).not.toEqual(Array.from(hC));
  });
});

describe('computeMetadataHash', () => {
  it('is insensitive to key insertion order (keys are sorted before hashing)', () => {
    const h1 = computeMetadataHash({ b: 2, a: 1, c: 'three' });
    const h2 = computeMetadataHash({ a: 1, c: 'three', b: 2 });
    expect(Array.from(h1)).toEqual(Array.from(h2));
  });

  it('produces a different hash when a value differs', () => {
    const h1 = computeMetadataHash({ tier: 'B', name: 'Jinx Test' });
    const h2 = computeMetadataHash({ tier: 'B', name: 'Different Name' });
    expect(Array.from(h1)).not.toEqual(Array.from(h2));
  });

  it('produces a real 32-byte digest', () => {
    expect(computeMetadataHash({}).length).toBe(32);
  });
});

describe('relayCertificate — orchestration', () => {
  function fakeLaunchManager(cert: FairLaunchCert): NoctisLaunchManager {
    return {
      getFairLaunchCert: vi.fn().mockResolvedValue(cert),
    } as unknown as NoctisLaunchManager;
  }

  function fakePinner(cidBytes: Uint8Array): IpfsPinner {
    return { pin: vi.fn().mockResolvedValue(cidBytes) };
  }

  function fakeSubmitter(txHash: string): CardanoTxSubmitter {
    return { submitAnchorCertificate: vi.fn().mockResolvedValue({ txHash }) };
  }

  // The manager hands back a FairLaunchCert whichever way it obtained one — a
  // published-ledger read on Cardano Launch, a circuit call on Midnight Launch — so the relayer
  // no longer has an SDK return shape to unwrap.
  it('assembles the bundle from the certificate the manager returns', async () => {
    const cert = baseCert();
    const launchManager = fakeLaunchManager(cert);
    const result = await relayCertificate(
      launchManager,
      'B',
      dvRoot(),
      fakePinner(fakeBytes(9, 34)),
      fakeSubmitter('tx-1'),
      'addr_relayer',
    );
    expect(result.bundle.launchId).toBe('01'.repeat(32));
  });

  it('maps tier "B" to certType DarkVeilCert and tier "C" to FullZKCert', async () => {
    const cert = baseCert();
    const submitterB = fakeSubmitter('tx-b');
    await relayCertificate(
      fakeLaunchManager(cert),
      'B',
      dvRoot(),
      fakePinner(fakeBytes(1)),
      submitterB,
      'addr_relayer',
    );
    expect(vi.mocked(submitterB.submitAnchorCertificate).mock.calls[0][0].certType).toBe('DarkVeilCert');

    const submitterC = fakeSubmitter('tx-c');
    await relayCertificate(
      fakeLaunchManager(cert),
      'C',
      undefined,
      fakePinner(fakeBytes(1)),
      submitterC,
      'addr_relayer',
    );
    expect(vi.mocked(submitterC.submitAnchorCertificate).mock.calls[0][0].certType).toBe('FullZKCert');
  });

  it('pins the canonicalized bundle bytes to IPFS and passes the returned CID through as proofIpfsCid', async () => {
    const cert = baseCert();
    const cidBytes = fakeBytes(77, 34);
    const pinner = fakePinner(cidBytes);
    const submitter = fakeSubmitter('tx-1');

    const result = await relayCertificate(fakeLaunchManager(cert), 'B', dvRoot(), pinner, submitter, 'addr_relayer');

    expect(pinner.pin).toHaveBeenCalledTimes(1);
    expect(Array.from(result.proofIpfsCid)).toEqual(Array.from(cidBytes));
    const submittedParams = vi.mocked(submitter.submitAnchorCertificate).mock.calls[0][0];
    expect(Array.from(submittedParams.proofIpfsCid)).toEqual(Array.from(cidBytes));
  });

  it('anchors with the submission time, not cert.closeTimestamp, and passes the given relayerAddress through', async () => {
    const cert = baseCert({ closeTimestamp: 9_999_999n });
    const submitter = fakeSubmitter('tx-1');

    await relayCertificate(
      fakeLaunchManager(cert),
      'B',
      dvRoot(),
      fakePinner(fakeBytes(1)),
      submitter,
      'addr_specific_relayer',
    );

    const [params, relayerAddr] = vi.mocked(submitter.submitAnchorCertificate).mock.calls[0];
    // zk_anchor.ak checks anchor_timestamp against the transaction's own
    // validity range, which is in POSIX milliseconds. cert.closeTimestamp is
    // Midnight's DarkVeil close time and could never fall inside that range,
    // so anchoring with it would fail on-chain every time.
    expect(params.timestamp).not.toBe(9_999_999n);
    expect(params.timestamp).toBeGreaterThan(1_700_000_000_000n);
    expect(relayerAddr).toBe('addr_specific_relayer');
  });

  it('merges extraMetadata with the tier into the metadata hash input (different extraMetadata -> different hash)', async () => {
    const cert = baseCert();
    const submitter1 = fakeSubmitter('tx-1');
    const submitter2 = fakeSubmitter('tx-2');

    const result1 = await relayCertificate(
      fakeLaunchManager(cert),
      'B',
      dvRoot(),
      fakePinner(fakeBytes(1)),
      submitter1,
      'addr',
      {
        displayName: 'Launch A',
      },
    );
    const result2 = await relayCertificate(
      fakeLaunchManager(cert),
      'B',
      dvRoot(),
      fakePinner(fakeBytes(1)),
      submitter2,
      'addr',
      {
        displayName: 'Launch B',
      },
    );

    expect(Array.from(result1.metadataHash)).not.toEqual(Array.from(result2.metadataHash));
  });

  it('returns the real txHash from the Cardano submitter alongside the bundle/hashes', async () => {
    const cert = baseCert();
    const result = await relayCertificate(
      fakeLaunchManager(cert),
      'B',
      dvRoot(),
      fakePinner(fakeBytes(1)),
      fakeSubmitter('real-tx-hash-99'),
      'addr',
    );
    expect(result.txHash).toBe('real-tx-hash-99');
    expect(result.proofBundleHash.length).toBe(32);
    expect(result.metadataHash.length).toBe(32);
  });
});
