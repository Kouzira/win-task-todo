import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleError, parseSchedule } from '../lib/schedule-parse.mjs';
import { specWords, triggerWords, triggersSummary } from '../lib/schedule-words.mjs';

const NOW = new Date('2026-11-04T12:00:00');
const p = (s) => parseSchedule(s, NOW);

test('daily, case-insensitive', () => {
  assert.deepEqual(p('daily 10:00'), { kind: 'daily', time: '10:00' });
  assert.deepEqual(p('Every Day 9:05'), { kind: 'daily', time: '09:05' });
  assert.deepEqual(p('DAILY 10:00'), { kind: 'daily', time: '10:00' });
  assert.deepEqual(p('every day at 10:00'), { kind: 'daily', time: '10:00' });
});

test('weekdays', () => {
  assert.deepEqual(p('weekdays 17:20'), { kind: 'weekdays', time: '17:20' });
  assert.deepEqual(p('every weekday at 10:00'), { kind: 'weekdays', time: '10:00' });
});

test('days of the week', () => {
  assert.deepEqual(p('mon,wed 09:30'), { kind: 'weekly', days: [1, 3], time: '09:30' });
  assert.deepEqual(p('Sunday, Saturday 08:00'), { kind: 'weekly', days: [6, 7], time: '08:00' });
  assert.deepEqual(p('fri 23:59'), { kind: 'weekly', days: [5], time: '23:59' });
  assert.deepEqual(p('Mon, Wed at 09:30'), { kind: 'weekly', days: [1, 3], time: '09:30' });
});

test('once, two date forms', () => {
  assert.deepEqual(p('once 2026-11-05 10:00'), { kind: 'once', date: '2026-11-05', time: '10:00' });
  assert.deepEqual(p('once 05/11/2026 10:00'), { kind: 'once', date: '2026-11-05', time: '10:00' });
});

test('at logon', () => {
  assert.deepEqual(p('At Logon'), { kind: 'logon' });
  assert.deepEqual(p('at logon'), { kind: 'logon' });
});

// The Vietnamese forms the tool accepted before it was translated. They are
// not documented any more, but schedules typed from old notes must still work.
test('the Vietnamese forms are still accepted', () => {
  assert.deepEqual(p('mỗi ngày 10:00'), { kind: 'daily', time: '10:00' });
  assert.deepEqual(p('Mỗi Ngày 9:05'), { kind: 'daily', time: '09:05' });
  assert.deepEqual(p('moi ngay 10:00'), { kind: 'daily', time: '10:00' });
  assert.deepEqual(p('mỗi ngày làm việc 10:00'), { kind: 'weekdays', time: '10:00' });
  assert.deepEqual(p('thứ hai,thứ tư 09:30'), { kind: 'weekly', days: [1, 3], time: '09:30' });
  assert.deepEqual(p('Chủ nhật, thứ bảy 08:00'), { kind: 'weekly', days: [6, 7], time: '08:00' });
  assert.deepEqual(p('một lần 2026-11-05 10:00'), { kind: 'once', date: '2026-11-05', time: '10:00' });
  assert.deepEqual(p('một lần 05/11/2026 10:00'), { kind: 'once', date: '2026-11-05', time: '10:00' });
  assert.deepEqual(p('khi đăng nhập'), { kind: 'logon' });
});

test('bad input gives a clear English error', () => {
  const bad = [
    ['', /No schedule given/],
    ['daily', /missing a time/],
    ['daily 25:00', /not valid/],
    ['daily 10:60', /not valid/],
    ['thursdee 10:00', /Unknown day/],
    ['mon,xyz 10:00', /Unknown day "xyz"/],
    ['once 2026-02-30 10:00', /does not exist/],
    ['once 2026-11-03 10:00', /already passed/],
    ['once 10:00', /needs a date and a time/],
    ['once 5-11-2026 10:00', /not in YYYY-MM-DD/],
    ['whatever 10:00', /Unrecognised schedule/],
    ['thứ chín 10:00', /Unknown day/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => p(input), (e) => e instanceof ScheduleError && re.test(e.message) && /Examples/.test(e.message), input);
  }
});

test('schedules in words', () => {
  assert.equal(specWords(p('daily 01:00')), 'Every day at 01:00');
  assert.equal(specWords(p('weekdays 10:00')), 'Every weekday at 10:00');
  assert.equal(specWords(p('mon,wed 09:30')), 'Mon, Wed at 09:30');
  assert.equal(specWords(p('once 2026-11-05 10:00')), 'Once: 2026-11-05 10:00');
  assert.equal(specWords(p('at logon')), 'At logon');
});

test('real triggers in words', () => {
  assert.equal(triggerWords({ type: 'Weekly', startBoundary: '2026-10-06T10:00:00+07:00', daysOfWeek: 62, weeksInterval: 1 }), 'Every weekday at 10:00');
  assert.equal(triggerWords({ type: 'Weekly', startBoundary: '2026-10-06T09:30:00', daysOfWeek: 'Monday, Wednesday' }), 'Mon, Wed at 09:30');
  assert.equal(triggerWords({ type: 'Weekly', startBoundary: '2026-10-06T09:30:00', daysOfWeek: 127 }), 'Every day at 09:30');
  assert.equal(triggerWords({ type: 'Weekly', startBoundary: '2026-10-06T09:30:00', daysOfWeek: 2, weeksInterval: 2 }), 'Every 2 weeks, Mon at 09:30');
  assert.equal(triggerWords({ type: 'Daily', startBoundary: '2026-10-01T01:00:00+07:00', daysInterval: 1 }), 'Every day at 01:00');
  assert.equal(triggerWords({ type: 'Daily', startBoundary: '2026-10-01T01:00:00', daysInterval: 3 }), 'Every 3 days at 01:00');
  assert.equal(triggerWords({ type: 'Time', startBoundary: '2026-11-05T10:00:00' }), 'Once: 2026-11-05 10:00');
  assert.equal(triggerWords({ type: 'Logon' }), 'At logon');
  assert.equal(triggerWords({ type: 'Logon', userId: 'alice' }), 'At logon of alice');
  assert.equal(triggerWords({ type: 'Boot' }), 'At startup');
  assert.equal(triggerWords({ type: 'Daily', startBoundary: '2026-10-01T08:00:00', daysInterval: 1, repetitionInterval: 'PT1H' }), 'Every day at 08:00, repeats every 1 h');
  assert.match(triggerWords({ type: 'Weird' }), /Other trigger/);
  assert.equal(triggersSummary([]), 'No schedule');
});
