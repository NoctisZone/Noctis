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
//
// TWO FAILURES CARRY NO CODE AND STILL MEAN SOMETHING. A node reply the SDK
// could not decode arrives only once the node has reported the transaction in
// a block, so the "failure" is a landed transaction whose receipt was lost —
// resubmitting it is the wrong move and stopping for a human is unnecessary;
// what is owed is a read of the chain. And an indexer outage kills a step
// after the node has accepted it just as easily as before, so it too is a
// "read the chain once the indexer is back", never a resubmit. Both were read
// as "no ledger code, needs an operator" during a rehearsal and each cost an
// hour of somebody's attention that a chain read would have settled.
// ============================================================================

/** What the caller should do next. Ordered by severity; later beats earlier. */
export type SubmissionDisposition =
  /** Nothing is wrong that time does not fix. Submit the same call again. */
  | 'retry'
  /**
   * The indexer is behind or down. Wait for it, then READ THE CHAIN before
   * submitting again: a step that dies in an outage may well have landed.
   */
  | 'wait-indexer'
  /** This wallet's view of the chain is stale. Catch it up, then submit again. */
  | 'resync'
  /**
   * The chain probably already holds this, or has moved past the state it
   * was built against. Read the chain, then submit only what is still owed.
   */
  | 'replan'
  /** The wallet cannot pay. Fund or wait for DUST generation; do not spin. */
  | 'insufficient-dust'
  /** Stop. Retrying is either useless or unsafe, and a human should look. */
  | 'operator';

const SEVERITY: Record<SubmissionDisposition, number> = {
  retry: 0,
  'wait-indexer': 1,
  resync: 2,
  replan: 3,
  'insufficient-dust': 4,
  operator: 5,
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
    code: 104,
    disposition: 'replan',
    because:
      'Transcript — the call was built against a contract state the chain has since left, usually because ' +
      'the previous submission landed while the local view still showed the old state. The same bytes are ' +
      'never valid again; read the chain and plan from what it holds now.',
  },
  {
    code: 107,
    disposition: 'replan',
    because:
      'VerifierKeyAlreadyPresent — the circuit this update delivers is already on chain, which is what a ' +
      'delivery retried after a lost receipt finds. Nothing is owed; read the chain to confirm and move on.',
  },
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

/**
 * Whether the run failed because the node's reply could not be decoded.
 *
 * The wallet's node client decodes the block number out of a submission
 * status only once that status is InBlock or Finalized — every earlier status
 * is passed through undecoded — so this error can only be raised about a
 * transaction the node has already put in a block. It is a lost receipt, not
 * a refusal. Measured three times in one night on Preprod: each transaction
 * it was reported for was on chain at the next read.
 */
export function nodeReplyUnreadableIn(output: string): boolean {
  return /Failed to parse result provided by node/.test(output);
}

/**
 * Whether the run failed on the indexer rather than on the node.
 *
 * The wallet syncs through the indexer's websocket and every read goes through
 * its HTTP endpoint, so an outage surfaces as a sync stream failure, a refused
 * upgrade, a load balancer's 503, or a bare transport error — never as a
 * ledger code. A step killed this way may have been accepted by the node
 * already; the indexer went away before the wallet could see that.
 *
 * Matched narrowly. A wallet's ordinary progress output mentions the indexer
 * too, and a matcher loose enough to catch that would turn every failed run
 * into an outage.
 */
export function indexerOutageIn(output: string): boolean {
  return /Wallet\.Sync|SyncWalletError|\[object ErrorEvent\]|Unexpected server response: 5\d\d|Received status code 5\d\d|\b50[234] Service Unavailable\b|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|fetch failed|socket hang up|indexer at \S+ (?:answered|is not reachable|is not caught up)/i.test(
    output,
  );
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
    // Two codeless failures are recognised by their text, and only these two:
    // each has a mechanism that says what happened to the transaction, which
    // is what a disposition is. Anything else without a code stays with an
    // operator — a stream that names no reason gives no basis to act.
    //
    // The node's reply is checked first. Both texts can appear together when
    // an outage follows a landed submission, and the reply is the stronger
    // evidence: it says the transaction is in a block, where the outage only
    // says the indexer went away.
    const stdout = String(result.stdout ?? '');
    if (nodeReplyUnreadableIn(stderr) || nodeReplyUnreadableIn(stdout)) {
      return {
        disposition: 'replan',
        codes,
        reason:
          'The node reported this transaction in a block, but its reply could not be decoded, so the receipt was ' +
          'lost rather than the transaction refused. Read the chain before anything is submitted again — ' +
          'a resubmission here is a duplicate.',
      };
    }
    if (indexerOutageIn(stderr) || indexerOutageIn(stdout)) {
      return {
        disposition: 'wait-indexer',
        codes,
        reason:
          'The indexer failed, not the node. The transaction may have been accepted before the indexer went ' +
          'away, so wait for the indexer, then read the chain, and submit again only if it is not there.',
      };
    }
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
  // A re-plan waits for the indexer to show the block the node reported, so a
  // read taken straight away does not still see the state the submission
  // changed. Measured at roughly twenty seconds behind the node on Preprod.
  const base: Record<SubmissionDisposition, number> = {
    retry: 6_000,
    'wait-indexer': 15_000,
    resync: 60_000,
    replan: 30_000,
    'insufficient-dust': 600_000,
    operator: 0,
  };
  const ceiling: Record<SubmissionDisposition, number> = {
    retry: 60_000,
    'wait-indexer': 120_000,
    resync: 600_000,
    replan: 120_000,
    'insufficient-dust': 3_600_000,
    operator: 0,
  };
  const grown = base[outcome.disposition] * 2 ** Math.max(0, attempt - 1);
  return Math.min(grown, ceiling[outcome.disposition]);
}
