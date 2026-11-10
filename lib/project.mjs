// The project label of a task. Task Scheduler has no field for it, so it is
// kept in the description, on a line of its own after the marker that makes a
// task the tool's own. A task made before labels existed has no such line, and
// the "Created by the tasks tool" marker keeps working for it.
import { LEGACY_MARKER, MARKER } from './classify.mjs';

export const PROJECT_PREFIX = 'tasks-project:';
const MAX_LABEL = 60;
const PROJECT_LINE = new RegExp(`^${PROJECT_PREFIX}(.*)$`);

export function cleanLabel(label) {
  return String(label ?? '').replace(/\s+/g, ' ').trim();
}

// null when the label is usable, else the reason in words.
export function labelProblem(label) {
  const l = cleanLabel(label);
  if (!l) return 'The project label is empty.';
  if (l.length > MAX_LABEL) return `The project label is longer than ${MAX_LABEL} characters.`;
  if (/[\x00-\x1f\x7f]/.test(String(label))) return 'The project label cannot contain control characters.';
  return null;
}

export const describeTask = (label) => (label ? `${MARKER}\n${PROJECT_PREFIX}${cleanLabel(label)}` : MARKER);

// Read back only from a description that the tool wrote (it carries the
// marker), so a hand-written description that happens to say the same thing
// is not taken for a label.
export function projectOf(task) {
  const lines = String(task?.description ?? '').split(/\r?\n/);
  if (!lines.some((l) => l.includes(MARKER) || l.includes(LEGACY_MARKER))) return null;
  for (const l of lines) {
    const m = PROJECT_LINE.exec(l.trim());
    if (m && cleanLabel(m[1])) return cleanLabel(m[1]);
  }
  return null;
}

export const sameProject = (a, b) => cleanLabel(a).toLowerCase() === cleanLabel(b).toLowerCase();

// The description as shown to a person: one line, without the label line
// (which has its own row).
export const visibleDescription = (description) => String(description ?? '').split(/\r?\n/)
  .filter((l) => !l.trim().startsWith(PROJECT_PREFIX)).join(' ').trim();
