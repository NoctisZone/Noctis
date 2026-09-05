// The holder's side of CTO governance from a browser: what register, my-leaf
// and has-voted trust, and what they refuse.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMAINS, deriveUserPublicKey, type UserSecretKey } from '../../contracts/midnight/witnesses.js';
import { computeVoteNullifier } from '../../packages/zk-proofs/src/cto-governance.js';
import { buildSnapshotBundle, entryRecomputesRoot } from '../cto-snapshot-bundle.js';
import type { CtoSession } from '../widget/cto-session.js';
import {
  bytesToHex,
  currentTimestampSeconds,
  entryReachesRoot,
  fetchMyLeaf,
  hasVoted,
  hexToBytes,
  myVoteNullifier,
  registerVoter,
  verifyMyLeaf,
  witnessProofFrom,
} from '../widget/cto-vote-flow.js';

const LAUNCH_HEX = '11'.repeat(32);
const SECRET: UserSecretKey = { bytes: new Uint8Array(32).fill(7) };
const MY_KEY_HEX = bytesToHex(deriveUserPublicKey(SECRET, DOMAINS.CTO_USER, hexToBytes(LAUNCH_HEX)).bytes);

function fakeSession(): CtoSession {
  return {
    cardano: {
      chain: 'cardano',
      walletId: 'eternl',
      walletName: 'Eternl',
      address: 'addr_test1me',
      paymentKeyHash: '',
      stakingKeyHash: '',
      rewardAddressHex: 'e0ff',
      stakeAddress: 'stake_test1me',
      networkId: 0,
      network: 'preprod',
      balance: '0',
    },
    privateStore: {} as CtoSession['privateStore'],
    getIdentity: async () => ({ userSecretKey: SECRET }),
    getIdentityPublicKey: async (launchId: Uint8Array) => deriveUserPublicKey(SECRET, DOMAINS.CTO_USER, launchId),
    getMasterSignatureMaterial: async () => ({ signature: 'cose-sig', key: 'cose-key' }),
  };
}

/** A real bundle with this identity in it plus two others, so a proof has siblings. */
function bundleWithMe() {
  return buildSnapshotBundle(LAUNCH_HEX, [
    { label: 'other-1', voterKeyHex: 'aa'.repeat(32), balance: '5000000', heldSinceTimestamp: '1700000000' },
    { label: 'me', voterKeyHex: MY_KEY_HEX, balance: '10000000', heldSinceTimestamp: '1700000000' },
    { label: 'other-2', voterKeyHex: 'bb'.repeat(32), balance: '7000000', heldSinceTimestamp: '1700000000' },
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerVoter', () => {
  it('sends the master signature material and accepts only its own derived key back', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, voter_key_hex: MY_KEY_HEX, registered_at: 1234 }),
        };
      }),
    );
    const result = await registerVoter('https://site/wp-json/np/v1', fakeSession(), 'launch-1', LAUNCH_HEX);
    expect(result).toEqual({ voterKeyHex: MY_KEY_HEX, registeredAt: 1234 });
    expect(calls[0].url).toBe('https://site/wp-json/np/v1/cto/register');
    expect(calls[0].body).toEqual({
      launch_id: 'launch-1',
      cardano_address: 'addr_test1me',
      cip8_signature_hex: 'cose-sig',
      cip8_key_hex: 'cose-key',
    });
  });

  it('refuses a registration whose server-derived key is not the one this wallet holds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, voter_key_hex: 'cc'.repeat(32) }) })),
    );
    await expect(registerVoter('https://site', fakeSession(), 'launch-1', LAUNCH_HEX)).rejects.toThrow(
      /different voting identity/,
    );
  });

  it('surfaces the server refusing the signature', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ message: 'signature did not verify' }) })),
    );
    await expect(registerVoter('https://site', fakeSession(), 'launch-1', LAUNCH_HEX)).rejects.toThrow(
      /signature did not verify/,
    );
  });
});

describe('entryReachesRoot', () => {
  it('agrees with the server-side walk on every entry of a real bundle, and on a tampered one', () => {
    const b = bundleWithMe();
    for (const e of b.entries) {
      expect(entryReachesRoot(e, b.rootHex)).toBe(true);
      expect(entryRecomputesRoot(e, b.rootHex)).toBe(true);
    }
    const bad = { ...b.entries[1], heldSinceTimestamp: '1' };
    expect(entryReachesRoot(bad, b.rootHex)).toBe(false);
    expect(entryRecomputesRoot(bad, b.rootHex)).toBe(false);
  });
});

