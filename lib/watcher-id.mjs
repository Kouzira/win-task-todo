// How the tool recognises its own watcher task. The name alone is not enough
// (anyone can create a task with that name), so the description must also
// carry the marker; only a task with both is treated as the watcher, shown as
// "Watcher", guarded by an extra question, and never offered for cancelling.
import { isDisabled } from './skip-status.mjs';

export const WATCH_TASK = 'win-task-todo watch';
export const WATCH_MARKER = 'tasks-watcher:win-task-todo';

export function isWatcher(task) {
  return String(task?.name ?? '') === WATCH_TASK
    && String(task?.description ?? '').split(/\r?\n/)[0] === WATCH_MARKER;
}

export const findWatcher = (all) => all.find((t) => isWatcher(t) && (t.path ?? '\\') === '\\') ?? null;

export const watcherStatus = (task) => (isDisabled(task.state) ? 'Watcher, off' : 'Watcher');

export const WATCHER_WARNING = `"${WATCH_TASK}" is the tool's own watcher task: it keeps the cards in the Notification Center up to date.`;
export const WATCHER_QUESTION = 'This is the tool\'s watcher. Continue anyway? (y/N)';
