import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../lib/ui-render.mjs';
import { applyResult, initialState, reduce } from '../lib/ui-reduce.mjs';
import { COMMANDS } from '../lib/ui-commands.mjs';

const NOW = new Date('2026-11-04T12:00:00');
const plain = (l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const row = (name, over = {}) => ({ name, kind: 'pending', status: 'Waiting, 5 h 20 min left', time: '17:20', schedule: 'Every weekday at 17:20', enabled: true, skipped: false, detail: [`Name  ${name}`], ...over });
const sample = (over = {}) => ({
  ...initialState(NOW),
  loading: false,
  rows: [
    row('Report sync'),
    row('Daily backup', { kind: 'done', status: 'Done', time: '10:00', schedule: 'Every weekday at 10:00' }),
    row('Nightly cleanup', { kind: 'failed', status: 'Failed at 09:27', time: '11-05 01:00', schedule: 'Every day at 01:00' }),
    row('Backup', { kind: 'skipped', status: 'Skipped 17:20, re-enabled at 17:21', skipped: true, enabled: false, time: '11-04 17:20' }),
  ],
  ...over,
});
const press = (state, ...keys) => keys.reduce((s, k) => reduce(s, typeof k === 'string' ? { name: k, ch: k } : k).state, state);
const typed = (state, text) => [...text].reduce((s, ch) => reduce(s, { name: ch === ' ' ? 'space' : ch, ch }).state, state);
const enter = (s) => reduce(s, { name: 'return', ch: '\r' });
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('typing keeps the selection; Up and Down only move it and never edit the text', () => {
  let s = press(sample(), 'down', 'down');
  s = typed(s, 'del');
  assert.equal(s.sel, 2);
  assert.equal(s.text, 'del');
  s = press(s, 'up');
  assert.equal(s.sel, 1);
  assert.equal(s.text, 'del');
  s = press(s, 'down', 'down', 'down', 'down');
  assert.equal(s.sel, 3);
  assert.equal(press(s, 'up', 'up', 'up', 'up', 'up').sel, 0);
  assert.equal(press(typed(s, 'ab'), 'backspace').text, 'dela');
});

test('while suggestions are open, Up and Down move the highlight (wrapping), not the task', () => {
  const s = typed(sample({ sel: 1 }), '/');
  assert.equal(s.hi, 0);
  assert.equal(press(s, 'down').hi, 1);
  assert.equal(press(s, 'down').sel, 1);
  assert.equal(press(s, 'up').hi, COMMANDS.length - 1);
  assert.equal(press(s, ...Array(COMMANDS.length).fill('down')).hi, 0);
  assert.equal(press(s, 'down').text, '/');
});

test('Enter with suggestions open runs the highlighted command on the selected task', () => {
  const s = press(typed(sample({ sel: 2 }), '/'), 'down', 'down');
  const step = enter(s);
  assert.equal(step.effect, null);
  assert.equal(step.state.mode, 'confirm');
  assert.deepEqual(step.state.confirm.effect, { type: 'delete', name: 'Nightly cleanup' });
  assert.deepEqual(enter(press(typed(sample({ sel: 1 }), '/s'), 'down')).effect, { type: 'plan-skip', name: 'Daily backup' });
  assert.equal(enter(press(typed(sample(), '/'), 'down')).state.mode, 'ask');
});

test('once suggestions close the arrows go back to the task list: after a space, text without /, empty input, after Esc', () => {
  assert.equal(press(typed(sample(), '/delete '), 'down').sel, 1);
  assert.equal(press(typed(sample(), 'abc'), 'down').sel, 1);
  assert.equal(press(sample(), 'down').sel, 1);
  const esc = press(typed(sample(), '/'), 'escape');
  assert.equal(esc.text, '');
  assert.equal(press(esc, 'down').sel, 1);
  assert.equal(press(typed(sample(), '/zz'), 'down').sel, 1);
});

test('Enter on an empty input opens the details at once, without calling the scheduler', () => {
  const step = enter(sample({ sel: 1 }));
  assert.equal(step.effect, null);
  assert.deepEqual(step.state.panel, { title: 'Daily backup', lines: ['Name  Daily backup'] });
  const bare = sample();
  bare.rows = bare.rows.map(({ detail, ...r }) => r);
  assert.deepEqual(enter(bare).effect, { type: 'details', name: 'Report sync' });
  assert.equal(enter(typed(sample(), '/show')).state.panel.title, 'Report sync');
});

test('Esc clears the input, closes the panel, cancels the question', () => {
  assert.equal(press(typed(sample(), '/del'), 'escape').text, '');
  assert.equal(press(enter(sample()).state, 'escape').panel, null);
  const q = enter(typed(sample(), '/delete')).state;
  assert.equal(q.mode, 'confirm');
  const c = reduce(q, { name: 'escape' }).state;
  assert.equal(c.mode, 'list');
  assert.equal(c.notice, 'Cancelled');
  assert.equal(press(enter(typed(sample(), '/add')).state, 'escape').mode, 'list');
});

test('write commands go through confirmation, only y releases the effect', () => {
  const cases = [
    ['/delete', 0, { type: 'delete', name: 'Report sync' }],
    ['/off', 0, { type: 'toggle', verb: 'off', name: 'Report sync' }],
    ['/on', 3, { type: 'toggle', verb: 'on', name: 'Backup' }],
    ['/run', 0, { type: 'run', name: 'Report sync' }],
    ['/unskip', 3, { type: 'unskip', name: 'Backup' }],
    ['/delete nightly cleanup', 0, { type: 'delete', name: 'Nightly cleanup' }],
  ];
  for (const [text, sel, effect] of cases) {
    const step = enter(typed(sample({ sel }), text));
    assert.equal(step.effect, null, text);
    assert.equal(step.state.mode, 'confirm');
    assert.deepEqual(step.state.confirm.effect, effect);
    assert.deepEqual(reduce(step.state, { name: 'y', ch: 'y' }).effect, effect);
    for (const k of [{ name: 'n', ch: 'n' }, { name: 'return', ch: '\r' }, { name: 'down' }]) {
      const no = reduce(step.state, k);
      assert.equal(no.effect, null);
      assert.equal(no.state.mode, 'list');
    }
  }
  assert.match(enter(typed(sample({ sel: 0 }), '/on')).state.notice, /is already on/);
  assert.match(enter(typed(sample({ sel: 0 }), '/unskip')).state.notice, /is not in a skipped state/);
});

test('read-only commands, reload, quit, unknown', () => {
  assert.deepEqual(enter(typed(sample({ sel: 1 }), '/log')).effect, { type: 'log', name: 'Daily backup' });
  assert.deepEqual(enter(typed(sample(), '/skip')).effect, { type: 'plan-skip', name: 'Report sync' });
  assert.deepEqual(enter(typed(sample(), '/g')).effect, { type: 'fetch' });
  assert.equal(enter(typed(sample({ loading: true }), '/refresh')).effect, null);
  assert.deepEqual(enter(typed(sample(), '/q')).effect, { type: 'quit' });
  const bad = enter(typed(sample(), '/xyz')).state;
  assert.equal(bad.notice, 'Unknown command: /xyz. Type /help.');
  assert.equal(bad.rows.length, 4);
  assert.ok(enter(typed(sample(), '/help')).state.panel.lines.length > COMMANDS.length);
});

test('Ctrl+C quits in every mode', () => {
  for (const mode of ['list', 'confirm', 'ask', 'busy']) {
    assert.deepEqual(reduce(sample({ mode, confirm: { effect: {} }, ask: { values: [] } }), { name: 'c', ctrl: true }).effect, { type: 'quit' });
  }
});

test('Tab fills the highlighted command into the input and closes the list', () => {
  assert.equal(press(typed(sample(), '/s'), 'tab').text, '/show ');
  assert.equal(press(typed(sample(), '/s'), 'down', 'tab').text, '/skip ');
  assert.equal(press(typed(sample(), '/sk'), 'tab').text, '/skip ');
  assert.equal(press(typed(sample(), 'abc'), 'tab').text, 'abc');
  const done = press(typed(sample(), '/d'), 'tab');
  assert.equal(done.hi, 0);
  assert.equal(press(done, 'down').sel, 1);
});

test('/add without arguments asks Name, Command, Schedule on the input line, then the plan, and only y creates', () => {
  let s = enter(typed(sample(), '/add')).state;
  assert.equal(s.mode, 'ask');
  s = typed(s, 'nhac'); s = enter(s).state;
  s = typed(s, 'echo hi'); s = enter(s).state;
  s = typed(s, 'daily 10:00');
  const last = enter(s);
  assert.deepEqual(last.effect, { type: 'plan-add', args: ['nhac', 'echo hi', 'daily 10:00'] });
  const planned = applyResult(last.state, { kind: 'plan', lines: ['Plan to create a task'], prompt: 'Create this task? (y/N)', effect: { type: 'add', args: ['x'] } });
  assert.equal(planned.state.mode, 'confirm');
  assert.equal(reduce(planned.state, { name: 'y', ch: 'y' }).effect.type, 'add');
  const direct = enter(typed(sample(), '/add a | b | daily 10:00'));
  assert.deepEqual(direct.effect, { type: 'plan-add', args: ['a', 'b', 'daily 10:00'] });
});

test('the automatic refresh keeps what is being typed and waits during a question', () => {
  const s = typed(sample({ sel: 2 }), '/del');
  const tick = reduce(s, { name: 'tick' });
  assert.deepEqual(tick.effect, { type: 'fetch' });
  assert.equal(tick.state.text, '/del');
  const fresh = applyResult(tick.state, { kind: 'rows', rows: [row('Nightly cleanup'), row('Z')], now: NOW.toISOString() });
  assert.equal(fresh.state.text, '/del');
  assert.equal(fresh.state.sel, 0);
  assert.equal(reduce(sample({ mode: 'confirm', confirm: { effect: {} } }), { name: 'tick' }).effect, null);
});

test('render: the input box and the hint line sit at the bottom, at the exact height', () => {
  const lines = render(typed(sample({ sel: 1 }), 'ab'), 120, 20).map(plain);
  assert.equal(lines.length, 20);
  assert.equal(lines[0], 'Schedule, Wed 2026-11-04');
  assert.match(lines[16], /^─+$/);
  assert.equal(lines[16].length, 120);
  assert.match(lines[17], /^› ab/);
  assert.match(lines[18], /^─+$/);
  assert.match(lines[19], /^\/help for commands/);
  assert.equal(lines.length, 19 + 1);
});

test('render: the hint line under the input changes with the open suggestions', () => {
  assert.match(plain(render(typed(sample(), '/'), 120, 20)[19]), /^Up, Down select command {3}Tab fill command {3}Enter run {3}Esc back to the task list/);
  assert.match(plain(render(typed(sample(), 'ab'), 120, 20)[19]), /^\/help for commands {3}Up, Down select task/);
  assert.match(plain(render(typed(sample(), '/delete '), 120, 20)[19]), /^\/help for commands/);
  const hi = render(press(typed(sample(), '/'), 'down'), 120, 30);
  assert.ok(hi.findIndex((l) => l.includes('[7m') && plain(l).includes('/add')) > 0);
});

test('render: the selected row is highlighted, colour follows the state', () => {
  const lines = render(sample({ sel: 1 }), 120, 20);
  assert.ok(lines[3].includes('\x1b[7m'));
  assert.match(plain(lines[3]), /^> Done\s+10:00\s+Daily backup/);
  assert.ok(!lines[2].includes('\x1b[7m'));
  assert.match(plain(lines[5]), /Skipped 17:20, re-enabled at 17:21/);
});

test('render: suggestions sit just above the status line, one row lit, the list above untouched', () => {
  const lines = render(typed(sample(), '/de'), 120, 20);
  const p = lines.map(plain);
  assert.match(p[0], /Schedule, /);
  assert.match(p[2], /Report sync/);
  assert.match(p[14], /^  \/delete\s+Delete a task/);
  assert.ok(lines[14].includes('\x1b[7m'));
  assert.match(p[17], /^› \/de/);
});

test('render: a lone "/" at 120x30 lists every command with its description', () => {
  const p = render(typed(sample(), '/'), 120, 30).map(plain);
  const body = p.slice(0, 25).join('\n');
  for (const c of COMMANDS) assert.match(body, new RegExp(`/${c.name}\\b.*${esc(c.desc)}`));
  assert.doesNotMatch(body, /more commands/);
});

test('render: with too little room it shows what fits, the lit row stays visible, the last line counts the rest', () => {
  const small = typed(sample(), '/');
  const p = render(small, 120, 11).map(plain);
  assert.equal(p.length, 11);
  assert.match(p[5], /and \d+ more commands, type to filter/);
  assert.match(p[4], /^  \/\w+/);
  const tabbed = press(small, ...Array(8).fill('down'));
  const q = render(tabbed, 120, 11);
  const lit = q.findIndex((l) => l.includes('\x1b[7m') && plain(l).startsWith('  /'));
  assert.ok(lit >= 0, 'the lit row is inside the suggestion area');
  assert.match(plain(q[lit]), /^  \/log/);
});

test('render: status line, confirmation question, step-by-step prompts, detail panel', () => {
  assert.equal(plain(render(sample({ notice: 'Deleted Backup' }), 80, 20)[15]), 'Deleted Backup');
  const q = render(enter(typed(sample(), '/delete')).state, 80, 20).map(plain);
  assert.ok(q.includes('Task to be deleted: Report sync'));
  assert.match(q[17], /^Delete this task\? \(y\/N\) ›/);
  assert.match(q[19], /y to confirm/);
  const a = render(press(enter(typed(sample(), '/add')).state, ...[...'ab'], 'return', ...[...'ec']), 80, 20).map(plain);
  assert.ok(a.includes('Name: ab'));
  assert.match(a[17], /^Command › ec/);
  assert.ok(render(enter(sample()).state, 80, 20).map(plain).includes('Name  Report sync'));
});

test('render: with more rows than room the selected row stays visible', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`Task ${i}`));
  const lines = render({ ...sample(), rows, sel: 25 }, 80, 14).map(plain);
  assert.ok(lines.slice(2, 9).some((l) => l.startsWith('> ') && l.includes('Task 25')));
  const top = render({ ...sample(), rows, sel: 0 }, 80, 14).map(plain);
  assert.ok(top.slice(2, 9).some((l) => l.startsWith('> ') && l.includes('Task 0')));
});

test('render: ellipsis at 60 columns, never wider than the screen, never cutting a colour code', () => {
  for (const width of [20, 40, 60, 79]) {
    for (const s of [sample(), typed(sample(), '/'), typed(sample(), 'x'.repeat(100))]) {
      for (const l of render(s, width, 20)) assert.ok(plain(l).length <= width + 1, `width ${width}: "${plain(l)}"`);
    }
    assert.ok(render(sample(), width, 20).slice(2, 7).some((l) => plain(l).includes('...')), `has an ellipsis at ${width}`);
  }
  assert.match(plain(render(typed(sample(), 'x'.repeat(100)), 60, 20)[17]), /^› \.\.\.x+ $/);
});
