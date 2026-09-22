// ============================================================================
// Binding a creator's identity to their launch — the whole submission
// ============================================================================
// creator-identity.test.ts covers the route client on its own. This covers the
// step above it: taking a connected session, deriving the launch-scoped
// identity, proving control of the creator's wallet, and sending both.
//
// The first block is the one that matters most and looks the least like a
// test. The gate excludes a registrant whose key equals the sealed creator
// key, and that key is derived under ONE domain. A key derived under any other
// domain is still 32 bytes, still launch-scoped, still passes the route's
// validation, the deploy's custody check and the constructor — and excludes
// nobody. Nothing downstream can tell the two apart, so the difference is
// pinned here.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMAINS, deriveUserPublicKey } from '../../contracts/midnight/witnesses.js';
import {
  bindCreatorIdentity,
  CREATOR_MIDNIGHT_KEY_ACTION,
  type CreatorIdentitySource,
  launchIdFromHex,
} from '../widget/creator-identity.js';
import { buildBinds } from '../widget/wallet-control.js';

const LAUNCH_HEX = '11'.repeat(32);
const OTHER_LAUNCH_HEX = '22'.repeat(32);
const SECRET = new Uint8Array(32).fill(7);
const API = 'https://noctis.example/wp-json/np/v1/';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('the domain the creator identity is derived under', () => {
  it('is the one the gate compares a registrant against, not the governance one', () => {
    // eligibility_gate.compact derives the caller as
    // deriveUserPublicKey(sk, launchId) under pad(32, "noctis:user:pk:v1")
    // and asserts caller != creatorKey. Seal a key from any other domain and
    // that assertion holds for every real registrant including the creator.
    const launchId = launchIdFromHex(LAUNCH_HEX);
    const eligibility = deriveUserPublicKey({ bytes: SECRET }, DOMAINS.ELIGIBILITY_USER, launchId);
    const governance = deriveUserPublicKey({ bytes: SECRET }, DOMAINS.CTO_USER, launchId);

    expect(hex(eligibility.bytes)).not.toBe(hex(governance.bytes));
    expect(DOMAINS.ELIGIBILITY_USER).toBe('noctis:user:pk:v1');
  });

  it('gives one wallet a different identity at each of its launches', () => {
    // A creator running two launches must not be matchable across them by the
    // value their own exclusion is written with.
    const here = deriveUserPublicKey({ bytes: SECRET }, DOMAINS.ELIGIBILITY_USER, launchIdFromHex(LAUNCH_HEX));
    const there = deriveUserPublicKey({ bytes: SECRET }, DOMAINS.ELIGIBILITY_USER, launchIdFromHex(OTHER_LAUNCH_HEX));
    expect(hex(here.bytes)).not.toBe(hex(there.bytes));
  });
});

describe('the launch a key is scoped to', () => {
  it('takes 32 bytes of hex, in either case', () => {
    expect(hex(launchIdFromHex(LAUNCH_HEX))).toBe(LAUNCH_HEX);
    expect(hex(launchIdFromHex(LAUNCH_HEX.toUpperCase()))).toBe(LAUNCH_HEX);
    expect(hex(launchIdFromHex(` ${LAUNCH_HEX} `))).toBe(LAUNCH_HEX);
  });

  it('refuses a value that is not hex rather than reading it as zeroes', () => {
    // Lenient hex parsing turns an unrecognised digit into a zero, which would
    // scope the identity to a launch that does not exist — and every check
    // after that point would pass.
    expect(() => launchIdFromHex('zz'.repeat(32))).toThrow(/64 hex characters/);
  });

  it('refuses the wrong length, both ways', () => {
    expect(() => launchIdFromHex('11'.repeat(31))).toThrow(/64 hex characters/);
    expect(() => launchIdFromHex('11'.repeat(33))).toThrow(/64 hex characters/);
    expect(() => launchIdFromHex('')).toThrow(/64 hex characters/);
  });
});

// ---------------------------------------------------------------------------

interface Recorded {
  nonceBinds: string | undefined;
  signedPayloadHex: string | undefined;
  submitted: Record<string, unknown> | undefined;
  submitUrl: string | undefined;
}

/** A session that derives the real key from a known secret, and a wallet that
 *  signs whatever it is handed — so what is asserted is what travelled. */
function fakeSource(): CreatorIdentitySource {
  return {
    cardano: {
      walletId: 'lace',
      stakeAddress: 'stake_test1creator',
      rewardAddressHex: 'e0deadbeef',
    },
    getIdentityPublicKey: async (launchId: Uint8Array) =>
      deriveUserPublicKey({ bytes: SECRET }, DOMAINS.ELIGIBILITY_USER, launchId),
  };
}

