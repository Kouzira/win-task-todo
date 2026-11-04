// `task notify` and the one function the watcher shares with it,
// refreshCards. When cards appear and leave:
//   - A task with a run still to come today, running now, skipped today, or
//     failed today has a card, posted silently.
//   - When a run ends (a new last run since the tool last looked, or a run
//     that was running is over), the card pops up with Windows' default
//     sound: "Done at 17:20", which then leaves by itself after LEAVE_MS,
//     or "Failed at 17:20 (...)", which stays until the owner closes it.
//   - A task done today with nothing more to come has no card, so the first
//     refresh after a logon shows only what is still to come or went wrong,
//     silently. A later run the same day brings the card back ("Runs today at ...").
//   - A card that leaves by the tool's own doing (expiry, removal, a
//     replacement) never counts as dismissed. A card the owner closes asks
//     about its task's next run today, unless the card was a failure.
// What was posted and seen is kept in state.json, so a restart of the
// watcher repeats nothing.
import { FILES, makeLogger } from './app-files.mjs';
import { dropExpired, issueToken } from './cancel-token.mjs';
import { hhmm, parseLocal } from './format.mjs';
import { installPlanLines, listOwnKeys, removeKeys, uninstallPlanLines, writeKeys } from './registry.mjs';
import { ASK_GROUP, GROUP, appIdOf, askTag, askXml, cardHistory, cardTag, cardText, cardXml, failureReason, postToasts, todayRows } from './toast.mjs';
import { buildRows } from './ui-model.mjs';

export const LEAVE_MS = 90000;
const isYes = (a) => /^(y|yes)$/i.test(String(a ?? '').trim());
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// cards: { [tag]: { name, path, app, day, postedAt, text, kind, dismissed, until } }
// seen:  { [tag]: { day, lastRun, kind } }, apps: { [id]: { name, path } }.
export function loadState(files) {
  let s = null;
  try { s = JSON.parse(files.read(FILES.state) ?? 'null'); } catch { s = null; }
  return { cards: obj(s?.cards), seen: obj(s?.seen), apps: obj(s?.apps) };
}

// Cards that should be in the Notification Center now: posted today, not
// dismissed, and not on their way out after a successful run.
export const activeTags = (state, now) => Object.entries(state.cards)
  .filter(([, c]) => c.day === dayKey(now) && c.dismissed !== dayKey(now) && !c.until).map(([tag]) => tag);

// The earliest moment a "Done" card has left, when the next card of that
// task may be posted; the watcher wakes then.
export const nextLeave = (state) => Math.min(...Object.values(state.cards).map((c) => c.until ?? Infinity));

// When a card was last clicked, by card tag.
export function readOpened(files) {
  try { return obj(JSON.parse(files.read(FILES.opened) ?? '{}')); } catch { return {}; }
}

const sameDay = (p, now) => Boolean(p) && p.y === now.getFullYear() && p.mo === now.getMonth() + 1 && p.d === now.getDate();

// The runs [Cancel today] can skip: own tasks, enabled, not already skipped,
// whose next run is later today. The watcher's own logon task never counts.
export function remainingToday(rows, now) {
  return rows.filter((r) => {
    if (r.watcher || !r.enabled || r.skipped) return false;
    const p = parseLocal(r.nextRun);
    return sameDay(p, now) && new Date(p.y, p.mo - 1, p.d, p.h, p.mi).getTime() >= now.getTime();
  });
}

// A run has ended since the tool last looked at this task today: its last run
// is new, or it was running and no longer is. Seen on another day (a logon)
// it is not an event, so a logon never brings a row of banners.
export function runEnded(seen, row, now) {
  if (!seen || seen.day !== dayKey(now) || row.kind === 'running') return false;
  if (!sameDay(parseLocal(row.lastRun), now)) return false;
  return seen.lastRun !== row.lastRun || seen.kind === 'running';
}

// What became of a card that should be in the Center. 'present': still there,
// or the tool cannot tell (notifications turned off for that task's ID make
// its card look gone). 'opened': gone because its body was clicked, which
// Windows treats like a dismissal; wintasktodo:open/<tag> records the time,
// and a record older than the card's last post is spent (the repost made it
// so, which stands in for clearing it). 'dismissed': gone and not opened, so
// the X, a swipe or "Clear all" removed it.
export function cardFate(card, hist, openedAt) {
  if (!hist.installed || hist.tags.includes(card.tag) || hist.blocked.includes(card.tag)) return 'present';
  return Number(openedAt) >= Number(card.postedAt) ? 'opened' : 'dismissed';
}

