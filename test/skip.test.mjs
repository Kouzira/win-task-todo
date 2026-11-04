import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { INFO, TASKS, fakeDeps } from './helpers.mjs';

const text = (d) => d.captured.out.join('\n');
const errText = (d) => d.captured.err.join('\n');
const kind = (w) => /(Register|Enable|Disable|Unregister|Start)-ScheduledTask/.exec(w.script)[1];

// A helper made before the translation: its name and description are in
// Vietnamese, and the tool must still recognise it by the marker alone.
const HELPER = {
  name: 'tasks bật lại Report sync', path: '\\', state: 'Ready', author: '', userId: 'alice', runLevel: 'Limited', logonType: 'Interactive',
  description: 'tasks-reenable:Report sync\nTạo bởi công cụ tasks: tự bật lại.',
  actions: [{ execute: 'conhost.exe', arguments: '--headless "C:\\Tools\\node.exe" "D:\\Projects\\win-task-todo\\tasks.mjs" on "Report sync" --yes', workingDirectory: '' }],
  triggers: [{ type: 'Time', enabled: true, startBoundary: '2026-11-04T17:21:00+07:00' }],
};
const disabled = (t) => ({ ...t, state: 'Disabled' });
const withSkipped = () => [...TASKS.map((t) => (t.name === '\Report sync' ? disabled(t) : t)), HELPER];

test('skip --dry-run prints the plan and writes nothing', async () => {
  const d = fakeDeps();
  assert.equal(await main(['skip', '\Report sync', '--dry-run'], d), 0);
  assert.match(text(d), /Skip the run of 2026-11-04 17:20 of Report sync\. The task will be turned off now and re-enabled at 17:21\./);
  assert.match(text(d), /--dry-run/);
  assert.equal(d.captured.writes.length, 0);
  assert.equal(d.captured.asked.length, 0);
});

test('skip asks y/N, an answer of no cancels', async () => {
  const d = fakeDeps({ answer: 'n' });
  assert.equal(await main(['skip', '\Report sync'], d), 1);
  assert.deepEqual(d.captured.asked, ['Skip this run? (y/N) ']);
  assert.equal(d.captured.writes.length, 0);
});

test('skip refuses: no upcoming run, task off, system task, helper task', async () => {
  const none = fakeDeps({ info: { ...INFO, '\\Report sync': { lastRun: null, nextRun: null, lastResult: null } } });
  assert.equal(await main(['skip', '\Report sync', '--yes'], none), 1);
  assert.match(errText(none), /no upcoming run/);
  const off = fakeDeps({ tasks: withSkipped() });
  assert.equal(await main(['skip', '\Report sync', '--yes'], off), 1);
  assert.match(errText(off), /is off/);
  const sys = fakeDeps();
  assert.equal(await main(['skip', 'StartCN', '--yes'], sys), 1);
  assert.match(errText(sys), /system \/ vendor/);
  const help = fakeDeps({ tasks: withSkipped() });
  assert.equal(await main(['skip', HELPER.name, '--yes'], help), 1);
  assert.match(errText(help), /helper task/);
  for (const d of [none, off, sys, help]) assert.equal(d.captured.writes.length, 0);
});

test('helper task: runs at next run + 1 minute, has the marker, runs hidden, deletes itself, catches up', async () => {
  const d = fakeDeps();
  assert.equal(await main(['skip', '\Report sync', '--yes'], d), 0);
  const w = d.captured.writes[0];
  assert.equal(kind(w), 'Register');
  assert.equal(w.data.name, 'task re-enable Report sync');
  assert.equal(w.data.at, '2026-11-04 17:21');
  assert.match(w.data.description, /^tasks-reenable:Report sync\n/);
  assert.doesNotMatch(w.data.description, /[^\x00-\x7f]/, 'new helpers are described in English');
  assert.equal(w.data.execute, 'conhost.exe');
  assert.equal(w.data.arguments, '--headless "C:\\Tools\\node.exe" "D:\\Projects\\win-task-todo\\tasks.mjs" on "Report sync" --yes');
  assert.match(w.script, /EndBoundary/);
  assert.match(w.script, /DeleteExpiredTaskAfter/);
  assert.match(w.script, /StartWhenAvailable/);
  assert.match(w.script, /-RunLevel Limited/);
  assert.ok(w.data.end > w.data.at);
});

test('skip creates the helper task first, then turns the task off', async () => {
  const d = fakeDeps();
  await main(['skip', '\Report sync', '--yes'], d);
  assert.deepEqual(d.captured.writes.map(kind), ['Register', 'Disable']);
  assert.equal(d.captured.writes[1].data.name, '\Report sync');
});

test('a failed helper task leaves the task on', async () => {
  const d = fakeDeps({ failOn: /Register-ScheduledTask/ });
  assert.equal(await main(['skip', '\Report sync', '--yes'], d), 1);
  assert.equal(d.captured.writes.length, 0);
  assert.match(errText(d), /was not turned off/);
});

test('a failed turn-off removes the helper task just created', async () => {
  const d = fakeDeps({ failOn: /Disable-ScheduledTask/ });
  assert.equal(await main(['skip', '\Report sync', '--yes'], d), 1);
  assert.deepEqual(d.captured.writes.map(kind), ['Register', 'Unregister']);
});

test('a 23:59 run is re-enabled on the next day', async () => {
  const d = fakeDeps({ info: { ...INFO, '\\Report sync': { lastRun: null, nextRun: '2026-11-04T23:59:00', lastResult: 0 } } });
  await main(['skip', '\Report sync', '--dry-run'], d);
  assert.match(text(d), /at 00:00 on 2026-11-05/);
});

test('unskip turns the task on and deletes the helper task', async () => {
  const d = fakeDeps({ tasks: withSkipped() });
  assert.equal(await main(['unskip', '\Report sync'], d), 0);
  assert.deepEqual(d.captured.writes.map(kind), ['Enable', 'Unregister']);
  assert.equal(d.captured.writes[1].data.name, HELPER.name);
});

test('unskip without a helper task says so and only turns the task on', async () => {
  const d = fakeDeps({ tasks: TASKS.map((t) => (t.name === '\Report sync' ? disabled(t) : t)) });
  assert.equal(await main(['unskip', '\Report sync'], d), 0);
  assert.deepEqual(d.captured.writes.map(kind), ['Enable']);
  assert.match(text(d), /No helper task/);
});

test('list: skipped state, helper tasks hidden, --all shows the Helper type', async () => {
  const d = fakeDeps({ tasks: withSkipped() });
  await main(['list'], d);
  assert.match(text(d), /Skipped 17:20, re-enabled at 17:21/);
  assert.doesNotMatch(text(d), /tasks bật lại|task re-enable/);
  const all = fakeDeps({ tasks: withSkipped() });
  await main(['list', '--all'], all);
  assert.match(text(all), /tasks bật lại.*Helper/);
});

test('list: a task still off after its re-enable time says it was not re-enabled', async () => {
  const d = fakeDeps({ tasks: withSkipped(), now: new Date('2026-11-04T18:00:00') });
  await main(['list'], d);
  assert.match(text(d), /Off \(not re-enabled yet\)/);
});

test('list: a task that is simply off stays Off', async () => {
  const d = fakeDeps({ tasks: TASKS.map((t) => (t.name === '\Report sync' ? disabled(t) : t)) });
  await main(['list'], d);
  assert.match(text(d), /\bOff\b/);
  assert.doesNotMatch(text(d), /Skipped|not re-enabled/);
});
