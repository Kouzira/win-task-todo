import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';
import { initialState, reduce } from '../lib/ui-reduce.mjs';
import { runEffect } from '../lib/ui-effects.mjs';
import { WATCHER_QUESTION } from '../lib/watcher-id.mjs';
import { TASKS, fakeDeps } from './helpers.mjs';
import { WATCHER } from './watch-helpers.mjs';

const NOW = new Date('2026-11-04T12:00:00');
const typed = (state, text) => [...text].reduce((s, ch) => reduce(s, { name: ch === ' ' ? 'space' : ch, ch }).state, state);
const enter = (s) => reduce(s, { name: 'return', ch: '\r' });
const y = (s) => reduce(s, { name: 'y', ch: 'y' });

async function uiState() {
  const res = await runEffect(fakeDeps({ tasks: [...TASKS, WATCHER] }), { type: 'fetch' });
  const sel = res.rows.findIndex((r) => r.name === 'win-task-todo watch');
  return { ...initialState(NOW), loading: false, rows: res.rows, sel };
}

test('the watcher task shows the state "Watcher" in task list and task ui', async () => {
  const d = fakeDeps({ tasks: [...TASKS, WATCHER] });
  await main(['list'], d);
  assert.match(d.captured.out.join('\n'), /win-task-todo watch.*Watcher/);
  const s = await uiState();
  assert.equal(s.rows[s.sel].status, 'Watcher');
  assert.equal(s.rows[s.sel].kind, 'watcher');
  const off = fakeDeps({ tasks: [...TASKS, { ...WATCHER, state: 'Disabled' }] });
  await main(['list'], off);
  assert.match(off.captured.out.join('\n'), /Watcher, off/);
});

test('task ui: /delete, /off, /run, /skip on the watcher ask one extra question that names it as the watcher', async () => {
  const s = await uiState();
  for (const [cmd, next] of [['/delete', { type: 'delete' }], ['/off', { type: 'toggle', verb: 'off' }], ['/run', { type: 'run' }]]) {
    const step = enter(typed(s, cmd));
    assert.equal(step.effect, null);
    assert.equal(step.state.confirm.prompt, WATCHER_QUESTION, cmd);
    assert.match(step.state.confirm.lines.join('\n'), /watcher/);
    const no = reduce(step.state, { name: 'n', ch: 'n' });
    assert.deepEqual([no.effect, no.state.mode], [null, 'list']);
    const ok = y(step.state);
    assert.equal(ok.effect, null, 'after the watcher question the ordinary question still follows');
    assert.equal(ok.state.mode, 'confirm');
    assert.deepEqual(y(ok.state).effect, { ...next, name: 'win-task-todo watch' });
  }
  const skip = y(enter(typed(s, '/skip')).state);
  assert.deepEqual(skip.effect, { type: 'plan-skip', name: 'win-task-todo watch' });
  const other = enter(typed({ ...s, sel: 0 }, '/delete'));
  assert.notEqual(other.state.confirm.prompt, WATCHER_QUESTION);
});

test('command line: off or delete on the watcher asks more, an answer of no writes nothing, --yes skips it', async () => {
  for (const verb of ['off', 'delete', 'run']) {
    const d = fakeDeps({ tasks: [...TASKS, WATCHER], answer: 'n' });
    assert.equal(await main([verb, 'win-task-todo watch'], d), 1);
    assert.deepEqual(d.captured.asked, [`${WATCHER_QUESTION} `]);
    assert.equal(d.captured.writes.length, 0);
  }
  const yes = fakeDeps({ tasks: [...TASKS, WATCHER] });
  assert.equal(await main(['off', 'win-task-todo watch', '--yes'], yes), 0);
  assert.equal(yes.captured.writes.length, 1);
  const ui = fakeDeps({ tasks: [...TASKS, WATCHER] });
  const res = await runEffect(ui, { type: 'toggle', verb: 'off', name: 'win-task-todo watch' });
  assert.equal(res.ok, true, 'task ui already asked, the effect does not ask again');
});
