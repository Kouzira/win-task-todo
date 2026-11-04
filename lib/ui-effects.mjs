// Runs the effects the `task ui` reducer asks for. Every one of them calls
// the same command function the command line uses (addCmd, skipCmd, ...),
// with its output captured instead of printed and the confirmation already
// given in the interface, so there is no second implementation of a write.
// Planning steps call the same functions with --dry-run, which prints the
// plan and changes nothing.
import { addCmd, deleteCmd, toggleCmd } from './manage.mjs';
import { skipCmd, unskipCmd } from './skip.mjs';
import { buildRows } from './ui-model.mjs';
import { logCmd, showCmd } from './view.mjs';

function capture(deps) {
  const lines = [];
  const push = (l = '') => lines.push(l);
  return { lines, deps: { ...deps, out: push, err: push, ask: async () => 'n' } };
}

const DRY_NOTE = /^Dry run/;
// The reducer has already asked its extra question for the watcher row, so
// the command functions must not ask again (their captured answer is no).
const OK = { 'watcher-ok': true };

async function plan(deps, effect, run, prompt) {
  const cap = capture(deps);
  const code = await run(cap.deps);
  if (code !== 0) return { kind: 'message', lines: cap.lines };
  return { kind: 'plan', lines: cap.lines.filter((l) => !DRY_NOTE.test(l)), prompt, effect };
}

async function write(deps, run) {
  const cap = capture(deps);
  const code = await run(cap.deps);
  return { kind: 'done', ok: code === 0, lines: cap.lines };
}

async function view(deps, title, run) {
  const cap = capture(deps);
  const code = await run(cap.deps);
  return code === 0 ? { kind: 'panel', title, lines: cap.lines } : { kind: 'message', lines: cap.lines };
}

export async function runEffect(deps, effect) {
  try {
    switch (effect.type) {
      case 'fetch': return { kind: 'rows', ...(await buildRows(deps)) };
      case 'details': return await view(deps, effect.name, (d) => showCmd(d, effect.name));
      case 'log': return await view(deps, `Log of ${effect.name}`, (d) => logCmd(d, effect.name));
      case 'plan-add':
        return await plan(deps, { type: 'add', args: effect.args }, (d) => addCmd(d, effect.args, { 'dry-run': true }), 'Create this task? (y/N)');
      case 'plan-skip':
        return await plan(deps, { type: 'skip', name: effect.name }, (d) => skipCmd(d, effect.name, { ...OK, 'dry-run': true }), 'Skip this run? (y/N)');
      case 'add': return await write(deps, (d) => addCmd(d, effect.args, { yes: true }));
      case 'delete': return await write(deps, (d) => deleteCmd(d, effect.name, { yes: true }));
      case 'toggle': return await write(deps, (d) => toggleCmd(d, effect.verb, effect.name, OK));
      case 'run': return await write(deps, (d) => toggleCmd(d, 'run', effect.name, OK));
      case 'skip': return await write(deps, (d) => skipCmd(d, effect.name, { yes: true }));
      case 'unskip': return await write(deps, (d) => unskipCmd(d, effect.name, OK));
      default: return { kind: 'message', lines: [`Unknown effect: ${effect.type}`] };
    }
  } catch (e) {
    return { kind: 'error', lines: [`Error: ${e.message}`] };
  }
}
