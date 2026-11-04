// The screen of `task ui` as a pure function: state and size in, an array of
// exactly `height` lines out. Text and colour only. Lengths are measured on
// the plain text and colour is added afterwards, so truncation to a narrow
// terminal never cuts an escape sequence in half.
//
// Top to bottom: header, the list (or a panel) with the suggestions laid over
// its bottom rows, a status line, then the input between two thin rules and a
// one-line hint. The bottom five rows are fixed, like the prompt of a chat
// terminal, so the input never moves while the list scrolls.
import { fitWidths, trunc } from './format.mjs';
import { daysText } from './schedule-words.mjs';
import { PROMPTS } from './ui-reduce.mjs';
import { suggest } from './ui-commands.mjs';

const REVERSE = '\x1b[7m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const COLOURS = { done: '\x1b[32m', failed: '\x1b[31m', pending: '\x1b[33m', running: '\x1b[36m', skipped: '\x1b[35m', off: DIM, none: DIM };

export const HINT = '/help for commands   Up, Down select task   Enter details   Ctrl+C quit';
export const HINT_SUGGEST = 'Up, Down select command   Tab fill command   Enter run   Esc back to the task list';
const BOTTOM = 5;

function headerLine(state) {
  const now = new Date(state.now);
  const iso = now.getDay() === 0 ? 7 : now.getDay();
  const wd = daysText([iso]);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `Schedule, ${wd} ${date}${state.loading ? '   Loading...' : ''}`;
}

function listLines(state, width, room) {
  if (!state.rows.length) return [state.loading ? 'Loading...' : 'No own tasks.'];
  const body = state.rows.map((r) => [r.status, r.time, r.name, r.schedule]);
  const natural = [0, 1, 2, 3].map((i) => Math.max(...body.map((r) => r[i].length)));
  const widths = fitWidths(natural, 2, Math.max(width - 2, 10), [10, 5, 12, 12]);
  // Keep the selected row on screen when there are more rows than room.
  const first = Math.min(Math.max(0, state.sel - room + 1), Math.max(0, body.length - room));
  return body.slice(first, first + room).map((cells, n) => {
    const idx = first + n;
    const selected = idx === state.sel;
    const plain = (selected ? '> ' : '  ') + cells.map((c, i) => trunc(c, widths[i]).padEnd(widths[i])).join('  ').trimEnd();
    const cut = trunc(plain, width);
    if (selected) return `${REVERSE}${cut.padEnd(width)}${RESET}`;
    const colour = COLOURS[state.rows[idx].kind] ?? '';
    const split = 2 + widths[0];
    return colour ? `${colour}${cut.slice(0, split)}${RESET}${cut.slice(split)}` : cut;
  });
}

// What the panel area shows instead of the list, if anything.
function panelLines(state) {
  if (state.mode === 'confirm') return state.confirm.lines;
  if (state.mode === 'ask') {
    const hint = state.ask.values.length === 2 ? ['', 'Example schedule: weekdays 18:00'] : [];
    return ['Add task', '', ...PROMPTS.map((p, i) => `${p}: ${state.ask.values[i] ?? ''}`.trimEnd()), ...hint];
  }
  if (!state.panel) return null;
  return [...(state.panel.title ? [state.panel.title, ''] : []), ...state.panel.lines];
}

// All matches when they fit; otherwise as many as fit, scrolled so the
// highlighted one is always inside, and a last line counting the rest.
function suggestionLines(state, width, room) {
  if (state.mode !== 'list') return [];
  const list = suggest(state.text);
  const at = state.hi;
  const cap = list.length > room ? Math.max(1, room - 1) : list.length;
  const start = Math.min(Math.max(0, at - cap + 1), list.length - cap);
  const w = Math.max(...list.map((c) => c.name.length + (c.alias ? 5 : 0)), 0) + 1;
  const lines = list.slice(start, start + cap).map((c, n) => {
    const name = `/${c.name}${c.alias ? ` (/${c.alias})` : ''}`;
    const plain = trunc(`  ${name.padEnd(w + 1)} ${c.desc}`, width);
    return start + n === at ? `${REVERSE}${plain.padEnd(width)}${RESET}` : `${DIM}${plain}${RESET}`;
  });
  if (cap < list.length) lines.push(`${DIM}${trunc(`  and ${list.length - cap} more commands, type to filter`, width)}${RESET}`);
  return lines;
}

function inputLine(state, width) {
  let label = '›';
  if (state.mode === 'confirm') label = `${state.confirm.prompt} ›`;
  else if (state.mode === 'ask') label = `${PROMPTS[state.ask.values.length]} ›`;
  const room = Math.max(1, width - label.length - 2);
  // A long text shows its tail, where the cursor is; the start is cut.
  const text = state.text.length > room ? `...${state.text.slice(-(room - 3))}` : state.text;
  return `${trunc(label, width)} ${text}${REVERSE} ${RESET}`;
}

export function render(state, width, height) {
  const top = Math.max(0, height - BOTTOM);
  const room = Math.max(1, top - 2);
  const shown = panelLines(state);
  const area = (shown ?? listLines(state, width, room)).slice(0, room).map((l) => (l.includes('\x1b') ? l : trunc(l, width)));
  while (area.length < room) area.push('');
  const sugs = suggestionLines(state, width, room);
  if (sugs.length) area.splice(room - sugs.length, sugs.length, ...sugs);
  const hint = state.mode === 'confirm' ? 'y to confirm, any other key cancels   Ctrl+C quit' : state.mode === 'ask' ? 'Enter next   Backspace edit   Esc cancel' : sugs.length ? HINT_SUGGEST : HINT;
  const rule = `${DIM}${'─'.repeat(width)}${RESET}`;
  const lines = [trunc(headerLine(state), width), '', ...area, trunc(state.notice, width), rule, inputLine(state, width), rule, `${DIM}${trunc(hint, width)}${RESET}`];
  // On a terminal too short for the layout the bottom five rows win.
  return lines.length > height ? [...lines.slice(0, Math.max(0, top)), ...lines.slice(lines.length - BOTTOM)] : lines;
}
