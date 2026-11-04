// A failed refresh is retried soon (30 s, 60 s, then every 120 s), never
// after the long fallback, and nothing in the loop may end the watcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInfo, fetchTasks } from '../lib/scheduler.mjs';
import { TASKS } from './helpers.mjs';
import { retryDelay, runWatcher } from '../lib/watch.mjs';
import { flush, memoryFiles, toastDeps } from './watch-helpers.mjs';

const at = (s) => new Date(`2026-11-04T${s}`);
const settle = async () => { for (let i = 0; i < 12; i++) await flush(); };
const LIST = /Get-ScheduledTask \|/;

// Makes the next `n` scheduler listings throw the transient error.
function failList(d, n) {
  const orig = d.run;
  const state = { left: n, calls: 0 };
  d.run = async (script) => {
    if (LIST.test(script)) {
      state.calls++;
      if (state.left-- > 0) throw new Error('PowerShell reported an error: One or more errors occurred.');
    }
    return orig(script);
  };
  return state;
}

// Moves the clock to `time` and fires the one pending timer step.
async function wake(d, time) {
  d.clock.now = at(time);
  d.timers.pending.shift().fn();
  await settle();
}

test('retry delays: 30 s, 60 s, then 120 s for good', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(retryDelay), [30000, 60000, 120000, 120000, 120000]);
});

test('watcher: two failed refreshes retry after 30 s and 60 s, then one recovery line, and no line for a plain success', async () => {
  const files = memoryFiles();
  const d = toastDeps({ files, clock: { now: at('12:00:00') } });
  const calls = failList(d, 2);
  let stop;
  const done = runWatcher(d, { onStart: (s) => { stop = s; } });
  await settle();
  assert.equal(d.timers.pending.length, 1);
  assert.equal(d.timers.pending[0].ms, 30000, 'first retry after 30 seconds, not the 30 minute fallback');
  await wake(d, '12:00:30');
  assert.equal(d.timers.pending[0].ms, 60000, 'second retry after 60 seconds');
  await wake(d, '12:01:30');
  assert.equal(calls.calls, 3);
  const log = files.read('watch.log');
  assert.match(log, /refresh failed \(1 in a row\): PowerShell reported an error: One or more errors occurred\.; next retry at 12:00:30/);
  assert.match(log, /refresh failed \(2 in a row\).*next retry at 12:01:30/);
  assert.equal(log.match(/refresh recovered after 2 failures/g).length, 1);
  assert.ok(d.timers.pending[0].ms <= 60000);
  await wake(d, '12:02:30');
  assert.equal(files.read('watch.log').match(/recovered/g).length, 1, 'later successes are not logged');
  stop();
  assert.equal(await done, 0);
});

test('watcher: the retry stays at 120 s while failures continue', async () => {
  const d = toastDeps({ clock: { now: at('12:00:00') } });
  failList(d, 99);
  let stop;
  const done = runWatcher(d, { onStart: (s) => { stop = s; } });
  await settle();
  const seen = [d.timers.pending[0].ms];
  for (const t of ['12:00:30', '12:01:30', '12:03:30', '12:05:30']) { await wake(d, t); seen.push(d.timers.pending[0].ms); }
  assert.deepEqual(seen, [30000, 60000, 60000, 60000, 60000], 'a timer step is at most a minute; the target is what grows');
  stop();
  await done;
});

test('watcher: a failure while a card shows Running still retries within two minutes', async () => {
  const tasks = TASKS.map((t) => (t.name === 'Report sync' ? { ...t, state: 'Running' } : t));
  const d = toastDeps({ tasks, clock: { now: at('17:30:00') } });
  const calls = failList(d, 0);
  let stop;
  const done = runWatcher(d, { onStart: (s) => { stop = s; } });
  await settle();
  assert.equal(d.timers.pending[0].ms, 60000);
  calls.left = 1;
  await wake(d, '17:31:00');
  await wake(d, '17:32:00');
  assert.equal(calls.calls, 2, 'the refresh at the 2 minute mark failed');
  assert.equal(d.timers.pending[0].ms, 30000, 'retry after 30 seconds, not 30 minutes');
  stop();
  await done;
});

test('watcher: an unexpected exception in the loop is logged and retried, and the watcher keeps running', async () => {
  const files = memoryFiles();
  const d = toastDeps({ files, clock: { now: at('12:00:00') } });
  const exists = files.exists;
  let boom = true;
  files.exists = (n) => { if (boom && n === 'watch.stop') { boom = false; throw new Error('disk gone'); } return exists(n); };
  let stop;
  const done = runWatcher(d, { onStart: (s) => { stop = s; } });
  await settle();
  assert.match(files.read('watch.log'), /watcher loop failed \(1 in a row\): disk gone; next retry at 12:00:30/);
  assert.equal(d.timers.pending[0].ms, 30000);
  await wake(d, '12:00:30');
  assert.match(files.read('watch.log'), /refresh recovered after 1 failures/);
  assert.ok(files.exists('watch.pid'), 'still running');
  stop();
  assert.equal(await done, 0);
});

test('PowerShell scripts: one task that errors is skipped, while the listing itself stays strict', async () => {
  const scripts = [];
  const run = async (s) => { scripts.push(s); return '[]'; };
  await fetchTasks(run);
  await fetchInfo(run, [{ path: '\\', name: 'x' }]);
  const [list, info] = scripts;
  assert.match(list, /\$out = @\(Get-ScheduledTask \| ForEach-Object \{/, 'the enumeration has no SilentlyContinue');
  assert.match(list, /try \{ \[pscustomobject\][\s\S]*\} catch \{ \}/, 'a task that fails to project is skipped');
  assert.match(info, /Get-ScheduledTaskInfo [^\n]*-ErrorAction SilentlyContinue/);
  assert.match(info, /catch \{ \}/);
});
