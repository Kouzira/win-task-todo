import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { LEAVE_MS, cardFate, refreshCards, remainingToday } from '../lib/notify.mjs';
import { ASK_GROUP, GROUP, appIdOf, askXml, cardTag, cardText, cardXml, todayRows } from '../lib/toast.mjs';
import { buildRows } from '../lib/ui-model.mjs';
import { INFO, TASKS } from './helpers.mjs';
import { TOKEN, WATCHER, memoryFiles, toastDeps } from './watch-helpers.mjs';

const tagOf = (name) => cardTag({ path: '\\', name });
const EVENING = tagOf('Report sync');
const MORNING = tagOf('Daily backup');
const CRYPTO = tagOf('Nightly cleanup');
const at = (s) => new Date(`2026-11-04T${s}`);
const all = (d) => d.captured.posts.flat();
const cardsOf = (d, i) => d.captured.posts[i].filter((t) => t.group === GROUP);
const asks = (d) => all(d).filter((t) => t.group === ASK_GROUP);
const FAILED = { ...INFO, '\\Report sync': { lastRun: '2026-11-04T09:30:00', nextRun: '2026-11-04T17:20:00', lastResult: -1073741510 } };
const evening = (info) => ({ ...INFO, '\\Report sync': info });

// One deps object whose scheduler data can change between refreshes, as the
// real one does when a task runs.
function scene(info = INFO, now = '12:00:00') {
  const files = memoryFiles();
  let current = info;
  const d = toastDeps({ files, clock: { now: at(now) } });
  const make = () => toastDeps({ files, info: current, clock: d.clock, share: d });
  return { d, files, refresh: () => refreshCards(make(), files), set: (i) => { current = i; } };
}

test('a card is the task name over one status line, escapes <, &, quotes; no buttons, no header', () => {
  const row = { name: 'Daily backup', path: '\\', kind: 'done', at: '10:00' };
  const x = cardXml(row, 'A<b>&"c\'</text><action/>');
  assert.ok(x.includes('<text>Daily backup</text><text>A&lt;b&gt;&amp;&quot;c&apos;&lt;/text&gt;&lt;action/&gt;</text>'));
  assert.equal((x.match(/<text>/g) ?? []).length, 2, 'title and status, nothing else');
  assert.match(cardXml(row), /<text>Daily backup<\/text><text>Done at 10:00<\/text>/);
  assert.match(cardXml({ ...row, name: 'A<B' }), /<text>A&lt;B<\/text>/);
  assert.doesNotMatch(x, /<action|<header|imageUri/);
  assert.match(x, new RegExp(`^<toast activationType="protocol" launch="wintasktodo:open/${cardTag(row)}">`));
  const a = askXml('Report sync', '17:20', TOKEN);
  assert.match(a, /<text>Report sync<\/text><text>Cancel today&apos;s run at 17:20\?<\/text>/);
  assert.match(a, new RegExp(`<action content="Cancel today" activationType="protocol" arguments="wintasktodo:cancel-today/${TOKEN}"/>`));
  assert.match(a, /<action content="Keep" activationType="system" arguments="dismiss"\/>/);
  assert.doesNotMatch(a, /<header/);
});

test('each task has its own Tag and AppUserModelID, stable by path and name', async () => {
  const { rows } = await buildRows(toastDeps({ tasks: [...TASKS, WATCHER] }));
  const today = todayRows(rows);
  assert.deepEqual(today.map((r) => r.name).sort(), ['Daily backup', 'Nightly cleanup', 'Report sync']);
  assert.deepEqual(Object.fromEntries(today.map((r) => [r.name, cardText(r)])), { 'Daily backup': 'Done at 10:00', 'Report sync': 'Runs today at 17:20', 'Nightly cleanup': 'Running since 09:27' });
  const ids = today.map((r) => appIdOf(cardTag(r)));
  assert.ok(ids.every((id) => /^WinTaskTodo\.[0-9a-f]{15}$/.test(id)));
  assert.equal(new Set(ids).size, 3);
  assert.equal(appIdOf(cardTag({ path: '\\', name: 'Report sync' })), appIdOf(EVENING));
  assert.notEqual(cardTag({ path: '\\A\\', name: 'x' }), cardTag({ path: '\\B\\', name: 'x' }));
  assert.equal(cardText({ kind: 'skipped', status: 'Skipped 17:20, re-enabled at 17:21' }), 'Skipped today, back on at 17:21');
});

