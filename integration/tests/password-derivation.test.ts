// ============================================================================
// widget/password-derivation.ts — the local-storage password, from a signature
// ============================================================================
// WHY THIS FILE EXISTS
//
// The private-state store needs a password meeting the SDK's own policy, and
// asking a user to invent a second one on top of their wallet was rejected as
// a design. So it is derived from a CIP-8 signature over a fixed domain: same
// wallet, same message, same password, every session.
//
// Two properties carry that design, and both are asserted against the REAL
// `validatePassword` rather than a local restatement of its rules. That is the
// module's own stated reason for existing — it deliberately does not
// reimplement the policy, because a 4+-character RUN and a 4+-character
// SEQUENCE are different checks and getting one subtly wrong is easy. A test
// that hand-rolled the rules would inherit exactly that risk.
//
//   1. Determinism. A different password on the next session locks the user
//      out of their own store, so this is not a nicety.
//   2. Compliance. A candidate the SDK rejects is a store that cannot open.
//
// The retry and exhaustion paths need `validatePassword` to refuse, which the
// real one will not do for a sha256-derived candidate — those tests mock it,
// and say so.

import { PasswordValidationError, validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  CTO_PASSWORD_DOMAIN,
  derivePasswordFromSignature,
  PASSWORD_DERIVATION_DOMAIN,
  toHex,
} from '../widget/password-derivation.js';

/** A CIP-8 `signature` field, in the shape a wallet really returns one. */
const SIGN_HEX = 'a4'.repeat(64);
const OTHER_SIGN_HEX = 'b7'.repeat(64);

describe('derivePasswordFromSignature', () => {
  it('is deterministic — the same signature derives the same password every session', () => {
    expect(derivePasswordFromSignature(SIGN_HEX)).toBe(derivePasswordFromSignature(SIGN_HEX));
  });

  it('derives a password the SDK itself accepts, not one this test judges compliant', () => {
    // The whole point of the module: it asks the real validator, so the test
    // does too rather than restating the rule set.
    expect(() => validatePassword(derivePasswordFromSignature(SIGN_HEX))).not.toThrow();
  });

  it('gives a different signature a different password', () => {
    expect(derivePasswordFromSignature(SIGN_HEX)).not.toBe(derivePasswordFromSignature(OTHER_SIGN_HEX));
  });

  it('separates domains, so one signature cannot yield another feature its password', () => {
    const darkveil = derivePasswordFromSignature(SIGN_HEX, PASSWORD_DERIVATION_DOMAIN);
    const cto = derivePasswordFromSignature(SIGN_HEX, CTO_PASSWORD_DOMAIN);
    expect(cto).not.toBe(darkveil);
    // Both still have to be usable; separation must not cost compliance.
    expect(() => validatePassword(cto)).not.toThrow();
  });

  it('defaults to the DarkVeil domain when none is named', () => {
    expect(derivePasswordFromSignature(SIGN_HEX)).toBe(
      derivePasswordFromSignature(SIGN_HEX, PASSWORD_DERIVATION_DOMAIN),
    );
  });

  it('clears the length floor the policy sets', () => {
    expect(derivePasswordFromSignature(SIGN_HEX).length).toBeGreaterThanOrEqual(16);
  });
});

// The salt loop only runs when the validator refuses, which the real one does
// not do here — so these drive it with a stub, and are explicit that they do.
describe('when the policy refuses a candidate', () => {
  it('re-salts and retries rather than returning something the store would reject', async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock('@midnight-ntwrk/midnight-js-utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@midnight-ntwrk/midnight-js-utils')>();
      return {
        ...actual,
        validatePassword: vi.fn((pw: string) => {
          calls++;
          // Refuse the first two candidates, accept the third.
          if (calls <= 2) throw new actual.PasswordValidationError('policy says no', 'insufficient_classes');
          return actual.validatePassword(pw);
        }),
      };
    });
    const { derivePasswordFromSignature: derive } = await import('../widget/password-derivation.js');

    const pw = derive(SIGN_HEX);
    expect(calls).toBe(3);
    // The retry must produce a DIFFERENT candidate — re-salting, not re-hashing
    // the same input and hoping.
    expect(pw).not.toBe(derivePasswordFromSignature(SIGN_HEX));
    vi.doUnmock('@midnight-ntwrk/midnight-js-utils');
  });

  it('gives up with the policy’s own last complaint rather than looping forever', async () => {
    vi.resetModules();
    vi.doMock('@midnight-ntwrk/midnight-js-utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@midnight-ntwrk/midnight-js-utils')>();
      return {
        ...actual,
        validatePassword: vi.fn(() => {
          throw new actual.PasswordValidationError('never acceptable', 'too_short');
        }),
      };
    });
    const { derivePasswordFromSignature: derive } = await import('../widget/password-derivation.js');

    expect(() => derive(SIGN_HEX)).toThrow(/after 64 attempts/);
    // Without the cause, a caller sees only "it did not work".
    expect(() => derive(SIGN_HEX)).toThrow(/never acceptable/);
    vi.doUnmock('@midnight-ntwrk/midnight-js-utils');
  });

  it('rethrows anything that is not a policy refusal, instead of counting it as one', async () => {
    vi.resetModules();
    vi.doMock('@midnight-ntwrk/midnight-js-utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@midnight-ntwrk/midnight-js-utils')>();
      return {
        ...actual,
        validatePassword: vi.fn(() => {
          throw new TypeError('the validator itself broke');
        }),
      };
    });
    const { derivePasswordFromSignature: derive } = await import('../widget/password-derivation.js');

    // A broken validator must surface as itself, not as 64 silent retries.
    expect(() => derive(SIGN_HEX)).toThrow(TypeError);
    expect(() => derive(SIGN_HEX)).toThrow(/the validator itself broke/);
    vi.doUnmock('@midnight-ntwrk/midnight-js-utils');
  });
});

describe('toHex', () => {
  it('pads every byte to two characters, so the output is fixed width', () => {
    expect(toHex(new Uint8Array([0x00, 0x01, 0x0f, 0xff]))).toBe('00010fff');
  });

  it('encodes an empty input as an empty string', () => {
    expect(toHex(new Uint8Array([]))).toBe('');
  });
});

describe('the exported domains', () => {
  it('are distinct, which is what makes the separation above real', () => {
    expect(PASSWORD_DERIVATION_DOMAIN).not.toBe(CTO_PASSWORD_DOMAIN);
  });

  it('are versioned, so a future change can be told from this one', () => {
    expect(PASSWORD_DERIVATION_DOMAIN).toMatch(/:v\d+$/);
    expect(CTO_PASSWORD_DOMAIN).toMatch(/:v\d+$/);
  });
});

describe('PasswordValidationError', () => {
  it('is the type the retry path keys on', () => {
    expect(new PasswordValidationError('x', 'too_short')).toBeInstanceOf(Error);
  });
});
