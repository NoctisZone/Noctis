// Tests for widget/claim-bundle.ts — the copy of a DarkVeil claim record that
// the buyer keeps.
//
// WHY THIS MATTERS
// The point of a buyer-held copy is that it works when the platform does not.
// So the thing worth testing is not the happy path — it is that a bundle which
// would fail at claim time is refused while the buyer is still looking at it,
// rather than months later when the server that could have reissued it is
// gone.

import { describe, expect, it, vi } from 'vitest';
import { buildDvAllocationTree, hashDvLeaf } from '../dv-allocation-tree.js';
import {
  type ClaimBundle,
  claimBundleFilename,
  fetchClaimBundle,
  parseSavedClaimBundle,
  serialiseClaimBundle,
  verifyClaimBundle,
} from '../widget/claim-bundle.js';

const VKH_A = 'aa'.repeat(28);
const VKH_B = 'bb'.repeat(28);
const SALT_A = '11'.repeat(32);
const SALT_B = '22'.repeat(32);

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(h: string): Uint8Array {
  return new Uint8Array(Buffer.from(h, 'hex'));
}

/** A real two-buyer tree, and the first buyer's real bundle from it. */
function realBundle(): ClaimBundle {
  const entries = [
    { vkh: fromHex(VKH_A), dvAmount: 1000n, salt: fromHex(SALT_A) },
    { vkh: fromHex(VKH_B), dvAmount: 2000n, salt: fromHex(SALT_B) },
  ];
  const tree = buildDvAllocationTree(entries);
  return {
    format: 'noctis-dv-claim-v1',
    launch_id: 'launch-1',
    address: 'addr_test1buyer',
    vkh_hex: VKH_A,
    root: hex(tree.root),
    dv_amount: '1000',
    salt_hex: SALT_A,
    leaf_index: 0,
    proof: tree.getProof(0).map((s) => ({ siblingHex: hex(s.sibling), goesLeft: s.goesLeft })),
    updated_at: 1_800_000_000,
  };
}

describe('verifyClaimBundle', () => {
  it('accepts a real bundle', () => {
    expect(verifyClaimBundle(realBundle())).toEqual({ ok: true });
  });

  it('refuses an amount edited upward', () => {
    // The one a buyer would be most tempted by, and the one the root exists
    // to make useless.
    const bundle = { ...realBundle(), dv_amount: '999999' };
    expect(verifyClaimBundle(bundle).ok).toBe(false);
  });

  it('refuses a replaced salt', () => {
    const bundle = { ...realBundle(), salt_hex: '00'.repeat(32) };
    expect(verifyClaimBundle(bundle).ok).toBe(false);
  });

  it('refuses a leaf index aimed at somebody else', () => {
    // The index is hashed into the leaf precisely so a proof cannot be
    // repointed at another buyer's nullifier bit.
    const bundle = { ...realBundle(), leaf_index: 1 };
    expect(verifyClaimBundle(bundle).ok).toBe(false);
  });

  it('refuses another wallet presenting this proof', () => {
    const bundle = { ...realBundle(), vkh_hex: VKH_B };
    expect(verifyClaimBundle(bundle).ok).toBe(false);
  });

  it('refuses a proof step flipped to the wrong side', () => {
    const real = realBundle();
    const bundle = { ...real, proof: real.proof.map((s) => ({ ...s, goesLeft: !s.goesLeft })) };
    expect(verifyClaimBundle(bundle).ok).toBe(false);
  });

  it('names a sibling that is not 32 bytes rather than hashing it anyway', () => {
    const real = realBundle();
    const bundle = { ...real, proof: [{ siblingHex: 'aabb', goesLeft: false }] };
    expect(verifyClaimBundle(bundle)).toMatchObject({ ok: false, reason: /32-byte sibling/ });
  });

  it('refuses an unrecognised format', () => {
    const bundle = { ...realBundle(), format: 'something-else' } as unknown as ClaimBundle;
    expect(verifyClaimBundle(bundle)).toMatchObject({ ok: false, reason: /unrecognised format/ });
  });

  it('refuses a non-integer leaf index instead of coercing it', () => {
    const bundle = { ...realBundle(), leaf_index: 1.5 };
    expect(verifyClaimBundle(bundle)).toMatchObject({ ok: false, reason: /whole number/ });
  });

  it('reports rather than throws when the amount is not a number', () => {
    const bundle = { ...realBundle(), dv_amount: 'not-a-number' };
    expect(() => verifyClaimBundle(bundle)).not.toThrow();
    expect(verifyClaimBundle(bundle).ok).toBe(false);
  });

  it('verifies a single-buyer bundle, where the root is the leaf', () => {
    const tree = buildDvAllocationTree([{ vkh: fromHex(VKH_A), dvAmount: 500n, salt: fromHex(SALT_A) }]);
    const bundle: ClaimBundle = {
      ...realBundle(),
      root: hex(tree.root),
      dv_amount: '500',
      leaf_index: 0,
      proof: [],
    };
    expect(hex(hashDvLeaf(fromHex(VKH_A), 500n, 0, fromHex(SALT_A)))).toBe(bundle.root);
    expect(verifyClaimBundle(bundle)).toEqual({ ok: true });
  });
});