test('first refresh (logon): every card silent, a finished task has no card, a failed task has a silent "Failed" card; each card under its own ID', async () => {
  const s = scene(FAILED);
  const res = await s.refresh();
  const posted = cardsOf(s.d, 0);
  assert.deepEqual(posted.map((t) => t.tag).sort(), [CRYPTO, EVENING].sort());
  assert.ok(posted.every((t) => t.suppress === true && !t.expires));
  assert.ok(posted.every((t) => t.app === appIdOf(t.tag)));
  assert.match(posted.find((t) => t.tag === EVENING).xml, /<text>Report sync<\/text><text>Failed at 09:30 \(code 0xC000013A\)<\/text>/);
  assert.deepEqual(s.d.captured.registered.map((r) => r.name).sort(), ['Nightly cleanup', 'Report sync']);
  assert.equal(res.cards[MORNING], undefined);
  await s.refresh();
  assert.equal(s.d.captured.posts.length, 1, 'nothing changed, so nothing is posted or registered again');
});

test('a successful run: banner and sound, then it leaves by itself; a card that leaves never leads to a question', async () => {
  const s = scene();
  await s.refresh();
  s.set(evening({ lastRun: '2026-11-04T17:20:00', nextRun: '2026-11-05T17:20:00', lastResult: 0 }));
  s.d.clock.now = at('17:21:00');
  const res = await s.refresh();
  const done = cardsOf(s.d, 1).find((t) => t.tag === EVENING);
  assert.equal(done.suppress, false);
  assert.match(done.xml, /<text>Done at 17:20<\/text>/);
  assert.equal(new Date(done.expires).getTime(), at('17:21:00').getTime() + LEAVE_MS);
  assert.equal(res.cards[EVENING].until, at('17:21:00').getTime() + LEAVE_MS);
  s.d.sim.center.delete(EVENING);
  s.d.clock.now = at('17:22:00');
  await s.refresh();
  s.d.clock.now = at('17:30:00');
  await s.refresh();
  assert.equal(asks(s.d).length, 0);
  assert.ok(s.d.captured.removed.includes(EVENING), 'the tool removes the card to be sure after it expires');
  assert.equal(all(s.d).filter((t) => t.tag === EVENING && !t.suppress).length, 1, 'one banner per run');
});

test('a failed run: banner, no expiry, stays; closing a failed card asks nothing', async () => {
  const s = scene();
  await s.refresh();
  s.set(evening({ lastRun: '2026-11-04T12:10:00', nextRun: '2026-11-04T17:20:00', lastResult: 1 }));
  s.d.clock.now = at('12:11:00');
  await s.refresh();
  const fail = cardsOf(s.d, 1).find((t) => t.tag === EVENING);
  assert.deepEqual([fail.suppress, fail.expires], [false, undefined]);
  assert.match(fail.xml, /Failed at 12:10 \(code 1\)/);
  s.d.clock.now = at('12:40:00');
  await s.refresh();
  assert.equal(all(s.d).filter((t) => t.tag === EVENING && !t.suppress).length, 1, 'no banner twice for one run');
  s.d.sim.center.delete(EVENING);
  s.d.clock.now = at('12:45:00');
  await s.refresh();
  assert.equal(asks(s.d).length, 0);
  assert.equal(s.d.captured.writes.length, 0);
});

