// Read-only commands: list, show, log. Nothing here changes the scheduler.
import { isOwnTask } from './classify.mjs';
import { dateTime, table } from './format.mjs';
import { findLog } from './logs.mjs';
import { findTask } from './match.mjs';
import { projectOf, sameProject, visibleDescription } from './project.mjs';
import { hex, resultWords, toUnsigned } from './results.mjs';
import { triggerWords, triggersSummary } from './schedule-words.mjs';
import { fetchInfo, fetchTasks, keyOf } from './scheduler.mjs';
import { isHelper, skipStatus } from './skip-status.mjs';
import { isWatcher, watcherStatus } from './watcher-id.mjs';

export function statusWord(state) {
  const s = String(state ?? '').toLowerCase();
  if (s === 'running' || s === '4') return 'Running';
  if (s === 'disabled' || s === '1') return 'Off';
  return 'On';
}

export async function loadTasks(deps) {
  const tasks = await fetchTasks(deps.run);
  return tasks.map((t) => ({ ...t, own: isOwnTask(t, deps.user) }));
}

export function printMissing(deps, name, found) {
  if (found.ambiguous) {
    deps.err(`Several tasks are named "${name}" in different folders:`);
    for (const t of found.ambiguous) deps.err(`  ${t.path}${t.name}`);
    return;
  }
  deps.err(`No task named "${name}" found.`);
  if (found.missing.length) {
    deps.err('Similar names:');
    for (const t of found.missing) deps.err(`  ${t.name}`);
  } else {
    deps.err('Use "task list --all" to see everything.');
  }
}

export async function listCmd(deps, flags) {
  const all = await loadTasks(deps);
  // Helper tasks that re-enable a skipped task are plumbing: hidden unless --all.
  let shown = flags.all ? all : all.filter((t) => t.own && !isHelper(t));
  if (flags.project) shown = shown.filter((t) => sameProject(projectOf(t), flags.project));
  const info = await fetchInfo(deps.run, shown);
  const rows = shown.map((t) => {
    const i = info.get(keyOf(t)) ?? {};
    return {
      name: t.name,
      path: t.path,
      schedule: triggersSummary(t.triggers),
      nextRun: i.nextRun ?? null,
      lastRun: i.lastRun ?? null,
      resultCode: i.lastResult ?? null,
      result: i.lastResult === null || i.lastResult === undefined ? 'Unknown' : resultWords(i.lastResult),
      status: isWatcher(t) ? watcherStatus(t) : skipStatus(t, all, deps.now()) ?? statusWord(t.state),
      project: projectOf(t),
      own: t.own,
      helper: isHelper(t),
    };
  });
  // Soonest first; tasks with no next run (disabled, expired) go last by name.
  rows.sort((a, b) => {
    if (a.nextRun && b.nextRun) return a.nextRun < b.nextRun ? -1 : a.nextRun > b.nextRun ? 1 : a.name.localeCompare(b.name);
    if (a.nextRun) return -1;
    if (b.nextRun) return 1;
    return a.name.localeCompare(b.name);
  });
  if (flags.json) {
    deps.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    deps.out(flags.project ? `No tasks with the project "${flags.project}".` : 'No own tasks. Use "task list --all" to include system tasks.');
    return 0;
  }
  // The Project column exists only when some task has a label, so a list
  // without labels looks exactly as it always did.
  const withProject = rows.some((r) => r.project);
  const headers = ['Name', 'Schedule', 'Next run', 'Last run', 'Result', 'State'];
  if (withProject) headers.push('Project');
  if (flags.all) headers.push('Type');
  const body = rows.map((r) => {
    const cells = [r.name, r.schedule, dateTime(r.nextRun), dateTime(r.lastRun), r.result, r.status];
    if (withProject) cells.push(r.project ?? '');
    if (flags.all) cells.push(r.helper ? 'Helper' : r.own ? 'Own' : 'System');
    return cells;
  });
  const mins = withProject ? [16, 20, 16, 16, 8, 34, 8, 8] : [16, 20, 16, 16, 8, 34, 8];
  for (const line of table(headers, body, undefined, mins)) deps.out(line);
  return 0;
}

