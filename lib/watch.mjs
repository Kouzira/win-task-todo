// The watcher loop of `task watch`: post the cards, sleep until the next
// moment that matters, refresh, repeat. Between wake-ups the process only
// holds a timer, so it costs no CPU and starts no PowerShell; the clock, the
// timers, the files and the runner are all injected, so the tests drive the
// loop without waiting and without touching Windows.
//
// Two kinds of wake-up. A refresh reads the scheduler (two PowerShell calls)
// and posts the cards. A check, at most every 5 minutes while today's cards
// should be in the Notification Center, asks only whether they still are (one
// PowerShell call: measured on 4 Nov 2026 at about 1.4 s wall time and 0.5 s
// of CPU, gone again at once). The alternative, a PowerShell kept alive with a
// handler on the toast's Dismissed event, measured 76 MB of working set with
// the WinRT types loaded, held for the whole session; it would also miss a
// card removed while it was not running. Twelve short checks an hour cost
// about 6 s of CPU and no memory between them, and they see every way the
// card can go, so the check wins.
import { FILES, makeLogger } from './app-files.mjs';
import { parseLocal } from './format.mjs';
import { activeTags, cardsStillThere, loadState, nextLeave, refreshCards } from './notify.mjs';
import { parseJson, payload } from './ps.mjs';

export const FALLBACK_MS = 30 * 60000;
export const CHECK_MS = 5 * 60000;
export const MIN_MS = 30000;
// Timers are set in steps of a minute at most, and each step compares the
// wall clock with the target. After the laptop sleeps, the wall clock has
// moved on, so the overdue refresh happens within a minute of waking instead
// of whenever the timer's own clock gets there.
export const STEP_MS = 60000;

export const RUNNING_MS = 2 * 60000;

// After a failed refresh the watcher retries soon instead of waiting for the
// normal interval: 30 s, then 60 s, then 120 s, and every 120 s from there on
// until one succeeds. Get-ScheduledTask raises a transient "One or more errors
// occurred" while a task is being modified or the scheduler is busy; before
// this, one such error left the cards stale for 30 minutes.
export const RETRY_BASE_MS = 30000;
export const RETRY_MAX_MS = 120000;
export const retryDelay = (failures) => Math.min(RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_MS);
const clock = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
const brief = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 300);

// The next refresh: one minute after any own task's next run today, every
// RUNNING_MS while a task runs (so the card pops up soon after the run ends),
// when a "Done" card has left (leaveAt, so a later run's card comes back), the
// start of the next day, or the fallback, whichever is first; never sooner
// than MIN_MS.
export function nextRefresh(rows, now, leaveAt = Infinity) {
  const t = now.getTime();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  let at = Math.min(t + FALLBACK_MS, midnight, leaveAt + 1000);
  for (const r of rows) {
    if (r.watcher) continue;
    if (r.kind === 'running') at = Math.min(at, t + RUNNING_MS);
    const p = parseLocal(r.nextRun);
    if (!p || p.y !== now.getFullYear() || p.mo !== now.getMonth() + 1 || p.d !== now.getDate()) continue;
    const after = new Date(p.y, p.mo - 1, p.d, p.h, p.mi).getTime() + 60000;
    if (after > t) at = Math.min(at, after);
  }
  return Math.max(at, t + MIN_MS);
}

// Some card was posted today and not dismissed, so it should be in the Center.
export const cardActive = (state, now) => activeTags(state, now).length > 0;

export function nextWake(refreshAt, active, now) {
  const check = now.getTime() + CHECK_MS;
  return active && check < refreshAt ? { at: check, kind: 'check' } : { at: refreshAt, kind: 'refresh' };
}

export function readLock(files) {
  try {
    const j = JSON.parse(files.read(FILES.lock) ?? 'null');
    return Number.isInteger(j?.pid) ? j : null;
  } catch { return null; }
}

// A lock is live only when it was written in this boot, names a process that
// is alive, and that process really is a watcher (a pid of a dead watcher can
// be reused by any other program). Anything else is stale and is replaced.
async function lockIsLive(held, me, sys) {
  if (held.pid === me.pid) return false;
  if (Math.abs(Number(held.boot) - me.boot) > 2) return false;
  if (!sys.isAlive(held.pid)) return false;
  return Boolean(await sys.isOurs(held.pid));
}

