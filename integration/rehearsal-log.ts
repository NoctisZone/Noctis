// ============================================================================
// Noctis Zone — a transition is rehearsed before it is taken
// ============================================================================
// A DarkVeil launch moves through one-way transitions on a published schedule.
// Close it and it cannot reopen; open buying against the wrong registrant root
// and the frozen set is the wrong set, for good. The window they happen in is
// short and the people watching it are the ones who would have to explain the
// result, so the cheapest possible moment to find out that a runner is wrong
// is BEFORE the window, against the same chain, with nothing submitted.
//
// That is what a dry run is for, and this is what makes taking one a condition
// of acting rather than a habit. A dry run banks a receipt here; a live run
// will not submit a transition that has no receipt.
//
// WHAT A RECEIPT IS MATCHED ON, and why it is these three things:
//
//   the contract       — a rehearsal against one launch says nothing about
//                        another, even mid-sentence identical ones
//   the transition     — the unit of risk is the circuit being called, not
//                        the launch; rehearsing a close does not clear an
//                        open
//   the dvState it was planned from
//                      — the same transition planned from a different
//                        lifecycle position is a different decision, because
//                        the planner reached it by a different route
//
// And DELIBERATELY NOT the rest of the snapshot. A registrant count changes
// between a rehearsal and the window it was taken for — that is registration
// working — so matching on it would void every receipt the moment it was
// useful. What must not change is which transition is being taken from which
// state, and that is exactly what is matched.
//
// A RECEIPT EXPIRES. Its value is that it was produced by the code that is
// about to run, against a chain in the shape it is about to be in. Neither
// survives indefinitely, so neither does the receipt.
//
// ONE RECEIPT CLEARS ONE TRANSITION. A launch cannot be pre-cleared end to
// end in a single sitting, because the inputs to the second transition do not
// exist until the first has happened — a registrant root cannot be rehearsed
// before there is a registrant set. Each transition is rehearsed from the
// position the chain is actually in. That is a limit worth naming rather than
// working around: a rehearsal of a step whose inputs are imaginary proves
// nothing about the step that will really be taken.
//
// A DRY RUN MAY USE A CLOCK THAT HAS NOT ARRIVED. It is the only way to
// rehearse a window ahead of reaching it, and the read is still real — only
// the time is moved. The receipt records both times separately so it can be
// read for what it is, rather than looking like a rehearsal that happened at a
// moment it did not.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConductorActionKind } from './launch-conductor.js';

/** One banked rehearsal: a transition that was planned in full and not taken. */
export interface RehearsalEntry {
  /** The launch this was rehearsed against. */
  contractAddress: string;
  /** The transition that was planned. */
  action: ConductorActionKind;
  /** The DarkVeil sub-phase it was planned FROM, as the chain read it. */
  dvState: number;
  /** Wall clock when the rehearsal ran, in milliseconds. */
  rehearsedAtMs: number;
  /**
   * The clock the plan was made against, in seconds.
   *
   * Equal to the wall clock for an ordinary dry run, and ahead of it for one
   * taken before the window it rehearses. Kept separate from `rehearsedAtMs`
   * so a receipt never reads as though it happened in the future.
   */
  plannedForSeconds: string;
  /** The planner's own reason, so a receipt can be read without re-deriving it. */
  because: string;
  /** Free-form note from whoever ran it. Not matched on; recorded for the reader. */
  note?: string;
}

export interface RehearsalQuery {
  contractAddress: string;
  action: ConductorActionKind;
  dvState: number;
  /** Wall clock now, in milliseconds — supplied so the check is testable. */
  nowMs: number;
}

export type RehearsalVerdict = { rehearsed: true; entry: RehearsalEntry } | { rehearsed: false; why: string };

/**
 * Where rehearsals are banked and looked up.
 *
 * An interface rather than a concrete store because the tick depends on it,
 * and a tick that reached for a file directly could not be tested without one.
 */
export interface RehearsalLog {
  record(entry: RehearsalEntry): void | Promise<void>;
  recall(query: RehearsalQuery): RehearsalVerdict | Promise<RehearsalVerdict>;
}

/**
 * A log that answers without waiting, which both of the ones below do.
 *
 * The interface admits a slower store — one behind a network, say — because a
 * tick can afford to await a lookup. Saying that these two are not is what
 * lets a caller read a verdict directly rather than threading an await through
 * code that never needed one.
 */
export interface SyncRehearsalLog extends RehearsalLog {
  recall(query: RehearsalQuery): RehearsalVerdict;
}

/**
 * How long a banked rehearsal clears its transition for.
 *
 * Long enough to rehearse a day or two ahead of a scheduled window, which is
 * when a rehearsal is actually useful; short enough that a receipt does not
 * outlive the build that produced it or the chain state it was taken against.
 */
