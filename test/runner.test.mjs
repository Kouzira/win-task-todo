import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { quoteArg, wrapWithLog } from '../lib/command.mjs';
import { parseRunnerArgs, rotate, runLogged } from '../lib/runner.mjs';

const LOG = 'D:\\logs\\Daily-backup.log';
const at = new Date('2026-11-04T10:00:00');

// An in-memory file system for the runner, with the same four operations.
function memoryIo(files = {}) {
  const store = new Map(Object.entries(files));
  const calls = [];
  return {
    store,
    calls,
    size: (f) => Buffer.byteLength(store.get(f) ?? ''),
    mkdir: (d) => calls.push(['mkdir', d]),
    append: (f, data) => store.set(f, (store.get(f) ?? '') + String(data)),
    rename: (a, b) => { calls.push(['rename', a, b]); store.set(b, store.get(a)); store.delete(a); },
    remove: (f) => { calls.push(['remove', f]); store.delete(f); },
  };
}

// A fake child process: the test emits its output and its end by hand.
function fakeSpawn(script) {
  const seen = [];
  const start = (file, args, options) => {
    seen.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => script(child));
    return child;
  };
  return { start, seen };
}

const OPTS = { log: LOG, exe: 'cmd.exe', args: '/c echo hi' };

test('a run: timestamp line, the output of the program, then exit <code>; the runner ends with that code', async () => {
  const io = memoryIo();
  const sp = fakeSpawn((c) => {
    c.stdout.emit('data', Buffer.from('backup started\n'));
    c.stderr.emit('data', Buffer.from('warning: slow disk\n'));
    c.emit('close', 3, null);
  });
  assert.equal(await runLogged(OPTS, { io, start: sp.start, now: () => at }), 3);
  assert.equal(io.store.get(LOG), '=== 2026-11-04 10:00:00 ===\nbackup started\nwarning: slow disk\nexit 3\n');
  assert.deepEqual(io.calls[0], ['mkdir', 'D:\\logs']);
});

test('the program is started with the argument string untouched, and a path with spaces keeps its quotes through argv0', async () => {
  const io = memoryIo();
  const sp = fakeSpawn((c) => c.emit('close', 0, null));
  await runLogged({ log: LOG, exe: 'powershell.exe', args: '-NoProfile -File "D:\\x y\\b.ps1"' }, { io, start: sp.start, now: () => at });
  assert.deepEqual(sp.seen[0].args, ['-NoProfile -File "D:\\x y\\b.ps1"']);
  assert.equal(sp.seen[0].file, 'powershell.exe');
  assert.equal(sp.seen[0].options.windowsVerbatimArguments, true);
  assert.equal(sp.seen[0].options.argv0, 'powershell.exe');
  const spaced = fakeSpawn((c) => c.emit('close', 0, null));
  await runLogged({ log: LOG, exe: '"C:\\Program Files\\Tool\\tool.exe"', args: '' }, { io, start: spaced.start, now: () => at });
  assert.equal(spaced.seen[0].file, 'C:\\Program Files\\Tool\\tool.exe');
  assert.equal(spaced.seen[0].options.argv0, '"C:\\Program Files\\Tool\\tool.exe"');
  assert.deepEqual(spaced.seen[0].args, []);
});

test('each run is appended: the log keeps earlier runs', async () => {
  const io = memoryIo();
  for (const code of [0, 1]) {
    const sp = fakeSpawn((c) => c.emit('close', code, null));
    await runLogged(OPTS, { io, start: sp.start, now: () => at });
  }
  assert.equal(io.store.get(LOG), '=== 2026-11-04 10:00:00 ===\nexit 0\n=== 2026-11-04 10:00:00 ===\nexit 1\n');
});

