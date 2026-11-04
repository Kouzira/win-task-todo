// `task watch` and its options: --install, --uninstall, --status, --stop.
// Without an option it runs the watcher loop in this process. Install and
// uninstall print exactly what they will create or remove (one logon task,
// the URI scheme, and on uninstall every per-task ID) and ask first.
import { FILES } from './app-files.mjs';
import { MARKER } from './classify.mjs';
import { userName } from './manage.mjs';
import { notifyInstallLines, notifyUninstallLines, installNotify, uninstallNotify } from './notify.mjs';
import { parseJson, payload } from './ps.mjs';
import { listOwnKeys } from './registry.mjs';
import { registerTask, unregisterTask } from './scheduler.mjs';
import { isDisabled } from './skip-status.mjs';
import { loadTasks } from './view.mjs';
import { WATCH_MARKER, WATCH_TASK, findWatcher } from './watcher-id.mjs';
import { isWatcherProcess, readLock, runWatcher } from './watch.mjs';

const isYes = (a) => /^(y|yes)$/i.test(String(a ?? '').trim());
const conhost = (deps) => `${deps.systemRoot ?? 'C:\\Windows'}\\System32\\conhost.exe`;

// conhost --headless gives the watcher no window at all; the scheduler's
// default 72 hour limit is lifted so it is not ended after three days.
export function watcherSpec(deps) {
  return {
    name: WATCH_TASK,
    execute: conhost(deps),
    arguments: `--headless "${deps.nodePath}" "${deps.scriptPath}" watch`,
    kind: 'logon', time: null, date: null, days: [],
    user: userName(deps.user),
    description: `${WATCH_MARKER}\n${MARKER}: watcher of the "Today's schedule" cards.`,
    noTimeLimit: true,
  };
}

export function installPlan(deps) {
  const s = watcherSpec(deps);
  return [
    'Plan to install the watcher',
    `  Task:       ${s.name}`,
    `  Schedule:   At logon of ${s.user}`,
    `  Will run:   ${s.execute} ${s.arguments}`,
    `  Runs as:    ${s.user}, only when logged on, limited rights (no admin needed), no run time limit`,
    `  Marker:     ${WATCH_MARKER} (first line of the description)`,
    ...notifyInstallLines(deps),
  ];
}

export function uninstallPlan(keys, task) {
  return [
    'Plan to remove the watcher',
    task ? `  Delete task: ${task.path}${task.name}` : `  Task "${WATCH_TASK}" does not exist, no task will be deleted.`,
    '  Stop the running watcher, if any.',
    ...notifyUninstallLines(keys),
  ];
}

// The pid of a running watcher, or null. A lock left by a dead process or a
// previous boot does not count.
export async function runningWatcher(deps) {
  const held = readLock(deps.app);
  if (!held || Math.abs(Number(held.boot) - deps.bootMinute()) > 2 || !deps.isAlive(held.pid)) return null;
  return (await isWatcherProcess(deps.run, held.pid)) ? held.pid : null;
}

const MEMORY_SCRIPT = `
$g = Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ ws = $(if ($g) { $g.WorkingSet64 } else { $null }) })
`;

// Another process's memory is out of reach of process.memoryUsage, so the
// working set comes from Get-Process.
export async function workingSetMb(run, pid) {
  const r = parseJson(await run(payload({ pid }) + MEMORY_SCRIPT));
  return r?.ws ? Math.round((r.ws / 1048576) * 10) / 10 : null;
}

const pause = (deps, ms) => new Promise((resolve) => deps.timers.setTimeout(resolve, ms));

// Asks through the stop file and waits up to ten seconds for the lock to go.
// Only when a watcher ignores it (hung) is its process ended, and only after
// its command line shows it is a watcher.
export async function stopWatcher(deps) {
  const pid = await runningWatcher(deps);
  if (!pid) return { was: false };
  deps.app.write(FILES.stop, String(deps.now().getTime()));
  for (let i = 0; i < 40; i++) {
    if (!deps.isAlive(pid) || readLock(deps.app)?.pid !== pid) return { was: true, pid, how: 'stop' };
    await pause(deps, 250);
  }
  if (await isWatcherProcess(deps.run, pid)) deps.kill(pid);
  return { was: true, pid, how: 'kill' };
}

async function install(deps, flags) {
  const all = await loadTasks(deps);
  const own = findWatcher(all);
  const clash = all.find((t) => t.name.toLowerCase() === WATCH_TASK && t !== own);
  if (clash) { deps.err(`Another task named "${clash.name}" (${clash.path}) exists and is not the tool's watcher. Not overwriting it.`); return 1; }
  if (own) { deps.out(`The watcher is already installed (${own.path}${own.name}). Run "task watch --status" to check it.`); return 0; }
  for (const l of installPlan(deps)) deps.out(l);
  if (!flags.yes && !isYes(await deps.ask('Install the watcher? (y/N) '))) { deps.out('Cancelled, nothing changed.'); return 1; }
  await installNotify(deps);
  await registerTask(deps.run, watcherSpec(deps));
  deps.out(`Created task "${WATCH_TASK}". The watcher starts at the next logon; to start it now: task run "${WATCH_TASK}".`);
  return 0;
}

async function uninstall(deps, flags) {
  const task = findWatcher(await loadTasks(deps));
  const keys = await listOwnKeys(deps.run);
  for (const l of uninstallPlan(keys, task)) deps.out(l);
  if (!flags.yes && !isYes(await deps.ask('Remove the watcher? (y/N) '))) { deps.out('Cancelled, nothing changed.'); return 1; }
  const stopped = await stopWatcher(deps);
  if (stopped.was) deps.out(`Stopped the watcher (pid ${stopped.pid}).`);
  if (task) { await unregisterTask(deps.run, task); deps.out(`Deleted task "${task.name}".`); }
  await uninstallNotify(deps, keys);
  deps.out('Removed the tool\'s registry keys.');
  return 0;
}

async function status(deps) {
  const task = findWatcher(await loadTasks(deps));
  deps.out(`Logon task "${WATCH_TASK}": ${task ? (isDisabled(task.state) ? 'yes, off' : 'yes, on') : 'not installed'}`);
  const pid = await runningWatcher(deps);
  if (pid) {
    const mb = await workingSetMb(deps.run, pid);
    deps.out(`Watcher: running, pid ${pid}${mb === null ? '' : `, memory ${mb} MB (working set)`}`);
  } else deps.out('Watcher: not running');
  const keys = await listOwnKeys(deps.run);
  const ids = keys.ids.filter((id) => id.includes('.')).length;
  deps.out(`Notifications: ${keys.scheme ? `registered, ${ids} tasks with their own ID` : 'not registered (task notify --install)'}`);
  deps.out(`Tool folder: ${deps.app.dir}`);
  return 0;
}

export async function watchCmd(deps, flags) {
  const picked = ['install', 'uninstall', 'status', 'stop'].filter((f) => flags[f]);
  if (picked.length > 1) { deps.err('Use only one of --install, --uninstall, --status, --stop.'); return 2; }
  switch (picked[0]) {
    case 'install': return install(deps, flags);
    case 'uninstall': return uninstall(deps, flags);
    case 'status': return status(deps);
    case 'stop': {
      const r = await stopWatcher(deps);
      deps.out(r.was ? `Stopped the watcher (pid ${r.pid}${r.how === 'kill' ? ', the process had to be ended because it did not stop by itself' : ''}).` : 'No watcher is running.');
      return 0;
    }
    default: return runWatcher(deps, { onStart: deps.onStopSignal });
  }
}
