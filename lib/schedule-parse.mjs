// Parses the plain-text schedule given to `task add` into a small spec:
//   { kind: 'daily' | 'weekdays' | 'weekly' | 'once' | 'logon',
//     time: 'HH:MM', days: [1..7 Monday..Sunday], date: 'YYYY-MM-DD' }
// English is the documented form. The Vietnamese forms the tool accepted
// before it was translated ("mỗi ngày 10:00", "thứ hai,thứ tư 09:30", ...)
// still parse, with or without diacritics, so schedules typed from old notes
// or scripts keep working.

export class ScheduleError extends Error {}

const strip = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();

// Monday = 1 ... Sunday = 7, matching ISO weekdays.
const DAY_TOKENS = {
  'thu hai': 1, t2: 1, mon: 1, monday: 1,
  'thu ba': 2, t3: 2, tue: 2, tues: 2, tuesday: 2,
  'thu tu': 3, t4: 3, wed: 3, wednesday: 3,
  'thu nam': 4, t5: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  'thu sau': 5, t6: 5, fri: 5, friday: 5,
  'thu bay': 6, t7: 6, sat: 6, saturday: 6,
  'chu nhat': 7, cn: 7, sun: 7, sunday: 7,
};

const EXAMPLES = 'Examples: "daily 10:00", "weekdays 10:00", "mon,wed 09:30", '
  + '"once 2026-11-05 10:00", "at logon".';

const fail = (msg) => { throw new ScheduleError(`${msg} ${EXAMPLES}`); };

function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) fail(`Time "${text}" is not in HH:MM form.`);
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) fail(`Time "${text}" is not valid (hours 0-23, minutes 0-59).`);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function parseDate(text) {
  let y, mo, d;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else fail(`Date "${text}" is not in YYYY-MM-DD or DD/MM/YYYY form.`);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    fail(`Date "${text}" does not exist.`);
  }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDays(text) {
  const days = [];
  for (const raw of text.split(/\s*,\s*/)) {
    const key = raw.trim();
    if (!(key in DAY_TOKENS)) fail(`Unknown day "${raw.trim()}".`);
    const n = DAY_TOKENS[key];
    if (!days.includes(n)) days.push(n);
  }
  return days.sort((a, b) => a - b);
}

// `now` is injectable so a one-off date in the past is rejected testably.
export function parseSchedule(input, now = new Date()) {
  const text = strip(String(input ?? ''));
  if (!text) fail('No schedule given.');

  if (/^(khi dang nhap|at logon|at log on|logon)$/.test(text)) return { kind: 'logon' };

  const timeAtEnd = /^(.*?)\s+(\d{1,2}:\d{2})$/.exec(text);
  if (!timeAtEnd) fail(`Schedule "${input}" is missing a time (HH:MM) or is not recognised.`);
  const [, rawHead, timeText] = timeAtEnd;
  // "every weekday at 10:00" reads naturally, so a trailing "at" is dropped.
  const head = rawHead.replace(/\s+at$/, '');

  if (/^(moi ngay lam viec|ngay lam viec|(?:every )?weekdays?)$/.test(head)) {
    return { kind: 'weekdays', time: parseTime(timeText) };
  }
  if (/^(moi ngay|hang ngay|daily|every day|everyday)$/.test(head)) {
    return { kind: 'daily', time: parseTime(timeText) };
  }
  const once = /^(?:mot lan|once)\s+(\S+)$/.exec(head);
  if (once) {
    const spec = { kind: 'once', date: parseDate(once[1]), time: parseTime(timeText) };
    const when = new Date(`${spec.date}T${spec.time}:00`);
    if (when.getTime() <= now.getTime()) fail(`The time ${spec.date} ${spec.time} has already passed.`);
    return spec;
  }
  if (/^(mot lan|once)$/.test(head)) fail('A "once" schedule needs a date and a time, for example "once 2026-11-05 10:00".');
  if (/^[a-z0-9 ,]+$/.test(head) && /^(t[2-7]|cn|thu|chu|mon|tue|wed|fri|sat|sun)/.test(head)) {
    return { kind: 'weekly', days: parseDays(head), time: parseTime(timeText) };
  }
  return fail(`Unrecognised schedule "${input}".`);
}
