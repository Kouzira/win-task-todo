// Finds what makes a task's command line unable to work before the task runs:
// a shell variable that was never filled in, and a Windows path that points
// at nothing. Pure: the machine is reached only through the injected
// `exists(path)`, so every case is tested with canned answers.
//
// The rule that shapes everything here: a false alarm is worse than a missed
// problem, so whatever cannot be parsed with confidence is skipped.
import path from 'node:path';

const win = path.win32;
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/g;
// What may stand right before a path that the command only writes to: a
// redirect or a log/output option. Such a target is often created by the run.
const WRITE_TARGET = /(?:>|--log(?:-file)?=?|--out(?:put)?(?:-file)?=?)\s*$/i;

// The tool's logging runner stores the real program and arguments as two
// quoted values with escaped inner quotes. Reading them back as one plain
// command line makes the paths inside visible to the checks below.
export function unwrapLogged(text) {
  const m = /\s--exe\s+"((?:\\.|[^"\\])*)"\s+--args\s+"((?:\\.|[^"\\])*)"\s*$/.exec(text);
  if (!m) return text;
  const plain = (s) => s.replace(/\\"/g, '"');
  return `${plain(m[1])} ${plain(m[2])}`.trim();
}

// The command line of a task as `task show` reads it: the program and its
// arguments of the first action. null when there is nothing to read.
export function commandText(task) {
  const a = task?.actions?.[0];
  if (!a || !String(a.execute ?? '').trim()) return null;
  return unwrapLogged(`${a.execute} ${a.arguments ?? ''}`.trim());
}

// `$name` is ordinary text for cmd.exe, so one left in a command means the
// shell that built the line never filled it in. PowerShell uses `$` for its
// own variables ($env:TEMP, $_), so a PowerShell command is not judged here.
function unfilledVariables(text) {
  const first = text.trim().match(/^(?:"([^"]*)"|(\S+))/)?.slice(1).find(Boolean) ?? '';
  if (/^(?:.*[\\/])?(?:powershell|pwsh)(?:\.exe)?$/i.test(first)) return [];
  // An odd number of single quotes means the quoting is not understood, so
  // "inside single quotes" cannot be decided: skip rather than guess.
  if ((text.match(/'/g) ?? []).length % 2) return [];
  const found = [];
  let inSingle = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") inSingle = !inSingle;
    else if (c === '$' && !inSingle) {
      const m = /^\$(\{[^}\s]*\}?|[A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
      if (m && !found.includes(m[0])) found.push(m[0]);
    }
  }
  return found.map((v) => `The text contains "${v}", a variable that the shell did not fill in.`);
}

// Where a path starting at `start` ends, and whether it was quoted. A path
// right after a quote runs to the closing quote (so spaces are allowed); an
// unquoted one runs to the next whitespace or quote.
function readPath(text, start) {
  const quoted = text[start - 1] === '"';
  const stop = quoted ? /"/ : /[\s"]/;
  const rest = text.slice(start);
  const cut = rest.search(stop);
  const raw = cut < 0 ? rest : rest.slice(0, cut);
  return { raw: quoted ? raw : raw.replace(/[,;)]+$/, ''), quoted, end: start + raw.length };
}

// An unquoted path with a space is cut at the space ("C:\Program" of
// "C:\Program Files\x.exe"). Longer readings are tried first: if any exists
// the path is fine.
function existsLongerReading(text, from, raw, exists) {
  let candidate = raw;
  let pos = from;
  for (let n = 0; n < 6; n++) {
    const next = /^(\s+)([^\s"]+)/.exec(text.slice(pos));
    if (!next) return false;
    candidate += next[1] + next[2];
    pos += next[0].length;
    if (exists(candidate)) return true;
  }
  return false;
}

function missingPaths(text, exists) {
  const out = [];
  DRIVE_PATH.lastIndex = 0;
  let m;
  while ((m = DRIVE_PATH.exec(text))) {
    const { raw, quoted, end } = readPath(text, m.index);
    DRIVE_PATH.lastIndex = Math.max(end, m.index + 1);
    // Trailing separator: a folder that may be filled in at run time.
    if (/[\\/]$/.test(raw)) continue;
    // Wildcards, unexpanded variables and shell operators mean the text is
    // not a plain path; what it expands to is unknown.
    if (/[*?%$<>|]/.test(raw)) continue;
    if (WRITE_TARGET.test(text.slice(0, m.index).replace(/"$/, ''))) continue;
    // Store app aliases (pwsh.exe, python.exe) are reparse points that Node's
    // file calls report as missing although they run, so they are not judged.
    if (/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(raw)) continue;
    if (exists(raw)) continue;
    if (!quoted) {
      if (existsLongerReading(text, end, raw, exists)) continue;
      // With no extension and no existing folder above it, the cut may have
      // been a space inside a name: too uncertain to report.
      if (!/\.\w{1,5}$/.test(raw) && !exists(win.dirname(raw))) continue;
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return out.map((p) => `The path ${p} does not exist.`);
}

export function findProblems(commandText, exists) {
  const text = String(commandText ?? '');
  if (!text.trim()) return [];
  return [...unfilledVariables(text), ...missingPaths(text, exists)];
}

// The existence test for a path that may be a file or a folder, built from
// the two helpers the dependencies already carry.
export const pathExists = (deps) => (p) => Boolean(deps.fileExists?.(p) || deps.dirExists?.(p));
