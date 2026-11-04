import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRow, timeLeft } from '../lib/ui-model.mjs';
import { render } from '../lib/ui-render.mjs';
import { applyResult, initialState, reduce } from '../lib/ui-reduce.mjs';
import { runEffect } from '../lib/ui-effects.mjs';
import { INFO, TASKS, fakeDeps } from './helpers.mjs';

const NOW = new Date('2026-11-04T12:00:00');
const kinds = (w) => /(Register|Enable|Disable|Unregister|Start)-ScheduledTask/.exec(w.script)[1];
const plain = (l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const row = (name, over = {}) => ({ name, kind: 'pending', status: 'Waiting, 5 h 20 min left', time: '17:20', schedule: 'Every weekday at 17:20', enabled: true, skipped: false, nextRun: '2026-11-04T17:20:00', ...over });
const sample = (over = {}) => ({
  ...initialState(NOW),
  loading: false,
  rows: [
    row('Report sync'),
    row('Daily backup', { kind: 'done', status: 'Done', time: '10:00', schedule: 'Every weekday at 10:00' }),
    row('Nightly cleanup', { kind: 'failed', status: 'Failed', time: '01:00', schedule: 'Every day at 01:00' }),
    row('Backup', { kind: 'skipped', status: 'Skipped 17:20, re-enabled at 17:21', skipped: true, enabled: false, time: '11-04 17:20' }),
  ],
  ...over,
});
const key = (name, ch = name) => ({ name, ch });

test('row states: Done, Failed, Waiting with time left, Off, No run today', () => {
  const none = fakeDeps().now();
  const mk = (task, info, all = [task]) => makeRow(task, info, all, NOW);
  const t = { ...TASKS[1] };
  assert.equal(mk(t, { lastRun: '2026-11-04T09:00:00', nextRun: '2026-11-05T09:00:00', lastResult: 0 }).status, 'Done');
  assert.equal(mk(t, { lastRun: '2026-11-04T09:00:00', nextRun: '2026-11-05T09:00:00', lastResult: 1 }).status, 'Failed at 09:00');
  assert.equal(mk(t, { lastRun: '2026-11-04T09:00:00', nextRun: '2026-11-05T09:00:00', lastResult: 1 }).time, '11-05 09:00');
  assert.equal(mk(t, INFO['\\Report sync']).status, 'Waiting, 5 h 20 min left');
  assert.equal(mk({ ...t, state: 'Disabled' }, {}).status, 'Off');
  assert.equal(mk(t, { lastRun: '2026-11-03T09:00:00', nextRun: '2026-11-05T09:00:00', lastResult: 0 }).status, 'No run today');
  assert.ok(none instanceof Date);
  assert.equal(timeLeft(NOW, { y: 2026, mo: 11, d: 4, h: 12, mi: 45 }), '45 min left');
  assert.equal(timeLeft(NOW, { y: 2026, mo: 11, d: 4, h: 14, mi: 0 }), '2 h left');
});

test('skipped state in the ui, and a helper task never enters the list', async () => {
  const helper = {
    name: 'task re-enable Report sync', path: '\\', state: 'Ready', description: 'tasks-reenable:Report sync\nCreated by the tasks tool',
    triggers: [{ type: 'Time', startBoundary: '2026-11-04T17:21:00+07:00' }], actions: [],
  };
  const off = TASKS.map((t) => (t.name === 'Report sync' ? { ...t, state: 'Disabled' } : t));
  const d = fakeDeps({ tasks: [...off, helper] });
  const res = await runEffect(d, { type: 'fetch' });
  assert.equal(res.kind, 'rows');
  assert.equal(res.rows.length, 3);
  const evening = res.rows.find((r) => r.name === 'Report sync');
  assert.equal(evening.status, 'Skipped 17:20, re-enabled at 17:21');
  assert.equal(evening.skipped, true);
  assert.equal(d.captured.writes.length, 0);
});

test('applyResult: a finished write shows its result and refreshes, keeping the selected row by name', () => {
  const done = applyResult(sample({ sel: 1 }), { kind: 'done', ok: true, lines: ['Turned off task "Daily backup".'] });
  assert.equal(done.state.mode, 'list');
  assert.equal(done.state.notice, 'Turned off task "Daily backup".');
  assert.deepEqual(done.effect, { type: 'fetch' });
  const rows = [row('Backup'), row('Daily backup')];
  const fresh = applyResult(sample({ sel: 1 }), { kind: 'rows', rows, now: NOW.toISOString() });
  assert.equal(fresh.state.sel, 1);
  assert.equal(fresh.state.loading, false);
});

test('effects call the command-line functions: a plan writes nothing, a write writes once', async () => {
  const d = fakeDeps();
  const plan = await runEffect(d, { type: 'plan-skip', name: 'Report sync' });
  assert.equal(plan.kind, 'plan');
  assert.match(plan.lines.join('\n'), /Skip the run of 2026-11-04 17:20/);
  assert.doesNotMatch(plan.lines.join('\n'), /dry-run/);
  const add = await runEffect(d, { type: 'plan-add', args: ['x', 'echo hi', 'daily 10:00'] });
  assert.equal(add.kind, 'plan');
  assert.match(add.lines.join('\n'), /Plan to create a task/);
  assert.equal(d.captured.writes.length, 0);
  assert.equal(d.captured.asked.length, 0);

  const skip = await runEffect(d, { type: 'skip', name: 'Report sync' });
  assert.equal(skip.kind, 'done');
  assert.deepEqual(d.captured.writes.map(kinds), ['Register', 'Disable']);
  await runEffect(d, { type: 'toggle', verb: 'on', name: 'Report sync' });
  await runEffect(d, { type: 'run', name: 'Report sync' });
  await runEffect(d, { type: 'delete', name: 'Report sync' });
  await runEffect(d, { type: 'add', args: ['x', 'echo hi', 'daily 10:00'] });
  assert.deepEqual(d.captured.writes.map(kinds), ['Register', 'Disable', 'Enable', 'Start', 'Unregister', 'Register']);
  assert.equal(d.captured.asked.length, 0);
});

test('effects refuse system tasks like the command line, and details use the same words as show', async () => {
  const d = fakeDeps();
  const res = await runEffect(d, { type: 'toggle', verb: 'off', name: 'StartCN' });
  assert.equal(res.ok, false);
  assert.match(res.lines.join('\n'), /system \/ vendor/);
  assert.equal(d.captured.writes.length, 0);
  const show = await runEffect(d, { type: 'details', name: 'Daily backup' });
  assert.equal(show.kind, 'panel');
  assert.match(show.lines.join('\n'), /Every weekday at 10:00/);
  const bad = await runEffect(fakeDeps({ failOn: /Get-ScheduledTask \|/ }), { type: 'fetch' });
  assert.equal(bad.kind, 'error');
});

test('task ui does not run when the output is not a terminal', async () => {
  const { main } = await import('../lib/cli.mjs');
  const d = fakeDeps();
  // Under the test runner stdin and stdout are pipes, so the guard answers.
  if (process.stdout.isTTY && process.stdin.isTTY) return;
  assert.equal(await main(['ui'], d), 1);
  assert.match(d.captured.err.join('\n'), /terminal/);
});
