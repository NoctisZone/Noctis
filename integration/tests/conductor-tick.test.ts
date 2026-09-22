import { describe, expect, it } from 'vitest';
import { DarkVeilState, LaunchPhase } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { type ConductorTickInput, describeTick, runConductorTick } from '../conductor-tick.js';
import type { DarkVeilSnapshot } from '../midnight-public-state.js';
import { SubmissionGate } from '../submission-gate.js';
import type { BankedJobResult } from '../submission-outcome.js';

const REG_OPEN = 1_000_000n;
const REG_CLOSE = REG_OPEN + 165_600n;
const BUY_OPEN = REG_CLOSE + 7_200n;
const BUY_CLOSE = BUY_OPEN + 86_400n;
const ZERO = '00'.repeat(32);

function snapshot(over: Partial<DarkVeilSnapshot> = {}): DarkVeilSnapshot {
  return {
    phase: LaunchPhase.DarkVeil,
    dvState: DarkVeilState.Inactive,
    dvFailed: false,
    dvPrice: 90n,
    dvAllocation: 150_000_000n,
    baseSlot: 0n,
    registrationCount: 0n,
    totalTokensCommitted: 0n,
    totalRaisedCommitted: 0n,
    allowlistRootHex: 'ab'.repeat(32),
    registrantRootHex: ZERO,
    pendingRegistrantRootHex: ZERO,
    settlementFinalized: false,
    fairLaunchCert: {} as DarkVeilSnapshot['fairLaunchCert'],
    schedule: {
      registrationOpenTime: REG_OPEN,
      registrationCloseTime: REG_CLOSE,
      buyingOpenTime: BUY_OPEN,
      buyingCloseTime: BUY_CLOSE,
      settlementDeadlineSeconds: 604_800n,
      minDvParticipants: 15n,
      darkVeilExpirySeconds: 604_800n,
    },
    ...over,
  };
}

function tickInput(over: Partial<ConductorTickInput> = {}, snap: Partial<DarkVeilSnapshot> = {}): ConductorTickInput {
  return {
    launchId: 'JINX',
    readSnapshot: async () => snapshot(snap),
    now: () => REG_OPEN + 1n,
    submit: async () => ({ stdout: '{"ok":true}', exitCode: 0 }),
    gate: new SubmissionGate(),
    fundingWalletKey: 'payer',
    ...over,
  };
}

