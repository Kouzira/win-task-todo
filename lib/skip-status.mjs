// What the tool knows about a skipped run, derived only from the scheduler's
// own data: a skipped task is a disabled task with a helper task beside it,
// and the helper's description carries a marker naming the task it will
// re-enable. Nothing is stored anywhere else, so the state cannot drift from
// what Windows really holds.
import { hhmm, parseLocal } from './format.mjs';

export const HELPER_PREFIX = 'tasks-reenable:';
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim();

export const helperMarker = (name) => HELPER_PREFIX + name;

// Name of the task a helper re-enables, or null when the task is no helper.
export function helperTarget(task) {
  const first = String(task.description ?? '').split(/\r?\n/)[0];
  return first.startsWith(HELPER_PREFIX) ? first.slice(HELPER_PREFIX.length) : null;
}

export const isHelper = (task) => helperTarget(task) !== null;

export function helperOf(all, name) {
  return all.find((t) => helperTarget(t) !== null && norm(helperTarget(t)) === norm(name)) ?? null;
}

export function isDisabled(state) {
  const s = String(state ?? '').toLowerCase();
  return s === 'disabled' || s === '1';
}

// Wall-clock arithmetic on parsed parts through UTC, so the machine's time
// zone and daylight saving never shift a plain "one minute later".
export function addMinutes(p, n) {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi + n));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

const pad = (n) => String(n).padStart(2, '0');
export const stampOf = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
export const dayText = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
const sameDay = (p, now) => p.y === now.getFullYear() && p.mo === now.getMonth() + 1 && p.d === now.getDate();

// Status text for the list, or null when the task is not in a skipped state.
export function skipStatus(task, all, now) {
  if (!isDisabled(task.state)) return null;
  const helper = helperOf(all, task.name);
  if (!helper) return null;
  const start = parseLocal((helper.triggers ?? [])[0]?.startBoundary);
  if (!start) return null;
  // Two minutes of slack: at the exact minute the helper may be mid-run, and
  // a false alarm there would teach the owner to ignore the warning.
  if (now.getTime() >= new Date(start.y, start.mo - 1, start.d, start.h, start.mi + 2).getTime()) {
    return 'Off (not re-enabled yet)';
  }
  const skipped = addMinutes(start, -1);
  const day = sameDay(skipped, now) ? '' : ` on ${dayText(skipped)}`;
  return `Skipped ${hhmm(skipped.h, skipped.mi)}${day}, re-enabled at ${hhmm(start.h, start.mi)}`;
}