// me: { pid, boot, started }; sys: { isAlive(pid), isOurs(pid) }.
export async function acquireLock(files, me, sys) {
  for (let i = 0; i < 2; i++) {
    if (files.createExclusive(FILES.lock, JSON.stringify(me))) return { ok: true };
    const held = readLock(files);
    if (held && await lockIsLive(held, me, sys)) return { ok: false, holder: held };
    files.remove(FILES.lock);
  }
  return { ok: false, holder: readLock(files) };
}

export function releaseLock(files, pid) {
  const held = readLock(files);
  if (held && held.pid === pid) files.remove(FILES.lock);
}

const CMDLINE_SCRIPT = `
$c = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$p.pid)
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ cmd = $(if ($c) { $c.CommandLine } else { $null }) })
`;

// The watcher's command line ends in `tasks.mjs" watch`; `watch --stop` and
// `watch --status` carry an option after it and are not watchers.
export async function isWatcherProcess(run, pid) {
  const r = parseJson(await run(payload({ pid }) + CMDLINE_SCRIPT));
  return /tasks\.mjs"?\s+watch\s*$/i.test(String(r?.cmd ?? ''));
}

export const lockSys = (deps) => ({ isAlive: deps.isAlive, isOurs: (pid) => isWatcherProcess(deps.run, pid) });

// Runs until a stop file appears (from `task watch --stop`) or stop() is
// called. Resolves with the exit code. opts.onStart receives stop().
export async function runWatcher(deps, opts = {}) {
  const files = deps.app;
  const log = makeLogger(files, deps.now);
  const timers = deps.timers;
  const me = { pid: deps.pid, boot: deps.bootMinute(), started: deps.now().toISOString() };
  const lock = await acquireLock(files, me, lockSys(deps));
  if (!lock.ok) {
    deps.err(`A watcher is already running (pid ${lock.holder?.pid ?? '?'}). Stop it with "task watch --stop".`);
    return 1;
  }
  files.remove(FILES.stop);
  let stopped = false;
  let timer = null;
  let wakeNow = () => {};
  const stop = () => { stopped = true; timers.clearTimeout(timer); wakeNow(); };
  const unwatch = files.watch(FILES.stop, () => { if (files.exists(FILES.stop)) stop(); });
  opts.onStart?.(stop);
  log(`watcher started, pid ${deps.pid}`);
  deps.out(`Watcher running (pid ${deps.pid}). Stop with Ctrl+C or "task watch --stop". Log: ${files.dir}\\${FILES.log}`);

  const sleepUntil = (target) => new Promise((resolve) => {
    wakeNow = resolve;
    const step = () => {
      const left = target - deps.now().getTime();
      if (stopped || left <= 0) { resolve(); return; }
      timer = timers.setTimeout(step, Math.min(left, STEP_MS));
    };
    step();
  });
  // Consecutive failures since the last success, and the moment of the next retry.
  let failures = 0;
  let refreshAt = 0;
  const failed = (what, e) => {
    failures++;
    refreshAt = deps.now().getTime() + retryDelay(failures);
    log(`${what} failed (${failures} in a row): ${brief(e)}; next retry at ${clock(new Date(refreshAt))}`);
  };
  // True when the refresh worked, and then refreshAt is the next planned one.
  const refresh = async () => {
    let res;
    try { res = await refreshCards(deps, files, log); } catch (e) { failed('refresh', e); return false; }
    if (failures > 0) log(`refresh recovered after ${failures} failures`);
    failures = 0;
    if (!res.installed) log('notifications not registered (task notify --install), will retry');
    refreshAt = nextRefresh(res.rows ?? [], deps.now(), nextLeave(loadState(files)));
    return true;
  };

  try {
    while (!stopped) {
      let wake;
      try {
        if (deps.now().getTime() >= refreshAt) await refresh();
        else {
          let there = true;
          try { there = await cardsStillThere(deps, files); } catch (e) { log(`card check failed: ${brief(e)}`); }
          if (!there) await refresh();
        }
        if (stopped || files.exists(FILES.stop)) break;
        wake = nextWake(refreshAt, cardActive(loadState(files), deps.now()), deps.now());
      } catch (e) {
        // Nothing in the loop may end the watcher: treat it like a failed refresh.
        failed('watcher loop', e);
        wake = { at: refreshAt, kind: 'refresh' };
      }
      await sleepUntil(wake.at);
      if (files.exists(FILES.stop)) stopped = true;
    }
  } finally {
    unwatch();
    timers.clearTimeout(timer);
    files.remove(FILES.stop);
    releaseLock(files, deps.pid);
    log('watcher stopped');
  }
  return 0;
}
