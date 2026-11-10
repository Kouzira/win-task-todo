// The help texts. `--help` and `-h` print one of these and run nothing: the
// check is made before any command is looked at, so no option combination can
// reach the scheduler, the registry or a notification when help was asked for.

export const HELP = [
  'task: read and manage Windows Task Scheduler in plain English',
  '',
  'Commands',
  '  task                              own tasks (same as task list)',
  '  task list [--all] [--json] [--project <label>]  --all includes system and vendor tasks',
  '  task show <name>                  details of one task',
  '  task add <name> <command> <schedule>  create a task [--yes] [--dry-run] [--cwd <dir>] [--log] [--project <label>]',
  '  task on <name> | off <name>       turn on | turn off',
  '  task run <name>                   run now',
  '  task delete <name> [--yes]        delete (always asks first, unless --yes)',
  '  task skip <name> | unskip <name>  skip the next run (re-enabled 1 minute later) | undo [--yes] [--dry-run]',
  '  task ui                           the day\'s tasks, full screen, commands start with /',
  '  task log <name>                   last run and the tail of the log file',
  '  task notify                       post or update the "Today\'s schedule" cards [--install] [--uninstall]',
  '  task watch                        the watcher that keeps the cards current [--install] [--uninstall] [--status] [--stop]',
  '  task doctor                       check why a card may not show (read only)',
  '  task help [command]               this page, or one command',
  '',
  'Every command accepts --help or -h: it prints help and does nothing else.',
  '',
  'Schedule: "daily 10:00", "weekdays 10:00", "mon,wed 09:30",',
  '          "once 2026-11-05 10:00", "at logon"',
  '',
  'Examples',
  '  task add backup "D:\\scripts\\backup.ps1" "weekdays 18:00" --dry-run',
  '  task show "Daily backup"',
];

export const COMMAND_HELP = {
  list: ['Usage: task list [--all] [--json] [--project <label>]', 'Own tasks, soonest first. --all adds system and vendor tasks, --json prints JSON, --project shows only the tasks with that label.'],
  show: ['Usage: task show <name>', 'Details of one task: command, working directory, schedule, account, runs, result, project.'],
  add: ['Usage: task add <name> <command> <schedule> [--yes] [--dry-run] [--cwd <dir>] [--log] [--project <label>]', 'Creates a task after printing the plan. --cwd sets its working directory (must exist), --log writes its output and exit code to <log folder>\\<name with hyphens>.log, --project stores a label.'],
  on: ['Usage: task on <name>', 'Turns a task on, then updates the cards.'],
  off: ['Usage: task off <name>', 'Turns a task off, then updates the cards.'],
  run: ['Usage: task run <name>', 'Starts a task now.'],
  delete: ['Usage: task delete <name> [--yes]', 'Deletes a task after asking, then updates the cards.'],
  skip: ['Usage: task skip <name> [--yes] [--dry-run]', 'Skips the next run; the task turns itself back on one minute later.'],
  unskip: ['Usage: task unskip <name> [--yes]', 'Undoes a skip: turns the task on and deletes the helper task.'],
  ui: ['Usage: task ui', 'The day\'s tasks in a full terminal screen; commands start with /.'],
  log: ['Usage: task log <name>', 'Last run, result and the end of the task\'s log file.'],
  notify: ['Usage: task notify [--install] [--uninstall] [--yes]', 'Posts or updates today\'s cards once. --install and --uninstall write or remove the registry keys.'],
  watch: ['Usage: task watch [--install] [--uninstall] [--status] [--stop] [--yes]', 'Runs the watcher that keeps the cards current, or installs, removes, inspects or stops it.'],
  doctor: ['Usage: task doctor', 'Checks, read only, why a card may not show, and says how to fix each finding.'],
  help: ['Usage: task help [command]', 'The general help, or the usage of one command.'],
};

// The usage of one command when it is known, otherwise the general help.
export function helpLines(command) {
  const entry = COMMAND_HELP[String(command ?? '').toLowerCase()];
  return entry ?? HELP;
}
