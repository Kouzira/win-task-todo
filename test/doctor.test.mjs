import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_LIMIT_MIN, checkAppIds, checkHistory, checkInstalled, checkLogonTask, checkPath, checkRefresh, checkSettings,
  checkWatcher, expectedCards, lastRefreshFailure, settingsFindings, verdict,
} from '../lib/doctor.mjs';
import { findOnPath } from '../lib/doctor-probe.mjs';
import { isDisabled } from '../lib/skip-status.mjs';

const status = (list) => list.map((r) => r.status);
const only = (list) => { assert.equal(list.length, 1); return list[0]; };
const card = (name, over = {}) => ({ name, tag: `c${name}`, app: `WinTaskTodo.${name}`, posted: true, closed: false, ...over });

test('PATH: found is ok; missing is a warning with a fix naming the tool folder', () => {
  assert.equal(only(checkPath('C:\\Tools\\task.cmd', 'C:\\Tools')).status, 'ok');
  const r = only(checkPath(null, 'D:\\tools\\win-task-todo'));
  assert.equal(r.status, 'warn');
  assert.match(r.fix, /D:\\tools\\win-task-todo/);
});

test('findOnPath looks for task.cmd, task.exe and task.bat in each PATH folder, Path or PATH', () => {
  const have = new Set(['C:\\Tools\\task.cmd', 'E:\\Bin\\task.exe']);
  const exists = (f) => have.has(f);
  assert.equal(findOnPath({ PATH: 'C:\\Windows;"C:\\Tools"' }, exists), 'C:\\Tools\\task.cmd');
  assert.equal(findOnPath({ Path: 'C:\\Windows;E:\\Bin' }, exists), 'E:\\Bin\\task.exe');
  assert.equal(findOnPath({ PATH: 'C:\\Windows' }, exists), null);
  assert.equal(findOnPath({}, exists), null);
});

test('notification part: the scheme key decides', () => {
  const bad = only(checkInstalled({ scheme: false, ids: [] }));
  assert.equal(bad.status, 'fail');
  assert.match(bad.fix, /task notify --install/);
  const good = only(checkInstalled({ scheme: true, ids: ['WinTaskTodo', 'WinTaskTodo.0123456789abcde'] }));
  assert.equal(good.status, 'ok');
  assert.match(good.text, /1 task IDs/);
});

test('logon task: missing and off fail with their own fix, on is ok', () => {
  const missing = only(checkLogonTask(null, isDisabled));
  assert.deepEqual([missing.status, /watch --install/.test(missing.fix)], ['fail', true]);
  const off = only(checkLogonTask({ state: 'Disabled' }, isDisabled));
  assert.deepEqual([off.status, /task on "win-task-todo watch"/.test(off.fix)], ['fail', true]);
  assert.equal(only(checkLogonTask({ state: 'Ready' }, isDisabled)).status, 'ok');
});

test('watcher: alive, a stale lock, and no lock are told apart', () => {
  assert.equal(only(checkWatcher(321, { pid: 321 })).status, 'ok');
  const stale = only(checkWatcher(null, { pid: 99 }));
  assert.equal(stale.status, 'fail');
  assert.match(stale.text, /stale lock/);
  assert.match(stale.text, /pid 99/);
  const none = only(checkWatcher(null, null));
  assert.equal(none.status, 'fail');
  assert.doesNotMatch(none.text, /stale/);
  assert.match(none.fix, /task run/);
});

