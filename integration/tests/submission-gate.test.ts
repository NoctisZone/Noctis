import { describe, expect, it } from 'vitest';
import { SubmissionGate, submitAll } from '../submission-gate.js';

/** Records when each submission was inside the gate, so overlap is observable. */
function tracker() {
  const running = new Map<string, number>();
  const maxConcurrent = new Map<string, number>();
  const order: string[] = [];
  return {
    order,
    maxConcurrent,
    run(key: string, label: string, ms: number) {
      return async () => {
        const now = (running.get(key) ?? 0) + 1;
        running.set(key, now);
        maxConcurrent.set(key, Math.max(maxConcurrent.get(key) ?? 0, now));
        order.push(label);
        await new Promise((resolve) => setTimeout(resolve, ms));
        running.set(key, (running.get(key) ?? 1) - 1);
        return label;
      };
    },
  };
}

describe('one submission at a time, per funding wallet', () => {
  it('never lets two from the same wallet overlap', async () => {
    // The measured failure: two registrations launched together, one refused at
    // submission after both had finished proving. The gate's whole job is that
    // this number is 1.
    const t = tracker();
    const gate = new SubmissionGate();
    await Promise.all([
      gate.submit('payer', t.run('payer', 'a', 30)),
      gate.submit('payer', t.run('payer', 'b', 30)),
      gate.submit('payer', t.run('payer', 'c', 30)),
    ]);
    expect(t.maxConcurrent.get('payer')).toBe(1);
    expect(t.order).toEqual(['a', 'b', 'c']);
  });

  it('lets different wallets run side by side', async () => {
    // The concurrency that must NOT be given away. A global lock would pass the
    // test above and fail this one, and a real launch — where fifteen people
    // pay for their own transactions — is entirely this case.
    const t = tracker();
    const gate = new SubmissionGate();
    const started = Date.now();
    await Promise.all([
      gate.submit('payer-1', t.run('payer-1', '1', 60)),
      gate.submit('payer-2', t.run('payer-2', '2', 60)),
      gate.submit('payer-3', t.run('payer-3', '3', 60)),
    ]);
    // Serialized these would take ~180ms; overlapped, ~60.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('serves a wallet in arrival order', async () => {
    // Without this a wallet under steady load can starve one submission
    // indefinitely, and the starved one is whichever registrant was unlucky —
    // a failure that looks like a bug in their registration rather than here.
    const t = tracker();
    const gate = new SubmissionGate();
    const labels = ['first', 'second', 'third', 'fourth'];
    await Promise.all(labels.map((label) => gate.submit('payer', t.run('payer', label, 5))));
    expect(t.order).toEqual(labels);
  });

  it('does not wedge a wallet when one submission fails', async () => {
    // A rejected submission has still finished with the node, so the next one
    // must not be held behind it. Getting this wrong strands every remaining
    // registrant behind the first failure.
    const gate = new SubmissionGate();
    const seen: string[] = [];
    const failed = gate.submit('payer', async () => {
      seen.push('doomed');
      throw new Error('node refused it');
    });
    const after = gate.submit('payer', async () => {
      seen.push('after');
      return 'ok';
    });
    await expect(failed).rejects.toThrow('node refused it');
    await expect(after).resolves.toBe('ok');
    expect(seen).toEqual(['doomed', 'after']);
  });

  it('reports a wait, so queueing is distinguishable from a slow chain', async () => {
    // A run that is slow because it is queueing looks exactly like one that is
    // slow because the chain is. Only this tells them apart.
    const waits: Array<{ key: string; queuedAhead: number }> = [];
    const gate = new SubmissionGate({ onWait: (r) => waits.push({ key: r.key, queuedAhead: r.queuedAhead }) });
    await Promise.all([
      gate.submit('payer', () => new Promise((r) => setTimeout(() => r('a'), 25))),
      gate.submit('payer', async () => 'b'),
      gate.submit('payer', async () => 'c'),
    ]);
    // The first waits for nobody; the other two do.
    expect(waits).toEqual([
      { key: 'payer', queuedAhead: 1 },
      { key: 'payer', queuedAhead: 2 },
    ]);
  });

  it('gives up waiting rather than queueing for ever, and says nothing was sent', async () => {
    const gate = new SubmissionGate({ maxWaitMs: 40 });
    const held = gate.submit('payer', () => new Promise((r) => setTimeout(() => r('slow'), 500)));
    await expect(gate.submit('payer', async () => 'queued')).rejects.toThrow(/Nothing was submitted/i);
    await expect(held).resolves.toBe('slow');
  });

  it('forgets a wallet once its queue drains', async () => {
    // A launch run touches a wallet per registrant; without this the map grows
    // one entry per wallet for the life of the process.
    const gate = new SubmissionGate();
    await gate.submit('payer', async () => 'done');
    expect(gate.depth('payer')).toBe(0);
  });

  it('drains a mixed batch, keeping contention out and concurrency in', async () => {
    const t = tracker();
    const gate = new SubmissionGate();
    const results = await submitAll(gate, [
      { key: 'p1', run: t.run('p1', 'p1-a', 20) },
      { key: 'p1', run: t.run('p1', 'p1-b', 20) },
      { key: 'p2', run: t.run('p2', 'p2-a', 20) },
      { key: 'p2', run: t.run('p2', 'p2-b', 20) },
    ]);
    expect(t.maxConcurrent.get('p1')).toBe(1);
    expect(t.maxConcurrent.get('p2')).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('reports a failure per item instead of losing the batch', async () => {
    // One registrant's rejection must not discard the other fourteen results,
    // each of which cost a real prove.
    const gate = new SubmissionGate();
    const results = await submitAll(gate, [
      { key: 'p1', run: async () => 'fine' },
      {
        key: 'p1',
        run: async () => {
          throw new Error('refused');
        },
      },
      { key: 'p2', run: async () => 'also fine' },
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});
