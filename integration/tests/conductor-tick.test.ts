import { describe, expect, it } from 'vitest';
import { DarkVeilState, LaunchPhase } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { type ConductorTickInput, describeTick, runConductorTick } from '../conductor-tick.js';
import type { DarkVeilSnapshot } from '../midnight-public-state.js';
import {
  DEFAULT_REHEARSAL_TTL_MS,
  type RehearsalEntry,
  type RehearsalLog,
  recallFrom,
  rehearsalNotRequired,
} from '../rehearsal-log.js';
import { SubmissionGate } from '../submission-gate.js';
import type { BankedJobResult } from '../submission-outcome.js';

const REG_OPEN = 1_000_000n;
const REG_CLOSE = REG_OPEN + 165_600n;
const BUY_OPEN = REG_CLOSE + 7_200n;
const BUY_CLOSE = BUY_OPEN + 86_400n;
const ZERO = '00'.repeat(32);
const GATE = '0200deadbeef';

/**
 * A rehearsal log held in memory, for the tests that are about the
 * precondition.
 *
 * Deliberately not shipped alongside the file-backed one: a rehearsal that
 * lives only inside the process about to act is not a rehearsal, because the
 * whole point is that somebody took one earlier and the code that is about to
 * run was the code that took it.
 */
function memoryLog(seed: RehearsalEntry[] = []): RehearsalLog & { entries: RehearsalEntry[] } {
  const entries = [...seed];
  return {
    entries,
    record: (e) => {
      entries.push(e);
    },
    recall: (q) => recallFrom(entries, q, DEFAULT_REHEARSAL_TTL_MS),
  };
}

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
    contractAddress: GATE,
    readSnapshot: async () => snapshot(snap),
    now: () => REG_OPEN + 1n,
    submit: async () => ({ stdout: '{"ok":true}', exitCode: 0 }),
    gate: new SubmissionGate(),
    fundingWalletKey: 'payer',
    // These cases are about what a turn does, not about the precondition,
    // which has its own block below. Waiving it here is the named call rather
    // than an omission, which is the whole reason the field is required.
    rehearsal: rehearsalNotRequired(),
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

  it('schedules a fresh read, not a stop, when the node’s reply could not be decoded', async () => {
    // Seen live: the transition had landed, the SDK could not decode the
    // node's reply, and the tick reported "refused, needs an operator". The
    // next tick's read is the answer, so that is what gets scheduled.
    const lostReceipt: BankedJobResult = {
      stdout:
        '{"ok":false,"error":"Transaction submission error <- Failed to parse result provided by node <- { readonly blockNumber: BN }"}',
      stderr: 'waiting for the wallet to catch up to the chain head\n',
      exitCode: 1,
    };
    const tick = await runConductorTick(tickInput({ submit: async () => lostReceipt }));
    expect(tick.did).toBe('failed');
    expect(tick.did === 'failed' && tick.outcome.disposition).toBe('replan');
    expect(tick.did === 'failed' && tick.retryInMs).toBeGreaterThan(0);
    const line = describeTick('JINX', tick);
    expect(line).toMatch(/needs a fresh read.*re-reading in/);
    expect(line).not.toMatch(/was refused/);
  });

  it('schedules a fresh read on a stale-view refusal rather than stopping', async () => {
    const tick = await runConductorTick(
      tickInput({ submit: async () => ({ stderr: '1010: Invalid Transaction: Custom error: 104', exitCode: 1 }) }),
    );
    expect(tick.did === 'failed' && tick.outcome.disposition).toBe('replan');
    expect(tick.did === 'failed' && tick.retryInMs).toBeGreaterThan(0);
  });

  it('waits on the indexer, then reads, when the action died in an outage', async () => {
    const tick = await runConductorTick(
      tickInput({
        submit: async () => ({ stderr: "Wallet.Sync: [object ErrorEvent] {\n  _tag: 'Wallet.Sync'\n}", exitCode: 1 }),
      }),
    );
    expect(tick.did === 'failed' && tick.outcome.disposition).toBe('wait-indexer');
    expect(describeTick('JINX', tick)).toMatch(/waiting on the indexer.*re-reading in/);
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

  it('does not submit a transition nobody has rehearsed', async () => {
    // The failure this exists for is a runner that is wrong in a way only a
    // real read and a real plan would show, discovered inside a one-way
    // window on a published schedule.
    let submitted = 0;
    const tick = await runConductorTick(
      tickInput({
        rehearsal: memoryLog(),
        submit: async () => {
          submitted += 1;
          return { exitCode: 0 };
        },
      }),
    );
    expect(tick.did).toBe('unrehearsed');
    expect(submitted).toBe(0);
    expect(describeTick('JINX', tick)).toMatch(/NOT REHEARSED.*dry run of startRegistration/);
  });

  it('submits once the same transition has been rehearsed from the same state', async () => {
    const rehearsal = memoryLog();
    const dry = await runConductorTick(tickInput({ rehearsal, dryRun: true }));
    expect(dry.did).toBe('planned');

    const live = await runConductorTick(tickInput({ rehearsal }));
    expect(live.did).toBe('submitted');
  });

  it('banks the state the plan was made FROM, not the one it leads to', async () => {
    // A live tick matches on it, so a rehearsal taken from one lifecycle
    // position never clears the same transition reached from another.
    const rehearsal = memoryLog();
    await runConductorTick(tickInput({ rehearsal, dryRun: true }));
    expect(rehearsal.entries[0]).toMatchObject({
      contractAddress: GATE,
      action: 'startRegistration',
      dvState: DarkVeilState.Inactive,
    });
  });

  it('does not let a rehearsal of one launch clear a transition on another', async () => {
    const rehearsal = memoryLog();
    await runConductorTick(tickInput({ rehearsal, dryRun: true }));
    const live = await runConductorTick(tickInput({ rehearsal, contractAddress: '0200somewhereelse' }));
    expect(live.did).toBe('unrehearsed');
  });

  it('records the clock a dry run planned against separately from when it ran', async () => {
    // Moving the clock forward against a real read is the only way to
    // rehearse a window before reaching it. Dating the receipt by the moved
    // clock would let it clear itself for as long as the move was large.
    const rehearsal = memoryLog();
    await runConductorTick(
      tickInput({ rehearsal, dryRun: true, now: () => 9_000_000n, nowMs: () => 1_700_000_000_000 }),
    );
    expect(rehearsal.entries[0].plannedForSeconds).toBe('9000000');
    expect(rehearsal.entries[0].rehearsedAtMs).toBe(1_700_000_000_000);
  });

  it('fails a dry run whose receipt did not land, rather than reporting it clear', async () => {
    // A dry run that quietly banked nothing is worse than no dry run: the
    // operator believes they are cleared for a window they are not.
    await expect(
      runConductorTick(
        tickInput({
          dryRun: true,
          rehearsal: {
            record: () => {
              throw new Error('read-only filesystem');
            },
            recall: () => ({ rehearsed: false, why: 'nothing banked' }),
          },
        }),
      ),
    ).rejects.toThrow('read-only filesystem');
  });

  it('banks nothing for a transition it could not build in the first place', async () => {
    // Rehearsing without the inputs a live run would use proves nothing about
    // the live run, so a blocked dry run must not clear anything.
    const rehearsal = memoryLog();
    const tick = await runConductorTick(
      tickInput(
        { rehearsal, dryRun: true, now: () => REG_CLOSE + 1n, canSupplyOffChainInput: () => false },
        { dvState: DarkVeilState.Registration, registrationCount: 20n },
      ),
    );
    expect(tick.did).toBe('blocked');
    expect(rehearsal.entries).toHaveLength(0);
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
