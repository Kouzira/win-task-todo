import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { LEGACY_MARKER, MARKER, isOwnTask } from '../lib/classify.mjs';
import { cleanLabel, describeTask, labelProblem, projectOf, sameProject, visibleDescription } from '../lib/project.mjs';
import { TASKS, USER, fakeDeps } from './helpers.mjs';

const text = (d) => d.captured.out.join('\n');
const errText = (d) => d.captured.err.join('\n');
const label = (name, project) => (t) => (t.name === name ? { ...t, description: describeTask(project) } : t);
const LABELLED = TASKS.map(label('Daily backup', 'Alpha')).map(label('Report sync', 'beta project'));

test('the label is stored after the marker and read back; a task without a label has none', () => {
  assert.equal(describeTask('Website  relaunch '), `${MARKER}\ntasks-project:Website relaunch`);
  assert.equal(describeTask(undefined), MARKER);
  assert.equal(describeTask(null), MARKER);
  assert.equal(projectOf({ description: describeTask('Alpha') }), 'Alpha');
  assert.equal(projectOf({ description: describeTask() }), null);
  assert.equal(projectOf({ description: '' }), null);
  assert.equal(projectOf({}), null);
});

test('a hand-written description that only looks like a label is not read, and old markers still count as the tool\'s own', () => {
  assert.equal(projectOf({ description: 'tasks-project:Alpha' }), null);
  assert.equal(projectOf({ description: `${LEGACY_MARKER}\ntasks-project:Alpha` }), 'Alpha', 'a legacy marker with a label line still reads');
  const old = { name: 'Old', path: '\\', description: MARKER, actions: [{ execute: 'cmd.exe', arguments: '/c x', workingDirectory: '' }], triggers: [] };
  assert.equal(isOwnTask(old, USER), true);
  assert.equal(isOwnTask({ ...old, description: LEGACY_MARKER }, USER), true);
  assert.equal(isOwnTask({ ...old, description: describeTask('Alpha') }, USER), true);
});

test('a label is one trimmed line of at most 60 characters', () => {
  assert.equal(labelProblem('Alpha'), null);
  assert.match(labelProblem('   '), /empty/);
  assert.match(labelProblem('x'.repeat(61)), /longer than 60/);
  assert.equal(labelProblem('x'.repeat(60)), null);
  assert.match(labelProblem('a\u0007b'), /control/);
  assert.equal(cleanLabel(' a\n b\t c '), 'a b c');
  assert.equal(sameProject('Alpha', ' alpha '), true);
  assert.equal(sameProject('Alpha', 'Beta'), false);
});

test('visibleDescription hides the label line and keeps the rest on one line', () => {
  assert.equal(visibleDescription(describeTask('Alpha')), MARKER);
  assert.equal(visibleDescription('first\nsecond'), 'first second');
});

test('add --project stores the label in the description, shows it in the plan; a bad label is refused', async () => {
  const d = fakeDeps();
  assert.equal(await main(['add', 'Weekly report', 'echo hi', 'daily 10:00', '--project', 'Website relaunch', '--yes'], d), 0);
  assert.equal(d.captured.writes[0].data.description, 'Created by the tasks tool\ntasks-project:Website relaunch');
  assert.match(text(d), /Project: +Website relaunch/);

  const plain = fakeDeps();
  await main(['add', 'Weekly report', 'echo hi', 'daily 10:00', '--yes'], plain);
  assert.equal(plain.captured.writes[0].data.description, MARKER);
  assert.doesNotMatch(text(plain), /Project:/);

  const bad = fakeDeps();
  assert.equal(await main(['add', 'Weekly report', 'echo hi', 'daily 10:00', '--project', 'x'.repeat(80), '--yes'], bad), 2);
  assert.match(errText(bad), /longer than 60/);
  assert.equal(bad.captured.writes.length, 0);

  const dry = fakeDeps();
  assert.equal(await main(['add', 'Weekly report', 'echo hi', 'daily 10:00', '--project', 'Alpha', '--dry-run'], dry), 0);
  assert.equal(dry.captured.writes.length, 0);
});

test('list shows a Project column only when some task has a label', async () => {
  const none = fakeDeps();
  await main(['list'], none);
  assert.doesNotMatch(none.captured.out[0], /Project/);

  const d = fakeDeps({ tasks: LABELLED });
  await main(['list'], d);
  assert.match(d.captured.out[0], /State +Project/);
  const byName = Object.fromEntries(d.captured.out.slice(1).map((l) => [l.slice(0, 15).trim(), l]));
  assert.match(byName['Report sync'], /beta project/);
  assert.match(byName['Daily backup'], /Alpha/);
  assert.doesNotMatch(byName['Nightly cleanup'], /Alpha|beta/);
  assert.ok(d.captured.out.every((l) => l.length <= 120));
});

test('list --project filters by label, ignoring case and spaces at the ends; no match says so', async () => {
  const d = fakeDeps({ tasks: LABELLED });
  assert.equal(await main(['list', '--project', ' ALPHA '], d), 0);
  assert.equal(d.captured.out.length, 2);
  assert.match(d.captured.out[1], /^Daily backup/);

  const two = fakeDeps({ tasks: LABELLED });
  await main(['list', '--project', 'Beta Project'], two);
  assert.match(two.captured.out[1], /^Report sync/);

  const none = fakeDeps({ tasks: LABELLED });
  assert.equal(await main(['list', '--project', 'Gamma'], none), 0);
  assert.equal(text(none), 'No tasks with the project "Gamma".');

  const json = fakeDeps({ tasks: LABELLED });
  await main(['list', '--json', '--project', 'Alpha'], json);
  assert.deepEqual(JSON.parse(text(json)).map((r) => [r.name, r.project]), [['Daily backup', 'Alpha']]);
});

test('list --json carries the project (null without one)', async () => {
  const d = fakeDeps({ tasks: LABELLED });
  await main(['list', '--json'], d);
  const rows = JSON.parse(text(d));
  assert.deepEqual(rows.map((r) => r.project).sort(), ['Alpha', 'beta project', null].sort());
});

test('show prints the project on its own row and a tidy description', async () => {
  const d = fakeDeps({ tasks: LABELLED });
  assert.equal(await main(['show', 'Daily backup'], d), 0);
  assert.match(text(d), /^Project +Alpha$/m);
  assert.match(text(d), /^Description +Created by the tasks tool$/m);
  assert.doesNotMatch(text(d), /tasks-project:/);
  const plain = fakeDeps();
  await main(['show', 'Daily backup'], plain);
  assert.doesNotMatch(text(plain), /^Project/m);
});
