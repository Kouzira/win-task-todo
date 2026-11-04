// Argument dispatch. Returns the process exit code; never exits by itself.
import { parseArgs } from './args.mjs';
import { addCmd, deleteCmd, toggleCmd } from './manage.mjs';
import { skipCmd, unskipCmd } from './skip.mjs';
import { uiCmd } from './ui.mjs';
import { notifyCmd } from './notify.mjs';
import { uriCmd } from './uri.mjs';
import { listCmd, logCmd, showCmd } from './view.mjs';
import { watchCmd } from './watch-cmd.mjs';

export const HELP = [
  'task: read and manage Windows Task Scheduler in plain English',
  '',
  'Commands',
  '  task                              own tasks (same as task list)',
  '  task list [--all] [--json]        --all includes system and vendor tasks',
  '  task show <name>                  details of one task',
  '  task add <name> <command> <schedule>  create a task [--yes] [--dry-run]',
  '  task on <name> | off <name>       turn on | turn off',
  '  task run <name>                   run now',
  '  task delete <name> [--yes]        delete (always asks first, unless --yes)',
  '  task skip <name> | unskip <name>  skip the next run (re-enabled 1 minute later) | undo [--yes] [--dry-run]',
  '  task ui                           the day\'s tasks, full screen, commands start with /',
  '  task log <name>                   last run and the tail of the log file',
  '  task notify                       post or update the "Today\'s schedule" cards [--install] [--uninstall]',
  '  task watch                        the watcher that keeps the cards current [--install] [--uninstall] [--status] [--stop]',
  '  task help                         this page',
  '',
  'Schedule: "daily 10:00", "weekdays 10:00", "mon,wed 09:30",',
  '          "once 2026-11-05 10:00", "at logon"',
  '',
  'Examples',
  '  task add backup "D:\\scripts\\backup.ps1" "weekdays 18:00" --dry-run',
  '  task show "Daily backup"',
];

export async function main(argv, deps) {
  // A URI comes from outside (a toast button, but just as well a web page),
  // so it skips the normal parser: uriCmd sees the raw arguments and refuses
  // anything but exactly one allowed URI.
  if (String(argv[0] ?? '').toLowerCase() === 'uri') {
    try { return await uriCmd(deps, argv.slice(1)); }
    catch (e) { deps.err(`Error: ${e.message}`); return 1; }
  }
  const { flags, positional, unknown } = parseArgs(argv);
  if (unknown.length) {
    deps.err(`Unknown option: ${unknown.join(' ')}. Run "task help".`);
    return 2;
  }
  const [cmd = 'list', ...rest] = positional;
  const name = rest.join(' ').trim();
  try {
    switch (cmd.toLowerCase()) {
      case 'help': for (const l of HELP) deps.out(l); return 0;
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