const LOGON = {
  interactive: 'only when logged on',
  interactivetoken: 'only when logged on',
  '3': 'only when logged on',
  password: 'whether logged on or not (password stored)',
  '1': 'whether logged on or not (password stored)',
  s4u: 'whether logged on or not (password not stored)',
  '2': 'whether logged on or not (password not stored)',
  serviceaccount: 'service account',
  '5': 'service account',
};

function runAsWords(t) {
  const who = t.userId || 'unknown';
  const logon = LOGON[String(t.logonType ?? '').toLowerCase()];
  const high = /^(highest|1)$/i.test(String(t.runLevel ?? ''));
  return `${who}${logon ? `, ${logon}` : ''}, ${high ? 'highest rights (admin)' : 'limited rights'}`;
}

export function resultLine(code) {
  if (code === null || code === undefined) return 'Unknown';
  const words = resultWords(code);
  if (words.startsWith('Failed, code')) return words;
  return `${words} (${toUnsigned(code) === 0 ? '0' : hex(code)})`;
}

export async function showCmd(deps, name) {
  const all = await loadTasks(deps);
  const found = findTask(name, all);
  if (!found.task) { printMissing(deps, name, found); return 1; }
  const t = found.task;
  const i = (await fetchInfo(deps.run, [t])).get(keyOf(t)) ?? {};
  for (const line of detailLines(t, i)) deps.out(line);
  return 0;
}

// The detail text of one task from data already fetched. `task ui` calls it
// with the task and run info its list fetch already holds, so Enter shows the
// panel at once instead of asking PowerShell for every task again (which took
// several seconds on a machine with about 200 tasks).
export function detailLines(t, i = {}) {
  const rows = [
    ['Name', t.name],
    ['Path', `${t.path}${t.name}`],
    ['Type', t.own ? 'Own task' : 'System / vendor'],
    ['State', statusWord(t.state)],
  ];
  const project = projectOf(t);
  if (project) rows.push(['Project', project]);
  const description = visibleDescription(t.description);
  if (description) rows.push(['Description', description]);
  if (!t.actions.length) rows.push(['Command', '(none)']);
  t.actions.forEach((a, n) => {
    const tag = t.actions.length > 1 ? ` ${n + 1}` : '';
    rows.push([`Command${tag}`, a.execute || '(empty)']);
    rows.push([`Arguments${tag}`, a.arguments || '(none)']);
    rows.push([`Working directory${tag}`, a.workingDirectory || '(default)']);
  });
  if (!t.triggers.length) rows.push(['Schedule', 'No schedule']);
  t.triggers.forEach((g, n) => rows.push([t.triggers.length > 1 ? `Schedule ${n + 1}` : 'Schedule', triggerWords(g)]));
  rows.push(['Runs as', runAsWords(t)]);
  rows.push(['Next run', dateTime(i.nextRun)]);
  rows.push(['Last run', dateTime(i.lastRun)]);
  rows.push(['Last result', resultLine(i.lastResult)]);
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`);
}

export async function logCmd(deps, name) {
  const all = await loadTasks(deps);
  const found = findTask(name, all);
  if (!found.task) { printMissing(deps, name, found); return 1; }
  const t = found.task;
  const i = (await fetchInfo(deps.run, [t])).get(keyOf(t)) ?? {};
  deps.out(`Task:         ${t.name}`);
  deps.out(`Last run:     ${dateTime(i.lastRun)}`);
  deps.out(`Last result:  ${resultLine(i.lastResult)}`);
  const log = await findLog(deps.logs, t);
  if (!log) {
    if (deps.logs.dir) deps.out(`No log file found for this task in ${deps.logs.dir}.`);
    else deps.out('No log folder is set. Set the environment variable TASK_LOG_DIR, or put {"logDir": "<folder>"} in %LOCALAPPDATA%\\win-task-todo\\config.json.');
    return 0;
  }
  const mtime = new Date(log.mtimeMs);
  const stamp = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')} `
    + `${String(mtime.getHours()).padStart(2, '0')}:${String(mtime.getMinutes()).padStart(2, '0')}`;
  deps.out(`Log file:     ${log.file} (last modified ${stamp})`);
  deps.out(`End of file (${log.lines.length} lines):`);
  for (const l of log.lines) deps.out(`  ${l}`);
  return 0;
}