function stubRoutes(submitStatus: number, submitBody: unknown): Recorded {
  const rec: Recorded = {
    nonceBinds: undefined,
    signedPayloadHex: undefined,
    submitted: undefined,
    submitUrl: undefined,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/auth/nonce')) {
        rec.nonceBinds = body.binds;
        return { ok: true, status: 200, json: async () => ({ payload_hex: 'facade' }) } as unknown as Response;
      }
      rec.submitUrl = url;
      rec.submitted = body;
      return {
        ok: submitStatus >= 200 && submitStatus < 300,
        status: submitStatus,
        json: async () => submitBody,
      } as unknown as Response;
    }),
  );
  return rec;
}

async function run(rec: Recorded, launchIdHex = LAUNCH_HEX) {
  return bindCreatorIdentity({
    apiBase: API,
    slug: 'my-launch',
    launchIdHex,
    source: fakeSource(),
    signData: async (_walletId, _address, payloadHex) => {
      rec.signedPayloadHex = payloadHex;
      return { signature: '84584da2', key: 'a4010103272006' };
    },
  });
}

describe('binding the identity', () => {
  it('sends the key the gate will compare against, under its own field name', async () => {
    const expected = hex(
      deriveUserPublicKey({ bytes: SECRET }, DOMAINS.ELIGIBILITY_USER, launchIdFromHex(LAUNCH_HEX)).bytes,
    );
    const rec = stubRoutes(200, { ok: true, midnight_key: expected });
    const result = await run(rec);

    expect(result).toMatchObject({ ok: true, keyHex: expected });
    expect(rec.submitted?.midnight_key).toBe(expected);
    // `key` stays the CIP-8 witness. Two meanings for one field is how a
    // signature ends up checked against an identity.
    expect(rec.submitted?.key).toBe('a4010103272006');
    expect(rec.submitUrl).toBe(`${API}launches/my-launch/creator-midnight-key`);
  });

  it('asks for a challenge bound to this launch and this key, the way the server rebuilds it', async () => {
    const expected = hex(
      deriveUserPublicKey({ bytes: SECRET }, DOMAINS.ELIGIBILITY_USER, launchIdFromHex(LAUNCH_HEX)).bytes,
    );
    const rec = stubRoutes(200, { ok: true, midnight_key: expected });
    await run(rec);

    expect(rec.nonceBinds).toBe(buildBinds(CREATOR_MIDNIGHT_KEY_ACTION, [LAUNCH_HEX, expected]));
  });

  it('binds a different challenge for a different launch, so one signature cannot serve both', async () => {
    const first = stubRoutes(200, { ok: true, midnight_key: 'x' });
    await run(first).catch(() => undefined);
    const second = stubRoutes(200, { ok: true, midnight_key: 'x' });
    await run(second, OTHER_LAUNCH_HEX).catch(() => undefined);

    expect(first.nonceBinds).not.toBe(second.nonceBinds);
  });

  it('signs the challenge the server issued, not one it made up', async () => {
    const rec = stubRoutes(200, { ok: true, midnight_key: 'x' });
    await run(rec).catch(() => undefined);
    expect(rec.signedPayloadHex).toBe('facade');
  });

  it('carries the derived key back on a refusal, because that is what a retry needs', async () => {
    const rec = stubRoutes(409, { code: 'np_midnight_key_sealed', message: 'already has a deployed gate' });
    const result = await run(rec);

    expect(result.ok).toBe(false);
    expect(result.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ok === false && result.code).toBe('np_midnight_key_sealed');
  });

  it('refuses a bad launch id before spending a wallet prompt on it', async () => {
    const rec = stubRoutes(200, { ok: true, midnight_key: 'x' });
    await expect(run(rec, 'nonsense')).rejects.toThrow(/64 hex characters/);
    expect(rec.signedPayloadHex).toBeUndefined();
    expect(rec.submitted).toBeUndefined();
  });

  it('refuses a wallet with no stake address rather than sending an unprovable claim', async () => {
    const rec = stubRoutes(200, { ok: true, midnight_key: 'x' });
    await expect(
      bindCreatorIdentity({
        apiBase: API,
        slug: 'my-launch',
        launchIdHex: LAUNCH_HEX,
        source: { ...fakeSource(), cardano: { walletId: 'lace', stakeAddress: '', rewardAddressHex: '' } },
        signData: async () => ({ signature: '', key: '' }),
      }),
    ).rejects.toThrow(/stake \(reward\) address/);
    expect(rec.submitted).toBeUndefined();
  });
});
