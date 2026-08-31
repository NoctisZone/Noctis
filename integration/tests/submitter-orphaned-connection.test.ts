// Constructing a submitter and never using it must not print to stderr.
//
// WHY THIS EXISTS
// Every submitter opens a Blockfrost connection in its constructor and keeps
// the promise, which nothing awaits until a method runs. A CLI that builds one
// and then fails before calling a method — a missing field, a malformed
// argument — leaves that rejection with no handler. Node then prints a stack
// trace to stderr AFTER the real {"error": "..."} has already gone to stdout.
//
// The output contract survived that: stdout was correct and the exit code was
// 1. What did not survive was the reading of it. A human sees a crash beside a
// correct error message and reasonably concludes something worse happened, and
// that is the whole cost of the defect.
//
// Deliberately NOT mocking @lucid-evolution/lucid: the property under test is
// what the real constructor does with a real failing connection, and a mock
// that resolves cannot fail to be handled.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StakingSubmitter } from '../staking-submitter.js';
import { LucidTierBCurveSubmitter } from '../tier-b-curve-submitter.js';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli');

/** Port 9 is discard; Node rejects it outright, so the failure is immediate. */
const UNREACHABLE = 'http://127.0.0.1:9/api';

const LAUNCH_ID_HEX = 'aa'.repeat(28);
const THREAD_POLICY = 'cc'.repeat(28);

function collectUnhandled(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  return { seen, stop: () => process.off('unhandledRejection', onUnhandled) };
}

/** Long enough for the connection to fail and for Node to decide it is unhandled. */
const settle = () => new Promise((r) => setTimeout(r, 150));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('a submitter that is constructed but never used', () => {
  it('does not report an unhandled rejection when its connection fails', async () => {
    const c = collectUnhandled();
    stop = c.stop;

    // Built, then abandoned — exactly what a CLI does when the request turns
    // out to be invalid after the submitter already exists.
    new StakingSubmitter({
      blockfrostProjectId: 'x',
      blockfrostUrl: UNREACHABLE,
      network: 'Preprod',
      stakingPoolScriptCbor: '590000',
      launchIdHex: LAUNCH_ID_HEX,
      threadNftPolicyId: THREAD_POLICY,
    });

    await settle();
    expect(c.seen).toEqual([]);
  });

  it('does not report one for the Cardano Launch curve submitter either', async () => {
    // Checked separately rather than assumed from the one above: each
    // submitter attaches its own handler, so one of them missing it is exactly
    // the regression worth catching.
    const c = collectUnhandled();
    stop = c.stop;

    new LucidTierBCurveSubmitter({
      blockfrostProjectId: 'x',
      blockfrostUrl: UNREACHABLE,
      network: 'Preprod',
      compiledScriptCbor: '590000',
      launchIdHex: LAUNCH_ID_HEX,
      threadNftPolicyId: THREAD_POLICY,
    });

    await settle();
    expect(c.seen).toEqual([]);
  });

  it('still surfaces the real error to a caller that does use it', async () => {
    // The point of attaching a no-op handler is that it marks the rejection
    // handled without consuming it. A submitter that swallowed its connection
    // failure would be far worse than the stderr noise this replaced.
    const submitter = new StakingSubmitter({
      blockfrostProjectId: 'x',
      blockfrostUrl: UNREACHABLE,
      network: 'Preprod',
      stakingPoolScriptCbor: '590000',
      launchIdHex: LAUNCH_ID_HEX,
      threadNftPolicyId: THREAD_POLICY,
    });

    // Matched loosely across Node versions but tightly enough to exclude a
    // validation error thrown before the connection is ever attempted — which
    // is the way this assertion could otherwise pass while the property it
    // names had stopped holding.
    await expect(submitter.readPoolDatum()).rejects.toThrow(/fetch failed|ECONNREFUSED|connect/i);
  });
});

// The other half of the fix, which the runtime tests above cannot observe: the
// action CLIs no longer BUILD a submitter until an action is about to use one.
// The handler attached above makes a stray rejection quiet; this keeps an
// invalid request from reaching the network in the first place.
describe('action CLIs construct their submitter lazily', () => {
  const ACTION_CLIS = ['stake-action.ts', 'tier-b-curve-action.ts', 'token-metadata-action.ts'];
  /** An eager `const submitter = new X({` above the dispatch, which is the shape being refused. */
  const EAGER = /\n\s*const submitter = new [A-Z]/;

  it.each(ACTION_CLIS)('%s builds its submitter behind a call, not before the switch', (name) => {
    const source = readFileSync(join(CLI_DIR, name), 'utf8');
    // An eager `const submitter = new X({` sits above the dispatch and runs
    // for every request, valid or not. The lazy form is a factory the cases
    // call after their own field checks have passed.
    expect(source, `${name} constructs its submitter eagerly`).not.toMatch(EAGER);
    expect(source, `${name} has no lazy submitter factory`).toMatch(/const submitter = \(\): [A-Za-z]+ =>/);
  });

  it('the scan would notice an eager construction (it is not matching nothing)', () => {
    // Without this, the assertions above pass vacuously the day the shape
    // changes — the failure mode that makes a source scan worse than no test.
    expect('\n  const submitter = new StakingSubmitter({').toMatch(EAGER);
  });
});