test('a program that cannot start is logged and ends with exit 1; a signal ends with 1 too', async () => {
  const io = memoryIo();
  const missing = fakeSpawn((c) => c.emit('error', new Error('spawn nope ENOENT')));
  assert.equal(await runLogged(OPTS, { io, start: missing.start, now: () => at }), 1);
  assert.match(io.store.get(LOG), /could not start cmd\.exe: spawn nope ENOENT\nexit 1\n$/);
  const throwing = await runLogged(OPTS, { io: memoryIo(), start: () => { throw new Error('bad'); }, now: () => at });
  assert.equal(throwing, 1);
  const killed = fakeSpawn((c) => c.emit('close', null, 'SIGTERM'));
  assert.equal(await runLogged(OPTS, { io: memoryIo(), start: killed.start, now: () => at }), 1);
});

test('exit is written once even when both error and close arrive', async () => {
  const io = memoryIo();
  const sp = fakeSpawn((c) => { c.emit('error', new Error('x')); c.emit('close', 0, null); });
  await runLogged(OPTS, { io, start: sp.start, now: () => at });
  assert.equal((io.store.get(LOG).match(/^exit /gm) ?? []).length, 1);
});

test('rotation: a log over the cap becomes .log.1 (replacing the old one) before the run; under the cap it is left alone', async () => {
  const big = 'x'.repeat(1024 * 1024 + 1);
  const io = memoryIo({ [LOG]: big, [`${LOG}.1`]: 'older' });
  const sp = fakeSpawn((c) => c.emit('close', 0, null));
  await runLogged(OPTS, { io, start: sp.start, now: () => at });
  assert.equal(io.store.get(`${LOG}.1`), big);
  assert.equal(io.store.get(LOG), '=== 2026-11-04 10:00:00 ===\nexit 0\n');
  const small = memoryIo({ [LOG]: 'x'.repeat(1024 * 1024) });
  assert.equal(rotate(small, LOG), false);
  assert.deepEqual(small.calls, []);
  assert.equal(rotate(memoryIo({ [LOG]: 'abcd' }), LOG, 3), true);
});

test('a log that cannot be written does not stop the program', async () => {
  const io = { ...memoryIo(), append: () => { throw new Error('disk full'); }, mkdir: () => { throw new Error('denied'); } };
  const sp = fakeSpawn((c) => c.emit('close', 7, null));
  assert.equal(await runLogged(OPTS, { io, start: sp.start, now: () => at }), 7);
});

test('runner arguments: all three are required and values come in pairs', () => {
  assert.deepEqual(parseRunnerArgs(['--log', 'a', '--exe', 'b', '--args', 'c d']), { log: 'a', exe: 'b', args: 'c d' });
  assert.deepEqual(parseRunnerArgs(['--args', '', '--log', 'a', '--exe', 'b']), { args: '', log: 'a', exe: 'b' });
  assert.equal(parseRunnerArgs(['--log', 'a', '--exe', 'b']), null);
  assert.equal(parseRunnerArgs(['--log', 'a', '--exe']), null);
  assert.equal(parseRunnerArgs(['--other', 'a']), null);
});

test('wrapWithLog: node runs the runner, the original action travels as two quoted arguments; the plain action is not touched', () => {
  const action = { execute: 'cmd.exe', arguments: '/c echo hi' };
  const wrapped = wrapWithLog(action, { nodePath: 'C:\\Tools\\node.exe', runnerPath: 'D:\\tools\\win-task-todo\\run-logged.mjs', logFile: LOG });
  assert.equal(wrapped.execute, 'C:\\Tools\\node.exe');
  assert.equal(wrapped.arguments, '"D:\\tools\\win-task-todo\\run-logged.mjs" --log "D:\\logs\\Daily-backup.log" --exe "cmd.exe" --args "/c echo hi"');
  assert.deepEqual(action, { execute: 'cmd.exe', arguments: '/c echo hi' });
});

// The real check of the quoting: a node child reads its command line back.
test('quoteArg survives a real command line round trip', { skip: process.platform !== 'win32' }, () => {
  const values = ['D:\\logs\\Daily backup.log', 'say "hi" there', 'C:\\dir with space\\', 'a\\"b', '-NoProfile -File "D:\\x y\\b.ps1"', '', 'plain'];
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const line = `-e ${quoteArg(script)} ${values.map(quoteArg).join(' ')}`;
  const r = spawnSync(process.execPath, [line], { argv0: `"${process.execPath}"`, windowsVerbatimArguments: true, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), values);
});
