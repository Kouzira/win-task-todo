import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { commandText, findProblems, unwrapLogged } from '../lib/command-check.mjs';
import { wrapWithLog } from '../lib/command.mjs';
import { checkCommands } from '../lib/doctor.mjs';
import { TASKS, fakeDeps } from './helpers.mjs';
import { WATCHER, memoryFiles, toastDeps } from './watch-helpers.mjs';

const have = (...paths) => (p) => paths.includes(p);
const none = have();
const text = (d) => d.captured.out.join('\n');

test('findProblems: a variable the shell left in the text is a problem, in a path or on its own', () => {
  const a = findProblems('node D:\\Folder$script', none);
  assert.equal(a.length, 1);
  assert.match(a[0], /"\$script"/);
  const b = findProblems('echo ${name} done', none);
  assert.match(b[0], /"\$\{name\}"/);
  assert.match(findProblems('run _$_x', none)[0], /"\$_x"/);
});

test('findProblems: a $ inside single quotes, a PowerShell command, a lone $ and a price are not variables', () => {
  assert.deepEqual(findProblems("echo '$script'", none), []);
  assert.deepEqual(findProblems('powershell.exe -Command "Write-Host $env:TEMP"', none), []);
  assert.deepEqual(findProblems('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c "$x = 1"', have('C:\\Program Files\\PowerShell\\7\\pwsh.exe')), []);
  assert.deepEqual(findProblems('echo cost 5$ and $1', none), []);
  // An unbalanced single quote cannot be read, so nothing is claimed.
  assert.deepEqual(findProblems("echo it's $name", none), []);
});

test('findProblems: a missing script or program is a problem, an existing one is not', () => {
  const missing = findProblems('node D:\\scripts\\build.mjs --fast', none);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /D:\\scripts\\build\.mjs does not exist/);
  assert.deepEqual(findProblems('node D:\\scripts\\build.mjs', have('D:\\scripts\\build.mjs')), []);
  assert.deepEqual(findProblems('D:\\scripts\\build.mjs', have('D:\\scripts\\build.mjs')), []);
  assert.equal(findProblems('"C:\\Tools\\a.exe" "D:\\x\\b.ps1"', have('C:\\Tools\\a.exe')).length, 1);
  assert.equal(findProblems('C:\\Tools\\a.exe C:\\Tools\\a.exe', none).length, 1, 'the same path is reported once');
  assert.equal(findProblems('type D:/docs/readme.txt', none).length, 1, 'forward slashes count');
});

test('findProblems: a quoted path with spaces is one path; an unquoted one cut at a space is tried longer', () => {
  const p = 'C:\\Program Files\\App\\run.exe';
  assert.deepEqual(findProblems(`"${p}" --go`, have(p)), []);
  const bad = findProblems(`"${p}" --go`, none);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /C:\\Program Files\\App\\run\.exe does not exist/);
  assert.deepEqual(findProblems(`${p} --go`, have(p)), []);
});

test('findProblems: a log or output target, a folder with a trailing separator and a wildcard are not checked', () => {
  assert.deepEqual(findProblems('build.cmd > D:\\logs\\out.txt', none), []);
  assert.deepEqual(findProblems('build.cmd >> "D:\\logs\\out.txt"', none), []);
  assert.deepEqual(findProblems('build.cmd 2>D:\\logs\\err.txt', none), []);
  assert.deepEqual(findProblems('tool --log D:\\logs\\run.log', none), []);
  assert.deepEqual(findProblems('tool --log=D:\\logs\\run.log', none), []);
  assert.deepEqual(findProblems('copy a.txt D:\\backup\\', none), []);
  assert.deepEqual(findProblems('del D:\\tmp\\*.tmp', none), []);
  // Store app aliases look missing to Node although they run.
  assert.deepEqual(findProblems('C:\\Users\\bob\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -File x', none), []);
});

test('findProblems: what cannot be parsed is not a problem', () => {
  assert.deepEqual(findProblems('', none), []);
  assert.deepEqual(findProblems(undefined, none), []);
  assert.deepEqual(findProblems('echo hello', none), []);
  assert.deepEqual(findProblems('echo %USERPROFILE%\\x.txt', none), []);
  assert.deepEqual(findProblems('dir x:y \\\\server\\share\\a.txt', none), []);
  // No extension and nothing existing above it: could be a space inside a name.
  assert.deepEqual(findProblems('C:\\Some Tool\\bin', none), []);
});

test('unwrapLogged and commandText read the command inside the logging runner as plain text', () => {
  const wrapped = wrapWithLog({ execute: 'cmd.exe', arguments: '/c "D:\\a b\\run.cmd"' }, { nodePath: 'C:\\Tools\\node.exe', runnerPath: 'C:\\Tools\\run-logged.mjs', logFile: 'D:\\logs\\x.log' });
  assert.equal(unwrapLogged(`${wrapped.execute} ${wrapped.arguments}`), 'cmd.exe /c "D:\\a b\\run.cmd"');
  const task = { actions: [wrapped] };
  assert.deepEqual(findProblems(commandText(task), none).length, 1);
  assert.deepEqual(findProblems(commandText(task), have('D:\\a b\\run.cmd')), []);
  assert.equal(unwrapLogged('node x.mjs'), 'node x.mjs');
  assert.equal(commandText({ actions: [] }), null);
  assert.equal(commandText({ actions: [{ execute: '  ', arguments: 'x' }] }), null);
});

