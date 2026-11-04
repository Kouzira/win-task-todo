import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommand, suggest } from '../lib/ui-commands.mjs';

const rows = ['Report sync', 'Daily backup', 'Nightly cleanup'].map((name) => ({ name }));
const parse = (text, sel = 0) => parseCommand(text, rows, sel);

test('a command without a name acts on the selected task', () => {
  for (const kind of ['show', 'delete', 'off', 'on', 'run', 'skip', 'unskip', 'log']) {
    const cmd = parse(`/${kind}`, 1);
    assert.equal(cmd.kind, kind);
    assert.equal(cmd.row.name, 'Daily backup');
  }
});

test('a command with a name: as typed, quoted, case-insensitive', () => {
  assert.equal(parse('/delete nightly cleanup').row.name, 'Nightly cleanup');
  assert.equal(parse('/off "Daily backup"').row.name, 'Daily backup');
  assert.equal(parse("/run 'Report sync'", 2).row.name, 'Report sync');
  assert.equal(parse('/LOG Daily backup').kind, 'log');
});

test('a name that does not match is reported with similar names, never guessed', () => {
  const cmd = parse('/delete Daily backu');
  assert.equal(cmd.kind, 'notice');
  assert.match(cmd.text, /No task "Daily backu" found\. Similar: .*Daily backup/);
  assert.equal(parseCommand('/delete', [], 0).kind, 'notice');
});

test('commands that need no name: refresh, g, help, quit, q', () => {
  assert.equal(parse('/refresh').kind, 'refresh');
  assert.equal(parse('/g').kind, 'refresh');
  assert.equal(parse('/help').kind, 'help');
  assert.equal(parse('/quit').kind, 'quit');
  assert.equal(parse('/q').kind, 'quit');
  assert.equal(parseCommand('/quit', [], 0).kind, 'quit');
});

test('/add: without arguments it asks in turn, with arguments split by " | "', () => {
  assert.deepEqual(parse('/add'), { kind: 'add' });
  assert.deepEqual(parse('/add nhac | echo hi | daily 10:00'), { kind: 'add', args: ['nhac', 'echo hi', 'daily 10:00'] });
  assert.deepEqual(parse('/add x | a | b | c').args, ['x', 'a | b', 'c']);
  assert.match(parse('/add nhac | echo hi').text, /Usage/);
  assert.match(parse('/add a |  | c').text, /Usage/);
});

test('an unknown command, and text that does not start with /', () => {
  assert.deepEqual(parse('/xyz'), { kind: 'notice', text: 'Unknown command: /xyz. Type /help.' });
  assert.equal(parse('/').kind, 'notice');
  assert.match(parse('delete it').text, /start with \//);
});

test('suggestions: "/" lists everything, more letters filter, at most six', () => {
  assert.equal(suggest('/').length, COMMANDS.length);
  assert.deepEqual(suggest('/d').map((c) => c.name), ['delete']);
  assert.deepEqual(suggest('/sk').map((c) => c.name), ['skip']);
  assert.deepEqual(suggest('/s').map((c) => c.name), ['show', 'skip']);
  assert.deepEqual(suggest('/g').map((c) => c.name), ['refresh']);
  assert.deepEqual(suggest('/zz'), []);
  assert.deepEqual(suggest('/delete x'), []);
  assert.deepEqual(suggest('delete'), []);
  assert.ok(suggest('/').every((c) => c.desc.length > 0));
});
