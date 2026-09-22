// ============================================================================
// Noctis Zone — the eligibility gate's deploy fields, read off the launch record
// ============================================================================
// A launch's DarkVeil schedule is written to its record when the launch is
// created, and the site displays that record. The gate contract is deployed
// with its own copy of the same schedule, sealed. Nothing used to connect the
// two: the deploy's clock fields were typed by hand from a calendar, so the
// record and the contract could disagree and nothing would say so — the
// conductor plans from the chain, the page counts down from the record.
//
// This module derives the deploy's fields FROM the record, so the contract is
// sealed with the schedule the site already shows. It also carries the two
// other record-held values a deploy needs — the launch id the mint produced,
// and the creator identity the creator bound — so the deploy input has one
// source for everything the record knows, and hand-typing is left for the
// values the record cannot know (secrets, supply, price).
//
// The mapping, in the deploy's own terms (eligibility-gate-deploy-args.ts):
//   registrationCloseTime      = the record's registration FREEZE (T-2h),
//                                because that is the instant registration
//                                closes; buying opens a freeze window later
//   registrationWindowSeconds  = freeze - opens        (46h on the product schedule)
//   freezeWindowSeconds        = buying opens - freeze (2h)
//   buyingWindowSeconds        = buying closes - opens (24h)
//
// A record the wizard made therefore maps exactly onto the deploy's own
// defaults; a rehearsal record with compressed windows maps onto compressed
// windows, and is noted as such rather than refused.
// ============================================================================

/** The subset of the public launch record this needs. Timestamps arrive as
 *  ISO strings from the site; seconds and milliseconds are accepted too. */
export interface LaunchScheduleRecord {
  launch_id_hex?: string;
  dv_registration_opens_ts?: string | number;
  dv_registration_freezes_ts?: string | number;
  dv_buying_opens_ts?: string | number;
  dv_buying_closes_ts?: string | number;
}

/** The launch's creator-identity route, as the site answers it. */
export interface CreatorKeyRecord {
  launch_id_hex?: string;
  /** Empty until the creator has bound one. */
  midnight_key?: string | null;
  /** True once the record names a deployed contract. */
  sealed?: boolean;
}

export interface GateDeployFields {
  launchIdHex: string;
  /** Absent when the record holds no creator identity yet. */
  creatorPubKeyHex?: string;
  /** Unix seconds, as strings, the way the deploy input carries them. */
  registrationCloseTime: string;
  registrationWindowSeconds: string;
  freezeWindowSeconds: string;
  buyingWindowSeconds: string;
  /** Things a deployer should read before spending: never errors, which throw. */
  notes: string[];
}

/** The product's DarkVeil windows, in seconds: T-48h to T-2h, a 2h freeze, 24h buying. */
export const PRODUCT_WINDOWS_SECONDS = {
  registration: 46 * 3600,
  freeze: 2 * 3600,
  buying: 24 * 3600,
} as const;

/** The crossing between the two clocks: anything at or past this is milliseconds. */
const MS_BOUNDARY = 1_000_000_000_000;

/**
 * A record timestamp as unix seconds. The site writes an ISO date with a Z; the
 * meta it derived from was milliseconds; a hand-edited record may hold
 * seconds. All three are one instant, and each is recognised by shape rather
 * than by which field it came from.
 */
export function recordTimestampToSeconds(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${field}: expected a positive timestamp, got ${value}`);
    return value >= MS_BOUNDARY ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field}: the record has no value for it`);
  }
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${field}: expected a positive timestamp, got ${text}`);
    return n >= MS_BOUNDARY ? Math.floor(n / 1000) : n;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${field}: cannot read "${text}" as a date`);
  return Math.floor(ms / 1000);
}

function hours(seconds: number): string {
  const h = seconds / 3600;
  return Number.isInteger(h) ? `${h}h` : `${(seconds / 60).toFixed(0)}min`;
}

/**
 * Derive the deploy's record-held fields. Throws on anything a deploy could
 * not be sealed with; returns notes for anything a deployer should know.
 */