describe('fetchClaimBundle', () => {
  function stubFetch(body: unknown, ok = true) {
    const urls: string[] = [];
    const spy = vi.fn(async (url: string) => {
      urls.push(url);
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
        text: async () => 'upstream said no',
      };
    });
    vi.stubGlobal('fetch', spy);
    return urls;
  }

  it('returns a verified bundle', async () => {
    stubFetch({ ...realBundle(), included: true });
    const result = await fetchClaimBundle('https://site/wp-json/np/v1', 'launch-1', 'addr_test1buyer');
    expect('included' in result && result.included === false).toBe(false);
    vi.unstubAllGlobals();
  });

  it('reports a wallet that did not buy as a normal answer', async () => {
    // Not an error: most wallets on a launch page did not take part in
    // DarkVeil, and a thrown error there would read as something being broken.
    stubFetch({ ok: true, included: false });
    await expect(fetchClaimBundle('https://site/wp-json/np/v1', 'launch-1', 'addr_test1nobody')).resolves.toEqual({
      included: false,
    });
    vi.unstubAllGlobals();
  });

  it('refuses to hand over a bundle the server got wrong', async () => {
    // The server is the only source, and this is the one moment a buyer could
    // still be told. Saving it silently would surface at claim time instead.
    stubFetch({ ...realBundle(), included: true, dv_amount: '999999' });
    await expect(fetchClaimBundle('https://site/wp-json/np/v1', 'launch-1', 'addr_test1buyer')).rejects.toThrow(
      /does not verify/,
    );
    vi.unstubAllGlobals();
  });

  it('surfaces a failed request with its status', async () => {
    stubFetch({}, false);
    await expect(fetchClaimBundle('https://site/wp-json/np/v1', 'launch-1', 'addr')).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });

  it('tolerates a REST base with a trailing slash', async () => {
    const urls = stubFetch({ ...realBundle(), included: true });
    await fetchClaimBundle('https://site/wp-json/np/v1/', 'launch-1', 'addr_test1buyer');
    expect(urls[0]).toContain('/np/v1/darkveil/allocation-proof?');
    expect(urls[0]).not.toContain('v1//darkveil');
    vi.unstubAllGlobals();
  });

  it('encodes an address so it cannot alter the query', async () => {
    const urls = stubFetch({ ok: true, included: false });
    await fetchClaimBundle('https://site/wp-json/np/v1', 'launch-1', 'addr&launch_id=other');
    expect(urls[0]).toContain('cardano_address=addr%26launch_id%3Dother');
    vi.unstubAllGlobals();
  });
});

describe('the saved file', () => {
  it('round-trips through save and reload', () => {
    const bundle = realBundle();
    expect(parseSavedClaimBundle(serialiseClaimBundle(bundle))).toMatchObject({
      launch_id: bundle.launch_id,
      dv_amount: bundle.dv_amount,
      leaf_index: bundle.leaf_index,
    });
  });

  it('carries a note explaining what it is', () => {
    // This file gets found in a downloads folder months later by someone who
    // does not remember saving it.
    const text = serialiseClaimBundle(realBundle());
    expect(text).toContain('_read_me');
    expect(text).toMatch(/cannot be regenerated/);
    expect(text).toMatch(/keep it private/i);
  });

  it('names the file after the launch and the wallet', () => {
    expect(claimBundleFilename(realBundle())).toBe('noctis-darkveil-claim-launch-1-aaaaaaaa.json');
  });

  it('refuses a file that is not JSON', () => {
    expect(() => parseSavedClaimBundle('nonsense')).toThrow(/not valid JSON/);
  });

  it('refuses a saved file whose contents no longer verify', () => {
    const tampered = serialiseClaimBundle({ ...realBundle(), dv_amount: '999999' });
    expect(() => parseSavedClaimBundle(tampered)).toThrow(/not a usable claim record/);
  });
});

describe('fetchClaimBundle with a wallet-control proof', () => {
  it('carries the proof in the query', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ ...realBundle(), included: true }), text: async () => '' };
      }),
    );
    await fetchClaimBundle('https://site/wp-json/np/v1', 'launch-1', 'addr_test1buyer', {
      stake_address: 'stake_test1abc',
      signature: 'sig',
      key: 'key',
    });
    expect(urls[0]).toMatch(/&stake_address=stake_test1abc&signature=sig&key=key$/);
    vi.unstubAllGlobals();
  });
});
