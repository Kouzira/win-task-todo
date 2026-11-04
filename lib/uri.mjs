// `task uri <uri>`: what runs when a card, a question card or its [Cancel
// today] button is clicked.
//
// SECURITY BOUNDARY. Any web page, document or program can launch a
// wintasktodo: URI, so this handler trusts nothing in it. It accepts exactly
// these forms, compared case-insensitively against the whole argument:
//   wintasktodo:open                     open `task ui` (the body of a question)
//   wintasktodo:open/<card tag>          the same, from one task's card
//   wintasktodo:cancel-today/<32 hex>    skip one task's run today, only with
//                                        the one-time token the watcher put
//                                        on that task's question card
// Anything else (an extra argument, a query, a path, a task name, a second
// URI) is refused and logged, and nothing runs. No part of a URI ever becomes
// a task name, a path or a command: open takes no parameter but a card tag,
// which is only a key in the click record and only for a card the watcher
// tracks; cancel-today acts on the task and run stored beside its token by
// the watcher, re-checked against the scheduler, never on the watcher itself.
//
// open is the one action a hostile page can trigger for real. Its effects are
// opening the list in a new terminal and recording a click, and a recorded
// click can at most keep one question from being asked (the card then comes
// back silently instead). Nothing is cancelled, changed or revealed by it.
import { FILES, makeLogger } from './app-files.mjs';
import { consumeToken } from './cancel-token.mjs';
import { dayKey, loadState, readOpened, remainingToday } from './notify.mjs';
import { skipCmd } from './skip.mjs';
import { TAG_PATTERN } from './toast.mjs';
import { buildRows } from './ui-model.mjs';

const OPEN = /^wintasktodo:open(?:\/(c[0-9a-f]{15}))?$/i;
const CANCEL = /^wintasktodo:cancel-today\/([0-9a-f]{32})$/i;

// { action: 'open', tag } | { action: 'cancel-today', token } | null.
export function parseUri(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') return null;
  const s = args[0];
  if (s.length > 64) return null;
  const open = OPEN.exec(s);
  if (open) return { action: 'open', tag: open[1] ? open[1].toLowerCase() : null };
  const m = CANCEL.exec(s);
  return m ? { action: 'cancel-today', token: m[1].toLowerCase() } : null;
}

// Windows Terminal when it is installed (a new window), otherwise a classic
// console through cmd's start. cmd /k strips the outer pair of quotes, which
// is why the whole command line sits inside one more pair.
export async function openList(deps) {
  const node = deps.nodePath;
  const script = deps.scriptPath;
  if (await deps.launch('wt.exe', ['-w', 'new', node, script, 'ui'])) return 'wt';
  await deps.launch('cmd.exe', ['/c', `start "" cmd /k ""${node}" "${script}" ui"`], { verbatim: true });
  return 'cmd';
}

// The click record only ever holds tags of cards the watcher posted, so a
// page launching made-up tags cannot grow the file. A plain open names no
// card and records nothing: it must not excuse the dismissal of every card.
function recordOpen(deps, tag) {
  if (!tag || !TAG_PATTERN.test(tag) || !loadState(deps.app).cards[tag]) return;
  deps.app.write(FILES.opened, JSON.stringify({ ...readOpened(deps.app), [tag]: deps.now().getTime() }));
}

async function cancelToday(deps, token, log) {
  const now = deps.now();
  const claim = consumeToken(deps.app, token, now, deps.pid);
  if (!claim.ok) { log(`cancel today refused: ${claim.reason}`); return 1; }
  if (claim.day !== dayKey(now)) { log('cancel today refused: token of another day'); return 1; }
  const { rows } = await buildRows(deps);
  const row = remainingToday(rows, now).find((r) => r.path === claim.path && r.name === claim.name && r.nextRun === claim.runAt);
  if (!row) { log(`cancel today: ${claim.name} no longer has that run, nothing done`); return 0; }
  const said = [];
  const push = (l = '') => said.push(l);
  const code = await skipCmd({ ...deps, out: push, err: push, ask: async () => 'n' }, row.name, { yes: true });
  log(`cancel today: ${row.name}: ${code === 0 ? 'skipped' : 'could not skip'}. ${said.join(' ')}`);
  return code;
}

export async function uriCmd(deps, args) {
  const log = makeLogger(deps.app, deps.now);
  const parsed = parseUri(args);
  if (!parsed) {
    log(`uri refused: ${JSON.stringify(args).slice(0, 300)}`);
    deps.err('Invalid URI, ignored.');
    return 2;
  }
  if (parsed.action === 'open') {
    recordOpen(deps, parsed.tag);
    log(`opened the list (${await openList(deps)})`);
    return 0;
  }
  return cancelToday(deps, parsed.token, log);
}
