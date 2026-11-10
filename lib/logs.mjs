// Finds the log a task writes. The log folder is the user's choice: the
// environment variable TASK_LOG_DIR, or the "logDir" key of an optional
// %LOCALAPPDATA%\win-task-todo\config.json. The convention is one file per
// script, named after the script (backup.ps1 writes backup.log). The file
// system is injected so tests use canned listings.
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 16 * 1024;

// The folder comes from TASK_LOG_DIR first, then from config.json; an
// unreadable or malformed config simply means "not set".
export function resolveLogDir(env = process.env, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const fromEnv = String(env.TASK_LOG_DIR ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!env.LOCALAPPDATA) return null;
  try {
    const cfg = JSON.parse(readFile(path.join(env.LOCALAPPDATA, 'win-task-todo', 'config.json')));
    const dir = typeof cfg?.logDir === 'string' ? cfg.logDir.trim() : '';
    return dir || null;
  } catch { return null; }
}

export function realLogStore(env = process.env, readFile) {
  const dir = resolveLogDir(env, readFile);
  return {
    dir,
    async list() {
      if (!dir) return [];
      let names;
      try { names = await fsp.readdir(dir); } catch { return []; }
      const out = [];
      for (const name of names) {
        if (!/\.(log|txt)$/i.test(name)) continue;
        const st = await fsp.stat(path.join(dir, name));
        if (st.isFile()) out.push({ name, mtimeMs: st.mtimeMs, size: st.size });
      }
      return out;
    },
    // Reads only the end of the file: one of the logs is about 2 MB.
    async tail(name, lines) {
      const fh = await fsp.open(path.join(dir, name), 'r');
      try {
        const { size } = await fh.stat();
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        const all = buf.toString('utf8').split(/\r?\n/);
        while (all.length && all[all.length - 1] === '') all.pop();
        return all.slice(-lines);
      } finally { await fh.close(); }
    },
  };
}

// The file `task add --log` makes the task write: the task name with spaces as
// hyphens, in the log folder `task log` reads. findLog matches it by the same
// slug, ignoring case, so `task log` finds it.
export const logFileName = (taskName) => `${String(taskName ?? '').trim().replace(/\s+/g, '-')}.log`;

const slug = (s) => String(s ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, '-');

// Names a log could have for this task: the script's base name, the task name,
// and the task name with spaces turned into hyphens.
export function candidateBases(task) {
  const bases = new Set();
  for (const a of task.actions ?? []) {
    const m = /([^\\/"\s]+)\.(?:ps1|bat|cmd|mjs|js|py)\b/i.exec(`${a.arguments ?? ''} ${a.execute ?? ''}`);
    if (m) bases.add(m[1].toLowerCase());
  }
  const full = slug(task.name);
  bases.add(full);
  return bases;
}

export async function findLog(store, task, lines = 20) {
  if (!store.dir) return null;
  const bases = candidateBases(task);
  const files = (await store.list()).filter((f) => bases.has(f.name.replace(/\.[^.]+$/, '').toLowerCase()));
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { file: path.join(store.dir, files[0].name), name: files[0].name, mtimeMs: files[0].mtimeMs, lines: await store.tail(files[0].name, lines) };
}
