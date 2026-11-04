// Plain-text table and date helpers. Widths are counted in UTF-16 units after
// NFC normalisation, which is exact for Latin text (every letter is one cell).

export const MAX_WIDTH = 120;

export function trunc(text, width) {
  const s = String(text ?? '').normalize('NFC');
  if (s.length <= width) return s;
  if (width <= 3) return '.'.repeat(Math.max(width, 0));
  return s.slice(0, width - 3) + '...';
}

// Shrinks the widest columns first until the row fits, so short columns such
// as the status keep their full text and the long name or schedule gives way.
export function fitWidths(natural, gap, max, mins = []) {
  const widths = natural.slice();
  const floorOf = (i) => Math.min(natural[i], mins[i] ?? 8);
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  while (total() > max) {
    let idx = 0;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] > floorOf(i) && (widths[idx] <= floorOf(idx) || widths[i] > widths[idx])) idx = i;
    }
    if (widths[idx] <= floorOf(idx)) break;
    widths[idx] -= 1;
  }
  return widths;
}

// mins keeps important columns (such as the schedule) readable: they shrink
// only after the others have given up all they can.
export function table(headers, rows, max = MAX_WIDTH, mins = []) {
  const gap = 2;
  const natural = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').normalize('NFC').length)));
  const widths = fitWidths(natural, gap, max, mins);
  const line = (cells) =>
    cells.map((c, i) => trunc(c, widths[i]).padEnd(widths[i])).join(' '.repeat(gap)).trimEnd();
  return [line(headers), ...rows.map(line)];
}

const pad = (n) => String(n).padStart(2, '0');

// The scheduler helper emits local wall time as yyyy-MM-ddTHH:mm:ss without a
// zone, so the text is split instead of going through Date (no time zone shift).
export function parseLocal(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

export function dateTime(iso) {
  const p = parseLocal(iso);
  if (!p || p.y < 2000) return '-';
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

export const hhmm = (h, mi) => `${pad(h)}:${pad(mi)}`;
