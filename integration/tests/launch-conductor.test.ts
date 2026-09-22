import { describe, expect, it } from 'vitest';
import { DarkVeilState, LaunchPhase } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { baseSlotFor, type ConductorInput, nextAction } from '../launch-conductor.js';
import type { DarkVeilSnapshot } from '../midnight-public-state.js';

// CLAUDE.md's own sequence: registration T-48h to T-2h, a 2h freeze, buying 24h.
const REG_OPEN = 1_000_000n;
const REG_CLOSE = REG_OPEN + 165_600n; // 46h
const BUY_OPEN = REG_CLOSE + 7_200n; //  2h freeze
const BUY_CLOSE = BUY_OPEN + 86_400n; // 24h
const EXPIRY = 604_800n; // 7 days
const SETTLEMENT_DEADLINE = 604_800n;
const ROOT = 'cd'.repeat(32);
const ZERO = '00'.repeat(32);

function snapshot(over: Partial<DarkVeilSnapshot> = {}): DarkVeilSnapshot {
  return {
    phase: LaunchPhase.DarkVeil,
    dvState: DarkVeilState.Inactive,
    dvFailed: false,
    dvPrice: 90n,
    dvAllocation: 150_000_000n,
    baseSlot: 0n,
    registrationCount: 0n,
    totalTokensCommitted: 0n,
    totalRaisedCommitted: 0n,
    allowlistRootHex: 'ab'.repeat(32),
    registrantRootHex: ZERO,
    pendingRegistrantRootHex: ZERO,
    settlementFinalized: false,
    fairLaunchCert: {
      launchId: new Uint8Array(32),
      totalRaised: 0n,
      totalTokensAllocated: 0n,
      totalParticipants: 0n,
      closeTimestamp: 0n,
      certHash: new Uint8Array(32),
    } as DarkVeilSnapshot['fairLaunchCert'],
    schedule: {
      registrationOpenTime: REG_OPEN,
      registrationCloseTime: REG_CLOSE,
      buyingOpenTime: BUY_OPEN,
      buyingCloseTime: BUY_CLOSE,
      settlementDeadlineSeconds: SETTLEMENT_DEADLINE,
      minDvParticipants: 15n,
      darkVeilExpirySeconds: EXPIRY,
    },
    ...over,
  };
}

const at = (nowSeconds: bigint, over: Partial<DarkVeilSnapshot> = {}, rest: Partial<ConductorInput> = {}) =>
  nextAction({ snapshot: snapshot(over), nowSeconds, ...rest });

describe('the schedule decides, and only the schedule', () => {
  it('opens registration once its sealed time has passed, and not before', () => {
    expect(at(REG_OPEN - 1n)).toMatchObject({ status: 'waiting', until: REG_OPEN });
    expect(at(REG_OPEN)).toMatchObject({ status: 'waiting' });
    expect(at(REG_OPEN + 1n)).toMatchObject({ status: 'due', action: { kind: 'startRegistration' } });
  });

  it('asks for the registrant root once registration has closed', () => {
    const inReg = { dvState: DarkVeilState.Registration, registrationCount: 20n };
    expect(at(REG_CLOSE - 1n, inReg)).toMatchObject({ status: 'waiting', until: BUY_OPEN });
    const due = at(REG_CLOSE + 1n, inReg);
    expect(due).toMatchObject({ status: 'due', action: { kind: 'publishRegistrantRoot' } });
    // The root commits to the registrant set, so nothing reading the chain can
    // compute it. Saying so is what lets a loop tell "waiting on us" from
    // "waiting on the clock".
    expect(due.status === 'due' && due.action.needsOffChainInput).toBe(true);
  });

  it('opens buying once the root is published, the floor is met and the time has come', () => {
    const ready = {
      dvState: DarkVeilState.Registration,
      registrationCount: 15n,
      pendingRegistrantRootHex: ROOT,
    };
    expect(at(BUY_OPEN - 1n, ready)).toMatchObject({ status: 'waiting', until: BUY_OPEN });
    expect(at(BUY_OPEN + 1n, ready)).toMatchObject({ status: 'due', action: { kind: 'openBuying' } });
  });

  it('does not ask for the root again while it waits for buying to open', () => {
    // publishRegistrantRoot writes the PENDING root; openBuying promotes it. A
    // planner watching the promoted one would keep asking for a root that had
    // already been published and never reach openBuying at all.
    const published = {
      dvState: DarkVeilState.Registration,
      registrationCount: 15n,
      pendingRegistrantRootHex: ROOT,
      registrantRootHex: ZERO,
    };
    expect(at(REG_CLOSE + 1n, published)).toMatchObject({ status: 'waiting', until: BUY_OPEN });
  });

  it('closes buying on the clock, with the one allocation that fits', () => {
    const buying = { dvState: DarkVeilState.Buying, registrationCount: 15n };
    expect(at(BUY_CLOSE - 1n, buying)).toMatchObject({ status: 'waiting', until: BUY_CLOSE });
    const due = at(BUY_CLOSE + 1n, buying);
    expect(due).toMatchObject({ status: 'due', action: { kind: 'closeDarkVeil' } });
    // 150,000,000 over 15 registrants. The circuit admits exactly this value,
    // so it is derived and never chosen.
    expect(due.status === 'due' && due.action.baseSlot).toBe(10_000_000n);
  });
});

