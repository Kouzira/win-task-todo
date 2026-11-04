// Turns the scheduler's data into the rows of `task ui`. makeRow is pure
// (everything it needs is passed in), so the status words can be tested
// without a scheduler; buildRows is the one function that fetches.
import { hhmm, parseLocal } from './format.mjs';
import { toUnsigned } from './results.mjs';
import { triggersSummary } from './schedule-words.mjs';
import { fetchInfo, keyOf } from './scheduler.mjs';
import { isDisabled, isHelper, skipStatus } from './skip-status.mjs';
import { detailLines, loadTasks } from './view.mjs';
import { isWatcher, watcherStatus } from './watcher-id.mjs';

const validParts = (iso) => { const p = parseLocal(iso); return p && p.y >= 2000 ? p : null; };
const sameDay = (p, now) => Boolean(p) && p.y === now.getFullYear() && p.mo === now.getMonth() + 1 && p.d === now.getDate();
const atMs = (p) => new Date(p.y, p.mo - 1, p.d, p.h, p.mi).getTime();
const pad = (n) => String(n).padStart(2, '0');

// Codes that say "not a failure": ready, running, never run.
const NOT_FAILURES = new Set([0x41300, 0x41301, 0x41303]);

export function timeLeft(now, next) {
  const minutes = Math.max(0, Math.round((atMs(next) - now.getTime()) / 60000));
  if (minutes < 1) return 'less than 1 min left';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min left`;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

// `at` is the clock time of today's event the row is about (the run that
// finished, failed or is due) and `left` the wait before a due run; each card
// in the Notification Center builds its line from them, so it says exactly
// what this list says. lastRun and lastResult let the watcher tell one failed
// run from the next.
export function makeRow(task, info, all, now) {
  const next = validParts(info.nextRun);
  const last = validParts(info.lastRun);
  const code = toUnsigned(info.lastResult);
  const base = {
    name: task.name, path: task.path, schedule: triggersSummary(task.triggers), enabled: !isDisabled(task.state),
    nextRun: info.nextRun ?? null, lastRun: info.lastRun ?? null, lastResult: info.lastResult ?? null,
  };
  if (isWatcher(task)) return { ...base, kind: 'watcher', watcher: true, status: watcherStatus(task), time: '-' };
  const skipped = skipStatus(task, all, now);
  if (skipped) return { ...base, kind: 'skipped', status: skipped, skipped: true, time: next ? `${pad(next.mo)}-${pad(next.d)} ${hhmm(next.h, next.mi)}` : '-' };
  if (!base.enabled) return { ...base, kind: 'off', status: 'Off', time: '-' };
  const lastTime = last ? hhmm(last.h, last.mi) : '-';
  if (/^(running|4)$/i.test(String(task.state)) || code === 0x41301) return { ...base, kind: 'running', status: 'Running', time: lastTime, at: lastTime };
  const failedToday = sameDay(last, now) && code !== null && code !== 0 && !NOT_FAILURES.has(code);
  // The time column is the next run for every row, so a failure says its own
  // time in the status: 09:27 beside other rows' next runs read as a schedule.
  if (failedToday) return { ...base, kind: 'failed', status: `Failed at ${lastTime}`, at: lastTime, time: next ? `${pad(next.mo)}-${pad(next.d)} ${hhmm(next.h, next.mi)}` : '-' };
  if (sameDay(next, now) && atMs(next) >= now.getTime()) {
    const left = timeLeft(now, next);
    return { ...base, kind: 'pending', status: `Waiting, ${left}`, left, at: hhmm(next.h, next.mi), time: hhmm(next.h, next.mi) };
  }
  if (sameDay(last, now) && code === 0) return { ...base, kind: 'done', status: 'Done', time: lastTime, at: lastTime };
  return { ...base, kind: 'none', status: 'No run today', time: next ? `${pad(next.mo)}-${pad(next.d)} ${hhmm(next.h, next.mi)}` : '-' };
}

// Soonest next run first; no next run goes last, by name.
export function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.nextRun && b.nextRun && a.nextRun !== b.nextRun) return a.nextRun < b.nextRun ? -1 : 1;
    if (a.nextRun && !b.nextRun) return -1;
    if (!a.nextRun && b.nextRun) return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function buildRows(deps) {
  const now = deps.now();
  const all = await loadTasks(deps);
  const own = all.filter((t) => t.own && !isHelper(t));
  const info = await fetchInfo(deps.run, own);
  const rows = own.map((t) => {
    const i = info.get(keyOf(t)) ?? {};
    return { ...makeRow(t, i, all, now), detail: detailLines(t, i) };
  });
  return { rows: sortRows(rows), now: now.toISOString() };
}
