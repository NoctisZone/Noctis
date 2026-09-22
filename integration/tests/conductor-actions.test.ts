import { describe, expect, it } from 'vitest';
import { DarkVeilState, LaunchPhase } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import {
  type CallContext,
  CLI_ACTION_FOR,
  nextOutstandingSettlement,
  planCall,
  type SettlementAttestation,
  settlementCompleteness,
} from '../conductor-actions.js';
import type { ConductorAction, ConductorActionKind } from '../launch-conductor.js';
import type { DarkVeilSnapshot } from '../midnight-public-state.js';

const ZERO = '00'.repeat(32);
const ROOT = 'ab'.repeat(32);
const ALICE = '11'.repeat(32);
const BOB = '22'.repeat(32);
const CARA = '33'.repeat(32);

function snapshot(over: Partial<DarkVeilSnapshot> = {}): DarkVeilSnapshot {
  return {
    phase: LaunchPhase.DarkVeil,
    dvState: DarkVeilState.Registration,
    dvFailed: false,
    dvPrice: 90n,
    dvAllocation: 150_000_000n,
    baseSlot: 0n,
    registrationCount: 15n,
    totalTokensCommitted: 0n,
    totalRaisedCommitted: 0n,
    allowlistRootHex: ROOT,
    registrantRootHex: ZERO,
    pendingRegistrantRootHex: ZERO,
    settlementFinalized: false,
    fairLaunchCert: {} as DarkVeilSnapshot['fairLaunchCert'],
    schedule: {
      registrationOpenTime: 1_000_000n,
      registrationCloseTime: 1_165_600n,
      buyingOpenTime: 1_172_800n,
      buyingCloseTime: 1_259_200n,
      settlementDeadlineSeconds: 604_800n,
      minDvParticipants: 15n,
      darkVeilExpirySeconds: 604_800n,
    },
    ...over,
  };
}

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  snapshot: snapshot(),
  offChain: {},
  ...over,
});

const act = (kind: ConductorActionKind, over: Partial<ConductorAction> = {}): ConductorAction => ({
  kind,
  because: 'under test',
  ...over,
});

describe('every transition the planner can name has a call that performs it', () => {
  it('maps all of them, so none can be planned with no way of being taken', () => {
    // Both directions, so the two lists are held to each other rather than
    // each being checked against a reading of the other. A transition added to
    // one and not the other is the whole failure mode, and it is silent: the
    // planner names something and the run has no way to ask for it.
    const planned: ConductorActionKind[] = [
      'advanceToDarkVeil',
      'startRegistration',
      'publishRegistrantRoot',
      'openBuying',
      'closeDarkVeil',
      'recordSettlements',
      'finalizeDvSettlement',
      'expireDarkVeil',
      'expireDvSettlement',
    ];
    for (const kind of planned) {
      expect(CLI_ACTION_FOR[kind], kind).toBeTruthy();
    }
    expect(Object.keys(CLI_ACTION_FOR).sort()).toEqual([...planned].sort());
  });

  it('asks for the governor secret only where a circuit reads a key', () => {
    // The clock-gated transitions consult no key at all, which is what stops a
    // launch stalling on one wallet being reachable. Asking for the secret
    // anyway would quietly make them governor-only again in practice.
    const needs = (kind: ConductorActionKind) => {
      const plan = planCall(act(kind, { baseSlot: 1n }), fullyStockedCtx());
      return plan.ok && plan.call.needsGovernorSecret;
    };
    expect(needs('advanceToDarkVeil')).toBe(true);
    expect(needs('publishRegistrantRoot')).toBe(true);
    expect(needs('recordSettlements')).toBe(true);
    expect(needs('finalizeDvSettlement')).toBe(true);
    expect(needs('startRegistration')).toBe(false);
    expect(needs('openBuying')).toBe(false);
    expect(needs('closeDarkVeil')).toBe(false);
    expect(needs('expireDarkVeil')).toBe(false);
    expect(needs('expireDvSettlement')).toBe(false);
  });
});

function fullyStockedCtx(): CallContext {
  return ctx({
    offChain: {
      registrantRoot: { rootHex: ROOT, registrantCount: 15 },
      settlements: { complete: true, entries: [{ buyerKeyHex: ALICE, settledAmount: '10' }] },
    },
    revealedKeys: [ALICE],
    recordedSettlements: {},
  });
}

