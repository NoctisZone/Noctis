/**
 * What to watch on the venue, and what is worth waking somebody for.
 *
 * THE WHOLE DESIGN IS ONE OBSERVATION: of the four outcomes a round reports,
 * only `failed` is ever an alarm.
 *
 *   filled      work done.
 *   unfillable  the normal resting state of a limit order waiting for a price.
 *               A market can sit entirely in this for hours with nothing wrong.
 *   declined    this batcher choosing not to, under a rule it states — an order
 *               gated to other executors, or a pool already filled as deep as a
 *               round allows.
 *   failed      a fill that was attempted and did not happen.
 *
 * Alerting that pages on anything else pages for an idle market, and the
 * operator learns to ignore it. Alerting that counts only fills stays silent
 * through a broken one, because a venue with nothing fillable and a venue that
 * cannot fill both produce zero fills.
 *
 * SO LIVENESS IS MEASURED ON ROUNDS, NOT ON FILLS. "No fill for an hour" is a
 * quiet market. "No round completed for an hour" is a batcher that has stopped.
 * Only the second is a fault, and only the second pages.
 *
 * A ROUND THAT THREW IS NOT A ROUND WITH FAILURES IN IT. The first is the
 * provider — a chain request that did not answer, and nothing about the venue
 * can be concluded from it. The second is the venue — the chain was read, fills
 * were attempted, and they did not land. The batcher already separates them
 * (`onRound` against `onError`), so they are counted separately here and they
 * alert differently: one provider hiccup is noise, a run of them means the
 * batcher is effectively down.
 *
 * POOLS READ IS ITS OWN SIGNAL. A launch whose market has quietly stopped
 * trading and a chain request returning fewer pools look identical from
 * outside — both are simply a smaller number. So the count is tracked against
 * the most this monitor has ever seen, and every UTXO the reader declined comes
 * back with its reason and is counted. A drop is then visible as a drop rather
 * than as a quiet day.
 */

import type { VenueBatcherRound, VenueFillOutcome } from './venue-batcher.js';

export type VenueAlertSeverity = 'page' | 'warn' | 'info';

export interface VenueAlert {
  severity: VenueAlertSeverity;
  /** Stable identifier, so an alerting system can route and de-duplicate on it. */
  code: 'fill_failed' | 'provider_error' | 'provider_down' | 'batcher_stalled' | 'pools_read_dropped' | 'utxos_skipped';
  summary: string;
  detail: string;
}

export interface VenueMonitorThresholds {
  /**
   * Consecutive provider errors before the batcher is called down rather than
   * unlucky. One failed request is a network; several in a row is an outage.
   */
  providerErrorsBeforePage: number;
  /**
   * How long without a COMPLETED round before paging. Rounds run on a short
   * interval, so this is generously above it — the point is to catch a stopped
   * process, not a slow one.
   */
  roundStalenessMs: number;
  /**
   * Warn when the pools read fall this far below the most ever seen, as a
   * count. A pool can legitimately disappear from a read — its UTXO is being
   * spent as the read happens — so one missing is not news.
   */
  poolsReadDropBeforeWarn: number;
}

export const VENUE_DEFAULT_THRESHOLDS: VenueMonitorThresholds = {
  providerErrorsBeforePage: 3,
  roundStalenessMs: 15 * 60 * 1000,
  poolsReadDropBeforeWarn: 2,
};

export interface VenueMonitorState {
  roundsCompleted: number;
  roundsThrown: number;
  /** Reset by any completed round, however that round went. */
  consecutiveProviderErrors: number;
  ordersSeen: number;
  filled: number;
  failed: number;
  unfillable: number;
  declined: number;
  /** The most pools any single round has read. The yardstick for a drop. */
  poolsReadHighWater: number;
  poolsReadLast: number;
  /** Every reason the reader has given for declining a UTXO, with a count. */
  skippedByReason: Record<string, number>;
  lastRoundAtMs: number | null;
  lastFillAtMs: number | null;
  /**
   * When a round last threw. Kept beside `lastRoundAtMs` so an operator can see
   * at a glance whether a silent stretch was a stopped batcher or one spinning
   * against a provider that will not answer — two very different call-outs that
   * look identical if only the last good round is recorded.
   */
  lastErrorAtMs: number | null;
}