describe('verifyMyLeaf', () => {
  it('accepts its own entry from a real bundle', () => {
    const b = bundleWithMe();
    const entry = b.entries.find((e) => e.label === 'me');
    if (!entry) throw new Error('fixture');
    const leaf = { format: 'noctis-cto-leaf-v1' as const, launchIdHex: LAUNCH_HEX, rootHex: b.rootHex, entry };
    expect(verifyMyLeaf(leaf, MY_KEY_HEX, LAUNCH_HEX)).toEqual({ ok: true });
  });

  it("refuses someone else's entry, even when it is a valid leaf of the same tree", () => {
    const b = bundleWithMe();
    const entry = b.entries.find((e) => e.label === 'other-1');
    if (!entry) throw new Error('fixture');
    const leaf = { format: 'noctis-cto-leaf-v1' as const, launchIdHex: LAUNCH_HEX, rootHex: b.rootHex, entry };
    expect(verifyMyLeaf(leaf, MY_KEY_HEX, LAUNCH_HEX).reason).toMatch(/different voting identity/);
  });

  it('refuses a tampered balance, another launch, and a bad format', () => {
    const b = bundleWithMe();
    const entry = b.entries.find((e) => e.label === 'me');
    if (!entry) throw new Error('fixture');
    const good = { format: 'noctis-cto-leaf-v1' as const, launchIdHex: LAUNCH_HEX, rootHex: b.rootHex, entry };
    expect(verifyMyLeaf({ ...good, entry: { ...entry, balance: '99999999' } }, MY_KEY_HEX, LAUNCH_HEX).reason).toMatch(
      /does not reach the root/,
    );
    expect(verifyMyLeaf(good, MY_KEY_HEX, '22'.repeat(32)).reason).toMatch(/different launch/);
    expect(
      verifyMyLeaf({ ...good, format: 'nope' as unknown as 'noctis-cto-leaf-v1' }, MY_KEY_HEX, LAUNCH_HEX).reason,
    ).toMatch(/unrecognised format/);
  });
});

describe('fetchMyLeaf', () => {
  it('proves wallet control under a leaf-scoped binds, then verifies what comes back', async () => {
    const b = bundleWithMe();
    const entry = b.entries.find((e) => e.label === 'me');
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith('/auth/nonce')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, payload_hex: 'aa' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ format: 'noctis-cto-leaf-v1', launch_id_hex: LAUNCH_HEX, root_hex: b.rootHex, entry }),
        };
      }),
    );
    vi.mock('../wallet-connection.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../wallet-connection.js')>()),
      signCardanoData: async () => ({ signature: 'sig', key: 'key' }),
    }));

    const leaf = await fetchMyLeaf('https://site/wp-json/np/v1', fakeSession(), 'launch-1', LAUNCH_HEX);
    expect('entry' in leaf && leaf.entry.voterKeyHex).toBe(MY_KEY_HEX);
    expect(urls[1]).toMatch(/\/cto\/leaf\?launch_id=launch-1&cardano_address=addr_test1me&stake_address=stake_test1me/);
  });

  it('reports not-in-snapshot as a normal answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/nonce')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, payload_hex: 'aa' }) };
        }
        return { ok: true, status: 200, json: async () => ({ included: false, reason: 'not registered' }) };
      }),
    );
    await expect(fetchMyLeaf('https://site', fakeSession(), 'launch-1', LAUNCH_HEX)).resolves.toEqual({
      included: false,
      reason: 'not registered',
    });
  });
});

describe('vote plumbing', () => {
  it('turns a bundle entry into the witness proof shape', () => {
    const b = bundleWithMe();
    const proof = witnessProofFrom(b.entries[0]);
    expect(proof).toHaveLength(20);
    expect(proof[0].sibling).toBeInstanceOf(Uint8Array);
    expect(proof[0].sibling).toHaveLength(32);
    expect(typeof proof[0].goesLeft).toBe('boolean');
  });

  it('declares the timestamp in seconds, never milliseconds', () => {
    expect(currentTimestampSeconds(1_700_000_000_123)).toBe(1_700_000_000n);
  });

  it('computes the nullifier the contract would record for this identity', () => {
    const pid = '33'.repeat(32);
    expect(myVoteNullifier(SECRET.bytes, LAUNCH_HEX, pid)).toEqual(
      computeVoteNullifier({
        voterSecret: SECRET.bytes,
        launchId: hexToBytes(LAUNCH_HEX),
        proposalId: hexToBytes(pid),
      }),
    );
  });

  it('hasVoted asks the ledger for exactly that nullifier', async () => {
    const pid = '33'.repeat(32);
    const mine = bytesToHex(myVoteNullifier(SECRET.bytes, LAUNCH_HEX, pid));
    const asked: string[] = [];
    const readLedger = async () => ({
      voteNullifiers: {
        member: (n: Uint8Array) => {
          asked.push(bytesToHex(n));
          return bytesToHex(n) === mine;
        },
      },
    });
    const provider = {} as never;
    await expect(hasVoted(provider, '00'.repeat(32), fakeSession(), LAUNCH_HEX, pid, readLedger)).resolves.toBe(true);
    await expect(
      hasVoted(provider, '00'.repeat(32), fakeSession(), LAUNCH_HEX, '44'.repeat(32), readLedger),
    ).resolves.toBe(false);
    expect(asked[0]).toBe(mine);
    expect(asked[1]).not.toBe(mine);
  });
});
