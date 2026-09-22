import { describe, expect, it } from 'vitest';
import {
  classifySubmission,
  isAutomaticallyRecoverable,
  LEDGER_CODES,
  ledgerCodesIn,
  retryDelayMs,
} from '../submission-outcome.js';

// The real shapes, copied from banked run output rather than invented. The
// wrapper text matters: a classifier that only recognises a bare "Custom
// error: N" and not the nested form would pass every test written from memory
// and fail on every real rejection.
const REAL_196 =
  'RpcError: 1010: Invalid Transaction: Custom error: 196\n' +
  '    at checkError (file:///C:/Users/.../node_modules/@polkadot/rpc-provider/coder/index.js:70:16)';
const REAL_196_NESTED =
  '{"error":"Transaction submission error <- Transaction submission failed <- ' +
  '1010: Invalid Transaction: Custom error: 196 (code=1010)"}';
const REAL_170 =
  'submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 170';
// What a caller sees once the CLI has wrapped it. This carries NO code, which
// is the entire reason classification reads the banked stderr instead.
const CALLER_VISIBLE = 'SubmissionError: Transaction submission error';

describe('reading the code out of a rejection', () => {
  it('takes the inner ledger code and never the outer 1010', () => {
    // 1010 is Substrate's "invalid transaction" and is identical for every
    // cause. A classifier that matched it would give one answer for everything
    // while looking like it was deciding.
    expect(ledgerCodesIn(REAL_196)).toEqual([196]);
    expect(ledgerCodesIn(REAL_196_NESTED)).toEqual([196]);
    expect(ledgerCodesIn(REAL_170)).toEqual([170]);
  });

  it('finds every code in a stream, not just the first', () => {
    expect(ledgerCodesIn(`${REAL_170}\n${REAL_196}`)).toEqual([170, 196]);
  });

  it('finds nothing in the error a caller actually sees', () => {
    // The defect this module exists to prevent: a retry wrapper watching this
    // stream can never match a code, so every transient reads as a hard
    // failure and the run stops having retried nothing.
    expect(ledgerCodesIn(CALLER_VISIBLE)).toEqual([]);
  });
});

describe('deciding what to do about it', () => {
  it('retries a lone ctime race', () => {
    const outcome = classifySubmission({ stderr: REAL_170, exitCode: 1 });
    expect(outcome.disposition).toBe('retry');
    expect(outcome.decidedBy).toBe(170);
    expect(isAutomaticallyRecoverable(outcome)).toBe(true);
  });

  it('resyncs on a stale view rather than resubmitting the same bytes', () => {
    const outcome = classifySubmission({ stderr: REAL_196, exitCode: 1 });
    expect(outcome.disposition).toBe('resync');
    expect(outcome.decidedBy).toBe(196);
  });

  it('lets the worse code decide when both are present', () => {
    // The exact case that stopped a settlement: a 196 beside a 170 is a stale
    // wallet, and submitting the same bytes again reproduces it exactly. Taking
    // the first or last match would make the verdict depend on print order.
    const both = classifySubmission({ stderr: `${REAL_170}\n${REAL_196}`, exitCode: 1 });
    expect(both.disposition).toBe('resync');
    expect(both.decidedBy).toBe(196);
    expect(both.codes).toEqual([170, 196]);
    expect(both.reason).toContain('alongside 170');

    // And in the other print order, which is the whole point.
    const reversed = classifySubmission({ stderr: `${REAL_196}\n${REAL_170}`, exitCode: 1 });
    expect(reversed.disposition).toBe('resync');
    expect(reversed.decidedBy).toBe(196);
  });

  it('refuses to retry a zero-fee rejection, which retrying cannot fix', () => {
    // 117 is an idle-chain fee of zero. The same bytes are refused identically
    // every time, so a retry loop here spins for ever and never learns.
    const outcome = classifySubmission({ stderr: 'Custom error: 117', exitCode: 1 });
    expect(outcome.disposition).toBe('operator');
    expect(isAutomaticallyRecoverable(outcome)).toBe(false);
  });

  it('treats an unrecognised code as a stop, even beside a known transient', () => {
    // Biasing the other way would mean choosing the reading that lets the
    // machine carry on, which is exactly the wrong instinct when something is
    // unexplained.
    const outcome = classifySubmission({ stderr: `${REAL_170}\nCustom error: 9999`, exitCode: 1 });
    expect(outcome.disposition).toBe('operator');
    expect(outcome.reason).toContain('9999');
  });

  it('stops on a stopped child rather than resubmitting a transaction that may have landed', () => {
    // The dangerous case. A child killed at its deadline may well have
    // submitted first, so "it failed, send it again" is how one transaction
    // becomes two.
    const outcome = classifySubmission({ stderr: REAL_170, timedOut: true, exitCode: 124 });
    expect(outcome.disposition).toBe('operator');
    expect(outcome.reason).toMatch(/already landed|before deciding/i);
  });

  it('stops on the error a caller sees, because it carries no code at all', () => {
    const outcome = classifySubmission({ stderr: CALLER_VISIBLE, exitCode: 1 });
    expect(outcome.disposition).toBe('operator');
    expect(outcome.codes).toEqual([]);
  });

  it('stops on silence', () => {
    expect(classifySubmission({ stderr: '', exitCode: 1 }).disposition).toBe('operator');
    expect(classifySubmission({}).disposition).toBe('operator');
  });
});

describe('the table itself', () => {
  it('names a reason for every code it will act on', () => {
    // A code that is retried automatically with no stated reason is a decision
    // nobody made on purpose.
    for (const entry of LEDGER_CODES) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
  });

  it('lists each code once', () => {
    const codes = LEDGER_CODES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('how long to wait', () => {
  it('waits longest for DUST and shortest for a ctime race', () => {
    // Shaped by what is being waited for. Generation is measured in hours, so
    // spinning on it achieves nothing; a ctime race is gone within a block.
    const race = classifySubmission({ stderr: REAL_170, exitCode: 1 });
    const dust = classifySubmission({ stderr: 'Custom error: 173', exitCode: 1 });
    expect(retryDelayMs(race, 1)).toBeLessThan(retryDelayMs(dust, 1));
  });

  it('grows with attempts but stops growing', () => {
    const outcome = classifySubmission({ stderr: REAL_170, exitCode: 1 });
    expect(retryDelayMs(outcome, 2)).toBeGreaterThan(retryDelayMs(outcome, 1));
    expect(retryDelayMs(outcome, 50)).toBe(retryDelayMs(outcome, 60));
  });

  it('never schedules a wait for something a human has to look at', () => {
    const outcome = classifySubmission({ stderr: 'Custom error: 117', exitCode: 1 });
    expect(retryDelayMs(outcome, 1)).toBe(0);
  });
});
