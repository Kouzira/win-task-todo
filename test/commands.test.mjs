import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { buildAction } from '../lib/command.mjs';
import { table, trunc } from '../lib/format.mjs';
import { findTask } from '../lib/match.mjs';
import { resolveLogDir } from '../lib/logs.mjs';
import { fakeDeps, TASKS } from './helpers.mjs';

const text = (d) => d.captured.out.join('\n');
const errText = (d) => d.captured.err.join('\n');

test('the default list has only own tasks, sorted by next run', async () => {
  const d = fakeDeps();
  assert.equal(await main([], d), 0);
  const lines = d.captured.out;
  assert.match(lines[0], /^Name\s+Schedule\s+Next run/);
  const names = lines.slice(1).map((l) => l.slice(0, 17).trim());
  assert.deepEqual(names, ['Report sync', 'Nightly cleanup', 'Daily backup']);
  assert.ok(lines.every((l) => l.length <= 120));
  assert.doesNotMatch(text(d), /Adobe|StartCN|Printer/);
  assert.match(text(d), /Every weekday at 17:20/);
  assert.match(text(d), /Failed, code 0xC000013A/);
  assert.match(text(d), /Running/);
  assert.match(text(d), /Last run/);
  assert.match(text(d), /2026-11-05 10:00/);
});

test('list --all includes system tasks, --json prints JSON', async () => {
  const all = fakeDeps();
  await main(['list', '--all'], all);
  assert.match(text(all), /Launch Adobe/);
  assert.match(text(all), /System/);
  const j = fakeDeps();
  await main(['list', '--json'], j);
  const rows = JSON.parse(text(j));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Report sync');
  assert.equal(rows[0].own, true);
});

test('show prints the full detail', async () => {
  const d = fakeDeps();
  assert.equal(await main(['show', 'daily BACKUP'], d), 0);
  const t = text(d);
  assert.match(t, /backup.ps1/);
  assert.match(t, /Working directory\s+D:\\Scripts/);
  assert.match(t, /Every weekday at 10:00/);
  assert.match(t, /Succeeded \(0\)/);
  assert.match(t, /Path\s+\\Daily backup/);
});

test('a wrong name reports an error and lists similar names', async () => {
  const d = fakeDeps();
  assert.equal(await main(['show', 'Daily backu'], d), 1);
  assert.match(errText(d), /No task named/);
  assert.match(errText(d), /Daily backup/);
  assert.ok('missing' in findTask('zzz', TASKS));
});

test('add: the plan, and --dry-run writes nothing', async () => {
  const d = fakeDeps();
  assert.equal(await main(['add', 'test', 'echo hi', 'daily 10:00', '--dry-run'], d), 0);
  const t = text(d);
  assert.match(t, /Name:\s+test/);
  assert.match(t, /Will run:\s+cmd\.exe \/c echo hi/);
  assert.match(t, /Schedule:\s+Every day at 10:00/);
  assert.match(t, /no admin needed/);
  assert.equal(d.captured.writes.length, 0);
  assert.equal(d.captured.asked.length, 0);
});

test('add: asks to confirm, an answer of no cancels', async () => {
  const d = fakeDeps({ answer: 'n' });
  assert.equal(await main(['add', 'test', 'echo hi', 'weekdays 10:00'], d), 1);
  assert.deepEqual(d.captured.asked, ['Create this task? (y/N) ']);
  assert.equal(d.captured.writes.length, 0);
});

test('add: y or --yes registers it, limited rights, current account', async () => {
  const d = fakeDeps({ answer: 'y' });
  assert.equal(await main(['add', 'test', 'echo hi', 'mon,wed 09:30'], d), 0);
  assert.equal(d.captured.writes.length, 1);
  const w = d.captured.writes[0];
  assert.match(w.script, /-RunLevel Limited/);
  assert.doesNotMatch(w.script, /Highest/);
  assert.deepEqual(w.data.days, ['Monday', 'Wednesday']);
  assert.equal(w.data.user, 'PC-01\\alice');
  assert.equal(w.data.execute, 'cmd.exe');
  const y = fakeDeps();
  assert.equal(await main(['add', 'test2', 'echo hi', 'daily 10:00', '--yes'], y), 0);
  assert.equal(y.captured.asked.length, 0);
  assert.equal(y.captured.writes.length, 1);
});

test('add: an existing name is refused, case-insensitively', async () => {
  const d = fakeDeps();
  assert.equal(await main(['add', 'daily BACKUP', 'echo hi', 'daily 10:00', '--yes'], d), 1);
  assert.match(errText(d), /already exists/);
  assert.equal(d.captured.writes.length, 0);
});

test('add: a bad schedule or name gives a clear error and writes nothing', async () => {
  const d = fakeDeps();
  assert.equal(await main(['add', 'x', 'echo', 'whenever you like', '--yes'], d), 2);
  assert.match(errText(d), /Invalid schedule/);
  assert.equal(await main(['add', 'a\\b', 'echo', 'daily 10:00', '--yes'], d), 2);
  assert.equal(await main(['add', 'x'], d), 2);
  assert.equal(d.captured.writes.length, 0);
});

