// `task skip` and `task unskip`. Windows has no "skip the next run", so a
// skip is: a one-time helper task that re-enables the task one minute after
// the skipped run, then the task is disabled. The helper is created FIRST.
// It is what guarantees the task comes back even if this tool is closed or
// the machine is off; the other order could leave a task disabled for good
// when the helper step fails.
import { refreshAfterChange } from './after-change.mjs';
import { MARKER } from './classify.mjs';
import { dateTime, parseLocal } from './format.mjs';
import { target, userName } from './manage.mjs';
import { fetchInfo, keyOf, taskAction, unregisterTask } from './scheduler.mjs';
import { helperName, registerHelper } from './skip-scheduler.mjs';
import { addMinutes, dayText, helperMarker, helperOf, isDisabled, isHelper, stampOf } from './skip-status.mjs';
import { loadTasks } from './view.mjs';

const isYes = (a) => /^(y|yes)$/i.test(String(a ?? '').trim());
const pad = (n) => String(n).padStart(2, '0');

// The helper stays valid for a day so that StartWhenAvailable can still run
// it after the machine was off at the exact minute; a window of a few
// minutes would expire before the machine woke and the task would stay off.
const WINDOW_MINUTES = 24 * 60;

// conhost --headless starts a console program with no window at all on
// Windows 11. powershell -WindowStyle Hidden still flashes a window for a
// moment before it hides, which would be seen on every re-enable.
export function helperPayload(deps, task, nextRun) {
  const start = addMinutes(parseLocal(nextRun), 1);
  const node = deps.nodePath ?? 'node';
  const script = deps.scriptPath ?? 'tasks.mjs';
  return {
    name: helperName(task.name),
    execute: 'conhost.exe',
    arguments: `--headless "${node}" "${script}" on "${task.name}" --yes`,
    at: stampOf(start),
    end: stampOf(addMinutes(start, WINDOW_MINUTES)),
    user: userName(deps.user),
    description: `${helperMarker(task.name)}\n${MARKER}: re-enables "${task.name}" after one run is skipped.`,
    reenable: start,
  };
}

export function skipPlan(task, nextRun, start) {
  const sameDayBack = start.d === parseLocal(nextRun).d;
  const back = `${pad(start.h)}:${pad(start.mi)}${sameDayBack ? '' : ` on ${dayText(start)}`}`;
  return `Skip the run of ${dateTime(nextRun)} of ${task.name}. The task will be turned off now and re-enabled at ${back}.`;
}

export async function skipCmd(deps, name, flags) {
  const all = await loadTasks(deps);
  const t = await target(deps, name, flags, all);
  if (!t) return 1;
  const refuse = (msg) => { deps.err(msg); return 1; };
  if (isHelper(t)) return refuse(`"${t.name}" is a helper task of this tool and cannot be skipped.`);
  if (isDisabled(t.state)) return refuse(`Task "${t.name}" is off, so it has no run to skip.`);
  if (/"/.test(t.name)) return refuse('The task name contains a double quote, so a safe helper task cannot be created for it.');
  const info = (await fetchInfo(deps.run, [t])).get(keyOf(t)) ?? {};
  const next = parseLocal(info.nextRun);
  if (!next || next.y < 2000) return refuse(`Task "${t.name}" has no upcoming run to skip.`);
  const { reenable, ...spec } = helperPayload(deps, t, info.nextRun);
  deps.out(skipPlan(t, info.nextRun, reenable));
  if (flags['dry-run']) { deps.out('Dry run (--dry-run): nothing done.'); return 0; }
  if (!flags.yes && !isYes(await deps.ask('Skip this run? (y/N) '))) {
    deps.out('Cancelled, nothing changed.');
    return 1;
  }
  try { await registerHelper(deps.run, spec); }
  catch (e) {
    deps.err(`Could not create the helper task, so "${t.name}" was not turned off. ${e.message}`);
    return 1;
  }
  try { await taskAction(deps.run, 'disable', t); }
  catch (e) {
    // Without this a helper would be left behind for a task that never got disabled.
    await unregisterTask(deps.run, { path: '\\', name: spec.name }).catch(() => {});
    deps.err(`Could not turn off "${t.name}"; the helper task was removed. ${e.message}`);
    return 1;
  }
  deps.out(`Skipped the run of ${dateTime(info.nextRun)} of "${t.name}". Re-enabled at ${pad(reenable.h)}:${pad(reenable.mi)}.`);
  await refreshAfterChange(deps);
  return 0;
}

export async function unskipCmd(deps, name, flags) {
  const all = await loadTasks(deps);
  const t = await target(deps, name, flags, all);
  if (!t) return 1;
  const helper = helperOf(all, t.name);
  await taskAction(deps.run, 'enable', t);
  if (!helper) {
    deps.out(`No helper task for "${t.name}" (no skip is pending). Task turned on.`);
    await refreshAfterChange(deps);
    return 0;
  }
  await unregisterTask(deps.run, helper);
  deps.out(`Re-enabled "${t.name}" and deleted the helper task "${helper.name}".`);
  await refreshAfterChange(deps);
  return 0;
}
