// The allowlist attestor slots take a public key, and a public key is a hash,
// so any 32 bytes satisfy every structural check the deploy path can make.
// A deploy whose attestor keys nobody holds a secret for seals a contract
// whose allowlist root can never be raised — and therefore one where nobody
// can ever register. These tests pin the one check that can tell the
// difference: deriving the key from the secret here, rather than trusting a
// caller to have done it.
import { describe, expect, it } from 'vitest';
import { DOMAINS, deriveRoleKey } from '../../contracts/midnight/witnesses.js';
import { resolveAttestorKeysHex } from '../cli/deploy-eligibility-gate.js';

const secretHex = (fill: number) => Buffer.alloc(32, fill).toString('hex');
const SECRETS: [string, string, string] = [secretHex(1), secretHex(2), secretHex(3)];

const expectedKey = (hex: string) =>
  Buffer.from(
    deriveRoleKey({ bytes: new Uint8Array(Buffer.from(hex, 'hex')) }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes,
  ).toString('hex');

describe('resolveAttestorKeysHex', () => {
  it('derives each key from its secret, matching the circuit-parity helper', () => {
    const keys = resolveAttestorKeysHex({ allowlistAttestorSecretsHex: SECRETS } as never);
    expect(keys).toEqual(SECRETS.map(expectedKey));
  });

  it('derives three distinct keys from three distinct secrets', () => {
    const keys = resolveAttestorKeysHex({ allowlistAttestorSecretsHex: SECRETS } as never);
    expect(new Set(keys).size).toBe(3);
  });

  it('never returns a secret as its own key', () => {
    const keys = resolveAttestorKeysHex({ allowlistAttestorSecretsHex: SECRETS } as never);
    // The bug this guards: a caller hands over 32 bytes that were never
    // derived, and they reach the constructor unchanged.
    for (const s of SECRETS) expect(keys).not.toContain(s);
  });

  it('passes externally-derived keys through untouched', () => {
    const keys: [string, string, string] = [secretHex(9), secretHex(8), secretHex(7)];
    expect(resolveAttestorKeysHex({ allowlistAttestorKeysHex: keys } as never)).toBe(keys);
  });

  it('refuses both forms at once', () => {
    expect(() =>
      resolveAttestorKeysHex({
        allowlistAttestorSecretsHex: SECRETS,
        allowlistAttestorKeysHex: SECRETS,
      } as never),
    ).toThrow(/not both/i);
  });

  it('refuses neither form', () => {
    expect(() => resolveAttestorKeysHex({} as never)).toThrow(/is required/i);
  });

  it('refuses a secret that is not 32 bytes', () => {
    expect(() =>
      resolveAttestorKeysHex({ allowlistAttestorSecretsHex: ['ab', secretHex(2), secretHex(3)] } as never),
    ).toThrow(/allowlistAttestorSecretsHex\[0\]/);
  });
});
