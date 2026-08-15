import assert from 'node:assert/strict';
import test from 'node:test';
import { CoalescingScheduler } from './coalescingScheduler';

test('coalesces overlapping requests into one follow-up pass', async () => {
  const releases: Array<(value: string) => void> = [];
  const triggers: string[] = [];
  let active = 0;
  let maxActive = 0;
  const scheduler = new CoalescingScheduler<string>(
    (trigger) =>
      new Promise((resolve) => {
        triggers.push(trigger);
        active++;
        maxActive = Math.max(maxActive, active);
        releases.push((value) => {
          active--;
          resolve(value);
        });
      }),
  );

  const first = scheduler.request('boot');
  await new Promise((resolve) => setImmediate(resolve));
  const second = scheduler.request('stats');
  const third = scheduler.request('periodic');
  assert.equal(scheduler.busy, true);
  assert.deepEqual(triggers, ['boot']);

  releases[0]('first');
  assert.equal(await first, 'first');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(triggers, ['boot', 'periodic,stats']);
  releases[1]('follow-up');

  assert.deepEqual(await Promise.all([second, third]), ['follow-up', 'follow-up']);
  assert.equal(maxActive, 1);
  assert.equal(scheduler.busy, false);
});

test('a failed pass rejects only its own waiters and still runs the coalesced pass', async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const scheduler = new CoalescingScheduler<number>(async () => {
    calls++;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      throw new Error('boom');
    }
    return 2;
  });

  const first = scheduler.request('first');
  await new Promise((resolve) => setImmediate(resolve));
  const next = scheduler.request('retry');
  releaseFirst();

  await assert.rejects(first, /boom/);
  assert.equal(await next, 2);
  assert.equal(calls, 2);
});