describe('a launch that will not reach its floor', () => {
  it('does not try to open buying, however long it waits', () => {
    // The floor is not an obstacle to work around. A launch that never clears
    // it is meant to expire into a full refund, and pretending otherwise would
    // mean submitting a transaction the contract refuses, every tick, for a
    // week.
    const short = {
      dvState: DarkVeilState.Registration,
      registrationCount: 3n,
      pendingRegistrantRootHex: ROOT,
    };
    const verdict = at(BUY_OPEN + 1n, short);
    expect(verdict.status).toBe('waiting');
    expect(verdict.status === 'waiting' && verdict.because).toMatch(/only 3 of the 15/);
    expect(verdict.status === 'waiting' && verdict.until).toBe(REG_CLOSE + EXPIRY);
  });

  it('expires it into a full refund once the deadline passes', () => {
    const short = { dvState: DarkVeilState.Registration, registrationCount: 3n };
    expect(at(REG_CLOSE + EXPIRY + 1n, short)).toMatchObject({
      status: 'due',
      action: { kind: 'expireDarkVeil' },
    });
  });

  it('puts the expiry ahead of everything else in that phase', () => {
    // Past the deadline, a launch that also lacks a root must expire rather
    // than have the root published — the refund is the outcome, and a late
    // root would only delay it.
    const late = { dvState: DarkVeilState.Registration, registrationCount: 20n };
    expect(at(REG_CLOSE + EXPIRY + 1n, late)).toMatchObject({
      status: 'due',
      action: { kind: 'expireDarkVeil' },
    });
  });
});

describe('the settlement record', () => {
  const closed = { dvState: DarkVeilState.Closed, registrationCount: 15n, baseSlot: 10_000_000n };

  it('will not finalize while it cannot confirm every settlement is in', () => {
    // The direction that matters. Closing a record early records a registrant
    // as a non-settler through no fault of their own, and the sweep then takes
    // their bond. Unknown must mean "not yet", never "probably fine".
    const unknown = at(BUY_CLOSE + 10n, closed);
    expect(unknown).toMatchObject({ status: 'due', action: { kind: 'recordSettlements' } });
    expect(unknown.status === 'due' && unknown.action.needsOffChainInput).toBe(true);

    const outstanding = at(BUY_CLOSE + 10n, closed, { settlementsComplete: false });
    expect(outstanding).toMatchObject({ status: 'due', action: { kind: 'recordSettlements' } });
  });

  it('finalizes once every settlement is recorded', () => {
    expect(at(BUY_CLOSE + 10n, closed, { settlementsComplete: true })).toMatchObject({
      status: 'due',
      action: { kind: 'finalizeDvSettlement' },
    });
  });

  it('expires a record nobody ever closed, ahead of finalizing it', () => {
    // Even told every settlement is in, past the deadline the hatch wins: a
    // record left open past its deadline is one nobody was tending, and the
    // refund must not depend on the party that stopped tending it.
    const late = BUY_CLOSE + SETTLEMENT_DEADLINE + 1n;
    expect(at(late, closed, { settlementsComplete: true })).toMatchObject({
      status: 'due',
      action: { kind: 'expireDvSettlement' },
    });
  });

  it('goes quiet once the record is closed', () => {
    expect(at(BUY_CLOSE + 10n, { ...closed, settlementFinalized: true })).toMatchObject({ status: 'idle' });
  });
});

describe('launches it must leave alone', () => {
  it('does nothing to a failed DarkVeil', () => {
    expect(at(BUY_CLOSE + 1n, { dvState: DarkVeilState.Buying, dvFailed: true })).toMatchObject({ status: 'idle' });
  });

  it('does nothing to a cancelled launch', () => {
    expect(at(BUY_CLOSE + 1n, { dvState: DarkVeilState.Buying, phase: LaunchPhase.Cancelled })).toMatchObject({
      status: 'idle',
    });
  });

  it('does nothing in the cancelled sub-phase', () => {
    expect(at(BUY_CLOSE + 1n, { dvState: DarkVeilState.Cancelled })).toMatchObject({ status: 'idle' });
  });
});

describe('the same chain gives the same answer', () => {
  it('is pure, so a tick that crashes and one that repeats agree', () => {
    // The property the whole design rests on: no local state, so two ticks
    // over one chain read cannot disagree and there is nothing to reconcile.
    const input: ConductorInput = {
      snapshot: snapshot({ dvState: DarkVeilState.Buying, registrationCount: 15n }),
      nowSeconds: BUY_CLOSE + 1n,
    };
    const first = nextAction(input);
    const second = nextAction(input);
    const third = nextAction({ ...input, snapshot: { ...input.snapshot } });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

describe('the allocation the close is given', () => {
  it('is the floor of the division, which is the only value the circuit takes', () => {
    expect(baseSlotFor(150_000_000n, 15n)).toBe(10_000_000n);
    expect(baseSlotFor(100n, 3n)).toBe(33n);
    expect(baseSlotFor(100n, 1n)).toBe(100n);
  });

  it('is zero rather than a division by zero when nobody registered', () => {
    expect(baseSlotFor(150_000_000n, 0n)).toBe(0n);
  });
});
