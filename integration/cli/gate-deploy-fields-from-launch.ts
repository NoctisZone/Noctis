// ============================================================================
// Noctis Zone — read a launch's record and print the gate deploy's fields
// ============================================================================
// The eligibility gate is sealed with a schedule, a launch id and a creator
// identity. All three already live on the launch record the site serves, so
// this reads them from there rather than having anyone type them: the
// schedule the page counts down from is the schedule the contract enforces,
// by construction. See gate-deploy-fields.ts for the mapping.
//
// Reads nothing secret and writes nothing: the two routes it calls are the
// public ones, and the output is what a deploy input's record-held fields
// should say. Merge it over the secrets and supply figures the record cannot
// know, then run the deploy.
//
// Input, one JSON object on stdin — EITHER
//   {"siteUrl":"https://noctis.zone","slug":"jinx"}
//     fetches /wp-json/np/v1/launches/<slug> and .../creator-midnight-key
// OR
//   {"record":{...},"creatorKey":{...}}
//     the same two answers, already in hand (creatorKey optional)
//
// Output: {"slug","siteUrl"?, ...GateDeployFields} or {"error"}.
// ============================================================================

import {
  type CreatorKeyRecord,
  gateDeployFieldsFromLaunchRecord,
  type LaunchScheduleRecord,
} from '../gate-deploy-fields.js';
import { parseJsonStdin, readStdin } from './cli-io.js';

interface Input {
  siteUrl?: string;
  slug?: string;
  record?: LaunchScheduleRecord & { slug?: string };
  creatorKey?: CreatorKeyRecord;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());

  let record: LaunchScheduleRecord & { slug?: string };
  let creatorKey: CreatorKeyRecord | undefined;
  let slug: string;
  let siteUrl: string | undefined;

  if (input.record) {
    record = input.record;
    creatorKey = input.creatorKey;
    slug = String(record.slug ?? input.slug ?? '');
  } else {
    if (!input.siteUrl || !input.slug) throw new Error('Give either {siteUrl, slug} or {record, creatorKey}.');
    if (!/^[a-z0-9-]+$/.test(input.slug))
      throw new Error(`slug must be lowercase letters, digits and dashes, got ${JSON.stringify(input.slug)}`);
    siteUrl = input.siteUrl.replace(/\/+$/, '');
    slug = input.slug;
    const base = `${siteUrl}/wp-json/np/v1/launches/${slug}`;
    const launch = (await fetchJson(base)) as { ok?: boolean; launch?: LaunchScheduleRecord };
    if (!launch?.launch) throw new Error(`${base} returned no launch`);
    record = { slug, ...launch.launch };
    creatorKey = (await fetchJson(`${base}/creator-midnight-key`)) as CreatorKeyRecord;
  }

  const fields = gateDeployFieldsFromLaunchRecord(record, creatorKey, Math.floor(Date.now() / 1000));
  process.stdout.write(JSON.stringify({ slug, ...(siteUrl ? { siteUrl } : {}), ...fields }));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  // Set rather than exit: a fetch that just failed may still hold a handle,
  // and exiting under it trips a libuv assertion on Windows.
  process.exitCode = 1;
});
