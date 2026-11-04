// The only place that starts PowerShell (the one other process the tool
// starts is the terminal opened by a card button, in deps.launch). A runner is `async (script) => stdout`;
// everything else takes the runner as a parameter, so tests pass a fake and
// never reach the real scheduler. Windows PowerShell 5.1 is used on purpose:
// it ships with Windows and carries the ScheduledTasks module.
import { execFile } from 'node:child_process';

// Forces UTF-8 on stdout (non-ASCII task names and paths survive) and makes
// any error abort the script instead of printing and carrying on.
const PRELUDE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='Stop';";

export function realRunner() {
  return (script) => new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PRELUDE + script],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // The whole message on one line: the first line alone was often just "One or more errors occurred.".
          const detail = String(stderr || err.message).replace(/\s+/g, ' ').trim().slice(0, 300);
          reject(new Error(`PowerShell reported an error: ${detail}`));
        } else resolve(stdout);
      },
    );
  });
}

// User-supplied values travel as base64 JSON and are decoded inside the
// script, so no quote or special character in a name or command can break
// out of the script text.
export function payload(value) {
  const b64 = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))|ConvertFrom-Json;`;
}

export function parseJson(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return JSON.parse(t);
}

export const asArray = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
