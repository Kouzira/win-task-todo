import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { ASK_GROUP, GROUP, appIdOf, cardTag } from '../lib/toast.mjs';
import { INFO } from './helpers.mjs';
import { CHECK_MS, FALLBACK_MS, MIN_MS, STEP_MS, acquireLock, nextRefresh, nextWake, runWatcher } from '../lib/watch.mjs';
import { TASKS } from './helpers.mjs';
import { WATCHER, flush, memoryFiles, toastDeps } from './watch-helpers.mjs';

const at = (s) => new Date(`2026-11-04T${s}`);
const row = (name, nextRun, over = {}) => ({ name, nextRun, ...over });
const kind = (w) => /(Register|Enable|Disable|Unregister|Start)-ScheduledTask/.exec(w.script)[1];
const EVENING = cardTag({ path: '\\', name: 'Report sync' });
const WATCH_CMD = '"C:\\Tools\\node.exe" "D:\\Projects\\win-task-todo\\tasks.mjs" watch';

test('next wake-up: one minute after today\'s next run, the start of the next day, or 30 minutes', () => {
  const rows = [row('a', '2026-11-04T17:20:00'), row('b', '2026-11-04T12:10:00'), row('c', '2026-11-04T09:00:00'), row('d', '2026-11-05T01:00:00')];
  assert.equal(nextRefresh(rows, at('12:00:00')), at('12:11:00').getTime());
  assert.equal(nextRefresh(rows, at('12:20:00')), at('12:20:00').getTime() + FALLBACK_MS);
  assert.equal(nextRefresh([], at('23:50:00')), new Date('2026-11-05T00:00:00').getTime());
  assert.equal(nextRefresh([row('a', '2026-11-04T12:00:00')], at('12:00:10')), at('12:01:00').getTime());
  assert.equal(nextRefresh([row('a', '2026-11-04T12:00:00')], at('12:00:50')), at('12:00:50').getTime() + MIN_MS);
  assert.equal(nextRefresh([row('w', '2026-11-04T12:05:00', { watcher: true })], at('12:00:00')), at('12:30:00').getTime());
  assert.equal(nextRefresh([row('r', null, { kind: 'running' })], at('12:00:00')), at('12:02:00').getTime(), 'while running, look again after 2 minutes');
  assert.equal(nextRefresh([], at('12:00:00'), at('12:01:30').getTime()), at('12:01:31').getTime(), 'when a "Done" card leaves, refresh right after');
  assert.deepEqual(nextWake(at('14:00:00').getTime(), true, at('12:00:00')), { at: at('12:00:00').getTime() + CHECK_MS, kind: 'check' });
  assert.deepEqual(nextWake(at('12:03:00').getTime(), true, at('12:00:00')), { at: at('12:03:00').getTime(), kind: 'refresh' });
  assert.deepEqual(nextWake(at('14:00:00').getTime(), false, at('12:00:00')), { at: at('14:00:00').getTime(), kind: 'refresh' });
});

test('one-instance lock: a second copy is refused; a dead pid, a pid from the previous boot, or a pid that is not a watcher gets its old lock replaced', async () => {
  const me = { pid: 2, boot: 1000 };
  const sys = (alive, ours) => ({ isAlive: () => alive, isOurs: async () => ours });
  const held = (lock) => memoryFiles({ 'watch.pid': JSON.stringify(lock) });
  assert.equal((await acquireLock(memoryFiles(), me, sys(false, false))).ok, true);
  const busy = await acquireLock(held({ pid: 1, boot: 1000 }), me, sys(true, true));
  assert.deepEqual([busy.ok, busy.holder.pid], [false, 1]);
  for (const [lock, s, why] of [
    [{ pid: 1, boot: 1000 }, sys(false, true), 'dead pid'],
    [{ pid: 1, boot: 900 }, sys(true, true), 'previous boot'],
    [{ pid: 1, boot: 1000 }, sys(true, false), 'pid reused by another program'],
    [{ pid: 2, boot: 1000 }, sys(true, true), 'own pid'],
  ]) {
    const files = held(lock);
    assert.equal((await acquireLock(files, me, s)).ok, true, why);
    assert.equal(JSON.parse(files.read('watch.pid')).pid, 2);
  }
  assert.equal((await acquireLock(memoryFiles({ 'watch.pid': 'garbage' }), me, sys(true, true))).ok, true);
});

