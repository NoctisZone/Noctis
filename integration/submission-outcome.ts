// ============================================================================
// Noctis Zone — what to do about a rejected Midnight submission
// ============================================================================
// An unattended run has to answer one question about every failure: submit
// this again, fix something first, or stop and fetch a human. Getting it wrong
// in either direction is expensive — a silent retry of a real fault repeats it
// for ever, and a stop on a routine transient abandons a launch mid-lifecycle
// with real bonds locked inside it.
//
// READ THE BANKED STDERR, NEVER THE CALLER'S PARSED OUTPUT. This is the whole
// reason the module exists in this shape. The node's code survives only in the
// CLI subprocess's stderr; by the time a failure reaches a caller it is the
// generic `SubmissionError: Transaction submission error`, which names no code
// at all. A retry wrapper written against that output once classified a
// routine ctime race as a hard failure and stopped a settlement at step 25 of
// 39 — having never retried once, because the string it matched on could not
// appear in the stream it watched.
//
// THE CODES ARE NESTED AND ONLY THE INNER ONE MEANS ANYTHING. A real rejection
// reads `1010: Invalid Transaction: Custom error: 196`. The 1010 is Substrate's
// "invalid transaction" and is the same for every cause; the `Custom error`
// after it is the ledger's own verdict. Matching the outer number classifies
// every rejection identically, which is worse than not classifying at all
// because it looks like it worked.
//
// THE WORST CODE PRESENT WINS. One stderr can carry several — a retried step
// prints its earlier attempts too — and a 196 sitting beside a 170 means the
// wallet's view is stale, which is not fixed by submitting the same bytes
// again. Taking the first or the last match would make the verdict depend on
// print order.
// ============================================================================

/** What the caller should do next. Ordered by severity; later beats earlier. */
export type SubmissionDisposition =
  /** Nothing is wrong that time does not fix. Submit the same call again. */
  | 'retry'
  /** The indexer is behind. Wait for it, then submit again. */
  | 'wait-indexer'
  /** This wallet's view of the chain is stale. Catch it up, then submit again. */
  | 'resync'
  /** The wallet cannot pay. Fund or wait for DUST generation; do not spin. */
  | 'insufficient-dust'
  /** Stop. Retrying is either useless or unsafe, and a human should look. */
  | 'operator';

const SEVERITY: Record<SubmissionDisposition, number> = {
  retry: 0,
  'wait-indexer': 1,
  resync: 2,
  'insufficient-dust': 3,
  operator: 4,
};

export interface LedgerCodeMeaning {
  code: number;
  disposition: SubmissionDisposition;
  /** Why, in a line, so a log entry explains itself without this file. */
  because: string;
}

/**
 * The ledger codes seen on Preprod, with what each one is owed.
 *
 * Deliberately a short list of MEASURED codes rather than a guess at the whole
 * ledger's error space: an unrecognised code falls through to `operator`,
 * which is the safe direction. Adding one here is a decision to retry it
 * automatically, and that should take evidence.
 */
export const LEDGER_CODES: readonly LedgerCodeMeaning[] = [
  {
    code: 117,
    disposition: 'operator',
    because:
      'NotNormalized — the fee came out as zero because the chain was idle. Retrying resubmits the ' +
      'same zero-fee transaction and is refused identically; the fix is a fee overhead, not another attempt.',
  },
  {
    code: 170,
    disposition: 'retry',
    because:
      'InvalidDustSpendProof — the proof was built against a dust root the node had already moved ' +
      'past. Measured at roughly 4% of submissions, and its own mitigation is to submit again.',
  },
  {
    code: 171,
    disposition: 'wait-indexer',
    because: 'The indexer has not caught up to the state this transaction was built against. Time fixes it.',
  },
  {
    code: 173,
    disposition: 'insufficient-dust',
    because:
      'The wallet cannot cover the fee. DUST generates over time, so this resolves without intervention ' +
      'on a funded wallet and never on an unfunded one — which is why it is not a plain retry.',
  },
  {
    code: 196,
    disposition: 'resync',
    because:
      "The wallet's view of the chain is stale. Submitting the same bytes again reproduces it exactly; " +
      'the wallet has to catch up first.',
  },
  {
    code: 241,
    disposition: 'resync',
    because:
      'UnknownMerkleRoot — the transaction references a root the node no longer keeps. Its documented ' +
      'fix is to resync against the current head and rebuild, so the same bytes are never valid again.',
  },
];

const BY_CODE = new Map(LEDGER_CODES.map((m) => [m.code, m]));

