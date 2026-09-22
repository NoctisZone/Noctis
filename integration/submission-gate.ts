// ============================================================================
// Noctis Zone — one Midnight submission at a time, per funding wallet
// ============================================================================
// Two transactions paid by the same wallet cannot be in flight at once. The
// node refuses one of them at SUBMISSION, after proving and balancing have both
// succeeded, with a code that names nothing about the collision — measured on
// Preprod with two registrations launched together, where the same payload
// rerun alone and unchanged went straight through.
//
// The reason it bites so hard is arithmetic rather than principle. A launch's
// settlement half is dominated by per-registrant circuits, so a fifteen-
// registrant run is sixty-odd transactions, and the obvious way to make that
// bearable is to run them in parallel. A driver that does so from one funding
// wallet fails transactions for a reason that looks nothing like its cause —
// after paying ~170 seconds of proving for each one.
//
// SERIALIZE BY WALLET, NOT GLOBALLY. The constraint is per funding wallet, so
// a global lock would give away the concurrency that IS available: in a real
// launch fifteen people pay for their own transactions and this contention
// never arises at all. Keying the gate by wallet keeps that shape reachable and
// makes the rehearsal's single-wallet case the degenerate one rather than the
// design.
//
// WHY THIS RATHER THAN RETRYING ON THE CODE. A retry loop would also work, and
// it is the weakest of the options available: it treats a predictable collision
// as a transient, and pays for the collision twice over — once in the wasted
// prove, once in the wait. The classifier in submission-outcome.ts still
// handles that code, because a stale wallet produces it too and no gate can
// prevent that one. The gate removes the collisions we cause; the classifier
// catches the ones we do not.
// ============================================================================

export interface GateWaitRecord {
  /** The funding wallet this submission queued behind. */
  key: string;
  /** How long it spent waiting for the wallet to come free. */
  waitedMs: number;
  /** How many were already queued when it arrived. */
  queuedAhead: number;
}

export interface SubmissionGateOptions {
  /**
   * Called when a submission waited on another. Not optional in spirit: a run
   * that is slow because it is queueing looks exactly like a run that is slow
   * because the chain is, and only this tells them apart.
   */
  onWait?: (record: GateWaitRecord) => void;
  /**
   * Longest a submission may wait for its turn before giving up.
   *
   * A submission that is still queued after this has not been sent, so timing
   * out here is safe in the way timing out a sent transaction is not — nothing
   * has reached the node. Default is generous because the thing being waited
   * for is a real proof-and-submit cycle, measured at roughly three minutes for
   * the heavy circuits.
   */
  maxWaitMs?: number;
}

const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * Runs one submission at a time per key, in arrival order.
 *
 * Arrival order matters: without it a wallet under steady load can starve a
 * submission indefinitely, and the starved one is whichever registrant was
 * unlucky — which is exactly the kind of failure that looks like a bug in
 * their registration rather than in the runner.
 */
export class SubmissionGate {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #depth = new Map<string, number>();
  readonly #onWait?: (record: GateWaitRecord) => void;
  readonly #maxWaitMs: number;

  constructor(options: SubmissionGateOptions = {}) {
    this.#onWait = options.onWait;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /** How many submissions are queued or running for a wallet right now. */
  depth(key: string): number {
    return this.#depth.get(key) ?? 0;
  }

  /**
   * Submit through the gate.
   *
   * `key` is the funding wallet. Anything sharing it is serialized; anything
   * with a different one runs beside it.
   */
  async submit<T>(key: string, run: () => Promise<T>): Promise<T> {
    const queuedAhead = this.depth(key);
    this.#depth.set(key, queuedAhead + 1);

    const previous = this.#queues.get(key) ?? Promise.resolve();
    const startedWaiting = Date.now();

    const mine = previous.then(() => undefined);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // THE NEXT ARRIVAL WAITS ON THE RELEASE, NEVER ON `run` ITSELF, and that is
    // what stops one rejection wedging a wallet's queue for the rest of the
    // run. `release()` sits in a `finally`, so it fires whether the submission
    // was accepted, refused by the node, or never got a turn — the chain is
    // therefore built only from promises that resolve, and a rejection reaches
    // the caller of `submit` without ever entering it.
    //
    // Written this way on purpose rather than by wrapping the chain in a
    // `catch`: a catch here would look like the thing providing the guarantee
    // while being unreachable, which is worse than not having one. The test
    // that covers this fails if `release()` is moved out of the `finally`, and
    // does not if a catch is removed — which is the right way round.
    this.#queues.set(
      key,
      mine.then(() => held),
    );

    try {
      await this.#waitForTurn(mine, key, queuedAhead, startedWaiting);
      const waitedMs = Date.now() - startedWaiting;
      if (queuedAhead > 0) {
        this.#onWait?.({ key, waitedMs, queuedAhead });
      }
      return await run();
    } finally {
      release();
      const depth = this.depth(key) - 1;
      if (depth <= 0) {
        // Drop the key entirely when nothing is left, so a long run over many
        // registrant wallets does not accumulate a map entry per wallet for
        // the life of the process.
        this.#depth.delete(key);
        if (this.#queues.get(key) === undefined) this.#queues.delete(key);
      } else {
        this.#depth.set(key, depth);
      }
    }
  }

  async #waitForTurn(turn: Promise<unknown>, key: string, queuedAhead: number, startedWaiting: number): Promise<void> {
    if (queuedAhead === 0) {
      await turn;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Waited ${Math.round((Date.now() - startedWaiting) / 1000)}s for funding wallet ${key} and never got a turn ` +
              `(${queuedAhead} ahead). Nothing was submitted, so this is safe to retry — but a queue this deep means ` +
              'the run is serialized on one wallet where it should be spread across several.',
          ),
        );
      }, this.#maxWaitMs);
      timer.unref?.();
    });
    try {
      await Promise.race([turn, expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Drain a list of submissions through the gate.
 *
 * Kept as a helper because the shape it encourages is the point: hand it
 * everything and let the gate decide what may overlap, rather than serializing
 * the whole run by hand and losing the concurrency between DIFFERENT wallets
 * along with the contention within one.
 */
export async function submitAll<T>(
  gate: SubmissionGate,
  items: ReadonlyArray<{ key: string; run: () => Promise<T> }>,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  return Promise.all(
    items.map((item) =>
      gate.submit(item.key, item.run).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
    ),
  );
}
