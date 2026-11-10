// Commands that change the scheduler: add, on, off, run, delete. Each one
// reads first, prints what it is about to do, and only then writes. Nothing
// here ever asks for elevation: tasks are registered for the current user,
// interactive logon, limited run level.
import { refreshAfterChange } from './after-change.mjs';
import path from 'node:path';
import { buildAction, wrapWithLog } from './command.mjs';
import { findProblems, pathExists } from './command-check.mjs';
import { isUnderMicrosoft } from './classify.mjs';
import { logFileName } from './logs.mjs';
import { findTask } from './match.mjs';
import { cleanLabel, describeTask, labelProblem } from './project.mjs';
import { ScheduleError, parseSchedule } from './schedule-parse.mjs';
import { specWords } from './schedule-words.mjs';
import { registerTask, taskAction, unregisterTask } from './scheduler.mjs';
import { loadTasks, printMissing } from './view.mjs';
import { WATCHER_QUESTION, WATCHER_WARNING, isWatcher } from './watcher-id.mjs';

const DAY_EN = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
const isYes = (a) => /^(y|yes)$/i.test(String(a ?? '').trim());

export function userName(user) {
  return user.domain ? `${user.domain}\\${user.name}` : user.name;
}

export function validName(name) {
  if (!name || !String(name).trim()) return 'The task name is empty.';
  if (/[\\/:*?"<>|]/.test(name)) return 'The task name cannot contain any of these characters: \\ / : * ? " < > |.';
  return null;
}

// extras: { cwd, logFile, project, wrapped } from the options of `task add`;
// `wrapped` is the action after the logging runner is put around it.
export function planLines(name, command, spec, user, extras = {}) {
  const action = extras.wrapped ?? buildAction(command);
  const lines = [
    'Plan to create a task',
    `  Name:       ${name}`,
    `  Command:    ${command}`,
    `  Will run:   ${action.execute} ${action.arguments}`.trimEnd(),
  ];
  if (extras.cwd) lines.push(`  Working dir: ${extras.cwd}`);
  if (extras.logFile) lines.push(`  Log:        ${extras.logFile} (output and exit code of each run, about 1 MB, then .log.1)`);
  if (extras.project) lines.push(`  Project:    ${extras.project}`);
  lines.push(
    `  Schedule:   ${specWords(spec)}`,
    `  Runs as:    ${userName(user)}, only when logged on, limited rights (no admin needed)`,
  );
  return lines;
}

// Checks --cwd, --log and --project; returns { error } or the extras.
function addExtras(deps, name, command, flags) {
  const extras = {};
  if (flags.cwd !== undefined) {
    const cwd = String(flags.cwd).trim().replace(/^"+|"+$/g, '');
    if (!path.win32.isAbsolute(cwd)) return { error: `--cwd must be a full path such as D:\\scripts, not "${cwd}".` };
    if (!deps.dirExists(cwd)) return { error: `The working directory "${cwd}" does not exist.` };
    extras.cwd = cwd;
  }
  if (flags.project !== undefined) {
    const bad = labelProblem(flags.project);
    if (bad) return { error: bad };
    extras.project = cleanLabel(flags.project);
  }
  let action = buildAction(command);
  if (flags.log) {
    if (!deps.logs?.dir) return { error: 'No log folder is set, so --log has nowhere to write. Set the environment variable TASK_LOG_DIR, or put {"logDir": "<folder>"} in %LOCALAPPDATA%\\win-task-todo\\config.json.' };
    extras.logFile = path.win32.join(deps.logs.dir, logFileName(name));
    action = wrapWithLog(action, { nodePath: deps.nodePath, runnerPath: deps.runnerPath, logFile: extras.logFile });
  }
  return { extras: { ...extras, wrapped: action }, action };
}

export async function addCmd(deps, positional, flags) {
  const [name, command, schedule, ...extra] = positional;
  if (!name || !command || !schedule || extra.length) {
    deps.err('Usage:   task add <name> <command> <schedule>   (quote the command and the schedule)');
    deps.err('Example: task add backup "D:\\scripts\\backup.ps1" "weekdays 18:00"');
    return 2;
  }
  const bad = validName(name);
  if (bad) { deps.err(bad); return 2; }
  let spec;
  try { spec = parseSchedule(schedule, deps.now()); }
  catch (e) {
    if (e instanceof ScheduleError) { deps.err(`Invalid schedule. ${e.message}`); return 2; }
    throw e;
  }
  const existing = await loadTasks(deps);
  const clash = existing.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  if (clash) {
    deps.err(`A task named "${clash.name}" already exists (${clash.path}${clash.name}). Not creating a duplicate; pick another name or delete the old task.`);
    return 1;
  }
  const made = addExtras(deps, name.trim(), command, flags);
  if (made.error) { deps.err(made.error); return 2; }
  for (const line of planLines(name.trim(), command, spec, deps.user, made.extras)) deps.out(line);
  // Advisory only: the user may be about to create the file, so the task is
  // still created with --yes and still planned with --dry-run.
  for (const p of findProblems(command, pathExists(deps))) deps.out(`Warning: ${p} The task may fail when it runs.`);
  if (flags['dry-run']) { deps.out('Dry run (--dry-run): nothing created.'); return 0; }
  if (!flags.yes && !isYes(await deps.ask('Create this task? (y/N) '))) {
    deps.out('Cancelled, nothing created.');
    return 1;
  }
  const { action, extras } = made;
  await registerTask(deps.run, {
    name: name.trim(),
    execute: action.execute,
    arguments: action.arguments,
    cwd: extras.cwd ?? null,
    kind: spec.kind,
    time: spec.time ?? null,
    date: spec.date ?? null,
    days: spec.kind === 'weekdays' ? [1, 2, 3, 4, 5].map((d) => DAY_EN[d])
      : spec.kind === 'weekly' ? spec.days.map((d) => DAY_EN[d]) : [],
    user: userName(deps.user),
    description: describeTask(extras.project),
  });
  deps.out(`Created task "${name.trim()}" (${specWords(spec)}).`);
  await refreshAfterChange(deps);
  return 0;
}

// Resolves the target of on/off/run/delete and enforces the protection of
// system and vendor tasks, which only --all lifts.
export async function target(deps, name, flags, preloaded) {
  if (!name) { deps.err('Missing task name. Run "task help" for usage.'); return null; }
  const all = preloaded ?? await loadTasks(deps);
  const found = findTask(name, all);
  if (!found.task) { printMissing(deps, name, found); return null; }
  const t = found.task;
  if ((isUnderMicrosoft(t) || !t.own) && !flags.all) {
    deps.err(`"${t.name}" is a system / vendor task (${t.path}), so it cannot be changed by default.`);
    deps.err('If you really need to, add --all to the command.');
    return null;
  }
  // The watcher is the tool's own task, so it passes the check above; it gets
  // one more question because switching it off silently ends the cards in the
  // Notification Center. `task ui` asks this itself and passes watcher-ok.
  if (isWatcher(t) && !flags.yes && !flags['watcher-ok']) {
    deps.out(WATCHER_WARNING);
    if (!isYes(await deps.ask(`${WATCHER_QUESTION} `))) {
      deps.out('Cancelled, nothing changed.');
      return null;
    }
  }
  return t;
}

const VERBS = {
  on: ['enable', 'Turned on'],
  off: ['disable', 'Turned off'],
  run: ['start', 'Requested an immediate run of'],
};

export async function toggleCmd(deps, verb, name, flags) {
  const t = await target(deps, name, flags);
  if (!t) return 1;
  const [action, done] = VERBS[verb];
  await taskAction(deps.run, action, t);
  deps.out(`${done} task "${t.name}".`);
  // Running a task changes no card by itself (the watcher sees the run end).
  if (verb !== 'run') await refreshAfterChange(deps);
  return 0;
}

export async function deleteCmd(deps, name, flags) {
  const t = await target(deps, name, flags);
  if (!t) return 1;
  deps.out(`Task to be deleted: ${t.name} (${t.path}${t.name})`);
  if (!flags.yes && !isYes(await deps.ask('Delete this task? (y/N) '))) {
    deps.out('Cancelled, nothing deleted.');
    return 1;
  }
  await unregisterTask(deps.run, t);
  deps.out(`Deleted task "${t.name}".`);
  await refreshAfterChange(deps);
  return 0;
}