test('watcher: posts the cards at the start, sleeps in setTimeout steps, refreshes on waking; the stop file ends it cleanly', async () => {
  const files = memoryFiles();
  const info = { ...INFO, '\\Nightly cleanup': { lastRun: '2026-11-04T01:00:00', nextRun: '2026-11-05T01:00:00', lastResult: 0 } };
  const d = toastDeps({ files, info, clock: { now: at('17:00:00') } });
  const done = runWatcher(d);
  await flush(); await flush();
  assert.equal(d.captured.posts.length, 1);
  assert.deepEqual(d.captured.posts[0].filter((t) => t.group === GROUP).map((t) => t.tag), [EVENING], 'a finished task has no card');
  assert.ok(files.exists('watch.pid'));
  const second = toastDeps({ files, alive: new Set([4242]), cmdlines: { 4242: WATCH_CMD }, pid: 99 });
  assert.equal(await runWatcher(second), 1);
  assert.match(second.captured.err.join('\n'), /A watcher is already running \(pid 4242\)/);
  assert.equal(d.timers.pending.length, 1);
  assert.ok(d.timers.pending[0].ms <= STEP_MS);
  // 5 minutes later: only the check (one history query), no scheduler read.
  const reads = d.captured.history.length;
  d.clock.now = at('17:05:00');
  d.timers.pending.shift().fn();
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(d.captured.history.length, reads + 1);
  assert.equal(d.captured.posts.length, 1);
  // 17:21, one minute after Report sync's run: a refresh. The fake run
  // leaves evening with nothing more today, so its card is taken out by the tool.
  d.clock.now = at('17:21:00');
  d.timers.pending.shift().fn();
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(d.captured.posts.length, 2);
  assert.deepEqual(d.captured.removed, [EVENING]);
  files.write('watch.stop', '1');
  assert.equal(await done, 0);
  assert.equal(files.exists('watch.pid'), false);
  assert.equal(files.exists('watch.stop'), false);
  assert.equal(d.timers.pending.length, 0);
  assert.match(files.read('watch.log'), /watcher started[\s\S]*watcher stopped/);
});

test('watcher: a card closed between two refreshes gets its question from the 5 minute check', async () => {
  const files = memoryFiles();
  const d = toastDeps({ files, clock: { now: at('12:00:00') } });
  let stop;
  const done = runWatcher(d, { onStart: (s) => { stop = s; } });
  for (let i = 0; i < 4; i++) await flush();
  d.sim.center.delete(EVENING);
  d.clock.now = at('12:05:00');
  d.timers.pending.shift().fn();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(d.captured.posts.length, 2);
  assert.deepEqual(d.captured.posts[1].map((t) => [t.group, t.tag]), [[ASK_GROUP, `q${EVENING.slice(1)}`]]);
  stop();
  assert.equal(await done, 0);
  assert.equal(d.captured.writes.length, 0);
});