const activeCards = (state, now) => activeTags(state, now).map((tag) => ({ tag, app: state.cards[tag].app ?? appIdOf(tag) }));

// The check the watcher makes every few minutes between refreshes: one
// PowerShell call, no scheduler query. True unless some card is gone.
export async function cardsStillThere(deps, files) {
  const cards = activeCards(loadState(files), deps.now());
  if (!cards.length) return true;
  const hist = await cardHistory(deps.run, cards);
  return cards.every((c) => cardFate({ tag: c.tag, postedAt: Infinity }, hist, 0) === 'present');
}

function question(files, deps, now, row, tag) {
  const p = parseLocal(row.nextRun);
  const { token, expires } = issueToken(files, { now, random: deps.random, day: dayKey(now), task: { tag, name: row.name, path: row.path, runAt: row.nextRun } });
  return { xml: askXml(row.name, hhmm(p.h, p.mi), token), tag: askTag(tag), group: ASK_GROUP, app: appIdOf(tag), suppress: false, expires: new Date(expires).toISOString() };
}

// The card a run that just ended gets: popup and sound in both cases; a
// success leaves by itself, a failure stays.
function endCard(row, now) {
  const p = parseLocal(row.lastRun);
  const at = hhmm(p.h, p.mi);
  const ok = row.kind !== 'failed';
  const text = ok ? `Done at ${at}` : `Failed at ${at} (${failureReason(row.lastResult)})`;
  return { text, kind: ok ? 'done' : 'failed', expires: ok ? now.getTime() + LEAVE_MS : null };
}

export async function refreshCards(deps, files, log = () => {}) {
  const now = deps.now();
  const today = dayKey(now);
  const { rows } = await buildRows(deps);
  const state = loadState(files);
  dropExpired(files, now);
  const checking = activeCards(state, now);
  let hist = null;
  if (checking.length) {
    hist = await cardHistory(deps.run, checking);
    if (!hist.installed) return { installed: false, rows };
  }
  const opened = readOpened(files);
  const cards = {};
  const toasts = [];
  const asked = [];
  const reopened = new Set();
  for (const { tag } of checking) {
    const c = state.cards[tag];
    const fate = cardFate({ tag, ...c }, hist, Number(opened[tag]) || 0);
    if (fate === 'opened') reopened.add(tag);
    if (fate !== 'dismissed') continue;
    cards[tag] = { ...c, dismissed: today };
    // A failed card has nothing to cancel; any other asks only when its task
    // still has a run to come today.
    const row = rows.find((r) => cardTag(r) === tag);
    const ask = c.kind !== 'failed' && row && remainingToday([row], now).length > 0;
    if (ask) { toasts.push(question(files, deps, now, row, tag)); asked.push(row.name); }
    log(`card ${c.name} closed${ask ? ', asked whether to cancel today\'s run' : ''}`);
  }
  for (const [tag, c] of Object.entries(state.cards)) {
    if (cards[tag] || c.day !== today) continue;
    if (c.dismissed === today || (c.until && c.until > now.getTime())) cards[tag] = c;
  }
  const seen = {};
  const own = rows.filter((r) => !r.watcher);
  const wanted = new Set(todayRows(own).map(cardTag));
  for (const row of own) {
    const tag = cardTag(row);
    const app = appIdOf(tag);
    const base = { name: row.name, path: row.path, app, day: today, postedAt: now.getTime(), dismissed: null };
    const ended = runEnded(state.seen[tag], row, now);
    seen[tag] = { day: today, lastRun: row.lastRun, kind: row.kind };
    if (ended) {
      const end = endCard(row, now);
      toasts.push({ xml: cardXml(row, end.text), tag, group: GROUP, app, suppress: false, ...(end.expires ? { expires: new Date(end.expires).toISOString() } : {}) });
      cards[tag] = { ...base, text: end.text, kind: end.kind, ...(end.expires ? { until: end.expires } : {}) };
      log(`${row.name}: ${end.text}`);
      continue;
    }
    if (!wanted.has(tag) || row.kind === 'done' || cards[tag]) continue;
    const text = cardText(row);
    const prev = state.cards[tag];
    if (prev && prev.day === today && !prev.dismissed && !prev.until && prev.text === text && !reopened.has(tag)) { cards[tag] = prev; continue; }
    toasts.push({ xml: cardXml(row, text), tag, group: GROUP, app, suppress: true });
    cards[tag] = { ...base, text, kind: row.kind };
  }
  // Every card the tool no longer wants (done, gone past its expiry, a task
  // turned off) is taken out by the tool itself, so it is never seen as
  // dismissed. IDs of tasks that no longer exist are unregistered; an empty
  // list is taken for a failed read, never for "every task was deleted".
  const exists = new Set(own.map((r) => appIdOf(cardTag(r))));
  const apps = { ...state.apps };
  const unregister = own.length ? Object.keys(apps).filter((id) => !exists.has(id)) : [];
  for (const id of unregister) delete apps[id];
  const remove = Object.entries(state.cards)
    .filter(([tag, c]) => !cards[tag] && c.dismissed !== c.day && !unregister.includes(c.app ?? appIdOf(tag)))
    .map(([tag, c]) => ({ tag, app: c.app ?? appIdOf(tag) }));
  const register = [];
  for (const t of toasts) {
    if (apps[t.app]) continue;
    const r = own.find((x) => appIdOf(cardTag(x)) === t.app);
    apps[t.app] = { name: r.name, path: r.path };
    register.push({ id: t.app, name: r.name });
  }
  let settings = {};
  if (toasts.length || remove.length || register.length || unregister.length) {
    const res = await postToasts(deps.run, { toasts, remove, register, unregister });
    if (!res.installed) return { installed: false, rows };
    settings = obj(res.settings);
  }
  files.write(FILES.state, JSON.stringify({ cards, seen, apps }));
  const blocked = Object.entries(settings).filter(([, s]) => s && s !== 'Enabled').map(([id]) => apps[id]?.name ?? id);
  return { installed: true, rows, cards, asked, toasts, remove, register, unregister, blocked };
}