function countOutcomes(outcomes: readonly VenueFillOutcome[]) {
  let filled = 0;
  let failed = 0;
  let unfillable = 0;
  let declined = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'filled') filled += 1;
    else if (outcome.status === 'failed') failed += 1;
    else if (outcome.status === 'unfillable') unfillable += 1;
    else declined += 1;
  }
  return { filled, failed, unfillable, declined };
}

/**
 * How many distinct pools a round touched.
 *
 * Derived from the orders' own pool references rather than taken as a separate
 * count, so it cannot disagree with what the round actually worked on.
 */
function poolsTouched(round: VenueBatcherRound): number {
  const seen = new Set<string>();
  for (const outcome of round.outcomes) {
    const nft = outcome.order.datum.pool_nft;
    if (nft) seen.add(`${nft.policy}${nft.name}`);
  }
  return seen.size;
}

/**
 * Accumulates what rounds report and says what is worth an alert.
 *
 * Deliberately has no transport: it returns alerts rather than sending them, so
 * the thing that decides what is alarming can be tested without a webhook, and
 * the thing that delivers can be swapped without touching any of these rules.
 */
export class VenueMonitor {
  private readonly thresholds: VenueMonitorThresholds;
  private state: VenueMonitorState = {
    roundsCompleted: 0,
    roundsThrown: 0,
    consecutiveProviderErrors: 0,
    ordersSeen: 0,
    filled: 0,
    failed: 0,
    unfillable: 0,
    declined: 0,
    poolsReadHighWater: 0,
    poolsReadLast: 0,
    skippedByReason: {},
    lastRoundAtMs: null,
    lastFillAtMs: null,
    lastErrorAtMs: null,
  };

  constructor(thresholds: Partial<VenueMonitorThresholds> = {}) {
    this.thresholds = { ...VENUE_DEFAULT_THRESHOLDS, ...thresholds };
  }

  snapshot(): VenueMonitorState {
    return { ...this.state, skippedByReason: { ...this.state.skippedByReason } };
  }

  /** A round that completed — however it went. Wire to the batcher's `onRound`. */
  observeRound(round: VenueBatcherRound, nowMs: number): VenueAlert[] {
    const alerts: VenueAlert[] = [];
    const counts = countOutcomes(round.outcomes);
    const pools = poolsTouched(round);

    this.state.roundsCompleted += 1;
    this.state.consecutiveProviderErrors = 0;
    this.state.ordersSeen += round.outcomes.length;
    this.state.filled += counts.filled;
    this.state.failed += counts.failed;
    this.state.unfillable += counts.unfillable;
    this.state.declined += counts.declined;
    this.state.lastRoundAtMs = nowMs;
    if (counts.filled > 0) this.state.lastFillAtMs = nowMs;

    for (const skipped of round.skipped) {
      this.state.skippedByReason[skipped.reason] = (this.state.skippedByReason[skipped.reason] ?? 0) + 1;
    }

    // The one order outcome that is ever an alarm.
    if (counts.failed > 0) {
      const reasons = round.outcomes
        .filter((outcome): outcome is Extract<VenueFillOutcome, { status: 'failed' }> => outcome.status === 'failed')
        .map((outcome) => `${outcome.order.txHash}#${outcome.order.outputIndex}: ${outcome.reason}`);
      alerts.push({
        severity: 'page',
        code: 'fill_failed',
        summary: `${counts.failed} fill${counts.failed === 1 ? '' : 's'} attempted and did not happen`,
        detail: reasons.join('\n'),
      });
    }

    // A drop in pools read, measured against the most ever seen rather than
    // against the last round, so a single bad read does not reset the yardstick.
    const previousHighWater = this.state.poolsReadHighWater;
    this.state.poolsReadLast = pools;
    if (pools > this.state.poolsReadHighWater) this.state.poolsReadHighWater = pools;
    const drop = previousHighWater - pools;
    if (previousHighWater > 0 && drop >= this.thresholds.poolsReadDropBeforeWarn) {
      alerts.push({
        severity: 'warn',
        code: 'pools_read_dropped',
        summary: `This round worked ${pools} pools against a high-water mark of ${previousHighWater}`,
        detail:
          'A market that has quietly stopped trading and a read that returned fewer pools look the same from ' +
          'outside. Check the skipped reasons below before concluding either.\n' +
          this.describeSkipped(round),
      });
    }

    if (round.skipped.length > 0) {
      alerts.push({
        severity: 'info',
        code: 'utxos_skipped',
        summary: `${round.skipped.length} UTXO${round.skipped.length === 1 ? '' : 's'} declined by the reader`,
        detail: this.describeSkipped(round),
      });
    }

    return alerts;
  }