describe('one turn of the conductor', () => {
  it('does nothing when nothing is due, and says what it is waiting for', async () => {
    const tick = await runConductorTick(tickInput({ now: () => REG_OPEN - 1n }));
    expect(tick.did).toBe('nothing');
    expect(describeTick('JINX', tick)).toMatch(/waiting until 1000000/);
  });

  it('submits the one action that is due', async () => {
    const seen: string[] = [];
    const tick = await runConductorTick(
      tickInput({
        submit: async (a) => {
          seen.push(a.kind);
          return { stdout: '{}', exitCode: 0 };
        },
      }),
    );
    expect(tick.did).toBe('submitted');
    expect(seen).toEqual(['startRegistration']);
  });

  it('acts at most once per turn, however much is due', async () => {
    // Each step changes what the next read says, so a turn that pressed on
    // would be acting against state it had just invalidated. The caller ticks
    // again and the planner re-derives.
    let calls = 0;
    await runConductorTick(
      tickInput({
        submit: async () => {
          calls += 1;
          return { stdout: '{}', exitCode: 0 };
        },
      }),
    );
    expect(calls).toBe(1);
  });

  it('runs the read and the plan for real in a dry run, and submits nothing', async () => {
    // The failure a dry run has to catch lives in the read and the plan. The
    // last time a driver broke a live window, a dry run would have caught it —
    // and one that skipped the read would have missed it too.
    let read = 0;
    let submitted = 0;
    const tick = await runConductorTick(
      tickInput({
        dryRun: true,
        readSnapshot: async () => {
          read += 1;
          return snapshot();
        },
        submit: async () => {
          submitted += 1;
          return { exitCode: 0 };
        },
      }),
    );
    expect(read).toBe(1);
    expect(submitted).toBe(0);
    expect(tick.did).toBe('planned');
    expect(describeTick('JINX', tick)).toMatch(/DRY RUN.*startRegistration/);
  });

  it('reports an action it cannot build rather than calling the launch up to date', async () => {
    // A launch waiting on a registrant root looks, from the chain, exactly
    // like one that is simply early. Silence here is how a launch stalls with
    // nobody noticing.
    const tick = await runConductorTick(
      tickInput(
        { now: () => REG_CLOSE + 1n, canSupplyOffChainInput: () => false },
        {
          dvState: DarkVeilState.Registration,
          registrationCount: 20n,
        },
      ),
    );
    expect(tick.did).toBe('blocked');
    expect(describeTick('JINX', tick)).toMatch(/BLOCKED.*publishRegistrantRoot/);
  });

  it('classifies a rejection from the banked stderr and schedules a retry', async () => {
    const rejected: BankedJobResult = {
      stderr: '1010: Invalid Transaction: Custom error: 170',
      exitCode: 1,
    };
    const tick = await runConductorTick(tickInput({ submit: async () => rejected }));
    expect(tick.did).toBe('failed');
    expect(tick.did === 'failed' && tick.outcome.disposition).toBe('retry');
    expect(tick.did === 'failed' && tick.retryInMs).toBeGreaterThan(0);
    expect(describeTick('JINX', tick)).toMatch(/refused.*retrying in/);
  });

  it('refuses to schedule a retry for something a human has to look at', async () => {
    const tick = await runConductorTick(
      tickInput({ submit: async () => ({ stderr: 'Custom error: 117', exitCode: 1 }) }),
    );
    expect(tick.did === 'failed' && tick.retryInMs).toBeNull();
    expect(describeTick('JINX', tick)).toMatch(/needs an operator/);
  });

  it('does not read a stopped child as a failure to send again', async () => {
    // It may have submitted before it was stopped, so this is the one case
    // where a retry doubles a transaction rather than wasting one.
    const tick = await runConductorTick(
      tickInput({ submit: async () => ({ stderr: '', timedOut: true, exitCode: 124 }) }),
    );
    expect(tick.did === 'failed' && tick.retryInMs).toBeNull();
  });

  it('treats a stopped child as stopped even if its exit code says otherwise', async () => {
    // The shared runner pairs timedOut with 124, so the two normally agree and
    // either alone would do. They are checked separately because a caller that
    // banks its results differently would otherwise have a stopped child read
    // as a clean success — which is the reading that resubmits a transaction
    // that may already have landed.
    const tick = await runConductorTick(
      tickInput({ submit: async () => ({ stdout: '', timedOut: true, exitCode: 0 }) }),
    );
    expect(tick.did).toBe('failed');
    expect(tick.did === 'failed' && tick.retryInMs).toBeNull();
  });

  it('does not mistake ordinary progress on stderr for a rejection', async () => {
    // CLIs write progress to stderr as a matter of course. Treating that as
    // failure would classify every successful run as a failed one.
    const tick = await runConductorTick(
      tickInput({ submit: async () => ({ stdout: '{"ok":true}', stderr: 'waiting for the wallet\n', exitCode: 0 }) }),
    );
    expect(tick.did).toBe('submitted');
  });

  it('puts its submission through the gate', async () => {
    // Otherwise two launches paid by one wallet collide, which is the failure
    // the gate exists for and which costs a full prove each time.
    const gate = new SubmissionGate();
    let concurrent = 0;
    let peak = 0;
    const run = () =>
      runConductorTick(
        tickInput({
          gate,
          submit: async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await new Promise((r) => setTimeout(r, 20));
            concurrent -= 1;
            return { exitCode: 0 };
          },
        }),
      );
    await Promise.all([run(), run(), run()]);
    expect(peak).toBe(1);
  });

  it('lets a read failure through, because a turn cannot proceed past it', async () => {
    // Everything else here is a state to report and tick again from. A read
    // that failed is the one thing that is genuinely a fault.
    await expect(
      runConductorTick(
        tickInput({
          readSnapshot: async () => {
            throw new Error('indexer unreachable');
          },
        }),
      ),
    ).rejects.toThrow('indexer unreachable');
  });
});