export function gateDeployFieldsFromLaunchRecord(
  record: LaunchScheduleRecord,
  creator?: CreatorKeyRecord,
  nowSeconds?: number,
): GateDeployFields {
  const launchIdHex = String(record.launch_id_hex ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(launchIdHex)) {
    throw new Error(
      `launch_id_hex: expected 64 hex characters (32 bytes) on the record, got ${JSON.stringify(record.launch_id_hex ?? '')}`,
    );
  }

  const opens = recordTimestampToSeconds(record.dv_registration_opens_ts, 'dv_registration_opens_ts');
  const freezes = recordTimestampToSeconds(record.dv_registration_freezes_ts, 'dv_registration_freezes_ts');
  const buyingOpens = recordTimestampToSeconds(record.dv_buying_opens_ts, 'dv_buying_opens_ts');
  const buyingCloses = recordTimestampToSeconds(record.dv_buying_closes_ts, 'dv_buying_closes_ts');

  const steps: [string, number][] = [
    ['dv_registration_opens_ts', opens],
    ['dv_registration_freezes_ts', freezes],
    ['dv_buying_opens_ts', buyingOpens],
    ['dv_buying_closes_ts', buyingCloses],
  ];
  for (let i = 1; i < steps.length; i++) {
    const [prevName, prev] = steps[i - 1];
    const [name, cur] = steps[i];
    if (cur <= prev) {
      throw new Error(
        `${name} (${cur}) must be later than ${prevName} (${prev}); the record's schedule is out of order`,
      );
    }
  }

  const registrationWindow = freezes - opens;
  const freezeWindow = buyingOpens - freezes;
  const buyingWindow = buyingCloses - buyingOpens;

  const notes: string[] = [];
  const p = PRODUCT_WINDOWS_SECONDS;
  if (registrationWindow !== p.registration || freezeWindow !== p.freeze || buyingWindow !== p.buying) {
    notes.push(
      `The record's windows are ${hours(registrationWindow)} / ${hours(freezeWindow)} / ${hours(buyingWindow)}, ` +
        `not the product's ${hours(p.registration)} / ${hours(p.freeze)} / ${hours(p.buying)}: a rehearsal schedule, sealed as written.`,
    );
  }
  if (nowSeconds !== undefined && freezes <= nowSeconds) {
    notes.push(
      `The record's registration already froze at ${freezes}, which is at or before now (${nowSeconds}); a contract sealed with it opens nothing.`,
    );
  }

  let creatorPubKeyHex: string | undefined;
  if (creator) {
    const creatorLaunch = String(creator.launch_id_hex ?? '').toLowerCase();
    if (creatorLaunch !== '' && creatorLaunch !== launchIdHex) {
      throw new Error(
        `The creator identity answered for launch ${creatorLaunch.slice(0, 12)}…, not ${launchIdHex.slice(0, 12)}…`,
      );
    }
    const key = String(creator.midnight_key ?? '').toLowerCase();
    if (key === '') {
      notes.push(
        'The record holds no creator identity yet: creatorPubKeyHex is absent, and a deploy has nothing to seal for it until the creator binds one.',
      );
    } else if (!/^[0-9a-f]{64}$/.test(key) || /^0+$/.test(key)) {
      throw new Error("The record's creator identity is not a 32-byte key");
    } else {
      creatorPubKeyHex = key;
    }
    if (creator.sealed) {
      notes.push(
        'The record already names a deployed contract: a deploy from these fields is a second contract for the same launch, and the record will have to be repointed at it.',
      );
    }
  }

  return {
    launchIdHex,
    ...(creatorPubKeyHex ? { creatorPubKeyHex } : {}),
    registrationCloseTime: String(freezes),
    registrationWindowSeconds: String(registrationWindow),
    freezeWindowSeconds: String(freezeWindow),
    buyingWindowSeconds: String(buyingWindow),
    notes,
  };
}
