import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_MIDNIGHT_KEY_ACTION,
  creatorMidnightKeyBinds,
  isIdentityKeyHex,
  submitCreatorMidnightKey,
} from '../widget/creator-identity.js';
import { buildBinds, type WalletControlProof } from '../widget/wallet-control.js';

const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const LAUNCH = 'deadbeef';

const proof: WalletControlProof = {
  stake_address: 'stake_test1abc',
  signature: '84584da2',
  key: 'a4010103272006',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }),
  );
  return calls;
}

describe('what a signature is bound to', () => {
  it('binds the launch and the key together, the way the server rebuilds it', () => {
    // A mismatch is refused server-side as an out-of-scope challenge rather
    // than as a bad signature, so the two have to be kept in step on purpose.
    expect(creatorMidnightKeyBinds(LAUNCH, KEY)).toBe(buildBinds(CREATOR_MIDNIGHT_KEY_ACTION, [LAUNCH, KEY]));
  });

  it('gives a different binding for a different key on the same launch', () => {
    // Otherwise a signature the creator gave for one identity would accept
    // another substituted after they had signed.
    expect(creatorMidnightKeyBinds(LAUNCH, KEY)).not.toBe(creatorMidnightKeyBinds(LAUNCH, OTHER_KEY));
  });

  it('gives a different binding for the same key on a different launch', () => {
    // A creator runs more than one launch, and a signature taken at one must
    // not bind an identity at the other.
    expect(creatorMidnightKeyBinds(LAUNCH, KEY)).not.toBe(creatorMidnightKeyBinds('feedface', KEY));
  });

  it('does not depend on the case a value is written in', () => {
    expect(creatorMidnightKeyBinds(LAUNCH.toUpperCase(), KEY.toUpperCase())).toBe(creatorMidnightKeyBinds(LAUNCH, KEY));
  });
});

describe('what counts as an identity', () => {
  it('takes 32 bytes of hex', () => {
    expect(isIdentityKeyHex(KEY)).toBe(true);
    expect(isIdentityKeyHex(KEY.toUpperCase())).toBe(true);
  });

  it('refuses an empty buffer, which is what an uninitialised one looks like', () => {
    expect(isIdentityKeyHex('00'.repeat(32))).toBe(false);
  });

  it('refuses anything that is not 32 bytes of hex', () => {
    expect(isIdentityKeyHex('abcd')).toBe(false);
    expect(isIdentityKeyHex('zz'.repeat(32))).toBe(false);
    expect(isIdentityKeyHex(`${KEY}00`)).toBe(false);
  });
});

describe('submitting the identity', () => {
  it('sends the identity under a name that does not collide with the CIP-8 witness', async () => {
    // The shared wallet-control verifier reads `key` as the witness public
    // key. Sending the identity under the same name would have it checked as
    // a signature, or stored as one.
    const calls = stubFetch(200, { ok: true, midnight_key: KEY });
    await submitCreatorMidnightKey({ apiBase: 'https://x/np/v1/', slug: 'my-launch', keyHex: KEY, proof });

    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.midnight_key).toBe(KEY);
    expect(sent.key).toBe(proof.key);
    expect(sent.stake_address).toBe(proof.stake_address);
    expect(sent.signature).toBe(proof.signature);
  });

  it('addresses the launch by slug', async () => {
    const calls = stubFetch(200, { ok: true, midnight_key: KEY });
    await submitCreatorMidnightKey({ apiBase: 'https://x/np/v1/', slug: 'my-launch', keyHex: KEY, proof });
    expect(calls[0].url).toBe('https://x/np/v1/launches/my-launch/creator-midnight-key');
  });

  it('refuses an unusable identity without asking the server', async () => {
    // A wallet that has not finished producing one yields an empty buffer, and
    // spending a signature prompt on it would cost the creator a second one.
    const calls = stubFetch(200, { ok: true, midnight_key: KEY });
    const result = await submitCreatorMidnightKey({
      apiBase: 'https://x/np/v1/',
      slug: 'my-launch',
      keyHex: '00'.repeat(32),
      proof,
    });
    expect(result).toMatchObject({ ok: false, code: 'np_bad_midnight_key' });
    expect(calls).toHaveLength(0);
  });

  it('carries the server’s own reason back, because every one of them is actionable', async () => {
    // A stale challenge, the wrong wallet, a launch whose gate is already
    // deployed: each has a different thing for the creator to do, and all
    // three arrive as "something went wrong" if the reason is dropped.
    stubFetch(409, {
      code: 'np_midnight_key_sealed',
      message: 'This launch already has a deployed gate…',
      data: { status: 409 },
    });
    const result = await submitCreatorMidnightKey({
      apiBase: 'https://x/np/v1/',
      slug: 'my-launch',
      keyHex: KEY,
      proof,
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'np_midnight_key_sealed' });
    expect(result.ok === false && result.message).toMatch(/already has a deployed gate/);
  });

  it('does not read a success with no identity in it as a success', async () => {
    // A proxy or a cache can return 200 with something that is not the route's
    // answer, and reporting that as stored would leave the creator believing
    // the launch knows an identity it does not.
    stubFetch(200, { ok: true });
    const result = await submitCreatorMidnightKey({
      apiBase: 'https://x/np/v1/',
      slug: 'my-launch',
      keyHex: KEY,
      proof,
    });
    expect(result.ok).toBe(false);
  });

  it('survives a response that is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      })) as unknown as typeof fetch,
    );
    const result = await submitCreatorMidnightKey({
      apiBase: 'https://x/np/v1/',
      slug: 'my-launch',
      keyHex: KEY,
      proof,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(result.ok === false && result.message).toMatch(/HTTP 502/);
  });

  it('reports the stored identity from the server rather than the one it sent', async () => {
    // They should agree, and the one that matters is what the record holds.
    stubFetch(200, { ok: true, midnight_key: OTHER_KEY });
    const result = await submitCreatorMidnightKey({
      apiBase: 'https://x/np/v1/',
      slug: 'my-launch',
      keyHex: KEY,
      proof,
    });
    expect(result).toEqual({ ok: true, keyHex: OTHER_KEY });
  });
});
