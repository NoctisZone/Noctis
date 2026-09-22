import { describe, expect, it } from 'vitest';
import { DOMAINS, deriveRoleKey } from '../../contracts/midnight/witnesses.js';
import {
  type CustodyRecord,
  checkIdentityCustody,
  describeThreshold,
  formatCustodyVerdict,
  type HeldSecrets,
  type IdentityCustody,
  type SealedIdentities,
} from '../identity-custody.js';

/** A 32-byte secret whose first byte is the one given. */
const secret = (firstByte: number): Uint8Array => {
  const out = new Uint8Array(32);
  out[0] = firstByte;
  out[31] = 0x5a;
  return out;
};

const keyFor = (sk: Uint8Array) => deriveRoleKey({ bytes: sk }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes;

const GOVERNOR = secret(0x01);
const ATTESTOR_ONE = secret(0x11);
const ATTESTOR_TWO = secret(0x12);
const ATTESTOR_THREE = secret(0x13);
const CREATOR_KEY = secret(0xc0);
const PLATFORM_ADDR = secret(0xad);

const platform = (holder = 'platform ops'): CustodyRecord => ({
  kind: 'platform-held',
  holder,
  storedAs: 'encrypted per role',
});

function custody(over: Partial<IdentityCustody> = {}): IdentityCustody {
  return {
    governor: platform(),
    attestors: [platform('ops A'), platform('ops B'), platform('ops C')],
    creator: { kind: 'external', holder: 'the launch creator' },
    platformAddr: { kind: 'receive-only', holder: 'platform treasury, cold' },
    ...over,
  };
}

function sealed(over: Partial<SealedIdentities> = {}): SealedIdentities {
  return {
    governorKey: keyFor(GOVERNOR),
    attestorKeys: [keyFor(ATTESTOR_ONE), keyFor(ATTESTOR_TWO), keyFor(ATTESTOR_THREE)],
    creatorPubKey: CREATOR_KEY,
    platformAddr: PLATFORM_ADDR,
    ...over,
  };
}

const held: HeldSecrets = { governorSecret: GOVERNOR, attestorSecrets: [ATTESTOR_ONE, ATTESTOR_TWO, ATTESTOR_THREE] };

describe('every sealed identity has to have a holder', () => {
  it('passes a manifest whose platform-held claims re-derive to what is being sealed', () => {
    const verdict = checkIdentityCustody(custody(), sealed(), held);
    expect(verdict.refusals).toEqual([]);
    expect(verdict.manifest).toHaveLength(6);
  });

  it('refuses a slot whose holder is the form being filled in rather than a name', () => {
    // The failure is not a wrong name. It is an unanswered one, which is the
    // same thing as a key nobody holds, written in words instead of bytes.
    for (const unanswered of ['', '  ', 'TBD', 'tbd', 'n/a', 'placeholder', 'unassigned', '?']) {
      const verdict = checkIdentityCustody(custody({ governor: platform(unanswered) }), sealed(), held);
      expect(
        verdict.refusals.map((r) => r.slot),
        unanswered,
      ).toContain('governor');
    }
  });

  it('accepts a provisional but real holder, because provisional is not unanswered', () => {
    const verdict = checkIdentityCustody(custody({ governor: platform('rehearsal operator') }), sealed(), held);
    expect(verdict.refusals).toEqual([]);
  });

  it('refuses a platform-held claim with no secret behind it', () => {
    // The claim would otherwise be the only evidence that anybody can satisfy
    // the circuit that reads the slot.
    const verdict = checkIdentityCustody(custody(), sealed(), { governorSecret: GOVERNOR });
    expect(verdict.refusals.map((r) => r.slot)).toEqual(['attestor-1', 'attestor-2', 'attestor-3']);
    expect(verdict.refusals[0].detail).toMatch(/no secret was supplied/);
  });

  it('refuses a platform-held claim whose secret derives to something else', () => {
    // The thing this catches is a manifest and a deploy payload that were
    // edited at different times.
    const verdict = checkIdentityCustody(
      custody(),
      sealed({ attestorKeys: [keyFor(secret(0x99)), keyFor(ATTESTOR_TWO), keyFor(ATTESTOR_THREE)] }),
      held,
    );
    expect(verdict.refusals.map((r) => r.slot)).toEqual(['attestor-1']);
    expect(verdict.refusals[0].detail).toMatch(/derives to .*not the/);
  });

  it('records an externally-held key as unproven rather than passing it quietly', () => {
    // Nothing here can check that a separate party derived their own key, and
    // that unverifiability is exactly what the separation buys and costs.
    const verdict = checkIdentityCustody(custody(), sealed(), held);
    expect(verdict.unproven.map((f) => f.slot)).toEqual(['creator']);
    expect(verdict.unproven[0].detail).toMatch(/Nothing here can check/);
  });

  it('refuses receive-only on a slot a circuit reads', () => {
    // Anywhere but the payout address it would be a slot excused from the one
    // check that matters.
    const verdict = checkIdentityCustody(
      custody({ attestors: [{ kind: 'receive-only', holder: 'ops' }, platform('B'), platform('C')] }),
      sealed(),
      held,
    );
    expect(verdict.refusals.map((r) => r.slot)).toContain('attestor-1');
    expect(verdict.refusals.find((r) => r.slot === 'attestor-1')?.detail).toMatch(/a circuit reads it/);
  });

  it('refuses the payout address being called platform-held, because nothing derives it', () => {
    const verdict = checkIdentityCustody(
      custody({ platformAddr: { kind: 'platform-held', holder: 'ops' } }),
      sealed(),
      held,
    );
    expect(verdict.refusals.map((r) => r.slot)).toContain('platformAddr');
    expect(verdict.refusals.find((r) => r.slot === 'platformAddr')?.detail).toMatch(/Say receive-only/);
  });
});

describe('an attestor that is secretly the governor', () => {
  it('refuses an attestor secret that is the governor secret', () => {
    // Both derive under the same domain, so the two keys are the same bytes.
    // The three sealed keys stay distinct, every structural check passes, and
    // one of the three attestors is the governor under another name — which
    // nothing downstream can see.
    const verdict = checkIdentityCustody(
      custody(),
      sealed({ attestorKeys: [keyFor(GOVERNOR), keyFor(ATTESTOR_TWO), keyFor(ATTESTOR_THREE)] }),
      { governorSecret: GOVERNOR, attestorSecrets: [GOVERNOR, ATTESTOR_TWO, ATTESTOR_THREE] },
    );
    expect(verdict.refusals.map((r) => r.slot)).toContain('attestor-1');
    expect(verdict.refusals.find((r) => r.slot === 'attestor-1')?.detail).toMatch(/same key wearing two names/);
  });

  it('refuses two attestor slots holding one secret', () => {
    // Approvals are recorded by attestor rather than by call, so two slots
    // holding one secret is two attestors where the threshold counts three.
    const verdict = checkIdentityCustody(
      custody(),
      sealed({ attestorKeys: [keyFor(ATTESTOR_ONE), keyFor(ATTESTOR_ONE), keyFor(ATTESTOR_THREE)] }),
      {
        governorSecret: GOVERNOR,
        attestorSecrets: [ATTESTOR_ONE, ATTESTOR_ONE, ATTESTOR_THREE],
      },
    );
    expect(verdict.refusals.map((r) => r.slot)).toContain('attestor-2');
    expect(verdict.refusals.find((r) => r.slot === 'attestor-2')?.detail).toMatch(/same secret as attestor-1/);
  });
});

describe('what a threshold is worth', () => {
  it('says plainly that three platform-held keys are not separation of duties', () => {
    // A real key-compromise control and a deliberate choice. The thing worth
    // guarding against is not the choice but its being read later as a
    // guarantee it never made.
    const line = describeThreshold(2, 0);
    expect(line).toMatch(/No single leaked key/);
    expect(line).toMatch(/not separation of duties/);
  });

  it('says when the platform cannot act alone', () => {
    expect(describeThreshold(2, 2)).toMatch(/cannot publish an allowlist root alone/);
    expect(describeThreshold(3, 1)).toMatch(/cannot publish an allowlist root alone/);
  });

  it('says when outside holders can join a threshold but not withhold one', () => {
    // Two platform keys against a threshold of two is the platform acting
    // alone, whatever the third holder is told.
    expect(describeThreshold(2, 1)).toMatch(/cannot withhold one/);
  });

  it('counts only externally-held attestors as independent', () => {
    const verdict = checkIdentityCustody(custody(), sealed(), held);
    expect(verdict.independentAttestors).toBe(0);
  });
});

describe('the manifest a deploy carries', () => {
  it('names every slot, its custody, its holder and the value being sealed', () => {
    const lines = formatCustodyVerdict(checkIdentityCustody(custody(), sealed(), held), 2);
    const text = lines.join('\n');
    for (const slot of ['governor', 'attestor-1', 'attestor-2', 'attestor-3', 'creator', 'platformAddr']) {
      expect(text, slot).toContain(slot);
    }
    expect(text).toContain('not separation of duties');
    expect(text).toContain('not verifiable here');
  });

  it('puts the refusals where an operator reads them, all of them at once', () => {
    // A deploy blocked one field at a time is how a provisioning session turns
    // into an afternoon.
    const verdict = checkIdentityCustody(custody({ governor: platform('TBD') }), sealed(), {
      governorSecret: GOVERNOR,
    });
    expect(verdict.refusals.length).toBeGreaterThan(1);
    expect(formatCustodyVerdict(verdict, 2).join('\n')).toContain('REFUSED');
  });
});
