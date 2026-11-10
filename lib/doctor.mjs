// The decisions of `task doctor`, as pure functions: each takes what was
// observed (read by doctor-cmd.mjs) and returns results of the form
// { status, text, fix? }, status being ok, info, warn or fail. Nothing here
// reads the machine, so every finding is tested with canned observations.

export const REFRESH_LIMIT_MIN = 35; // the watcher sleeps 30 minutes at most, plus slack for a slow refresh
export const SETTINGS_PATH = 'Settings > System > Notifications';
const result = (status, text, fix) => ({ status, text, ...(fix ? { fix } : {}) });

export function checkPath(found, folder) {
  if (found) return [result('ok', `The "task" command is found on PATH (${found}).`)];
  return [result('warn', 'The "task" command is not found on PATH (no task.cmd in any PATH folder). Cards do not need it, but typing "task" will fail.',
    `Add the tool's folder to PATH, then reopen the terminal: [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${folder}', 'User')`)];
}

// tasks: [{ name, problems }] for the user's own tasks; a task whose command
// could not be read arrives with no problems and so is not reported.
export function checkCommands(tasks) {
  const bad = tasks.filter((t) => t.problems.length);
  if (!bad.length) return [result('ok', "Each task's command points at files that exist.")];
  return bad.map((t) => result('warn', `The command of "${t.name}" may not work: ${t.problems.join(' ')}`,
    `delete and add it again with the right path (task delete "${t.name}", then task add ...)`));
}

export function checkInstalled(keys) {
  if (!keys.scheme) {
    return [result('fail', 'The notification part is not installed (the wintasktodo: registry key is missing), so no card can be posted.', 'Run: task notify --install')];
  }
  return [result('ok', `The notification part is installed (${keys.ids.filter((id) => id.includes('.')).length} task IDs registered).`)];
}

export function checkLogonTask(task, isDisabled) {
  if (!task) return [result('fail', 'The logon task "win-task-todo watch" does not exist, so the watcher will not start at logon.', 'Run: task watch --install')];
  if (isDisabled(task.state)) return [result('fail', 'The logon task "win-task-todo watch" is turned off.', 'Run: task on "win-task-todo watch"')];
  return [result('ok', 'The logon task "win-task-todo watch" exists and is on.')];
}

// pid: the live watcher or null; lock: what watch.pid holds, or null.
export function checkWatcher(pid, lock) {
  if (pid) return [result('ok', `The watcher is running (pid ${pid}).`)];
  if (lock) {
    return [result('fail', `The watcher is not running: watch.pid names pid ${lock.pid}, which is gone or is not a watcher (a stale lock, replaced by the next watcher).`,
      'Run: task run "win-task-todo watch" (or task watch in a terminal)')];
  }
  return [result('fail', 'The watcher is not running, so cards are only updated by commands and by task notify.', 'Run: task run "win-task-todo watch" (it also starts by itself at the next logon)')];
}

// The cards that should be in the Notification Center now: tasks with a card
// today, minus those whose run is done (no card until a run ends) and those
// whose card the owner closed today (the tool leaves it closed on purpose).
export function expectedCards(rows, state, todayKey, rowTag, rowApp) {
  return rows.filter((r) => !r.watcher && ['pending', 'running', 'failed', 'skipped'].includes(r.kind)
    && !(r.kind === 'skipped' && / on \d{4}-/.test(r.status)))
    .map((r) => {
      const tag = rowTag(r);
      const c = state.cards?.[tag];
      return { name: r.name, tag, app: rowApp(tag), posted: Boolean(c), closed: Boolean(c && c.dismissed === todayKey) };
    });
}

export function checkAppIds(cards, ids) {
  if (!cards.length) return [result('info', 'No task needs a card today, so there is nothing to register or show.')];
  const missing = cards.filter((c) => !ids.includes(c.app));
  if (!missing.length) return [result('ok', `Every task with a card today (${cards.length}) has its app ID registered.`)];
  return missing.map((c) => result('fail', `"${c.name}" has no app ID registered (${c.app}), so Windows cannot show its card.`, 'Run: task notify (it registers the ID when it posts the card)'));
}

