// Decides which tasks are the owner's own and which belong to the system or a
// vendor. Calibrated on the real machine (4 Nov 2026), where a single signal
// was never enough:
//   - Author or principal alone matches the user for Adobe, AMD, Google and
//     Edge helpers too, because installers register their tasks as the user.
//   - Tasks made by hand with a script on D: have an empty Author, so the author cannot be needed.
//   - What does separate them is where the program lives: vendor tasks run
//     from Program Files or Windows, the owner's from D: or the user profile.
// So a path on D: or under the profile is the strongest sign, a program under
// Program Files or Windows rules the task out, and author or principal
// matching only decides what remains (for example a bare `cmd.exe`).

export const MARKER = 'Created by the tasks tool';
// The wording of the marker before the tool was translated. Tasks created then
// still carry it in their description, so it stays recognised.
export const LEGACY_MARKER = 'Tạo bởi công cụ tasks';

const SYSTEM_DIR = /^[a-z]:\\(program files( \(x86\))?|windows|programdata)\\/i;

const lower = (s) => String(s ?? '').toLowerCase();

export function isUnderMicrosoft(task) {
  return /^\\microsoft(\\|$)/i.test(String(task.path ?? ''));
}

function userMatches(value, user) {
  const v = lower(value).replace(/^\.\\/, '');
  if (!v) return false;
  const short = lower(user.name);
  return v === short || v === lower(`${user.domain}\\${user.name}`) || v.endsWith('\\' + short);
}

function ownsPath(text, user) {
  const t = lower(text);
  if (/(^|[\s"'=])d:\\/.test(t)) return true;
  const profile = lower(user.profile);
  return Boolean(profile) && t.includes(profile);
}

export function isOwnTask(task, user) {
  if (isUnderMicrosoft(task)) return false;
  const description = String(task.description ?? '');
  if (description.includes(MARKER) || description.includes(LEGACY_MARKER)) return true;
  const actions = task.actions ?? [];
  const exe = actions[0]?.execute ?? '';
  const everything = actions.map((a) => `${a.execute} ${a.arguments} ${a.workingDirectory}`).join(' ');
  if (ownsPath(everything, user)) return true;
  if (!String(exe).trim()) return false;
  if (SYSTEM_DIR.test(String(exe).replace(/"/g, '').trim())) return false;
  return userMatches(task.author, user) || userMatches(task.userId, user);
}
