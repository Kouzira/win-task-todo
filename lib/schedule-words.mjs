// Turns schedules into English words, both for a spec parsed from user text
// (the `add` plan) and for the trigger records read back from the scheduler.
import { hhmm, parseLocal } from './format.mjs';

const DAY_NAMES = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const pad = (n) => String(n).padStart(2, '0');

export const daysText = (days) => days.map((d) => DAY_NAMES[d]).join(', ');

export function specWords(spec) {
  switch (spec.kind) {
    case 'daily': return `Every day at ${spec.time}`;
    case 'weekdays': return `Every weekday at ${spec.time}`;
    case 'weekly': return `${daysText(spec.days)} at ${spec.time}`;
    case 'once': return `Once: ${spec.date} ${spec.time}`;
    case 'logon': return 'At logon';
    default: return 'Unknown schedule';
  }
}

// Windows stores DaysOfWeek as a bit mask: Sunday 1, Monday 2, ... Saturday 64.
// Some PowerShell versions print the enum names instead, so both are read.
const MASK_BITS = [[2, 1], [4, 2], [8, 3], [16, 4], [32, 5], [64, 6], [1, 7]];
const NAME_TO_DAY = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

export function daysFromMask(value) {
  if (typeof value === 'number') {
    return MASK_BITS.filter(([bit]) => value & bit).map(([, d]) => d).sort((a, b) => a - b);
  }
  const out = [];
  for (const part of String(value ?? '').split(/[,\s]+/)) {
    const d = NAME_TO_DAY[part.toLowerCase()];
    if (d && !out.includes(d)) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

// ISO 8601 duration such as PT1H or PT30M, as the scheduler stores repetition.
export function durationWords(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(iso ?? ''));
  if (!m) return null;
  const parts = [];
  if (m[1]) parts.push(`${m[1]} ${m[1] === '1' ? 'day' : 'days'}`);
  if (m[2]) parts.push(`${m[2]} h`);
  if (m[3]) parts.push(`${m[3]} min`);
  return parts.length ? parts.join(' ') : null;
}

export function triggerWords(t) {
  const start = parseLocal(t.startBoundary);
  const at = start ? hhmm(start.h, start.mi) : null;
  const atText = at ? ` at ${at}` : '';
  let text;
  switch (t.type) {
    case 'Daily': {
      const n = t.daysInterval || 1;
      text = n === 1 ? `Every day${atText}` : `Every ${n} days${atText}`;
      break;
    }
    case 'Weekly': {
      const days = daysFromMask(t.daysOfWeek);
      const every = t.weeksInterval > 1 ? `Every ${t.weeksInterval} weeks, ` : '';
      // After "Every 2 weeks," the phrase continues in lower case; a list of
      // day names keeps its capitals, so it never reads "mon".
      if (days.length === 7) text = every ? `${every}every day${atText}` : `Every day${atText}`;
      else if (days.join() === '1,2,3,4,5') text = every ? `${every}every weekday${atText}` : `Every weekday${atText}`;
      else text = `${every}${daysText(days)}${atText}`;
      break;
    }
    case 'Time':
      text = start ? `Once: ${start.y}-${pad(start.mo)}-${pad(start.d)} ${at}` : 'Once';
      break;
    case 'Logon': text = t.userId ? `At logon of ${t.userId}` : 'At logon'; break;
    case 'Boot': text = 'At startup'; break;
    case 'Idle': text = 'When the machine is idle'; break;
    case 'Registration': text = 'When the task is registered'; break;
    case 'SessionStateChange': text = 'On session state change (lock, unlock...)'; break;
    case 'Event': text = 'On a system event'; break;
    case 'Monthly': text = `Monthly${atText}`; break;
    case 'MonthlyDOW': text = `Monthly, by day of the week${atText}`; break;
    default: text = `Other trigger (${t.type || 'unknown'})`;
  }
  const every = durationWords(t.repetitionInterval);
  if (every) text += `, repeats every ${every}`;
  if (t.enabled === false) text += ' (trigger off)';
  return text;
}

// One line for the list view: all triggers joined, or a plain "no schedule".
export function triggersSummary(triggers) {
  if (!triggers || !triggers.length) return 'No schedule';
  return triggers.map(triggerWords).join('; ');
}