export const DEFAULT_REHEARSAL_TTL_MS = 72 * 60 * 60 * 1000;

export interface FileRehearsalLogOptions {
  /** Overrides DEFAULT_REHEARSAL_TTL_MS. */
  ttlMs?: number;
  /** Supplied in tests; defaults to the real clock. */
  nowMs?: () => number;
}

/**
 * Whether a banked entry clears a query, and if not, in a sentence saying why.
 *
 * Pure, and separate from any store, because this is the whole rule and it is
 * the thing worth testing directly. Entries are searched newest first, so the
 * most recent rehearsal of a transition is the one that answers for it.
 */
export function recallFrom(entries: readonly RehearsalEntry[], query: RehearsalQuery, ttlMs: number): RehearsalVerdict {
  const forContract = entries.filter((e) => e.contractAddress === query.contractAddress);
  if (forContract.length === 0) {
    return {
      rehearsed: false,
      why: `nothing has been rehearsed against ${query.contractAddress}. Take a dry run of ${query.action} first.`,
    };
  }

  const forTransition = forContract.filter((e) => e.action === query.action && e.dvState === query.dvState);
  if (forTransition.length === 0) {
    const others = [...new Set(forContract.map((e) => e.action))].join(', ');
    return {
      rehearsed: false,
      why:
        `${query.action} has not been rehearsed from dvState ${query.dvState} on this launch ` +
        `(rehearsed here: ${others}). Take a dry run of this transition first.`,
    };
  }

  // Newest first: a transition rehearsed twice is answered by the later one,
  // which is the one that ran against the chain as it is now.
  const newest = [...forTransition].sort((a, b) => b.rehearsedAtMs - a.rehearsedAtMs)[0];
  const ageMs = query.nowMs - newest.rehearsedAtMs;
  if (ageMs > ttlMs) {
    return {
      rehearsed: false,
      why:
        `the last rehearsal of ${query.action} here was ${Math.round(ageMs / 3_600_000)}h ago, past the ` +
        `${Math.round(ttlMs / 3_600_000)}h it clears for. Take another dry run.`,
    };
  }
  // A receipt from the future is not evidence of anything. It means a clock
  // moved backwards between the rehearsal and now, and the safe reading of a
  // clock nobody can trust is that nothing has been rehearsed.
  if (ageMs < 0) {
    return {
      rehearsed: false,
      why: `the last rehearsal of ${query.action} here is dated in the future; the clock cannot be relied on.`,
    };
  }

  return { rehearsed: true, entry: newest };
}

/**
 * Rehearsals banked in a JSON file.
 *
 * Written whole and moved into place rather than appended, so a run
 * interrupted mid-write leaves the previous file intact: a torn log reads as
 * "nothing is rehearsed", and a half-written entry could read as a rehearsal
 * that never finished.
 */
export function fileRehearsalLog(path: string, options: FileRehearsalLogOptions = {}): SyncRehearsalLog {
  const ttlMs = options.ttlMs ?? DEFAULT_REHEARSAL_TTL_MS;
  const nowMs = options.nowMs ?? (() => Date.now());

  const read = (): RehearsalEntry[] => {
    if (!existsSync(path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as RehearsalEntry[]) : [];
    } catch {
      // Unreadable means unknown, and unknown means nothing is rehearsed. The
      // direction matters: the other reading would let a corrupt file clear a
      // live transition.
      return [];
    }
  };

  return {
    record(entry: RehearsalEntry): void {
      mkdirSync(dirname(path), { recursive: true });
      const entries = read();
      entries.push(entry);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries, null, 1));
      renameSync(tmp, path);
    },
    recall(query: RehearsalQuery): RehearsalVerdict {
      return recallFrom(read(), { ...query, nowMs: query.nowMs || nowMs() }, ttlMs);
    },
  };
}

/**
 * A log that clears everything and banks nothing.
 *
 * Named for what it gives up, because that is the point: the tick takes a
 * `RehearsalLog` and will not run without one, so the only way to run a
 * transition that has not been rehearsed is to write this call and have
 * someone read it. A test that is not about the precondition uses it; a run
 * against a real launch should not.
 */
export function rehearsalNotRequired(): SyncRehearsalLog {
  return {
    record(): void {
      /* nothing to bank: nothing is checked */
    },
    recall(): RehearsalVerdict {
      return {
        rehearsed: true,
        entry: {
          contractAddress: '',
          action: 'startRegistration',
          dvState: -1,
          rehearsedAtMs: 0,
          plannedForSeconds: '0',
          because: 'the rehearsal requirement was waived by the caller',
        },
      };
    },
  };
}
