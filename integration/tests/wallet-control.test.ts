// The one client-side wallet-control handshake, and the binds it scopes a
// signature to.

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBinds, proveWalletControl, proveWalletControlFrom, withProofQuery } from '../widget/wallet-control.js';

// A real preprod reward address (hex) and its bech32 form, so the derivation
// runs through lucid rather than a stand-in.
const REWARD_HEX = `e0${'ab'.repeat(28)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNonce(payloadHex = 'deadbeef') {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, json: async () => ({ ok: true, payload_hex: payloadHex }) };
    }),
  );
  return calls;
}

describe('buildBinds', () => {
  it('matches NP_CIP8::build_binds: sha256 over action and params joined by |', () => {
    const expected = createHash('sha256').update('cto:leaf|launch-1|addr_test1abc', 'utf8').digest('hex');
    expect(buildBinds('cto:leaf', ['launch-1', 'addr_test1abc'])).toBe(expected);
  });

  it('moves when any parameter moves', () => {
    expect(buildBinds('cto:leaf', ['launch-1', 'a'])).not.toBe(buildBinds('cto:leaf', ['launch-1', 'b']));
    expect(buildBinds('cto:leaf', ['a'])).not.toBe(buildBinds('cto:register', ['a']));
  });
});

describe('proveWalletControl (raw CIP-30 api)', () => {
  it('derives the bech32 stake address from the wallet, asks for a nonce under it, and signs with the reward address', async () => {
    const calls = stubNonce('cafe');
    const api = {
      getRewardAddresses: async () => [REWARD_HEX],
      signData: vi.fn(async (address: string, payload: string) => ({
        signature: `sig:${address}:${payload}`,
        key: 'k',
      })),
    };
    const proof = await proveWalletControl('https://site/wp-json/np/v1/', api, 'ab'.repeat(32));

    expect(proof.stake_address).toMatch(/^stake_test1/);
    expect(calls[0].url).toBe('https://site/wp-json/np/v1/auth/nonce');
    expect(calls[0].body).toEqual({ stake_address: proof.stake_address, binds: 'ab'.repeat(32) });
    expect(api.signData).toHaveBeenCalledWith(REWARD_HEX, 'cafe');
    expect(proof.signature).toBe(`sig:${REWARD_HEX}:cafe`);
    expect(proof.key).toBe('k');
  });

  it('refuses a wallet with no reward address rather than signing with nothing', async () => {
    stubNonce();
    const api = { getRewardAddresses: async () => [], signData: vi.fn() };
    await expect(proveWalletControl('https://site', api)).rejects.toThrow(/no stake \(reward\) address/);
    expect(api.signData).not.toHaveBeenCalled();
  });

  it('surfaces the server refusing a nonce', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ message: 'Too many nonce requests.' }) })),
    );
    const api = { getRewardAddresses: async () => [REWARD_HEX], signData: vi.fn() };
    await expect(proveWalletControl('https://site', api)).rejects.toThrow(/Too many nonce requests/);
  });
});

describe('proveWalletControlFrom (an existing connection)', () => {
  it('uses the connection’s own stake address and signs through the supplied signer', async () => {
    const calls = stubNonce('0102');
    const signData = vi.fn(async () => ({ signature: 's', key: 'k' }));
    const proof = await proveWalletControlFrom(
      'https://site',
      { walletId: 'eternl', stakeAddress: 'stake_test1abc', rewardAddressHex: 'e0ff' },
      signData,
    );
    expect(calls[0].body).toEqual({ stake_address: 'stake_test1abc' });
    expect(signData).toHaveBeenCalledWith('eternl', 'e0ff', '0102');
    expect(proof).toEqual({ stake_address: 'stake_test1abc', signature: 's', key: 'k' });
  });

  it('refuses an enterprise-only connection', async () => {
    stubNonce();
    await expect(
      proveWalletControlFrom('https://site', { walletId: 'x', stakeAddress: '', rewardAddressHex: '' }, vi.fn()),
    ).rejects.toThrow(/no stake \(reward\) address/);
  });
});

describe('withProofQuery', () => {
  it('appends the three fields, encoded, whether or not a query exists', () => {
    const proof = { stake_address: 'stake_test1a', signature: 'a+b', key: 'k' };
    expect(withProofQuery('https://s/leaf', proof)).toBe(
      'https://s/leaf?stake_address=stake_test1a&signature=a%2Bb&key=k',
    );
    expect(withProofQuery('https://s/leaf?x=1', proof)).toBe(
      'https://s/leaf?x=1&stake_address=stake_test1a&signature=a%2Bb&key=k',
    );
  });
});
