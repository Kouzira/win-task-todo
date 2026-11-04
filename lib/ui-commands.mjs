// The command line of `task ui` as pure functions: the text typed on the
// input line goes in, an action or a notice comes out. Nothing here touches
// the terminal or the scheduler, and nothing writes: an action only names what
// the reducer should ask for (and confirm) next.
import { findTask } from './match.mjs';

// Order matters: it is the order of the suggestions when only "/" is typed,
// and only six fit, so the commands used most come first.
export const COMMANDS = [
  { name: 'show', desc: 'Task details (same as Enter)', arg: true },
  { name: 'add', desc: 'Add a task: /add name | command | schedule', arg: false },
  { name: 'delete', desc: 'Delete a task', arg: true },
  { name: 'off', desc: 'Turn a task off', arg: true },
  { name: 'on', desc: 'Turn a task on', arg: true },
  { name: 'run', desc: 'Run now', arg: true },
  { name: 'skip', desc: 'Skip the next run', arg: true },
  { name: 'unskip', desc: 'Undo a skip, re-enable now', arg: true },
  { name: 'log', desc: 'Tail of the log file', arg: true },
  { name: 'refresh', alias: 'g', desc: 'Reload the list', arg: false },
  { name: 'help', desc: 'List commands and keys', arg: false },
  { name: 'quit', alias: 'q', desc: 'Quit', arg: false },
];

export const MAX_SUGGESTIONS = 6;
export const ADD_USAGE = 'Usage: /add <name> | <command> | <schedule>';

export const HELP_LINES = [
  ...COMMANDS.map((c) => {
    const names = `/${c.name}${c.alias ? ` (/${c.alias})` : ''}${c.arg ? ' [name]' : ''}`;
    return `${names.padEnd(20)}${c.desc}`;
  }),
  '',
  'Without a name the command acts on the selected task. A name with spaces may be quoted or typed as it is.',
  'Up, Down: select a task (also while typing). Enter: task details when the input is empty.',
  'Tab: fill in the suggested command, press again to change the suggestion. Esc: clear the input, close the panel. Ctrl+C: quit.',
];

const byName = (word) => COMMANDS.find((c) => c.name === word || c.alias === word);

// The commands whose name (or short alias) starts with what follows the slash:
// all of them for a bare "/", so the owner sees everything on offer at once,
// and at most six once a letter narrows it. Once a space is typed the command
// is chosen and nothing is suggested.
export function suggest(text) {
  if (!/^\/\S*$/.test(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  const hits = COMMANDS.filter((c) => c.name.startsWith(prefix) || (c.alias && c.alias.startsWith(prefix)));
  return prefix ? hits.slice(0, MAX_SUGGESTIONS) : hits;
}

const unquote = (s) => {
  const m = /^"(.*)"$|^'(.*)'$/.exec(s);
  return m ? (m[1] ?? m[2]) : s;
};

// The pipe may appear inside the command itself, so the first part is the
// name, the last the schedule, and whatever lies between is the command.
function parseAdd(rest) {
  if (!rest) return { kind: 'add' };
  const parts = rest.split(' | ').map((p) => p.trim());
  if (parts.length < 3 || parts.some((p) => !p)) return { kind: 'notice', text: ADD_USAGE };
  return { kind: 'add', args: [parts[0], parts.slice(1, -1).join(' | '), parts[parts.length - 1]] };
}

function pickRow(rest, rows, sel) {
  if (!rest) {
    const row = rows[sel];
    return row ? { row } : { notice: 'There is no task to select.' };
  }
  const hit = findTask(unquote(rest), rows);
  if (hit.task) return { row: hit.task };
  if (hit.ambiguous) return { notice: `Several tasks are named "${unquote(rest)}".` };
  const near = hit.missing.map((t) => t.name).join(', ');
  return { notice: `No task "${unquote(rest)}" found.${near ? ` Similar: ${near}.` : ''}` };
}

export function parseCommand(text, rows, sel) {
  const m = /^\/(\S*)\s*(.*)$/s.exec(text.trim());
  if (!m) return { kind: 'notice', text: 'Commands start with /, for example /help.' };
  const cmd = byName(m[1].toLowerCase());
  if (!cmd) return { kind: 'notice', text: `Unknown command: /${m[1]}. Type /help.` };
  const rest = m[2].trim();
  if (cmd.name === 'add') return parseAdd(rest);
  if (!cmd.arg) return { kind: cmd.name };
  const picked = pickRow(rest, rows, sel);
  return picked.row ? { kind: cmd.name, row: picked.row } : { kind: 'notice', text: picked.notice };
}
