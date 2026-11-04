// The one-time tokens behind the [Cancel today] buttons. Any web page or
// document can launch a wintasktodo: URI, so a cancel URI is worthless
// without a secret only its question card carries: 128 random bits, written by
// the watcher when it posts the question, valid for 15 minutes and for one
// use, and bound to one task and one run time. Each question has its own file,
// named after the card (never after anything in a URI), so the button handler
// and the watcher never overwrite each other's writes.
import { timingSafeEqual } from 'node:crypto';

export const TOKEN_MINUTES = 15;
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const FILE = /^cancel-c[0-9a-f]{15}\.json$/;

export const tokenFile = (tag) => `cancel-${tag}.json`;

// task: { tag, name, path, runAt } of the run the question offers to skip.
export function issueToken(files, { now, random, day, task }) {
  const token = random(16).toString('hex');
  const expires = now.getTime() + TOKEN_MINUTES * 60000;
  files.write(tokenFile(task.tag), JSON.stringify({ token, expires, day, name: task.name, path: task.path, runAt: task.runAt }));
  return { token, expires };
}

// A question nobody answered ([Keep], its X, or nothing) leaves its token
// file behind; the refresh drops those once they expire, so nothing of an
// old question is left to be used or to look like a pending one.
export function dropExpired(files, now) {
  for (const file of files.list().filter((n) => FILE.test(n))) {
    const saved = read(files, file);
    if (!saved || !(now.getTime() < Number(saved.expires))) files.remove(file);
  }
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function read(files, name) {
  try { return JSON.parse(files.read(name) ?? 'null'); } catch { return null; }
}

// { ok: true, name, path, runAt, day } for a token that matches, is unexpired
// and unused, and has now been claimed; { ok: false, reason } otherwise. A
// wrong guess leaves every real token in place, so a hostile page cannot burn
// one; the claim is a rename, which only one of two simultaneous launches can
// win, and a used token's file is gone.
export function consumeToken(files, token, now, pid) {
  if (!TOKEN_PATTERN.test(String(token))) return { ok: false, reason: 'malformed token' };
  for (const file of files.list().filter((n) => FILE.test(n))) {
    const saved = read(files, file);
    if (!saved || typeof saved.token !== 'string' || !same(saved.token, token)) continue;
    if (!(now.getTime() < Number(saved.expires))) {
      files.remove(file);
      return { ok: false, reason: 'token expired' };
    }
    const claimed = `${file}.${pid}.used`;
    if (!files.claim(file, claimed)) return { ok: false, reason: 'token already used' };
    files.remove(claimed);
    return { ok: true, name: String(saved.name), path: String(saved.path), runAt: saved.runAt, day: saved.day };
  }
  return { ok: false, reason: 'no token matched (wrong, used or never issued)' };
}