test('add: how the command is built', () => {
  assert.deepEqual(buildAction('echo hi'), { execute: 'cmd.exe', arguments: '/c echo hi' });
  assert.deepEqual(buildAction('D:\\x\\run.ps1'), { execute: 'powershell.exe', arguments: '-NoProfile -ExecutionPolicy Bypass -File "D:\\x\\run.ps1"' });
  assert.deepEqual(buildAction('powershell -File a.ps1'), { execute: 'powershell.exe', arguments: '-NoProfile -ExecutionPolicy Bypass -File a.ps1' });
  assert.equal(buildAction('pwsh -Command Get-Date').execute, 'pwsh.exe');
});

test('on, off, run, delete refuse system tasks without --all', async () => {
  for (const verb of ['on', 'off', 'run', 'delete']) {
    for (const name of ['StartCN', 'Test service', 'Launch Adobe CCXProcess']) {
      const d = fakeDeps({ answer: 'y' });
      assert.equal(await main([verb, name], d), 1, `${verb} ${name}`);
      assert.match(errText(d), /system \/ vendor/);
      assert.equal(d.captured.writes.length, 0);
    }
  }
});

test('--all allows acting on system tasks', async () => {
  const d = fakeDeps();
  assert.equal(await main(['off', 'StartCN', '--all'], d), 0);
  assert.match(d.captured.writes[0].script, /Disable-ScheduledTask/);
});

test('on, off, run call the right command for an own task', async () => {
  const d = fakeDeps();
  await main(['off', 'Report sync'], d);
  await main(['on', 'Report sync'], d);
  await main(['run', 'Report sync'], d);
  const kinds = d.captured.writes.map((w) => /(Enable|Disable|Start)-ScheduledTask/.exec(w.script)[1]);
  assert.deepEqual(kinds, ['Disable', 'Enable', 'Start']);
  assert.equal(d.captured.writes[0].data.name, 'Report sync');
});

test('delete always asks, --yes skips the question', async () => {
  const no = fakeDeps({ answer: '' });
  assert.equal(await main(['delete', 'Report sync'], no), 1);
  assert.deepEqual(no.captured.asked, ['Delete this task? (y/N) ']);
  assert.equal(no.captured.writes.length, 0);
  const yes = fakeDeps({ answer: 'y' });
  assert.equal(await main(['delete', 'Report sync'], yes), 0);
  assert.match(yes.captured.writes[0].script, /Unregister-ScheduledTask/);
  const flag = fakeDeps();
  await main(['delete', 'Report sync', '--yes'], flag);
  assert.equal(flag.captured.asked.length, 0);
  assert.equal(flag.captured.writes.length, 1);
});

test('log: the tail of the log matching the script name, or a clear note when there is none', async () => {
  const logs = {
    dir: 'C:\\L',
    list: async () => [{ name: 'backup.log', mtimeMs: 1, size: 5 }, { name: 'report-sync.log', mtimeMs: 2, size: 5 }],
    tail: async (name) => [`last line of ${name}`],
  };
  const d = fakeDeps({ logs });
  assert.equal(await main(['log', 'Daily backup'], d), 0);
  assert.match(text(d), /last line of backup.log/);
  assert.doesNotMatch(text(d), /report-sync.log/);
  const none = fakeDeps({ logs: { dir: 'C:\\L', list: async () => [], tail: async () => [] } });
  await main(['log', 'Nightly cleanup'], none);
  assert.match(text(none), /No log file found/);
  const unset = fakeDeps();
  await main(['log', 'Daily backup'], unset);
  assert.match(text(unset), /Last result/);
  assert.match(text(unset), /No log folder is set.*TASK_LOG_DIR/);
});

test('log folder: TASK_LOG_DIR first, then logDir in config.json, else none', () => {
  const cfg = (o) => () => JSON.stringify(o);
  const bad = () => { throw new Error('missing'); };
  assert.equal(resolveLogDir({ TASK_LOG_DIR: 'E:\\Logs', LOCALAPPDATA: 'C:\\L' }, cfg({ logDir: 'X' })), 'E:\\Logs');
  assert.equal(resolveLogDir({ LOCALAPPDATA: 'C:\\L' }, cfg({ logDir: 'D:\\Scripts\\logs' })), 'D:\\Scripts\\logs');
  assert.equal(resolveLogDir({ TASK_LOG_DIR: '  ', LOCALAPPDATA: 'C:\\L' }, cfg({ logDir: 5 })), null);
  assert.equal(resolveLogDir({ LOCALAPPDATA: 'C:\\L' }, bad), null);
  assert.equal(resolveLogDir({ LOCALAPPDATA: 'C:\\L' }, () => '{not json'), null);
  assert.equal(resolveLogDir({}, cfg({ logDir: 'X' })), null);
});

test('help, an unknown command, an unknown option', async () => {
  const d = fakeDeps();
  assert.equal(await main(['help'], d), 0);
  assert.match(text(d), /Examples/);
  assert.match(text(d), /^task: /);
  assert.match(text(d), /task notify[\s\S]*task watch/);
  assert.doesNotMatch(text(d), /\btasks (list|show|add|ui|help|notify|watch)\b/, 'the command is now named task');
  assert.equal(await main(['bay'], d), 2);
  assert.equal(await main(['list', '--yess'], d), 2);
});

test('table: truncates with an ellipsis and fits 120 columns', () => {
  assert.equal(trunc('abcdefghij', 6), 'abc...');
  const rows = [['x'.repeat(200), 'y'.repeat(200)]];
  for (const l of table(['A', 'B'], rows)) assert.ok(l.length <= 120);
});

test('no test touches the real scheduler: the fake runner refuses unknown scripts', async () => {
  const d = fakeDeps();
  await assert.rejects(() => d.run('Get-Date'));
});
