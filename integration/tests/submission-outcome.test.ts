import { describe, expect, it } from 'vitest';
import {
  classifySubmission,
  indexerOutageIn,
  isAutomaticallyRecoverable,
  LEDGER_CODES,
  ledgerCodesIn,
  nodeReplyUnreadableIn,
  retryDelayMs,
} from '../submission-outcome.js';

// Three codeless shapes, again copied from banked output rather than written
// from memory. The first is what a CLI's stdout holds when the node put the
// transaction in a block and the SDK could not decode the reply; the second
// is the stderr of a step whose wallet sync died when the indexer went away;
// the third is the ordinary retry warning the wallet prints on the way past,
// which appears in SUCCESSFUL runs too and must classify as nothing.
const REAL_NODE_REPLY_UNREADABLE =
  '{"ok":false,"error":"Transaction submission error <- Failed to parse result provided by node <- ' +
  '{ readonly blockNumber: BN }\\n└─ [\\"blockNumber\\"]\\n   └─ Expected BN, actual undefined"}';
const REAL_INDEXER_OUTAGE =
  'Wallet.Sync: [object ErrorEvent]\n' +
  '    at file:///C:/Users/.../node_modules/@midnight-ntwrk/wallet-sdk-unshielded-wallet/dist/v1/Sync.js:39:245\n' +
  '    at file:///C:/Users/.../node_modules/effect/dist/esm/internal/cause.js:279:78 {\n' +
  "  _tag: 'Wallet.Sync'\n" +
  '}';
const ROUTINE_WARNING =
  'timestamp=2026-09-23T02:11:00.308Z level=WARN fiber=#26 message="{\n' +
  '  \\"message\\": \\"An unknown error occurred\\",\n' +
  '  \\"_tag\\": \\"ServerError\\"\n' +
  '}" message="Observed error in PendingTransactionsService, retrying"';

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

describe('the two failures that carry no code', () => {
  it('recognises the node reply the SDK could not decode, and nothing else, as one', () => {
    expect(nodeReplyUnreadableIn(REAL_NODE_REPLY_UNREADABLE)).toBe(true);
    expect(nodeReplyUnreadableIn(REAL_INDEXER_OUTAGE)).toBe(false);
    expect(nodeReplyUnreadableIn(ROUTINE_WARNING)).toBe(false);
  });

  it('recognises an indexer outage, and not the wallet’s routine retry warning', () => {
    // The warning is printed by successful runs as a matter of course. A
    // matcher that caught it would read every failed run as an outage.
    expect(indexerOutageIn(REAL_INDEXER_OUTAGE)).toBe(true);
    expect(indexerOutageIn('Error: Unexpected server response: 503')).toBe(true);
    expect(indexerOutageIn('The indexer at https://indexer.example/api answered 503 from its load balancer.')).toBe(
      true,
    );
    expect(indexerOutageIn(ROUTINE_WARNING)).toBe(false);
    expect(indexerOutageIn(REAL_170)).toBe(false);
  });

  it('re-plans, rather than stopping or resubmitting, when the node’s reply could not be read', () => {
    // The reply is only decoded once the node reports the transaction in a
    // block, so the failure is a lost receipt. Resubmitting duplicates it;
    // stopping abandons a launch over a transaction that landed.
    const outcome = classifySubmission({ stdout: REAL_NODE_REPLY_UNREADABLE, stderr: ROUTINE_WARNING, exitCode: 1 });
    expect(outcome.disposition).toBe('replan');
    expect(outcome.codes).toEqual([]);
    expect(isAutomaticallyRecoverable(outcome)).toBe(true);
    expect(outcome.reason).toMatch(/read the chain/i);
  });

  it('waits for the indexer, then reads, when the indexer died under the step', async () => {
    const outcome = classifySubmission({ stderr: REAL_INDEXER_OUTAGE, exitCode: 1 });
    expect(outcome.disposition).toBe('wait-indexer');
    expect(isAutomaticallyRecoverable(outcome)).toBe(true);
    expect(outcome.reason).toMatch(/read the chain/i);
  });

  it('lets the node’s reply decide when an outage follows a landed submission', () => {
    // Both texts can appear in one run. The reply says the transaction is in
    // a block; the outage only says the indexer went away. The stronger
    // evidence wins.
    const outcome = classifySubmission({
      stdout: REAL_NODE_REPLY_UNREADABLE,
      stderr: `${ROUTINE_WARNING}\n${REAL_INDEXER_OUTAGE}`,
      exitCode: 1,
    });
    expect(outcome.disposition).toBe('replan');
  });

  it('still lets a real ledger code win over either text', () => {
    // A refusal beside an outage warning is a refusal. Reading the outage
    // instead would retry something the node has already said no to.
    const outcome = classifySubmission({ stderr: `${REAL_INDEXER_OUTAGE}\nCustom error: 117`, exitCode: 1 });
    expect(outcome.disposition).toBe('operator');
    expect(outcome.decidedBy).toBe(117);
  });

  it('re-plans on a stale-view refusal (104) instead of asking for an operator', () => {
    // Seen live: the previous submission had landed, the indexer still
    // showed the old state, and the next plan was built against it. The same
    // bytes are never valid again, so the answer is a fresh read, not a stop.
    const outcome = classifySubmission({ stderr: '1010: Invalid Transaction: Custom error: 104', exitCode: 1 });
    expect(outcome.disposition).toBe('replan');
    expect(outcome.decidedBy).toBe(104);
    expect(isAutomaticallyRecoverable(outcome)).toBe(true);
  });

  it('re-plans when a delivered key turns out to be already present (107)', () => {
    const outcome = classifySubmission({ stderr: 'Custom error: 107', exitCode: 1 });
    expect(outcome.disposition).toBe('replan');
  });

  it('ranks a re-plan above a plain retry, so a landed-then-raced pair reads as landed', () => {
    const outcome = classifySubmission({ stderr: `${REAL_170}\nCustom error: 104`, exitCode: 1 });
    expect(outcome.disposition).toBe('replan');
    expect(outcome.decidedBy).toBe(104);
  });

  it('gives a re-plan time for the indexer to show the block first', () => {
    const outcome = classifySubmission({ stdout: REAL_NODE_REPLY_UNREADABLE, exitCode: 1 });
    expect(retryDelayMs(outcome, 1)).toBeGreaterThanOrEqual(20_000);
    expect(retryDelayMs(outcome, 1)).toBeLessThan(
      retryDelayMs(classifySubmission({ stderr: 'Custom error: 173', exitCode: 1 }), 1),
    );
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
