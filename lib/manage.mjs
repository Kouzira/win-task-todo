// Commands that change the scheduler: add, on, off, run, delete. Each one
// reads first, prints what it is about to do, and only then writes. Nothing
// here ever asks for elevation: tasks are registered for the current user,
// interactive logon, limited run level.
import { buildAction } from './command.mjs';
import { MARKER, isUnderMicrosoft } from './classify.mjs';
import { findTask } from './match.mjs';
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

export function planLines(name, command, spec, user) {
  const action = buildAction(command);
  return [
    'Plan to create a task',
    `  Name:       ${name}`,
    `  Command:    ${command}`,
    `  Will run:   ${action.execute} ${action.arguments}`.trimEnd(),
    `  Schedule:   ${specWords(spec)}`,
    `  Runs as:    ${userName(user)}, only when logged on, limited rights (no admin needed)`,
  ];
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
  for (const line of planLines(name.trim(), command, spec, deps.user)) deps.out(line);
  if (flags['dry-run']) { deps.out('Dry run (--dry-run): nothing created.'); return 0; }
  if (!flags.yes && !isYes(await deps.ask('Create this task? (y/N) '))) {
    deps.out('Cancelled, nothing created.');
    return 1;
  }
  const action = buildAction(command);
  await registerTask(deps.run, {
    name: name.trim(),
    execute: action.execute,
    arguments: action.arguments,
    kind: spec.kind,
    time: spec.time ?? null,
    date: spec.date ?? null,
    days: spec.kind === 'weekdays' ? [1, 2, 3, 4, 5].map((d) => DAY_EN[d])
      : spec.kind === 'weekly' ? spec.days.map((d) => DAY_EN[d]) : [],
    user: userName(deps.user),
    description: MARKER,
  });
  deps.out(`Created task "${name.trim()}" (${specWords(spec)}).`);
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
  return 0;
}
