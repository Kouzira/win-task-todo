import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { refreshCards } from '../lib/notify.mjs';
import { appIdOf, cardTag } from '../lib/toast.mjs';
import { isSettingsScript } from '../lib/doctor-probe.mjs';
import { TASKS } from './helpers.mjs';
import { WATCHER, memoryFiles, toastDeps } from './watch-helpers.mjs';

const NOW = new Date('2026-11-04T12:00:00');
const WATCH_CMD = 'conhost.exe --headless "C:\\Tools\\node.exe" "D:\\tools\\win-task-todo\\tasks.mjs" watch';
const idOf = (name) => appIdOf(cardTag({ path: '\\', name }));
const text = (d) => d.captured.out.join('\n');
// The files the canned tasks in helpers.mjs point at, so a healthy machine has them.
const TASK_FILES = [
  'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
  'D:\\Scripts\\backup.ps1', 'D:\\Scripts\\report-sync.ps1', 'D:\\Scripts\\cleanup.bat',
];
const WRITERS = /SetValue|CreateSubKey|DeleteSubKey|\.Show\(|History\.(Remove|Clear)|Register-ScheduledTask|Unregister-|Enable-|Disable-|Start-ScheduledTask|Stop-|Set-|New-Item|Remove-Item/;

// A machine where everything works: the watcher runs, two cards were posted
// by a refresh and are in the simulated Notification Center.
async function healthy(over = {}) {
  const files = memoryFiles();
  const first = toastDeps({ files, tasks: [...TASKS, WATCHER], now: NOW });
  await refreshCards(first, files);
  files.write('watch.pid', JSON.stringify({ pid: 777, boot: 1000 }));
  files.mtimes.set('state.json', NOW.getTime() - 10 * 60000);
  const d = toastDeps({
    files, share: first, tasks: [...TASKS, WATCHER], clock: first.clock, alive: new Set([777]), cmdlines: { 777: WATCH_CMD },
    env: { PATH: 'C:\\Windows;C:\\Tools' }, pathFiles: ['C:\\Tools\\task.cmd', ...TASK_FILES], ...over,
  });
  return { d, files };
}

test('doctor on a healthy machine: one line per check, no problem, exit 0, and it only reads', async () => {
  const { d } = await healthy();
  d.sim.settings = { [idOf('Report sync')]: { Enabled: 1, ShowBanner: 1 } };
  const scripts = [];
  const postsBefore = d.captured.posts.length;
  const removedBefore = d.captured.removed.length;
  const run = d.run;
  d.run = async (s) => { scripts.push(s); return run(s); };
  assert.equal(await main(['doctor'], d), 0);
  const out = text(d);
  assert.match(out, /ok +The "task" command is found on PATH \(C:\\Tools\\task\.cmd\)/);
  assert.match(out, /ok +The notification part is installed/);
  assert.match(out, /ok +The logon task "win-task-todo watch" exists and is on/);
  assert.match(out, /ok +The watcher is running \(pid 777\)/);
  assert.match(out, /ok +Every task with a card today \(2\) has its app ID registered/);
  assert.match(out, /ok +Windows notification settings show nothing turned off/);
  assert.match(out, /info +Do not disturb \/ Focus is not checked/);
  assert.match(out, /ok +Windows' toast history holds 2 of 2 expected cards/);
  assert.match(out, /ok +The last refresh was 10 minutes ago/);
  assert.match(out, /Verdict: everything checked is fine/);
  assert.doesNotMatch(out, /FAIL|WARN/);
  assert.equal(d.captured.err.length, 0);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.doesNotMatch(s, WRITERS, 'doctor runs only read scripts');
  assert.equal(d.captured.writes.length, 0);
  assert.equal(d.captured.posts.length, postsBefore, 'nothing is posted by doctor');
  assert.equal(d.captured.registry.length, 0);
  assert.equal(d.captured.removed.length, removedBefore);
  assert.equal(d.captured.settingsReads.length, 1);
  assert.deepEqual(d.captured.settingsReads[0].ids.sort(), [idOf('Nightly cleanup'), idOf('Report sync')].sort());
  assert.equal(d.captured.launched.length + d.captured.killed.length, 0);
});

test('doctor writes nothing to the tool folder either', async () => {
  const { d, files } = await healthy();
  const before = JSON.stringify([...files.store]);
  await main(['doctor'], d);
  assert.equal(JSON.stringify([...files.store]), before);
});

test('doctor on a broken machine: each failing line has a fix, the verdict counts them, exit 1', async () => {
  const files = memoryFiles({ 'watch.pid': JSON.stringify({ pid: 5, boot: 1000 }), 'watch.log': '2026-11-04 11:59:00 refresh failed (1 in a row): PowerShell reported an error: simulated; next retry at 11:59:30\n' });
  const d = toastDeps({ files, installed: false, now: NOW, tasks: TASKS });
  assert.equal(await main(['doctor'], d), 1);
  const out = text(d);
  assert.match(out, /WARN +The "task" command is not found on PATH/);
  assert.match(out, /FAIL +The notification part is not installed/);
  assert.match(out, /Fix: Run: task notify --install/);
  assert.match(out, /FAIL +The logon task "win-task-todo watch" does not exist/);
  assert.match(out, /Fix: Run: task watch --install/);
  assert.match(out, /FAIL +The watcher is not running: watch\.pid names pid 5/);
  assert.match(out, /FAIL +"Report sync" has no app ID registered/);
  assert.match(out, /FAIL +"Nightly cleanup" has no app ID registered/);
  assert.match(out, /FAIL +Windows reports the notification part as not installed/);
  assert.match(out, /WARN +No refresh has run yet/);
  assert.match(out, /WARN +The last refresh in watch\.log failed at 2026-11-04 11:59:00: PowerShell reported an error: simulated/);
  assert.match(out, /Verdict: \d+ problems found, \d+ warnings\./);
  const lines = d.captured.out;
  for (let i = 0; i < lines.length; i++) if (/ FAIL /.test(lines[i])) assert.match(lines[i + 1] ?? '', /^ {8}Fix: /, `a fix follows: ${lines[i]}`);
});

test('doctor reports what Windows settings turn off, and a card that left the Notification Center', async () => {
  const { d } = await healthy();
  d.sim.toastEnabled = 1;
  d.sim.settings = { [idOf('Report sync')]: { Enabled: 0 }, [idOf('Nightly cleanup')]: { ShowBanner: 0 } };
  d.sim.center.delete(cardTag({ path: '\\', name: 'Nightly cleanup' }));
  assert.equal(await main(['doctor'], d), 1);
  const out = text(d);
  assert.match(out, /FAIL +Windows has notifications turned off for "Report sync" \(Enabled=0\)/);
  assert.match(out, /WARN +Banners are off for "Nightly cleanup" \(ShowBanner=0\)/);
  assert.match(out, /WARN +The card of "Nightly cleanup" was posted but Windows' history no longer holds it/);
});

test('doctor: an old refresh with a live watcher is a warning; a toast switch off is a failure', async () => {
  const { d, files } = await healthy();
  files.mtimes.set('state.json', NOW.getTime() - 50 * 60000);
  d.sim.toastEnabled = 0;
  assert.equal(await main(['doctor'], d), 1);
  assert.match(text(d), /WARN +The last refresh was 50 minutes ago/);
  assert.match(text(d), /FAIL +Windows has toast notifications switched off for the whole account/);
});

test('doctor: a read that fails costs one warning line, the rest of the report still shows', async () => {
  const { d } = await healthy();
  const run = d.run;
  d.run = async (s) => {
    if (isSettingsScript(s)) throw new Error('PowerShell reported an error: simulated');
    return run(s);
  };
  assert.equal(await main(['doctor'], d), 0);
  assert.match(text(d), /WARN +Could not check the notification settings: PowerShell reported an error: simulated/);
  assert.match(text(d), /ok +Windows' toast history holds 2 of 2/);
  assert.match(text(d), /Verdict: no hard problem, 1 warning\./);
});

test('doctor with nothing due today does not query the history', async () => {
  const { d } = await healthy({ tasks: [WATCHER] });
  assert.equal(await main(['doctor'], d), 0);
  assert.match(text(d), /No task needs a card today/);
  assert.match(text(d), /No card is expected in the Notification Center/);
});