describe('freezing the registrant set', () => {
  it('refuses a root built over a set that is not the set the chain holds', () => {
    // This is the check the phase driver carried and the reason it carried it:
    // publishing freezes who is in the phase, and a root built before the set
    // stopped growing freezes the wrong one for the life of the launch, with
    // nothing later reporting it.
    const plan = planCall(
      act('publishRegistrantRoot'),
      ctx({ offChain: { registrantRoot: { rootHex: ROOT, registrantCount: 14 } } }),
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.missing).toMatch(/all 15 registrants — this one commits to 14/);
  });

  it('refuses a root that is not 32 bytes', () => {
    const plan = planCall(
      act('publishRegistrantRoot'),
      ctx({ offChain: { registrantRoot: { rootHex: 'ab', registrantCount: 15 } } }),
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.missing).toMatch(/32-byte registrant root/);
  });

  it('reports a missing root rather than treating the launch as up to date', () => {
    const plan = planCall(act('publishRegistrantRoot'), ctx());
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.missing).toMatch(/only whoever can enumerate that set/);
  });

  it('carries a matching root through, lower-cased for the chain', () => {
    const plan = planCall(
      act('publishRegistrantRoot'),
      ctx({ offChain: { registrantRoot: { rootHex: ROOT.toUpperCase(), registrantCount: 15n } } }),
    );
    expect(plan.ok && plan.call.args.registrantRootHex).toBe(ROOT);
  });
});

describe('closing the phase', () => {
  it('will not close without the allocation every later refund divides by', () => {
    // Whatever this call carries becomes the divisor for the rest of the
    // launch, and the contract cannot check it because Compact has no
    // in-circuit division. A close that carried nothing would be choosing one.
    const plan = planCall(act('closeDarkVeil'), ctx());
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.missing).toMatch(/per-registrant allocation/);
  });

  it('carries the allocation the planner derived', () => {
    const plan = planCall(act('closeDarkVeil', { baseSlot: 10_000_000n }), ctx());
    expect(plan.ok && plan.call.args.baseSlot).toBe('10000000');
  });
});

describe('recording what settled on Cardano', () => {
  const attestation: SettlementAttestation = {
    complete: true,
    entries: [
      { buyerKeyHex: ALICE, settledAmount: '100' },
      { buyerKeyHex: BOB, settledAmount: '50' },
    ],
  };

  it('takes one at a time, so a run that dies resumes from the chain', () => {
    const plan = planCall(
      act('recordSettlements'),
      ctx({ offChain: { settlements: attestation }, recordedSettlements: {} }),
    );
    expect(plan.ok && plan.call.args).toMatchObject({ buyerKeyHex: ALICE, settledAmount: '100' });
  });

  it('skips one the chain already holds at the attested amount', () => {
    const plan = planCall(
      act('recordSettlements'),
      ctx({ offChain: { settlements: attestation }, recordedSettlements: { [ALICE]: '100' } }),
    );
    expect(plan.ok && plan.call.args.buyerKeyHex).toBe(BOB);
  });

  it('re-records one whose attested amount has been corrected', () => {
    // Recording replaces rather than accumulates — the circuit subtracts the
    // previous figure before adding the new one — so a corrected observation
    // is meant to be recorded again. Reading "present" as "done" would leave
    // the wrong figure in the certificate permanently.
    const plan = planCall(
      act('recordSettlements'),
      ctx({ offChain: { settlements: attestation }, recordedSettlements: { [ALICE]: '90' } }),
    );
    expect(plan.ok && plan.call.args).toMatchObject({ buyerKeyHex: ALICE, settledAmount: '100' });
  });

  it('has nothing to carry once every attested settlement is on chain', () => {
    const plan = planCall(
      act('recordSettlements'),
      ctx({ offChain: { settlements: attestation }, recordedSettlements: { [ALICE]: '100', [BOB]: '50' } }),
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.missing).toMatch(/not already recorded/);
  });

  it('reports the absent attestation rather than inventing an amount', () => {
    const plan = planCall(act('recordSettlements'), ctx());
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.missing).toMatch(/cannot look/);
  });

  it('treats a recorded zero as recorded, not as absent', () => {
    // Present-with-zero is a buyer the relayer looked at and found had claimed
    // nothing. Absent is a buyer nobody has looked at. The forfeiture sweep
    // treats those differently, so nothing upstream may flatten them together.
    expect(
      nextOutstandingSettlement(
        { complete: true, entries: [{ buyerKeyHex: ALICE, settledAmount: '0' }] },
        { [ALICE]: '0' },
      ),
    ).toBeNull();
    expect(
      nextOutstandingSettlement({ complete: true, entries: [{ buyerKeyHex: ALICE, settledAmount: '0' }] }, {}),
    ).not.toBeNull();
  });
});

