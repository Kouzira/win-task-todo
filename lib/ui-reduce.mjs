// The key handling of `task ui` as a pure reducer: (state, key) goes in,
// { state, effect } comes out. Nothing here touches the scheduler or the
// terminal; the shell in ui.mjs runs the effects and feeds their results back
// through applyResult. A write command never returns an effect directly: it
// first moves to a confirm step, and only a "y" there releases the effect.
//
// The input line is always focused, so `text` is the buffer of whatever is
// typed and the selection (`sel`) is only ever changed by Up and Down, never
// by typing. Modes: list (typing and commands), confirm (the input line is the
// question), ask (the input line collects Name, Command, Schedule), busy (an effect is
// running). `panel` is an overlay in the list area and is independent of mode.
import { HELP_LINES, parseCommand, suggest } from './ui-commands.mjs';
import { WATCHER_QUESTION, WATCHER_WARNING } from './watcher-id.mjs';

export const PROMPTS = ['Name', 'Command', 'Schedule'];

export function initialState(now = new Date()) {
  return { rows: [], sel: 0, mode: 'list', loading: true, now: now.toISOString(), panel: null, text: '', hi: 0, ask: null, confirm: null, notice: '' };
}

const FETCH = { type: 'fetch' };
const done = (state, effect = null) => ({ state, effect });
const busy = (state, effect) => done({ ...state, mode: 'busy', loading: true }, effect);
const ask = (state, prompt, lines, effect) => done({ ...state, mode: 'confirm', confirm: { prompt, lines, effect } });
const printable = (key) => Boolean(key.ch) && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(key.ch);

// Backspace and printable characters edit the buffer in list and ask mode
// alike; any edit drops a Tab cycle in progress.
function edit(state, key) {
  if (key.name === 'backspace') return { ...state, text: state.text.slice(0, -1), hi: 0 };
  if (printable(key)) return { ...state, text: state.text + key.ch, hi: 0 };
  return null;
}

// A result of one line becomes the status line; several lines need the panel.
function report(state, lines, extra = {}) {
  const clean = lines.filter((l) => l !== '');
  if (clean.length <= 1) return { ...state, ...extra, panel: null, notice: clean[0] ?? '' };
  return { ...state, ...extra, notice: '', panel: { title: '', lines } };
}

const WRITES = new Set(['delete', 'on', 'off', 'run', 'skip', 'unskip']);

function act(state, cmd) {
  const row = cmd.row;
  // A write on the watcher's own task first asks whether that is really
  // meant; only after a "y" does the command take its usual course, with its
  // own question still to come.
  if (row?.watcher && WRITES.has(cmd.kind) && !cmd.watcherOk) {
    return ask(state, WATCHER_QUESTION, [WATCHER_WARNING], { type: 'watcher-ok', cmd });
  }
  switch (cmd.kind) {
    case 'notice': return done({ ...state, notice: cmd.text });
    case 'quit': return done(state, { type: 'quit' });
    case 'refresh': return state.loading ? done(state) : done({ ...state, loading: true }, FETCH);
    case 'help': return done({ ...state, panel: { title: 'Commands and keys', lines: HELP_LINES } });
    case 'show':
      // Details come from the last list fetch when it carried them, so they
      // open at once; only a row without them asks the scheduler again.
      if (row.detail) return done({ ...state, panel: { title: row.name, lines: row.detail } });
      return busy(state, { type: 'details', name: row.name });
    case 'log': return busy(state, { type: 'log', name: row.name });
    case 'skip': return busy(state, { type: 'plan-skip', name: row.name });
    case 'unskip':
      if (!row.skipped && row.enabled) return done({ ...state, notice: `"${row.name}" is not in a skipped state.` });
      return ask(state, 'Re-enable now and delete the helper task? (y/N)', [`Re-enable "${row.name}" now.`], { type: 'unskip', name: row.name });
    case 'on': case 'off': {
      const on = cmd.kind === 'on';
      if (on === row.enabled) return done({ ...state, notice: `"${row.name}" is already ${on ? 'on' : 'off'}.` });
      return ask(state, `Turn ${on ? 'on' : 'off'} this task? (y/N)`, [`Turn ${on ? 'on' : 'off'} task "${row.name}".`], { type: 'toggle', verb: cmd.kind, name: row.name });
    }
    case 'delete': return ask(state, 'Delete this task? (y/N)', [`Task to be deleted: ${row.name}`], { type: 'delete', name: row.name });
    case 'run': return ask(state, 'Run this task now? (y/N)', [`Run task "${row.name}" now.`], { type: 'run', name: row.name });
    case 'add':
      if (cmd.args) return busy(state, { type: 'plan-add', args: cmd.args });
      return done({ ...state, mode: 'ask', ask: { values: [] } });
    default: return done(state);
  }
}

