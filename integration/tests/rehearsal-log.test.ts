import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REHEARSAL_TTL_MS,
  fileRehearsalLog,
  type RehearsalEntry,
  recallFrom,
  rehearsalNotRequired,
} from '../rehearsal-log.js';

const GATE = '0200abc…contract';
const HOUR = 3_600_000;

function entry(over: Partial<RehearsalEntry> = {}): RehearsalEntry {
  return {
    contractAddress: GATE,
    action: 'closeDarkVeil',
    dvState: 2,
    rehearsedAtMs: 1_000 * HOUR,
    plannedForSeconds: '1234567890',
    because: 'buying closed at 1234567890',
    ...over,
  };
}

const at = (hours: number) => 1_000 * HOUR + hours * HOUR;

describe('whether a transition has been rehearsed', () => {
  const query = { contractAddress: GATE, action: 'closeDarkVeil' as const, dvState: 2, nowMs: at(1) };

  it('clears a transition rehearsed against this launch, from this state, recently', () => {
    const verdict = recallFrom([entry()], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(true);
  });

  it('clears nothing when nothing has been rehearsed, and says to take a dry run', () => {
    const verdict = recallFrom([], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
    expect(verdict.rehearsed === false && verdict.why).toMatch(/dry run of closeDarkVeil/);
  });

  it('does not let a rehearsal of one transition clear another', () => {
    // The unit of risk is the circuit being called. Rehearsing a close proves
    // nothing whatever about opening buying, which takes different arguments
    // and freezes a set for good.
    const verdict = recallFrom([entry({ action: 'openBuying' })], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
    expect(verdict.rehearsed === false && verdict.why).toMatch(/rehearsed here: openBuying/);
  });

  it('does not let a rehearsal from one lifecycle position clear the same transition from another', () => {
    // The planner reached it by a different route, so it is a different
    // decision even though it names the same circuit.
    const verdict = recallFrom([entry({ dvState: 1 })], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
    expect(verdict.rehearsed === false && verdict.why).toMatch(/from dvState 2/);
  });

  it('does not let a rehearsal against one launch clear another', () => {
    // Two launches can be mid-sentence identical and still want different
    // answers, and an address is the only thing that tells them apart.
    const verdict = recallFrom([entry({ contractAddress: '0200other' })], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
    expect(verdict.rehearsed === false && verdict.why).toMatch(/nothing has been rehearsed against/);
  });

  it('ignores the rest of the snapshot, so registration can carry on between a rehearsal and its window', () => {
    // A registrant count changes between a rehearsal and the window it was
    // taken for — that is registration working. Matching on it would void
    // every receipt at the moment it became useful.
    const banked = entry({ action: 'openBuying', dvState: 1 });
    const verdict = recallFrom([banked], { ...query, action: 'openBuying', dvState: 1 }, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(true);
  });

  it('stops clearing once the rehearsal is older than the window it clears for', () => {
    const verdict = recallFrom([entry()], { ...query, nowMs: at(73) }, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
    expect(verdict.rehearsed === false && verdict.why).toMatch(/73h ago, past the 72h/);
  });

  it('still clears just inside the window', () => {
    const verdict = recallFrom([entry()], { ...query, nowMs: at(71) }, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(true);
  });

  it('refuses a rehearsal dated in the future rather than treating it as fresh', () => {
    // An age computed from a clock that moved backwards is meaningless, and
    // the generous reading of a clock nobody can trust would clear a live
    // transition on the strength of it.
    const verdict = recallFrom([entry({ rehearsedAtMs: at(5) })], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
    expect(verdict.rehearsed === false && verdict.why).toMatch(/dated in the future/);
  });

  it('answers from the newest rehearsal of a transition, not the first one banked', () => {
    // A transition rehearsed twice is answered by the later run, which is the
    // one that saw the chain as it is now.
    const stale = entry({ because: 'stale', rehearsedAtMs: at(-100) });
    const fresh = entry({ because: 'fresh', rehearsedAtMs: at(-1) });
    const verdict = recallFrom([stale, fresh], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed && verdict.entry.because).toBe('fresh');
  });

  it('is not cleared by a newer rehearsal of a DIFFERENT transition sitting alongside a stale one', () => {
    // Newest-first has to be applied after the transition filter, not before,
    // or an unrelated rehearsal taken this morning would answer for a close
    // nobody has looked at in a week.
    const staleClose = entry({ rehearsedAtMs: at(-100) });
    const freshOther = entry({ action: 'openBuying', rehearsedAtMs: at(-1) });
    const verdict = recallFrom([staleClose, freshOther], query, DEFAULT_REHEARSAL_TTL_MS);
    expect(verdict.rehearsed).toBe(false);
  });
});

describe('rehearsals banked in a file', () => {
  const dirs: string[] = [];
  const freshDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'noctis-rehearsal-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('banks a rehearsal and finds it again', () => {
    const path = join(freshDir(), 'nested', 'rehearsals.json');
    const log = fileRehearsalLog(path);
    log.record(entry());
    expect(log.recall({ contractAddress: GATE, action: 'closeDarkVeil', dvState: 2, nowMs: at(1) })).toMatchObject({
      rehearsed: true,
    });
  });

  it('keeps every rehearsal rather than replacing the last', () => {
    const path = join(freshDir(), 'rehearsals.json');
    const log = fileRehearsalLog(path);
    log.record(entry({ action: 'openBuying', dvState: 1 }));
    log.record(entry());
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(2);
    expect(log.recall({ contractAddress: GATE, action: 'openBuying', dvState: 1, nowMs: at(1) })).toMatchObject({
      rehearsed: true,
    });
  });

  it('reads an unreadable log as nothing rehearsed, not as everything cleared', () => {
    // Unknown means unknown. The other reading would let a corrupt file clear
    // a live transition, which is the direction that cannot be recovered from.
    const path = join(freshDir(), 'rehearsals.json');
    writeFileSync(path, '{ not json');
    const verdict = fileRehearsalLog(path).recall({
      contractAddress: GATE,
      action: 'closeDarkVeil',
      dvState: 2,
      nowMs: at(1),
    });
    expect(verdict.rehearsed).toBe(false);
  });

  it('reads a log that is valid JSON but not a list of entries as nothing rehearsed', () => {
    // A bare entry rather than a junk object on purpose: this one would clear
    // the transition if a non-array were wrapped into a list instead of
    // rejected, so the test fails when the shape check is dropped rather than
    // passing because the contents happened not to match.
    const path = join(freshDir(), 'rehearsals.json');
    writeFileSync(path, JSON.stringify(entry()));
    expect(
      fileRehearsalLog(path).recall({ contractAddress: GATE, action: 'closeDarkVeil', dvState: 2, nowMs: at(1) }),
    ).toMatchObject({ rehearsed: false });
  });

  it('takes its window from the caller, so a run can hold itself to a tighter one', () => {
    const path = join(freshDir(), 'rehearsals.json');
    const log = fileRehearsalLog(path, { ttlMs: HOUR });
    log.record(entry());
    expect(log.recall({ contractAddress: GATE, action: 'closeDarkVeil', dvState: 2, nowMs: at(2) })).toMatchObject({
      rehearsed: false,
    });
  });
});

describe('waiving the requirement', () => {
  it('clears everything, which is why it is a call somebody has to write', () => {
    // Named for what it gives up so it shows up in a diff. The tick takes a
    // log and will not run without one, so this is the only way to submit a
    // transition nobody has rehearsed.
    const log = rehearsalNotRequired();
    expect(log.recall({ contractAddress: 'anything', action: 'closeDarkVeil', dvState: 9, nowMs: 0 })).toMatchObject({
      rehearsed: true,
    });
  });
});
