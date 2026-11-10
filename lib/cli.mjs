// Argument dispatch. Returns the process exit code; never exits by itself.
import { parseArgs } from './args.mjs';
import { doctorCmd } from './doctor-cmd.mjs';
import { HELP, helpLines } from './help.mjs';
import { addCmd, deleteCmd, toggleCmd } from './manage.mjs';
import { skipCmd, unskipCmd } from './skip.mjs';
import { uiCmd } from './ui.mjs';
import { notifyCmd } from './notify.mjs';
import { uriCmd } from './uri.mjs';
import { listCmd, logCmd, showCmd } from './view.mjs';
import { watchCmd } from './watch-cmd.mjs';

export { HELP };

// The command a help request is about: the first word that is not an option,
// skipping a leading "help" (`task help add`).
function helpTopic(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  return String(words[0] ?? '').toLowerCase() === 'help' ? words[1] : words[0];
}

export async function main(argv, deps) {
  // Help comes first and is decided on the raw arguments: whatever else is on
  // the line, nothing is run, so `task notify --help` can never post a card.
  const first = argv.find((a) => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h') || String(first ?? '').toLowerCase() === 'help') {
    for (const l of helpLines(helpTopic(argv))) deps.out(l);
    return 0;
  }
  // A URI comes from outside (a toast button, but just as well a web page),
  // so it skips the normal parser: uriCmd sees the raw arguments and refuses
  // anything but exactly one allowed URI.
  if (String(argv[0] ?? '').toLowerCase() === 'uri') {
    try { return await uriCmd(deps, argv.slice(1)); }
    catch (e) { deps.err(`Error: ${e.message}`); return 1; }
  }
  const { flags, positional, unknown, missing } = parseArgs(argv);
  if (unknown.length) {
    deps.err(`Unknown option: ${unknown.join(' ')}. Run "task help".`);
    return 2;
  }
  if (missing.length) {
    deps.err(`${missing.join(' ')} needs a value. Run "task help".`);
    return 2;
  }
  const [cmd = 'list', ...rest] = positional;
  const name = rest.join(' ').trim();
  try {
    switch (cmd.toLowerCase()) {
      case 'doctor': return await doctorCmd(deps);
      case 'list': return await listCmd(deps, flags);
      case 'show': return await requireName(deps, name, () => showCmd(deps, name));
      case 'log': return await requireName(deps, name, () => logCmd(deps, name));
      case 'add': return await addCmd(deps, rest, flags);
      case 'on': case 'off': case 'run':
        return await requireName(deps, name, () => toggleCmd(deps, cmd.toLowerCase(), name, flags));
      case 'skip': return await requireName(deps, name, () => skipCmd(deps, name, flags));
      case 'unskip': return await requireName(deps, name, () => unskipCmd(deps, name, flags));
      case 'ui': return await uiCmd(deps);
      case 'notify': return await notifyCmd(deps, flags);
      case 'watch': return await watchCmd(deps, flags);
      case 'delete': return await requireName(deps, name, () => deleteCmd(deps, name, flags));
      default:
        deps.err(`Unknown command "${cmd}". Run "task help".`);
        return 2;
    }
  } catch (e) {
    deps.err(`Error: ${e.message}`);
    return 1;
  }
}

async function requireName(deps, name, fn) {
  if (!name) { deps.err('Missing task name. Run "task help" for usage.'); return 2; }
  return fn();
}
