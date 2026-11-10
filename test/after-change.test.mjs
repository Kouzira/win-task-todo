import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { refreshAfterChange } from '../lib/after-change.mjs';
import { isPostScript } from '../lib/toast.mjs';
import { toastDeps } from './watch-helpers.mjs';

const text = (d) => d.captured.out.join('\n');
const UPDATED = /Cards updated\./;

// What a refresh is seen doing: it reads today's rows, so it asks Windows for
// the tool's keys and then posts the cards (the fake scheduler answers from
// canned data).
const refreshed = (d) => d.captured.posts.length > 0 && UPDATED.test(text(d));

const CHANGES = [
  ['add', ['add', 'Weekly report', 'echo hi', 'daily 10:00', '--yes']],
  ['on', ['on', 'Daily backup']],
  ['off', ['off', 'Daily backup']],
  ['delete', ['delete', 'Daily backup', '--yes']],
  ['skip', ['skip', 'Daily backup', '--yes']],
  ['unskip', ['unskip', 'Daily backup']],
];

test('every change refreshes the cards at once and says so in one line', async () => {
  for (const [name, argv] of CHANGES) {
    const d = toastDeps();
    assert.equal(await main(argv, d), 0, name);
    assert.ok(refreshed(d), `${name} refreshed the cards`);
    assert.equal(d.captured.out.filter((l) => UPDATED.test(l)).length, 1, `${name} says it once`);
    assert.ok(d.captured.writes.length > 0, `${name} changed the scheduler first`);
  }
});

test('the refresh happens after the change, never before it', async () => {
  const d = toastDeps();
  const order = [];
  const run = d.run;
  d.run = async (script) => {
    if (/Disable-ScheduledTask/.test(script)) order.push('change');
    if (isPostScript(script)) order.push('refresh');
    return run(script);
  };
  await main(['off', 'Daily backup'], d);
  assert.deepEqual(order, ['change', 'refresh']);
});

test('no refresh after a dry run, after answering no, or after a refused change', async () => {
  const dry = toastDeps();
  assert.equal(await main(['add', 'Weekly report', 'echo hi', 'daily 10:00', '--dry-run'], dry), 0);
  const skipDry = toastDeps();
  assert.equal(await main(['skip', 'Daily backup', '--dry-run'], skipDry), 0);
  const no = toastDeps({ answer: 'n' });
  assert.equal(await main(['delete', 'Daily backup'], no), 1);
  const noAdd = toastDeps({ answer: 'n' });
  assert.equal(await main(['add', 'Weekly report', 'echo hi', 'daily 10:00'], noAdd), 1);
  const system = toastDeps();
  assert.equal(await main(['off', 'Launch Adobe CCXProcess'], system), 1);
  for (const d of [dry, skipDry, no, noAdd, system]) {
    assert.equal(d.captured.posts.length, 0);
    assert.doesNotMatch(text(d), UPDATED);
  }
});

test('run does not refresh the cards', async () => {
  const d = toastDeps();
  assert.equal(await main(['run', 'Daily backup'], d), 0);
  assert.equal(d.captured.posts.length, 0);
});

test('when the notification part is not installed nothing is refreshed and nothing is said', async () => {
  const d = toastDeps({ installed: false });
  assert.equal(await main(['off', 'Daily backup'], d), 0);
  assert.equal(d.captured.posts.length, 0);
  assert.equal(d.captured.history.length, 0);
  assert.doesNotMatch(text(d), /Cards|cards/);
  assert.equal(d.captured.err.length, 0);
});

test('a failing refresh never changes the exit code', async () => {
  const d = toastDeps();
  const run = d.run;
  d.run = async (script) => {
    if (isPostScript(script)) throw new Error('PowerShell reported an error: simulated');
    return run(script);
  };
  assert.equal(await main(['on', 'Daily backup'], d), 0);
  assert.match(text(d), /Turned on task "Daily backup"/);
  assert.match(text(d), /could not be updated now/);
  assert.equal(d.captured.err.length, 0);
  assert.equal(await main(['add', 'Weekly report', 'echo hi', 'daily 10:00', '--yes'], d), 0);
  assert.equal(await main(['delete', 'Daily backup', '--yes'], d), 0);
});

test('a failing registry read is swallowed too, and without a tool folder there is no refresh', async () => {
  const d = toastDeps();
  d.run = async () => { throw new Error('boom'); };
  assert.equal(await refreshAfterChange(d), false);
  assert.deepEqual(d.captured.out, []);
  const bare = toastDeps();
  delete bare.app;
  assert.equal(await refreshAfterChange(bare), false);
  assert.equal(bare.captured.posts.length, 0);
});