  /**
   * A round that threw. Wire to the batcher's `onError`.
   *
   * This says nothing about the venue — the chain was never read. It is only
   * ever about whoever serves chain data, so it warns on its own and pages only
   * once it has happened enough times in a row to mean the batcher is not
   * running rather than merely unlucky.
   */
  observeRoundError(error: unknown, nowMs: number): VenueAlert[] {
    this.state.roundsThrown += 1;
    this.state.consecutiveProviderErrors += 1;
    this.state.lastErrorAtMs = nowMs;
    const message = error instanceof Error ? error.message : String(error);
    const runLength = this.state.consecutiveProviderErrors;

    if (runLength >= this.thresholds.providerErrorsBeforePage) {
      return [
        {
          severity: 'page',
          code: 'provider_down',
          summary: `${runLength} rounds in a row failed before reading the chain`,
          detail:
            `Latest: ${message}\n` +
            'No fill has been attempted in any of them, so nothing is known about the venue itself — this is ' +
            'the chain provider. Fills are not happening while it lasts.',
        },
      ];
    }
    return [
      {
        severity: 'warn',
        code: 'provider_error',
        summary: `A round failed before reading the chain (${runLength} in a row)`,
        detail: message,
      },
    ];
  }

  /**
   * Liveness, on a timer rather than on a round — because the symptom being
   * watched for is rounds not arriving at all, which no round can report.
   *
   * Measured on rounds and never on fills. A venue with nothing fillable
   * produces no fills and is perfectly healthy.
   */
  checkLiveness(nowMs: number): VenueAlert[] {
    const last = this.state.lastRoundAtMs;
    if (last === null) return [];
    const silentMs = nowMs - last;
    if (silentMs < this.thresholds.roundStalenessMs) return [];
    return [
      {
        severity: 'page',
        code: 'batcher_stalled',
        summary: `No round has completed for ${Math.floor(silentMs / 60000)} minutes`,
        detail:
          'Rounds run on a short interval, so this is the batcher having stopped rather than a quiet market. ' +
          'A quiet market still completes rounds; it just fills nothing in them.',
      },
    ];
  }

  private describeSkipped(round: VenueBatcherRound): string {
    if (round.skipped.length === 0) return 'Nothing was declined this round.';
    const byReason = new Map<string, number>();
    for (const skipped of round.skipped) {
      byReason.set(skipped.reason, (byReason.get(skipped.reason) ?? 0) + 1);
    }
    return [...byReason.entries()].map(([reason, count]) => `  ${count}x ${reason}`).join('\n');
  }
}

/**
 * The alerts that should actually wake somebody.
 *
 * A convenience with a point to it: the separation only holds if the delivery
 * side uses it, and a caller that forwards everything has quietly undone the
 * whole design.
 */
export function venuePagingAlerts(alerts: readonly VenueAlert[]): VenueAlert[] {
  return alerts.filter((alert) => alert.severity === 'page');
}
