// The tool's own small files in %LOCALAPPDATA%\win-task-todo\: the watcher's
// state, its lock, the stop request and the log. Everything goes through one
// object with a handful of synchronous methods, so the tests swap in an
// in-memory copy and never touch the disk; the files are a few hundred bytes,
// so synchronous calls cost nothing worth an async API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'win-task-todo';
// state.json is written by the watcher only. card-opened.json is written by
// the open button only, and each cancel-<card>.json by the watcher, then
// consumed by the cancel button. Keeping what the button handler writes apart
// from the watcher's own state means neither process can overwrite what the
// other just wrote.
export const FILES = {
  state: 'state.json', lock: 'watch.pid', stop: 'watch.stop', log: 'watch.log', oldLog: 'watch.log.1',
  opened: 'card-opened.json',
};
export const LOG_CAP = 1024 * 1024;

export function appDir(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, APP_DIR_NAME) : path.join(os.tmpdir(), APP_DIR_NAME);
}

export function realAppFiles(env = process.env) {
  const dir = appDir(env);
  const full = (name) => path.join(dir, name);
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    read(name) { try { return fs.readFileSync(full(name), 'utf8'); } catch { return null; } },
    // Written to a temporary name and renamed, so a watcher killed by a
    // shutdown in the middle of a write never leaves half a JSON file.
    write(name, text) {
      ensure();
      fs.writeFileSync(full(`${name}.tmp`), text);
      fs.renameSync(full(`${name}.tmp`), full(name));
    },
    append(name, text) { ensure(); fs.appendFileSync(full(name), text); },
    size(name) { try { return fs.statSync(full(name)).size; } catch { return 0; } },
    pathOf: full,
    list() { try { return fs.readdirSync(dir); } catch { return []; } },
    rename(from, to) { try { fs.renameSync(full(from), full(to)); } catch { /* nothing to rotate */ } },
    // A rename succeeds for exactly one caller, so it is how a one-time token
    // is claimed: two launches of the same URI cannot both use it.
    claim(from, to) { try { fs.renameSync(full(from), full(to)); return true; } catch { return false; } },
    remove(name) { try { fs.unlinkSync(full(name)); } catch { /* already gone */ } },
    exists(name) { return fs.existsSync(full(name)); },
    // The 'wx' flag fails when the file exists, which makes creating the lock
    // and checking that nobody holds it one atomic step.
    createExclusive(name, text) {
      ensure();
      try { fs.writeFileSync(full(name), text, { flag: 'wx' }); return true; }
      catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    },
    // fs.watch on Windows is ReadDirectoryChangesW on the folder, which is
    // reliable for a local folder; the file name can be missing in an event,
    // so an event without one is treated as a possible match.
    watch(name, onChange) {
      ensure();
      const w = fs.watch(dir, (_event, file) => { if (!file || String(file).toLowerCase() === name) onChange(); });
      w.on('error', () => {});
      return () => w.close();
    },
  };
}

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// One line per entry, control characters removed: a hostile URI is logged
// too, and it must not be able to forge extra lines in the log.
export function makeLogger(files, now = () => new Date()) {
  return (text) => {
    try {
      if (files.size(FILES.log) > LOG_CAP) {
        files.remove(FILES.oldLog);
        files.rename(FILES.log, FILES.oldLog);
      }
      files.append(FILES.log, `${stamp(now())} ${String(text).replace(/[\x00-\x1f\x7f]/g, ' ')}\n`);
    } catch { /* a log that cannot be written must not stop the watcher */ }
  };
}

// Boot time in whole minutes. A lock written before a restart names a pid
// that may belong to some other process now, so a lock from another boot is
// stale whatever its pid says.
export const bootMinute = () => Math.round((Date.now() - os.uptime() * 1000) / 60000);

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