test('running and then done (the same run) is also an end; with a later run today the "Runs today" card returns silently', async () => {
  const s = scene(evening({ lastRun: '2026-11-04T11:50:00', nextRun: '2026-11-04T15:00:00', lastResult: 267009 }));
  await s.refresh();
  s.set(evening({ lastRun: '2026-11-04T11:50:00', nextRun: '2026-11-04T15:00:00', lastResult: 0 }));
  s.d.clock.now = at('12:02:00');
  await s.refresh();
  const done = cardsOf(s.d, 1).find((t) => t.tag === EVENING);
  assert.deepEqual([done.suppress, /Done at 11:50/.test(done.xml), Boolean(done.expires)], [false, true, true]);
  s.d.clock.now = at('12:02:30');
  await s.refresh();
  assert.equal(s.d.captured.posts.length, 2, 'while the "Done" card is still showing it is not replaced');
  s.d.clock.now = new Date(at('12:02:00').getTime() + LEAVE_MS + 1000);
  await s.refresh();
  const back = cardsOf(s.d, 2).find((t) => t.tag === EVENING);
  assert.deepEqual([back.suppress, /Runs today at 15:00/.test(back.xml)], [true, true]);
});

test('a routine refresh is always silent; a new day (logon) has no banner', async () => {
  const s = scene();
  await s.refresh();
  s.d.clock.now = at('12:31:00');
  await s.refresh();
  assert.ok(all(s.d).every((t) => t.suppress === true));
  s.set({ ...INFO, '\\Daily backup': { lastRun: '2026-11-05T10:00:00', nextRun: '2026-11-06T10:00:00', lastResult: 0 }, '\\Report sync': { lastRun: '2026-11-04T17:20:00', nextRun: '2026-11-05T17:20:00', lastResult: 0 } });
  s.d.clock.now = new Date('2026-11-05T11:00:00');
  await s.refresh();
  assert.ok(all(s.d).every((t) => t.suppress === true));
});

test('closing a card asks only about that task, under its ID; Clear all asks only tasks with a run left today', async () => {
  const s = scene();
  await s.refresh();
  s.d.sim.center.delete(EVENING);
  s.d.clock.now = at('12:05:00');
  const res = await s.refresh();
  assert.deepEqual(res.asked, ['Report sync']);
  const [q] = asks(s.d);
  assert.deepEqual([q.tag, q.app, q.suppress], [`q${EVENING.slice(1)}`, appIdOf(EVENING), false]);
  const saved = JSON.parse(s.files.read(`cancel-${EVENING}.json`));
  assert.deepEqual([saved.name, saved.runAt], ['Report sync', '2026-11-04T17:20:00']);
  const c = scene();
  await c.refresh();
  c.d.sim.center.clear();
  c.d.clock.now = at('12:05:00');
  await c.refresh();
  assert.deepEqual(asks(c.d).map((t) => t.tag), [`q${EVENING.slice(1)}`], 'a running task is not asked');
});

test('clicking a card excuses only that card\'s question; a bare open excuses nothing; Keep leaves no trace', async () => {
  const s = scene({ ...INFO, '\\Nightly cleanup': { lastRun: '2026-11-03T01:00:00', nextRun: '2026-11-04T18:00:00', lastResult: 0 } });
  await s.refresh();
  s.d.clock.now = at('12:05:00');
  await main(['uri', `wintasktodo:open/${EVENING}`], toastDeps({ files: s.files, clock: s.d.clock }));
  await main(['uri', 'wintasktodo:open'], toastDeps({ files: s.files, clock: s.d.clock }));
  s.d.sim.center.clear();
  await s.refresh();
  assert.deepEqual(asks(s.d).map((t) => t.tag), [`q${CRYPTO.slice(1)}`]);
  assert.deepEqual(cardsOf(s.d, 1).map((t) => [t.tag, t.suppress]), [[EVENING, true]]);
  // [Keep]: the question goes, nothing is recorded; once its token expires the file goes too.
  for (const time of ['12:10:00', '12:30:00', '13:00:00']) { s.d.clock.now = at(time); await s.refresh(); }
  assert.equal(asks(s.d).length, 1);
  assert.equal(s.files.list().filter((n) => n.startsWith('cancel-')).length, 0);
});