function submit(state) {
  const text = state.text.trim();
  const cleared = { ...state, text: '', hi: 0, notice: '', panel: null };
  if (!text) {
    const row = state.rows[state.sel];
    return row ? act(cleared, { kind: 'show', row }) : done(cleared);
  }
  return act(cleared, parseCommand(text, state.rows, state.sel));
}

// Tab writes the highlighted command into the input, followed by a space, so
// the list closes and a task name can be typed next.
function onTab(state, list) {
  if (!list.length) return done(state);
  return done({ ...state, text: `/${list[state.hi].name} `, hi: 0 });
}

// While the suggestion list is open (a "/" and no space yet) Up and Down move
// its highlight, wrapping at the ends, and Enter runs the highlighted command
// on the selected task. Otherwise the same keys act on the task list.
function onList(state, key) {
  const k = key.name;
  const list = suggest(state.text);
  if (k === 'escape') return done({ ...state, text: '', hi: 0, panel: null, notice: '' });
  if ((k === 'up' || k === 'down') && list.length) {
    const hi = (state.hi + (k === 'up' ? list.length - 1 : 1)) % list.length;
    return done({ ...state, hi });
  }
  if (k === 'up' || k === 'down') {
    if (!state.rows.length) return done(state);
    const sel = k === 'up' ? Math.max(0, state.sel - 1) : Math.min(state.rows.length - 1, state.sel + 1);
    return done({ ...state, sel, panel: null });
  }
  if (k === 'tab') return onTab(state, list);
  if (k === 'return') return submit(list.length ? { ...state, text: `/${list[state.hi].name}` } : state);
  const edited = edit(state, key);
  return done(edited ?? state);
}

function onAsk(state, key) {
  if (key.name === 'escape') return done({ ...state, mode: 'list', ask: null, text: '', notice: 'Cancelled, nothing created.' });
  if (key.name === 'return') {
    const value = state.text.trim();
    if (!value) return done(state);
    const values = [...state.ask.values, value];
    if (values.length < PROMPTS.length) return done({ ...state, ask: { values }, text: '' });
    return busy({ ...state, mode: 'list', ask: null, text: '' }, { type: 'plan-add', args: values });
  }
  return done(edit(state, key) ?? state);
}

export function reduce(state, key) {
  if (key.ctrl && key.name === 'c') return done(state, { type: 'quit' });
  // The refresh never touches `text`, so a tick in the middle of typing costs
  // the owner nothing; it only waits while a question or an effect is open.
  if (key.name === 'tick') return state.mode === 'list' && !state.loading ? done({ ...state, loading: true }, FETCH) : done(state);
  switch (state.mode) {
    case 'busy': return done(state);
    case 'confirm':
      if (String(key.ch ?? '').toLowerCase() === 'y') {
        const effect = state.confirm.effect;
        const back = { ...state, confirm: null, mode: 'list' };
        if (effect.type === 'watcher-ok') return act(back, { ...effect.cmd, watcherOk: true });
        return busy(back, effect);
      }
      return done({ ...state, mode: 'list', confirm: null, text: '', notice: 'Cancelled' });
    case 'ask': return onAsk(state, key);
    default: return onList(state, key);
  }
}

// Results of effects. Writes end with a refresh, so the list always shows
// what the scheduler holds now rather than what the screen guessed.
export function applyResult(state, res) {
  switch (res.kind) {
    case 'rows': {
      const at = state.rows[state.sel]?.name;
      const idx = res.rows.findIndex((r) => r.name === at);
      const sel = idx >= 0 ? idx : Math.min(state.sel, Math.max(0, res.rows.length - 1));
      return done({ ...state, rows: res.rows, sel, now: res.now, loading: false });
    }
    case 'panel': return done({ ...state, mode: 'list', loading: false, panel: { title: res.title, lines: res.lines } });
    case 'plan':
      return done({ ...state, mode: 'confirm', loading: false, confirm: { prompt: res.prompt, lines: res.lines, effect: res.effect } });
    case 'done': return done(report(state, res.lines, { mode: 'list', loading: true }), FETCH);
    default: return done(report(state, res.lines ?? ['Unknown error.'], { mode: 'list', loading: false }));
  }
}
