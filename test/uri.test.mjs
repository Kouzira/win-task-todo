import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { issueToken, tokenFile } from '../lib/cancel-token.mjs';
import { cardTag } from '../lib/toast.mjs';
import { parseUri } from '../lib/uri.mjs';
import { INFO, TASKS } from './helpers.mjs';
import { TOKEN, WATCHER, memoryFiles, toastDeps } from './watch-helpers.mjs';

const kind = (w) => /(Register|Enable|Disable|Unregister|Start)-ScheduledTask/.exec(w.script)[1];
const OTHER = 'cd'.repeat(16);
const TAG = cardTag({ path: '\\', name: 'Report sync' });
// The watcher and the morning task with a run due today, so the tests prove
// a token reaches only its own task, and never the watcher.
const TASKS_W = [...TASKS, WATCHER];
const INFO_W = {
  ...INFO,
  '\\win-task-todo watch': { lastRun: '2026-11-04T08:00:00', nextRun: '2026-11-04T18:00:00', lastResult: 0 },
  '\\Daily backup': { lastRun: '2026-11-03T10:00:00', nextRun: '2026-11-04T19:00:00', lastResult: 0 },
};
const EVENING = { tag: TAG, name: 'Report sync', path: '\\', runAt: '2026-11-04T17:20:00' };

function withToken({ task = EVENING, day = '2026-11-04', now = new Date('2026-11-04T12:00:00'), token = 0xab } = {}) {
  const files = memoryFiles();
  issueToken(files, { now, random: (n) => Buffer.alloc(n, token), day, task });
  return files;
}

const HOSTILE = [
  'wintasktodo:stop', 'wintasktodo:disable', 'wintasktodo:disable?x', 'wintasktodo:../../', 'wintasktodo:open%20&calc',
  'Report sync', 'wintasktodo:Report sync', 'wintasktodo:open/', 'wintasktodo://open', 'wintasktodo:open ', ' wintasktodo:open',
  'wintasktodo:open?x=1', 'wintasktodo:open&calc', 'wintasktodo:open"', `wintasktodo:open/${TAG}/x`, 'wintasktodo:open/c123',
  'wintasktodo:open/Report sync', 'wintasktodo:open/..\\..\\x', `wintasktodo:open/q${TAG.slice(1)}`, 'wintasktodo:cancel-today',
  'wintasktodo:cancel-today/', 'wintasktodo:cancel-today/xyz', `wintasktodo:cancel-today/${TOKEN.slice(1)}`, `wintasktodo:cancel-today/${TOKEN}0`,
  `wintasktodo:cancel-today/${TOKEN}?x`, `wintasktodo:cancel-today/${TOKEN}/Report sync`, `wintasktodo:cancel-today/../${TOKEN}`,
  'D:\\Projects\\win-task-todo\\tasks.mjs', 'wintasktodo:', '', 'cmd /c calc', 'http://example.com', 'wintasktodo:open\nwintasktodo:open',
];

test('accepts only open, open/<card tag> and cancel-today/<token>, case-insensitively', () => {
  assert.deepEqual(parseUri(['wintasktodo:open']), { action: 'open', tag: null });
  assert.deepEqual(parseUri(['WinTaskTodo:OPEN']), { action: 'open', tag: null });
  assert.deepEqual(parseUri([`wintasktodo:open/${TAG.toUpperCase()}`]), { action: 'open', tag: TAG });
  assert.deepEqual(parseUri([`wintasktodo:cancel-today/${TOKEN}`]), { action: 'cancel-today', token: TOKEN });
  assert.deepEqual(parseUri([`WINTASKTODO:CANCEL-TODAY/${TOKEN.toUpperCase()}`]), { action: 'cancel-today', token: TOKEN });
});

test('every other URI, hostile ones included, is refused and logged as one line, touching nothing', async () => {
  for (const uri of HOSTILE) assert.equal(parseUri([uri]), null, JSON.stringify(uri));
  assert.equal(parseUri(['wintasktodo:open', '--yes']), null);
  for (const argv of [...HOSTILE.map((u) => [u]), ['wintasktodo:open', 'x'], []]) {
    const files = withToken();
    const d = toastDeps({ files, tasks: TASKS_W, info: INFO_W });
    assert.equal(await main(['uri', ...argv], d), 2, JSON.stringify(argv));
    assert.equal(d.captured.writes.length, 0);
    assert.equal(d.captured.launched.length, 0);
    assert.equal(files.exists('card-opened.json'), false);
    assert.ok(files.exists(tokenFile(TAG)), 'the real token is untouched');
    assert.match(files.read('watch.log'), /uri refused/);
    assert.equal(files.read('watch.log').trim().split('\n').length, 1, 'one log line, a new line cannot be forged');
  }
});

