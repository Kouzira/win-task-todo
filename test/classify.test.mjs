import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnTask, LEGACY_MARKER, MARKER } from '../lib/classify.mjs';
import { TASKS, USER } from './helpers.mjs';

const own = (name) => isOwnTask(TASKS.find((t) => t.name === name), USER);

test('the owner\'s own tasks', () => {
  for (const n of ['Daily backup', 'Report sync', 'Nightly cleanup']) assert.equal(own(n), true, n);
});

test('vendor and system tasks are not own tasks, even when author or account match the user', () => {
  for (const n of ['Launch Adobe CCXProcess', 'StartCN', 'RtkAudUService64_BG', 'PlatformExperiencesHelper_Daily',
    'Printer Health Monitor', 'SoftLandingCreativeManagementTask', 'Test service']) assert.equal(own(n), false, n);
});

test('the Microsoft folder is always system, even when run from drive D:', () => {
  const t = { name: 'x', path: '\\Microsoft\\Windows\\X\\', author: 'alice', actions: [{ execute: 'D:\\a.exe', arguments: '' }] };
  assert.equal(isOwnTask(t, USER), false);
});

test('a path under the user profile, or this tool\'s marker, makes an own task', () => {
  const a = { name: 'x', path: '\\', actions: [{ execute: 'C:\\Users\\alice\\bin\\tool.exe', arguments: '' }] };
  assert.equal(isOwnTask(a, USER), true);
  const b = { name: 'y', path: '\\', description: MARKER, actions: [{ execute: 'cmd.exe', arguments: '/c echo' }] };
  assert.equal(isOwnTask(b, USER), true);
  // Tasks created before the translation carry the Vietnamese marker.
  assert.equal(isOwnTask({ ...b, description: `${LEGACY_MARKER}: x` }, USER), true);
});

test('a bare command such as cmd.exe needs a matching author or account', () => {
  const base = { name: 'z', path: '\\', userId: 'Someone', actions: [{ execute: 'cmd.exe', arguments: '/c echo hi' }] };
  assert.equal(isOwnTask({ ...base, author: 'Someone' }, USER), false);
  assert.equal(isOwnTask({ ...base, author: 'PC-01\\alice' }, USER), true);
});