test('notifications of a task turned off in Settings: its card is not taken as closed, notify says so', async () => {
  assert.equal(cardFate({ tag: 'c1', postedAt: 5 }, { installed: true, tags: [], blocked: ['c1'] }, 0), 'present');
  assert.equal(cardFate({ tag: 'c1', postedAt: 5 }, { installed: true, tags: [], blocked: [] }, 6), 'opened');
  assert.equal(cardFate({ tag: 'c1', postedAt: 5 }, { installed: true, tags: [], blocked: [] }, 4), 'dismissed');
  const s = scene();
  await s.refresh();
  s.d.sim.blocked.add(appIdOf(EVENING));
  s.d.sim.center.delete(EVENING);
  await s.refresh();
  assert.equal(asks(s.d).length, 0);
  const d = toastDeps();
  d.sim.blocked.add(appIdOf(EVENING));
  await main(['notify'], d);
  assert.match(d.captured.err.join('\n'), /blocking notifications for: Report sync/);
});

test('a task deleted from Task Scheduler has its ID removed; an empty list removes nothing; the watcher is never cancelled', async () => {
  const s = scene();
  await s.refresh();
  const gone = toastDeps({ files: s.files, tasks: TASKS.filter((t) => t.name !== 'Report sync'), share: s.d });
  s.d.captured.removed.length = 0;
  await refreshCards(gone, s.files);
  assert.deepEqual(gone.captured.unregistered, [appIdOf(EVENING)]);
  assert.ok(!gone.captured.removed.includes(EVENING), 'removing the ID removes its card as well');
  const empty = toastDeps({ files: s.files, tasks: [] });
  await refreshCards(empty, s.files);
  assert.deepEqual(empty.captured.unregistered, []);
  const info = { ...INFO, '\\win-task-todo watch': { lastRun: '2026-11-04T08:00:00', nextRun: '2026-11-04T18:00:00', lastResult: 267009 } };
  const { rows } = await buildRows(toastDeps({ tasks: [...TASKS, WATCHER], info }));
  assert.deepEqual(remainingToday(rows, at('12:00:00')).map((r) => r.name), ['Report sync']);
  assert.ok(!todayRows(rows).some((r) => r.watcher));
});

test('task notify: --install writes only the URI scheme; --uninstall lists and removes every ID of the tool and nothing else', async () => {
  const no = toastDeps({ installed: false });
  assert.equal(await main(['notify'], no), 1);
  assert.match(no.captured.err.join('\n'), /task notify --install/);
  const ins = toastDeps();
  assert.equal(await main(['notify', '--install', '--yes'], ins), 0);
  assert.deepEqual(ins.captured.registry[0].data.keys.map((k) => k.path), ['Software\\Classes\\wintasktodo', 'Software\\Classes\\wintasktodo\\shell\\open\\command']);
  const ids = ['WinTaskTodo', appIdOf(EVENING), appIdOf(MORNING)];
  const un = toastDeps({ ids, answer: 'n' });
  assert.equal(await main(['notify', '--uninstall'], un), 1);
  const plan = un.captured.out.join('\n');
  assert.deepEqual(plan.match(/HKCU\\\S+/g), ['HKCU\\Software\\Classes\\wintasktodo', ...ids.map((id) => `HKCU\\Software\\Classes\\AppUserModelId\\${id}`)]);
  assert.equal(un.captured.registry.length, 0);
  const yes = toastDeps({ ids });
  await main(['notify', '--uninstall', '--yes'], yes);
  assert.deepEqual(yes.captured.registry[0].data.ids, ids);
  assert.match(yes.captured.registry[0].script, /DeleteSubKeyTree\('Software\\Classes\\wintasktodo'/);
});
