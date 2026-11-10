// `task doctor`: explains, read only, why a card might not show. It gathers
// the observations (each guarded, so one failed read costs one line and not
// the whole report), hands them to the decisions in doctor.mjs, and prints
// one line per finding, a fix under each problem, and a verdict.
import { FILES } from './app-files.mjs';
import { dayKey, loadState } from './notify.mjs';
import { listOwnKeys } from './registry.mjs';
import { appIdOf, cardHistory, cardTag } from './toast.mjs';
import { buildRows } from './ui-model.mjs';
import { isDisabled } from './skip-status.mjs';
import { loadTasks } from './view.mjs';
import { findWatcher, isWatcher } from './watcher-id.mjs';
import { readLock } from './watch.mjs';
import { runningWatcher } from './watch-cmd.mjs';
import {
  checkAppIds, checkCommands, checkHistory, checkInstalled, checkLogonTask, checkPath, checkRefresh, checkSettings, checkWatcher,
  expectedCards, lastRefreshFailure, verdict,
} from './doctor.mjs';
import { commandText, findProblems, pathExists } from './command-check.mjs';
import { isUnderMicrosoft } from './classify.mjs';
import { isHelper } from './skip-status.mjs';
import { findOnPath, readNotificationSettings } from './doctor-probe.mjs';

const MARK = { ok: 'ok  ', info: 'info', warn: 'WARN', fail: 'FAIL' };
const brief = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200);

// A failed read becomes one warning, so the rest of the report still shows.
async function attempt(what, fn, fallback) {
  try { return { value: await fn() }; }
  catch (e) { return { value: fallback, problem: { status: 'warn', text: `Could not check ${what}: ${brief(e)}` } }; }
}

export async function doctorCmd(deps) {
  const results = [];
  const add = (list) => results.push(...list);
  const take = async (what, fn, fallback) => {
    const r = await attempt(what, fn, fallback);
    if (r.problem) results.push(r.problem);
    return r.problem ? null : r.value;
  };
  deps.out('task doctor (read only: nothing is created, changed or posted)');

  const found = findOnPath(deps.env, deps.fileExists ?? (() => false));
  add(checkPath(found, deps.scriptPath.replace(/[\\/][^\\/]*$/, '')));

  const keys = await take('the registry keys', () => listOwnKeys(deps.run));
  if (keys) add(checkInstalled(keys));

  const all = await take('the scheduler', () => loadTasks(deps));
  if (all) add(checkLogonTask(findWatcher(all), isDisabled));
  if (all) {
    const exists = pathExists(deps);
    const mine = all.filter((t) => t.own && !isUnderMicrosoft(t) && !isHelper(t) && !isWatcher(t));
    add(checkCommands(mine.map((t) => {
      const text = commandText(t);
      return { name: t.name, problems: text ? findProblems(text, exists) : [] };
    })));
  }

  const w = await attempt('the watcher process', () => runningWatcher(deps), null);
  if (w.problem) results.push(w.problem); else add(checkWatcher(w.value, readLock(deps.app)));
  const pid = w.value;

  const built = await take('today\'s tasks', () => buildRows(deps));
  const state = loadState(deps.app);
  const cards = built ? expectedCards(built.rows, state, dayKey(deps.now()), cardTag, appIdOf) : [];
  if (built && keys) add(checkAppIds(cards, keys.ids));

  if (built) {
    const settings = await take('the notification settings', () => readNotificationSettings(deps.run, cards.map((c) => c.app)));
    if (settings) add(checkSettings(cards, settings));
    const hist = cards.length ? await take('the toast history', () => cardHistory(deps.run, cards.map((c) => ({ app: c.app, tag: c.tag })))) : null;
    if (hist) add(checkHistory(cards, hist));
    else if (!cards.length) add(checkHistory(cards, { installed: true, tags: [], blocked: [] }));
  }

  const log = deps.app.read(FILES.log);
  add(checkRefresh({
    mtimeMs: deps.app.mtime ? deps.app.mtime(FILES.state) : null,
    nowMs: deps.now().getTime(),
    watcherAlive: Boolean(pid),
    failure: lastRefreshFailure(log),
  }));

  for (const r of results) {
    deps.out(`  ${MARK[r.status]}  ${r.text}`);
    if (r.fix) deps.out(`        Fix: ${r.fix}`);
  }
  deps.out(verdict(results));
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