/**
 * Every ledger code in a stderr stream, in the order found.
 *
 * Matches the INNER code only. `1010: Invalid Transaction: Custom error: 196`
 * yields 196 and never 1010 — see the header for why that distinction is the
 * difference between classifying and appearing to.
 */
export function ledgerCodesIn(stderr: string): number[] {
  const found: number[] = [];
  for (const m of stderr.matchAll(/Custom error:\s*(\d+)/g)) {
    found.push(Number(m[1]));
  }
  return found;
}

export interface SubmissionOutcome {
  disposition: SubmissionDisposition;
  /** Every code found, so a log shows what was weighed and not only the verdict. */
  codes: number[];
  /** The one that decided it, or undefined when nothing was recognised. */
  decidedBy?: number;
  reason: string;
}

/** A banked job row: what the CLI subprocess actually produced. */
export interface BankedJobResult {
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
  /** True when the runner stopped the child at its deadline. */
  timedOut?: boolean | null;
}

/**
 * Classify a finished CLI run.
 *
 * Takes the banked row rather than a thrown error, because the row is the only
 * place the node's own code survives — see the header. A run that succeeded is
 * not passed here at all; deciding whether it succeeded is the caller's job and
 * is answered by the chain, not by an exit code.
 */
export function classifySubmission(result: BankedJobResult): SubmissionOutcome {
  const stderr = String(result.stderr ?? '');
  const codes = ledgerCodesIn(stderr);

  // A stopped child tells us nothing about the chain. It may well have
  // submitted before it was stopped, so the safe reading is that the outcome
  // is unknown and somebody has to look — never "it failed, send it again",
  // which is how a transaction lands twice.
  if (result.timedOut) {
    return {
      disposition: 'operator',
      codes,
      reason:
        'The CLI was stopped at its deadline, so whether it submitted is unknown. Read the chain before ' +
        'deciding — a resubmission here can double a transaction that already landed.',
    };
  }

  if (codes.length === 0) {
    return {
      disposition: 'operator',
      codes,
      reason:
        stderr.trim() === ''
          ? 'The run failed and produced no stderr, so there is nothing to classify.'
          : 'No ledger error code appeared in the run output, so the failure is not one of the known transients.',
    };
  }

  let worst: LedgerCodeMeaning | undefined;
  const unknown: number[] = [];
  for (const code of codes) {
    const meaning = BY_CODE.get(code);
    if (!meaning) {
      unknown.push(code);
      continue;
    }
    if (!worst || SEVERITY[meaning.disposition] > SEVERITY[worst.disposition]) worst = meaning;
  }

  // An unrecognised code beside recognised ones still stops the run. The
  // recognised one may be incidental — a retried step prints its earlier
  // attempts — and deciding on it would be choosing the reading that lets the
  // machine carry on, which is the wrong bias when something is unexplained.
  if (unknown.length > 0) {
    return {
      disposition: 'operator',
      codes,
      reason: `Unrecognised ledger code ${unknown.join(', ')}. Classify it deliberately before it is retried automatically.`,
    };
  }

  const decided = worst as LedgerCodeMeaning;
  const others = codes.filter((c) => c !== decided.code);
  const alongside = others.length > 0 ? ` (alongside ${[...new Set(others)].join(', ')})` : '';
  return {
    disposition: decided.disposition,
    codes,
    decidedBy: decided.code,
    reason: `${decided.code}${alongside}: ${decided.because}`,
  };
}

/** Whether the conductor may submit the same call again without a human. */
export function isAutomaticallyRecoverable(outcome: SubmissionOutcome): boolean {
  return outcome.disposition !== 'operator';
}

/**
 * How long to wait before the next attempt.
 *
 * Shaped by what is actually being waited for, not by a single backoff curve:
 * a ctime race is gone within a block, an indexer catches up in seconds, and a
 * stale wallet needs a real catch-up. A wallet with no DUST waits longest,
 * because generation is measured in hours and spinning on it achieves nothing.
 */
export function retryDelayMs(outcome: SubmissionOutcome, attempt: number): number {
  const base: Record<SubmissionDisposition, number> = {
    retry: 6_000,
    'wait-indexer': 15_000,
    resync: 60_000,
    'insufficient-dust': 600_000,
    operator: 0,
  };
  const ceiling: Record<SubmissionDisposition, number> = {
    retry: 60_000,
    'wait-indexer': 120_000,
    resync: 600_000,
    'insufficient-dust': 3_600_000,
    operator: 0,
  };
  const grown = base[outcome.disposition] * 2 ** Math.max(0, attempt - 1);
  return Math.min(grown, ceiling[outcome.disposition]);
}
