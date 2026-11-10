import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { COMMAND_HELP, HELP } from '../lib/help.mjs';
import { parseArgs } from '../lib/args.mjs';
import { fakeDeps } from './helpers.mjs';

const COMMANDS = ['add', 'on', 'off', 'run', 'delete', 'skip', 'unskip', 'notify', 'watch', 'ui', 'log', 'show', 'list', 'doctor'];

// Deps for which any contact with the outside world is a failure: the runner
// counts its calls, and the files, the launcher and the process helpers throw.
function guarded() {
  const d = fakeDeps({ answer: 'y' });
  const calls = [];
  d.run = async (script) => { calls.push(script); throw new Error('PowerShell must not be called'); };
  const trap = (what) => () => { throw new Error(`${what} must not be used`); };
  d.app = new Proxy({}, { get: (_t, k) => trap(`app.${String(k)}`) });
  d.launch = trap('launch');
  d.kill = trap('kill');
  d.ask = async () => { throw new Error('nothing may be asked'); };
  d.calls = calls;
  return d;
}

test('--help and -h, in any position, print help and run nothing, for every command', async () => {
  for (const cmd of COMMANDS) {
    for (const argv of [[cmd, '--help'], [cmd, '-h'], ['--help', cmd], [cmd, 'some name', '--yes', '-h']]) {
      const d = guarded();
      assert.equal(await main(argv, d), 0, argv.join(' '));
      assert.equal(d.calls.length, 0, `${argv.join(' ')} called PowerShell`);
      assert.equal(d.captured.err.length, 0);
      assert.match(d.captured.out[0], /^Usage: task /, `${argv.join(' ')} prints the usage of the command`);
    }
  }
});

test('watch --install --help and notify --install --help install nothing and ask nothing', async () => {
  for (const argv of [['watch', '--install', '--help'], ['watch', '--uninstall', '-h'], ['notify', '--install', '--yes', '--help'], ['notify', '--uninstall', '-h']]) {
    const d = guarded();
    assert.equal(await main(argv, d), 0);
    assert.equal(d.calls.length, 0);
    assert.equal(d.captured.writes.length, 0);
  }
});

test('task help, and task help <command>, print help without running anything', async () => {
  const general = guarded();
  assert.equal(await main(['help'], general), 0);
  assert.deepEqual(general.captured.out, HELP);
  const one = guarded();
  assert.equal(await main(['help', 'notify'], one), 0);
  assert.deepEqual(one.captured.out, COMMAND_HELP.notify);
  const unknown = guarded();
  assert.equal(await main(['help', 'nonsense'], unknown), 0);
  assert.deepEqual(unknown.captured.out, HELP, 'an unknown topic falls back to the general help');
  assert.equal(general.calls.length + one.calls.length + unknown.calls.length, 0);
});

test('help wins over an unknown option and over a missing value', async () => {
  const d = guarded();
  assert.equal(await main(['add', '--bogus', '--cwd', '--help'], d), 0);
  assert.equal(d.captured.err.length, 0);
});

test('the general help lists doctor and the new add and list options', () => {
  const text = HELP.join('\n');
  assert.match(text, /task doctor/);
  assert.match(text, /--cwd <dir>/);
  assert.match(text, /--project <label>/);
  assert.match(text, /--log/);
  for (const c of COMMANDS) assert.ok(COMMAND_HELP[c], `${c} has its own usage line`);
});

test('the parser takes --cwd and --project values (also --name=value) and reports a missing one', () => {
  assert.deepEqual(parseArgs(['add', 'x', '--cwd', 'D:\\a b', '--project=Alpha', '--log']).flags, { cwd: 'D:\\a b', project: 'Alpha', log: true });
  assert.deepEqual(parseArgs(['add', '--cwd']).missing, ['--cwd']);
  assert.deepEqual(parseArgs(['add', '--project=']).missing, ['--project']);
  assert.deepEqual(parseArgs(['add', '--log=1']).unknown, ['--log=1']);
  assert.deepEqual(parseArgs(['add', '--project', '-h']).flags, { project: '-h' });
});

test('a missing option value is reported and runs nothing', async () => {
  const d = fakeDeps();
  assert.equal(await main(['add', 'x', 'echo hi', 'daily 10:00', '--cwd'], d), 2);
  assert.match(d.captured.err.join('\n'), /--cwd needs a value/);
  assert.equal(d.captured.writes.length, 0);
});