test('expected cards: pending, running, failed and a skip today; not done, off, none, the watcher, or a skip on another day', () => {
  const rows = [
    { name: 'P', kind: 'pending' }, { name: 'R', kind: 'running' }, { name: 'F', kind: 'failed' },
    { name: 'S', kind: 'skipped', status: 'Skipped 17:20, re-enabled at 17:21' },
    { name: 'S2', kind: 'skipped', status: 'Skipped 10:00, re-enabled at 10:01 on 2026-11-05' },
    { name: 'D', kind: 'done' }, { name: 'O', kind: 'off' }, { name: 'N', kind: 'none' }, { name: 'W', kind: 'watcher', watcher: true },
  ];
  const state = { cards: { cP: { dismissed: '2026-11-04' }, cR: { dismissed: null } } };
  const got = expectedCards(rows, state, '2026-11-04', (r) => `c${r.name}`, (tag) => `app.${tag}`);
  assert.deepEqual(got.map((c) => c.name), ['P', 'R', 'F', 'S']);
  assert.deepEqual(got.map((c) => [c.posted, c.closed]), [[true, true], [true, false], [false, false], [false, false]]);
  assert.equal(got[0].app, 'app.cP');
});

test('app IDs: every missing registration is its own failure; none expected is info', () => {
  const cards = [card('A'), card('B')];
  assert.deepEqual(status(checkAppIds(cards, ['WinTaskTodo.A', 'WinTaskTodo.B'])), ['ok']);
  const miss = checkAppIds(cards, ['WinTaskTodo.A']);
  assert.deepEqual(status(miss), ['fail']);
  assert.match(miss[0].text, /"B"/);
  assert.match(miss[0].fix, /task notify/);
  assert.equal(status(checkAppIds(cards, [])).length, 2);
  assert.deepEqual(status(checkAppIds([], [])), ['info']);
});

test('settings values: absent is the default (on); each of Enabled, ShowBanner and ShowInActionCenter at 0 is a finding', () => {
  assert.deepEqual(settingsFindings('A', undefined), []);
  assert.deepEqual(settingsFindings('A', { Enabled: 1, ShowBanner: 1, ShowInActionCenter: 1 }), []);
  const enabled = only(settingsFindings('A', { Enabled: 0 }));
  assert.deepEqual([enabled.status, /Enabled=0/.test(enabled.text), /Settings > System > Notifications/.test(enabled.fix)], ['fail', true, true]);
  const banner = only(settingsFindings('A', { ShowBanner: 0 }));
  assert.deepEqual([banner.status, /ShowBanner=0/.test(banner.text)], ['warn', true]);
  const center = only(settingsFindings('A', { ShowInActionCenter: 0 }));
  assert.deepEqual([center.status, /ShowInActionCenter=0/.test(center.text)], ['fail', true]);
  assert.deepEqual(status(settingsFindings('A', { Enabled: 0, ShowBanner: 0, ShowInActionCenter: 0 })), ['fail', 'fail', 'warn']);
});

test('settings check: the global switch, each app, and an honest note that Focus is not checked', () => {
  const cards = [card('A'), card('B')];
  const clean = checkSettings(cards, { toastEnabled: null, apps: {} });
  assert.deepEqual(status(clean), ['ok', 'info']);
  assert.match(clean[1].text, /Do not disturb \/ Focus is not checked/);
  assert.match(clean[1].text, /Settings > System > Notifications/);
  const off = checkSettings(cards, { toastEnabled: 0, apps: {} });
  assert.deepEqual(status(off), ['fail', 'info']);
  assert.match(off[0].text, /ToastEnabled=0/);
  const one = checkSettings(cards, { toastEnabled: 1, apps: { 'WinTaskTodo.B': { Enabled: 0 } } });
  assert.deepEqual(status(one), ['fail', 'info']);
  assert.match(one[0].text, /"B"/);
});

test('toast history: present, blocked, posted but gone, never posted, closed on purpose, and not installed', () => {
  const hist = (tags, blocked = [], installed = true) => ({ installed, tags, blocked });
  const cards = [card('A'), card('B')];
  const good = checkHistory(cards, hist(['cA', 'cB']));
  assert.deepEqual(status(good), ['ok']);
  assert.match(good[0].text, /2 of 2/);
  const gone = checkHistory(cards, hist(['cA']));
  assert.deepEqual(status(gone), ['ok', 'warn']);
  assert.match(gone[1].text, /"B" was posted but/);
  const never = checkHistory([card('A', { posted: false })], hist([]));
  assert.deepEqual(status(never), ['fail']);
  assert.match(never[0].text, /No card was ever posted for "A"/);
  const blocked = checkHistory(cards, hist(['cA'], ['cB']));
  assert.deepEqual(status(blocked), ['ok', 'fail']);
  assert.match(blocked[1].text, /blocks notifications for "B"/);
  const closed = checkHistory([card('A', { closed: true })], hist([]));
  assert.deepEqual(status(closed), ['info']);
  const notInstalled = checkHistory(cards, hist([], [], false));
  assert.deepEqual(status(notInstalled), ['fail']);
  assert.match(notInstalled[0].fix, /--install/);
});