export const notifyInstallLines = (deps) => installPlanLines(deps);
export const notifyUninstallLines = (keys) => uninstallPlanLines(keys.ids);
export const installNotify = (deps) => writeKeys(deps.run, deps);
export const uninstallNotify = (deps, keys) => removeKeys(deps.run, keys.ids);

async function confirmed(deps, flags, lines, question) {
  for (const l of lines) deps.out(l);
  if (flags.yes || isYes(await deps.ask(question))) return true;
  deps.out('Cancelled, nothing changed.');
  return false;
}

export async function notifyCmd(deps, flags) {
  if (flags.install && flags.uninstall) { deps.err('Choose either --install or --uninstall.'); return 2; }
  if (flags.install) {
    if (!(await confirmed(deps, flags, notifyInstallLines(deps), 'Write these entries? (y/N) '))) return 1;
    await installNotify(deps);
    deps.out('Registered. Run "task notify" to post the cards.');
    return 0;
  }
  if (flags.uninstall) {
    const keys = await listOwnKeys(deps.run);
    if (!(await confirmed(deps, flags, notifyUninstallLines(keys), 'Delete these entries? (y/N) '))) return 1;
    await uninstallNotify(deps, keys);
    deps.out('Removed.');
    return 0;
  }
  const res = await refreshCards(deps, deps.app, makeLogger(deps.app, deps.now));
  if (!res.installed) {
    deps.err('The tool is not registered to send notifications. Run "task notify --install" first.');
    return 1;
  }
  const shown = Object.values(res.cards).filter((c) => c.dismissed !== c.day);
  deps.out(shown.length ? `Cards today (${shown.length}):` : 'No task needs a card today.');
  for (const c of shown) deps.out(`  ${c.name}: ${c.text}${c.until ? ' (leaves by itself)' : ''}`);
  for (const name of res.asked) deps.out(`The card of "${name}" was closed; asked whether to cancel today's run.`);
  if (res.blocked.length) deps.err(`Windows is blocking notifications for: ${res.blocked.join(', ')}. See Settings, System, Notifications.`);
  return 0;
}