test('watch --install: the plan has exactly one logon task and two registry keys; an answer of no writes nothing', async () => {
  const no = toastDeps({ answer: 'n' });
  assert.equal(await main(['watch', '--install'], no), 1);
  const plan = no.captured.out.join('\n');
  assert.match(plan, /Task: {7}win-task-todo watch/);
  assert.match(plan, /At logon of PC-01\\alice/);
  assert.match(plan, /conhost\.exe --headless "C:\\Tools\\node\.exe" "D:\\Projects\\win-task-todo\\tasks\.mjs" watch/);
  assert.deepEqual(plan.match(/HKCU\\[^\s]+/g), ['HKCU\\Software\\Classes\\wintasktodo', 'HKCU\\Software\\Classes\\wintasktodo\\shell\\open\\command', 'HKCU\\Software\\Classes\\AppUserModelId\\WinTaskTodo.<id>']);
  assert.deepEqual([no.captured.writes.length, no.captured.registry.length], [0, 0]);
  const yes = toastDeps();
  assert.equal(await main(['watch', '--install', '--yes'], yes), 0);
  assert.equal(yes.captured.writes.length, 1);
  const w = yes.captured.writes[0];
  assert.deepEqual([kind(w), w.data.name, w.data.kind, w.data.noTimeLimit], ['Register', 'win-task-todo watch', 'logon', true]);
  assert.equal(w.data.execute, 'C:\\Windows\\System32\\conhost.exe');
  assert.match(w.data.description, /^tasks-watcher:win-task-todo\n/);
  assert.match(w.script, /-RunLevel Limited/);
  assert.match(w.script, /ExecutionTimeLimit/);
  assert.deepEqual(yes.captured.registry[0].data.keys.map((k) => k.path), ['Software\\Classes\\wintasktodo', 'Software\\Classes\\wintasktodo\\shell\\open\\command']);
  assert.equal(yes.captured.registry[0].data.keys[1].values[0].value, '"C:\\Windows\\System32\\conhost.exe" --headless "C:\\Tools\\node.exe" "D:\\Projects\\win-task-todo\\tasks.mjs" uri "%1"');
  assert.doesNotMatch(plan, /gear|png/);
});

test('watch --uninstall: removes exactly the watcher task, the URI scheme and every ID of the tool, nothing else', async () => {
  const look = toastDeps({ tasks: [...TASKS, WATCHER], answer: 'n' });
  assert.equal(await main(['watch', '--uninstall'], look), 1);
  assert.match(look.captured.out.join('\n'), /Delete task: \\win-task-todo watch/);
  assert.deepEqual([look.captured.writes.length, look.captured.registry.length], [0, 0]);
  const ids = [appIdOf(EVENING)];
  const d = toastDeps({ tasks: [...TASKS, WATCHER], ids });
  assert.equal(await main(['watch', '--uninstall', '--yes'], d), 0);
  assert.deepEqual(d.captured.writes.map(kind), ['Unregister']);
  assert.equal(d.captured.writes[0].data.name, 'win-task-todo watch');
  assert.deepEqual(d.captured.registry.map((r) => r.data.ids), [ids]);
  assert.match(look.captured.out.join('\n'), /Delete from the registry/);
  assert.match(d.captured.registry[0].script, /DeleteSubKeyTree/);
  const fake = { ...WATCHER, description: 'no marker' };
  const other = toastDeps({ tasks: [...TASKS, fake] });
  await main(['watch', '--uninstall', '--yes'], other);
  assert.equal(other.captured.writes.length, 0, 'a task with the same name but no marker is not deleted');
});

test('watch --status and --stop', async () => {
  const files = memoryFiles({ 'watch.pid': JSON.stringify({ pid: 777, boot: 1000 }) });
  const d = toastDeps({ files, tasks: [...TASKS, WATCHER], alive: new Set([777]), cmdlines: { 777: WATCH_CMD } });
  assert.equal(await main(['watch', '--status'], d), 0);
  const out = d.captured.out.join('\n');
  assert.match(out, /Logon task "win-task-todo watch": yes, on/);
  assert.match(out, /Watcher: running, pid 777, memory 41 MB \(working set\)/);
  assert.match(out, /Notifications: registered/);
  const none = toastDeps();
  await main(['watch', '--status'], none);
  assert.match(none.captured.out.join('\n'), /not installed[\s\S]*Watcher: not running/);
  const alive = new Set([777]);
  const s = toastDeps({ files, alive, cmdlines: { 777: WATCH_CMD } });
  s.timers.setTimeout = (fn) => { alive.delete(777); fn(); };
  assert.equal(await main(['watch', '--stop'], s), 0);
  assert.match(s.captured.out.join('\n'), /Stopped the watcher \(pid 777\)/);
  assert.ok(files.exists('watch.stop'));
  assert.equal(s.captured.killed.length, 0);
  const idle = toastDeps();
  await main(['watch', '--stop'], idle);
  assert.match(idle.captured.out.join('\n'), /No watcher is running/);
});