describe('whether the settlement record may be closed', () => {
  const closed = snapshot({ dvState: DarkVeilState.Closed });

  it('is unknown without an attestation, which the planner reads as not complete', () => {
    expect(settlementCompleteness(ctx({ snapshot: closed }))).toMatchObject({ complete: 'unknown' });
  });

  it('is not complete while the relayer does not claim to have seen everything', () => {
    const verdict = settlementCompleteness(
      ctx({ snapshot: closed, offChain: { settlements: { complete: false, entries: [] } }, revealedKeys: [] }),
    );
    expect(verdict.complete).toBe(false);
  });

  it('is not complete while an attested settlement is still not on chain', () => {
    const verdict = settlementCompleteness(
      ctx({
        snapshot: closed,
        offChain: { settlements: { complete: true, entries: [{ buyerKeyHex: ALICE, settledAmount: '100' }] } },
        revealedKeys: [ALICE],
        recordedSettlements: {},
      }),
    );
    expect(verdict.complete).toBe(false);
    expect(verdict.complete === false && verdict.why).toMatch(/attested but not yet recorded/);
  });

  it('refuses to close on the relayer’s word when a buyer it never mentions revealed on chain', () => {
    // The assurance is necessary and not sufficient. A buyer who revealed on
    // Midnight and appears in no attestation would be recorded as having
    // settled nothing, and the forfeiture sweep takes the whole bond of a
    // registrant who settled nothing.
    const verdict = settlementCompleteness(
      ctx({
        snapshot: closed,
        offChain: { settlements: { complete: true, entries: [{ buyerKeyHex: ALICE, settledAmount: '100' }] } },
        revealedKeys: [ALICE, CARA],
        recordedSettlements: { [ALICE]: '100' },
      }),
    );
    expect(verdict.complete).toBe(false);
    expect(verdict.complete === false && verdict.why).toMatch(/revealed on chain and appear in no attestation/);
    expect(verdict.complete === false && verdict.why).toMatch(/forfeiture sweep/);
  });

  it('is unknown, not true, when the chain’s own list of revealers was never read', () => {
    // Without it the attestation cannot be checked for gaps at all, and the
    // gap is the thing that strands somebody. Answering "complete" here would
    // be answering a question nobody asked.
    const verdict = settlementCompleteness(
      ctx({
        snapshot: closed,
        offChain: { settlements: { complete: true, entries: [{ buyerKeyHex: ALICE, settledAmount: '100' }] } },
        recordedSettlements: { [ALICE]: '100' },
      }),
    );
    expect(verdict.complete).toBe('unknown');
  });

  it('is complete when the relayer says so and the chain agrees in both directions', () => {
    const verdict = settlementCompleteness(
      ctx({
        snapshot: closed,
        offChain: {
          settlements: {
            complete: true,
            entries: [
              { buyerKeyHex: ALICE, settledAmount: '100' },
              { buyerKeyHex: BOB, settledAmount: '0' },
            ],
          },
        },
        revealedKeys: [ALICE, BOB],
        recordedSettlements: { [ALICE]: '100', [BOB]: '0' },
      }),
    );
    expect(verdict.complete).toBe(true);
  });

  it('does not care about the case a key is written in', () => {
    const verdict = settlementCompleteness(
      ctx({
        snapshot: closed,
        offChain: {
          settlements: { complete: true, entries: [{ buyerKeyHex: ALICE.toUpperCase(), settledAmount: '7' }] },
        },
        revealedKeys: [ALICE],
        recordedSettlements: { [ALICE]: '7' },
      }),
    );
    expect(verdict.complete).toBe(true);
  });
});