test('add: a missing path prints a Warning after the plan and before the question; the answer decides', async () => {
  const d = fakeDeps({ answer: 'y' });
  assert.equal(await main(['add', 'Build', 'node D:\\scripts\\build.mjs', 'daily 10:00'], d), 0);
  const out = d.captured.out;
  const plan = out.findIndex((l) => /^Plan to create/.test(l));
  const warn = out.findIndex((l) => /^Warning: .*D:\\scripts\\build\.mjs does not exist/.test(l));
  assert.ok(plan >= 0 && warn > plan);
  assert.equal(d.captured.asked.length, 1);
  assert.equal(d.captured.writes.length, 1, 'advisory only: the task is created after yes');
});

test('add --yes still creates the task, and --dry-run prints the warning and creates nothing', async () => {
  const yes = fakeDeps();
  assert.equal(await main(['add', 'Build', 'node D:\\Folder$script', 'daily 10:00', '--yes'], yes), 0);
  assert.match(text(yes), /Warning: .*"\$script"/);
  assert.equal(yes.captured.writes.length, 1);
  assert.equal(yes.captured.asked.length, 0);

  const dry = fakeDeps();
  assert.equal(await main(['add', 'Build', 'node D:\\scripts\\build.mjs', 'daily 10:00', '--dry-run'], dry), 0);
  assert.match(text(dry), /Warning: .*does not exist/);
  assert.equal(dry.captured.writes.length, 0);
});

test('add: no warning when the file exists, or when there is no path at all', async () => {
  const ok = fakeDeps({ files: ['D:\\scripts\\build.mjs'] });
  await main(['add', 'Build', 'node D:\\scripts\\build.mjs', 'daily 10:00', '--yes'], ok);
  assert.doesNotMatch(text(ok), /Warning/);
  const plain = fakeDeps();
  await main(['add', 'Hi', 'echo hi', 'daily 10:00', '--yes'], plain);
  assert.doesNotMatch(text(plain), /Warning/);
});

test('doctor check: one warning per task with a problem, a fix line, and ok when none', () => {
  const bad = checkCommands([
    { name: 'A', problems: ['The path D:\\x.ps1 does not exist.'] },
    { name: 'B', problems: [] },
    { name: 'C', problems: ['The text contains "$v", a variable that the shell did not fill in.'] },
  ]);
  assert.deepEqual(bad.map((r) => r.status), ['warn', 'warn']);
  assert.match(bad[0].text, /"A".*D:\\x\.ps1 does not exist/);
  assert.match(bad[0].fix, /^delete and add it again with the right path \(task delete "A", then task add \.\.\.\)$/);
  const good = checkCommands([{ name: 'B', problems: [] }]);
  assert.deepEqual(good.map((r) => r.status), ['ok']);
  assert.match(good[0].text, /Each task's command points at files that exist/);
  assert.equal(checkCommands([]).length, 1);
});

test('doctor: a task pointing at a missing script is named; the watcher, system tasks and unreadable ones are skipped; nothing is changed', async () => {
  const mk = (name, actions, over = {}) => ({ ...TASKS[0], name, actions, ...over });
  const tasks = [
    mk('Broken', [{ execute: 'cmd.exe', arguments: '/c D:\\gone\\run.cmd', workingDirectory: '' }]),
    mk('Fine', [{ execute: 'cmd.exe', arguments: '/c D:\\here\\run.cmd', workingDirectory: '' }]),
    mk('No action', []),
    mk('Vendor', [{ execute: 'C:\\Vendor\\gone.exe', arguments: '' }], { author: 'Some Vendor', userId: '' }),
    WATCHER,
  ];
  const d = toastDeps({ files: memoryFiles(), tasks, now: new Date('2026-11-04T12:00:00'), pathFiles: ['D:\\here\\run.cmd'] });
  await main(['doctor'], d);
  const out = text(d);
  assert.match(out, /WARN +The command of "Broken" may not work: The path D:\\gone\\run\.cmd does not exist\./);
  assert.match(out, /Fix: delete and add it again with the right path \(task delete "Broken", then task add \.\.\.\)/);
  assert.doesNotMatch(out, /"Fine"|"No action"|"Vendor"|gone\.exe/);
  assert.equal(d.captured.writes.length, 0);
  assert.equal(d.captured.registry.length, 0);

  const clean = toastDeps({ files: memoryFiles(), tasks: [tasks[1], WATCHER], now: new Date('2026-11-04T12:00:00'), pathFiles: ['D:\\here\\run.cmd'] });
  await main(['doctor'], clean);
  assert.match(text(clean), /ok +Each task's command points at files that exist/);
});
