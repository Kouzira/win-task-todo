import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { findLog, logFileName } from '../lib/logs.mjs';
import { describeTask } from '../lib/project.mjs';
import { fakeDeps } from './helpers.mjs';

const text = (d) => d.captured.out.join('\n');
const errText = (d) => d.captured.err.join('\n');
const LOGS = { dir: 'D:\\logs', list: async () => [], tail: async () => [] };
const ADD = ['add', 'Daily backup 2', 'D:\\scripts\\backup.ps1', 'daily 10:00'];
const withDeps = () => fakeDeps({ dirs: ['D:\\scripts'], logs: LOGS });

test('--cwd: shown in the plan, passed to the scheduler, absolute and existing only', async () => {
  const d = withDeps();
  assert.equal(await main([...ADD, '--cwd', 'D:\\scripts', '--yes'], d), 0);
  assert.match(text(d), /Working dir: D:\\scripts/);
  assert.equal(d.captured.writes[0].data.cwd, 'D:\\scripts');
  assert.match(d.captured.writes[0].script, /WorkingDirectory = \$p\.cwd/);

  const quoted = withDeps();
  assert.equal(await main([...ADD, '--cwd=D:\\scripts', '--yes'], quoted), 0);
  assert.equal(quoted.captured.writes[0].data.cwd, 'D:\\scripts');

  const none = withDeps();
  assert.equal(await main([...ADD, '--yes'], none), 0);
  assert.equal(none.captured.writes[0].data.cwd, null);
  assert.doesNotMatch(text(none), /Working dir/);

  const missing = withDeps();
  assert.equal(await main([...ADD, '--cwd', 'D:\\nowhere', '--yes'], missing), 2);
  assert.match(errText(missing), /"D:\\nowhere" does not exist/);
  assert.equal(missing.captured.writes.length, 0);

  const relative = withDeps();
  assert.equal(await main([...ADD, '--cwd', 'scripts', '--yes'], relative), 2);
  assert.match(errText(relative), /full path/);
  assert.equal(relative.captured.writes.length, 0);
});

test('--cwd with --dry-run shows the plan and writes nothing', async () => {
  const d = withDeps();
  assert.equal(await main([...ADD, '--cwd', 'D:\\scripts', '--dry-run'], d), 0);
  assert.match(text(d), /Working dir: D:\\scripts/);
  assert.equal(d.captured.writes.length, 0);
});

test('--log: the plan names the file, the action runs the runner with node, the original command travels as arguments', async () => {
  const d = withDeps();
  assert.equal(await main(['add', 'Daily backup 2', 'echo hi', 'daily 10:00', '--log', '--yes'], d), 0);
  assert.match(text(d), /Log: +D:\\logs\\Daily-backup-2\.log \(output and exit code of each run, about 1 MB, then \.log\.1\)/);
  const w = d.captured.writes[0].data;
  assert.equal(w.execute, 'C:\\Tools\\node.exe');
  assert.equal(w.arguments, '"D:\\Projects\\win-task-todo\\run-logged.mjs" --log "D:\\logs\\Daily-backup-2.log" --exe "cmd.exe" --args "/c echo hi"');
  assert.match(text(d), /Will run: +C:\\Tools\\node\.exe "D:\\Projects\\win-task-todo\\run-logged\.mjs"/);
});

test('--log around a PowerShell script keeps its arguments exactly', async () => {
  const d = withDeps();
  await main([...ADD, '--log', '--yes'], d);
  const { arguments: args } = d.captured.writes[0].data;
  assert.match(args, /--exe "powershell\.exe" --args "-NoProfile -ExecutionPolicy Bypass -File \\"D:\\scripts\\backup\.ps1\\""$/);
});

test('without --log the action is exactly what it was', async () => {
  const d = withDeps();
  await main(['add', 'Daily backup 2', 'echo hi', 'daily 10:00', '--yes'], d);
  const w = d.captured.writes[0].data;
  assert.deepEqual([w.execute, w.arguments], ['cmd.exe', '/c echo hi']);
  assert.doesNotMatch(text(d), /Log:/);
});

test('--log without a log folder is refused with the way to set one', async () => {
  const d = fakeDeps();
  assert.equal(await main(['add', 'x', 'echo hi', 'daily 10:00', '--log', '--yes'], d), 2);
  assert.match(errText(d), /TASK_LOG_DIR/);
  assert.match(errText(d), /config\.json/);
  assert.equal(d.captured.writes.length, 0);
});

test('the log file is named after the task, spaces as hyphens, and task log finds it', async () => {
  assert.equal(logFileName('Daily backup 2'), 'Daily-backup-2.log');
  assert.equal(logFileName('  Report   sync '), 'Report-sync.log');
  const store = {
    dir: 'D:\\logs',
    list: async () => [{ name: 'Daily-backup-2.log', mtimeMs: 5, size: 10 }, { name: 'other.log', mtimeMs: 9, size: 1 }],
    tail: async () => ['=== 2026-11-04 10:00:00 ===', 'exit 0'],
  };
  const found = await findLog(store, { name: 'Daily backup 2', actions: [{ execute: 'C:\\Tools\\node.exe', arguments: '"D:\\Projects\\win-task-todo\\run-logged.mjs" --log "D:\\logs\\Daily-backup-2.log" --exe "cmd.exe" --args "/c echo hi"' }] });
  assert.equal(found.name, 'Daily-backup-2.log');
  assert.deepEqual(found.lines, ['=== 2026-11-04 10:00:00 ===', 'exit 0']);

  const task = { name: 'Daily backup 2', path: '\\', state: 'Ready', description: describeTask(), userId: 'alice', actions: [{ execute: 'C:\\Tools\\node.exe', arguments: '"D:\\x\\run-logged.mjs"', workingDirectory: '' }], triggers: [] };
  const d = fakeDeps({ tasks: [task], logs: store });
  assert.equal(await main(['log', 'Daily backup 2'], d), 0);
  assert.match(text(d), /Log file: +D:\\logs\\Daily-backup-2\.log/);
  assert.match(text(d), /exit 0/);
});

test('--cwd, --log and --project together: one plan, one write', async () => {
  const d = withDeps();
  assert.equal(await main([...ADD, '--cwd', 'D:\\scripts', '--log', '--project', 'Website relaunch', '--yes'], d), 0);
  assert.equal(d.captured.writes.length, 1);
  const w = d.captured.writes[0].data;
  assert.equal(w.cwd, 'D:\\scripts');
  assert.equal(w.description, 'Created by the tasks tool\ntasks-project:Website relaunch');
  assert.match(w.arguments, /--log "D:\\logs\\Daily-backup-2\.log"/);
});