// values: { Enabled, ShowBanner, ShowInActionCenter } as read from the
// registry; a value that is absent means the Windows default, which is on.
export function settingsFindings(name, values) {
  const v = values ?? {};
  const out = [];
  if (v.Enabled === 0) out.push(result('fail', `Windows has notifications turned off for "${name}" (Enabled=0).`, `${SETTINGS_PATH}: find "${name}" in the app list and turn it on.`));
  if (v.ShowInActionCenter === 0) out.push(result('fail', `"${name}" is set not to keep notifications in the Notification Center (ShowInActionCenter=0).`, `${SETTINGS_PATH} > "${name}": select "Show notifications in notification center".`));
  if (v.ShowBanner === 0) out.push(result('warn', `Banners are off for "${name}" (ShowBanner=0): its cards appear in the Notification Center but never as a banner.`, `${SETTINGS_PATH} > "${name}": select "Show notification banners".`));
  return out;
}

export function checkSettings(cards, settings) {
  const out = [];
  if (settings.toastEnabled === 0) {
    out.push(result('fail', 'Windows has toast notifications switched off for the whole account (ToastEnabled=0).', `${SETTINGS_PATH}: turn "Notifications" on.`));
  }
  const apps = settings.apps ?? {};
  const found = cards.flatMap((c) => settingsFindings(c.name, apps[c.app]));
  out.push(...found);
  if (!out.length) out.push(result('ok', 'Windows notification settings show nothing turned off for the tasks with a card (a missing value means the default, on).'));
  out.push(result('info', `Do not disturb / Focus is not checked (it is not stored where it can be read cheaply). If it is on, banners are held back: look at ${SETTINGS_PATH} > Do not disturb.`));
  return out;
}

// hist: { installed, tags, blocked } from Windows' own toast history.
export function checkHistory(cards, hist) {
  const live = cards.filter((c) => !c.closed);
  if (!live.length) return [result('info', 'No card is expected in the Notification Center right now.')];
  if (!hist.installed) return [result('fail', 'Windows reports the notification part as not installed, so its history cannot hold a card.', 'Run: task notify --install')];
  const out = [];
  let there = 0;
  for (const c of live) {
    if (hist.blocked.includes(c.tag)) {
      out.push(result('fail', `Windows blocks notifications for "${c.name}": its card cannot be shown.`, `${SETTINGS_PATH}: find "${c.name}" and turn it on (also check Do not disturb).`));
    } else if (hist.tags.includes(c.tag)) there++;
    else if (c.posted) out.push(result('warn', `The card of "${c.name}" was posted but Windows' history no longer holds it (closed, cleared, or removed by Windows).`, 'Run: task notify (it posts the card again unless it was closed on purpose)'));
    else out.push(result('fail', `No card was ever posted for "${c.name}".`, 'Run: task notify'));
  }
  if (there) out.unshift(result('ok', `Windows' toast history holds ${there} of ${live.length} expected cards.`));
  return out;
}

// The last log line about a refresh decides: a failure after the last success
// is a finding. Lines are "yyyy-mm-dd hh:mm:ss text".
export function lastRefreshFailure(logText) {
  const lines = String(logText ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ refresh recovered| watcher started/.test(lines[i])) return null;
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (?:refresh|watcher loop) failed.*?: (.*)$/.exec(lines[i]);
    if (m) return { at: m[1], text: m[2].slice(0, 120) };
  }
  return null;
}

export function checkRefresh({ mtimeMs, nowMs, watcherAlive, failure }) {
  const out = [];
  if (mtimeMs === null || mtimeMs === undefined) {
    out.push(result('warn', 'No refresh has run yet (the tool has no state file).', 'Run: task notify'));
  } else {
    const age = Math.max(0, Math.round((nowMs - mtimeMs) / 60000));
    const note = 'The watcher sleeps up to 30 minutes between refreshes; a command that changes a task refreshes at once.';
    if (watcherAlive && age > REFRESH_LIMIT_MIN) {
      out.push(result('warn', `The last refresh was ${age} minutes ago, longer than the watcher's 30 minute limit. ${note}`, 'Read %LOCALAPPDATA%\\win-task-todo\\watch.log, then run: task watch --stop, task run "win-task-todo watch"'));
    } else out.push(result('ok', `The last refresh was ${age} minute${age === 1 ? '' : 's'} ago. ${note}`));
  }
  if (failure) out.push(result('warn', `The last refresh in watch.log failed at ${failure.at}: ${failure.text}`, 'The watcher retries every 30 to 120 seconds; if this stays, run: task notify'));
  return out;
}

export function verdict(results) {
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  if (fails) return `Verdict: ${fails} problem${fails === 1 ? '' : 's'} found${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}. A card may not show until the fixes above are done.`;
  if (warns) return `Verdict: no hard problem, ${warns} warning${warns === 1 ? '' : 's'}.`;
  return 'Verdict: everything checked is fine. Routine cards are silent: look in the Notification Center (Win+N), not for a banner.';
}
