// `task ui`: the thin I/O shell around the pure parts. It owns the terminal
// (alternate screen, raw keys, the resize event, the 60 second refresh) and nothing else; what
// is drawn comes from render(), what a key does from reduce(), and what is
// written to the scheduler from runEffect().
import readline from 'node:readline';
import { runEffect } from './ui-effects.mjs';
import { render } from './ui-render.mjs';
import { applyResult, initialState, reduce } from './ui-reduce.mjs';

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
const REFRESH_MS = 60000;

export async function uiCmd(deps, io = { stdin: process.stdin, stdout: process.stdout }) {
  const { stdin, stdout } = io;
  if (!stdin.isTTY || !stdout.isTTY) {
    deps.err('"task ui" must run in a terminal window (it cannot run when output is redirected).');
    return 1;
  }
  let state = initialState(deps.now());
  let timer = null;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let closed = false;

  const paint = () => {
    if (closed) return;
    const cols = Math.max(20, stdout.columns || 80);
    const rows = Math.max(10, stdout.rows || 24);
    stdout.write('\x1b[H' + render(state, cols, rows).map((l) => `${l}\x1b[K`).join('\n'));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    stdin.removeListener('keypress', onKey);
    stdout.removeListener('resize', paint);
    try { stdin.setRawMode(false); } catch { /* already restored */ }
    stdin.pause();
    stdout.write(LEAVE);
    finish();
  };
  const handle = (step) => {
    state = step.state;
    paint();
    if (!step.effect) return;
    if (step.effect.type === 'quit') { close(); return; }
    runEffect(deps, step.effect).then((res) => { if (!closed) handle(applyResult(state, res)); });
  };
  function onKey(str, key = {}) {
    handle(reduce(state, { name: key.name, ch: str, ctrl: Boolean(key.ctrl), meta: Boolean(key.meta) }));
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(ENTER);
  // The screen is restored on any way out: normal quit, Ctrl+C (a keypress in
  // raw mode), a crash, or the process being ended.
  process.once('exit', () => { if (!closed) stdout.write(LEAVE); });
  stdin.on('keypress', onKey);
  stdout.on('resize', paint);
  timer = setInterval(() => handle(reduce(state, { name: 'tick' })), REFRESH_MS);
  paint();
  handle({ state, effect: { type: 'fetch' } });
  try { await finished; } finally { close(); }
  return 0;
}