test('watch.log: a failure after the last success is reported; a later recovery or restart clears it', () => {
  const failed = '2026-11-04 12:00:00 refresh failed (1 in a row): PowerShell reported an error: simulated; next retry at 12:00:30';
  assert.deepEqual(lastRefreshFailure(`2026-11-04 11:00:00 watcher started, pid 5\n${failed}\n`), { at: '2026-11-04 12:00:00', text: 'PowerShell reported an error: simulated; next retry at 12:00:30'.slice(0, 120) });
  assert.equal(lastRefreshFailure(`${failed}\n2026-11-04 12:01:00 refresh recovered after 1 failures\n`), null);
  assert.equal(lastRefreshFailure(`${failed}\n2026-11-04 12:05:00 watcher started, pid 9\n`), null);
  assert.equal(lastRefreshFailure(''), null);
  assert.equal(lastRefreshFailure(null), null);
  assert.ok(lastRefreshFailure('2026-11-04 12:00:00 watcher loop failed (2 in a row): boom; next retry at 12:01:00'));
});

test('refresh age: fine within 35 minutes, a warning beyond it only while the watcher is alive; the 30 minute sleep is always explained', () => {
  const now = Date.parse('2026-11-04T12:00:00');
  const min = (m) => now - m * 60000;
  const fresh = checkRefresh({ mtimeMs: min(10), nowMs: now, watcherAlive: true, failure: null });
  assert.deepEqual(status(fresh), ['ok']);
  assert.match(fresh[0].text, /10 minutes ago/);
  assert.match(fresh[0].text, /sleeps up to 30 minutes/);
  assert.match(checkRefresh({ mtimeMs: min(1), nowMs: now, watcherAlive: true, failure: null })[0].text, /1 minute ago/);
  assert.deepEqual(status(checkRefresh({ mtimeMs: min(REFRESH_LIMIT_MIN), nowMs: now, watcherAlive: true, failure: null })), ['ok']);
  const stale = checkRefresh({ mtimeMs: min(REFRESH_LIMIT_MIN + 1), nowMs: now, watcherAlive: true, failure: null });
  assert.deepEqual(status(stale), ['warn']);
  assert.match(stale[0].fix, /watch\.log/);
  assert.deepEqual(status(checkRefresh({ mtimeMs: min(300), nowMs: now, watcherAlive: false, failure: null })), ['ok']);
  assert.deepEqual(status(checkRefresh({ mtimeMs: null, nowMs: now, watcherAlive: true, failure: null })), ['warn']);
  const failing = checkRefresh({ mtimeMs: min(2), nowMs: now, watcherAlive: true, failure: { at: '2026-11-04 11:58:00', text: 'boom' } });
  assert.deepEqual(status(failing), ['ok', 'warn']);
  assert.match(failing[1].text, /11:58:00: boom/);
});

test('the verdict counts problems and warnings', () => {
  assert.match(verdict([{ status: 'ok' }, { status: 'info' }]), /everything checked is fine/);
  assert.match(verdict([{ status: 'warn' }, { status: 'ok' }]), /no hard problem, 1 warning\./);
  assert.match(verdict([{ status: 'fail' }, { status: 'fail' }, { status: 'warn' }]), /2 problems found, 1 warning\./);
  assert.match(verdict([{ status: 'fail' }]), /1 problem found\./);
});