test('open starts task ui in Windows Terminal, or through cmd without it; records a click only for a card the watcher tracks', async () => {
  const files = memoryFiles({ 'state.json': JSON.stringify({ cards: { [TAG]: { name: 'Report sync' } }, reported: [] }) });
  const d = toastDeps({ files });
  assert.equal(await main(['uri', `wintasktodo:open/${TAG}`], d), 0);
  assert.deepEqual(d.captured.launched, [{ cmd: 'wt.exe', args: ['-w', 'new', 'C:\\Tools\\node.exe', 'D:\\Projects\\win-task-todo\\tasks.mjs', 'ui'] }]);
  assert.deepEqual(JSON.parse(files.read('card-opened.json')), { [TAG]: d.now().getTime() });
  await main(['uri', `wintasktodo:open/c${'0'.repeat(15)}`], d);
  assert.deepEqual(Object.keys(JSON.parse(files.read('card-opened.json'))), [TAG], 'an unknown tag is not recorded');
  await main(['uri', 'wintasktodo:open'], d);
  assert.deepEqual(Object.keys(JSON.parse(files.read('card-opened.json'))), [TAG], 'a bare open records nothing');
  const old = toastDeps({ launchOk: (cmd) => cmd !== 'wt.exe' });
  await main(['uri', 'wintasktodo:open'], old);
  assert.deepEqual(old.captured.launched[1], { cmd: 'cmd.exe', args: ['/c', 'start "" cmd /k ""C:\\Tools\\node.exe" "D:\\Projects\\win-task-todo\\tasks.mjs" ui"'], verbatim: true });
  assert.equal(d.captured.writes.length + old.captured.writes.length, 0);
});

test('cancel today with the right token: skips exactly one task through skip (helper first, then off), touching no other task or the watcher', async () => {
  const files = withToken();
  const d = toastDeps({ files, tasks: TASKS_W, info: INFO_W });
  assert.equal(await main(['uri', `wintasktodo:cancel-today/${TOKEN}`], d), 0);
  assert.deepEqual(d.captured.writes.map(kind), ['Register', 'Disable']);
  assert.equal(d.captured.writes[0].data.name, 'task re-enable Report sync');
  assert.equal(d.captured.writes[1].data.name, 'Report sync');
  assert.ok(d.captured.writes.every((w) => !/win-task-todo watch|Daily backup/.test(JSON.stringify(w.data))));
  assert.equal(files.exists(tokenFile(TAG)), false);
  assert.match(files.read('watch.log'), /cancel today: Report sync: skipped/);
});

test('the token of task A cannot cancel task B; a missing, wrong, expired, used or other-day token does nothing', async () => {
  const tryIt = async (files, token, now) => {
    const d = toastDeps({ files, tasks: TASKS_W, info: INFO_W });
    if (now) d.clock.now = now;
    await main(['uri', `wintasktodo:cancel-today/${token}`], d);
    return d.captured.writes.map((w) => w.data.name);
  };
  const MORNING = { tag: cardTag({ path: '\\', name: 'Daily backup' }), name: 'Daily backup', path: '\\', runAt: '2026-11-04T19:00:00' };
  const both = withToken();
  issueToken(both, { now: new Date('2026-11-04T12:00:00'), random: (n) => Buffer.alloc(n, 0xcd), day: '2026-11-04', task: MORNING });
  assert.deepEqual(await tryIt(both, OTHER), ['task re-enable Daily backup', 'Daily backup'], 'the token of morning cancels only morning');
  assert.deepEqual(await tryIt(both, TOKEN), ['task re-enable Report sync', 'Report sync'], 'the token of evening cancels only evening');
  assert.deepEqual(await tryIt(memoryFiles(), TOKEN), [], 'no token at all');
  const wrong = withToken();
  assert.deepEqual(await tryIt(wrong, OTHER), [], 'wrong token');
  assert.equal((await tryIt(wrong, TOKEN)).length, 2, 'a wrong guess does not burn the real token');
  assert.deepEqual(await tryIt(withToken(), TOKEN, new Date('2026-11-04T12:15:00')), [], 'expires after 15 minutes');
  assert.equal((await tryIt(withToken(), TOKEN, new Date('2026-11-04T12:14:00'))).length, 2, 'still valid');
  const used = withToken();
  assert.equal((await tryIt(used, TOKEN)).length, 2);
  assert.deepEqual(await tryIt(used, TOKEN), [], 'reuse');
  assert.deepEqual(await tryIt(withToken({ day: '2026-11-03' }), TOKEN), [], 'token of another day');
  assert.match(used.read('watch.log'), /no token matched/);
});

test('a token cancels only the run that was asked about: a moved or past run does nothing, and neither does a token tied to the watcher', async () => {
  const moved = toastDeps({ files: withToken({ task: { ...EVENING, runAt: '2026-11-04T16:00:00' } }), tasks: TASKS_W, info: INFO_W });
  await main(['uri', `wintasktodo:cancel-today/${TOKEN}`], moved);
  assert.equal(moved.captured.writes.length, 0);
  const late = toastDeps({ files: withToken({ now: new Date('2026-11-04T17:15:00') }), tasks: TASKS_W, info: INFO_W });
  late.clock.now = new Date('2026-11-04T17:25:00');
  await main(['uri', `wintasktodo:cancel-today/${TOKEN}`], late);
  assert.equal(late.captured.writes.length, 0);
  const watcher = { tag: cardTag(WATCHER), name: WATCHER.name, path: '\\', runAt: '2026-11-04T18:00:00' };
  const w = toastDeps({ files: withToken({ task: watcher }), tasks: TASKS_W, info: INFO_W });
  await main(['uri', `wintasktodo:cancel-today/${TOKEN}`], w);
  assert.equal(w.captured.writes.length, 0);
});
