// After a task is added, turned on or off, deleted, skipped or unskipped, the
// cards are refreshed at once, with the same function `task notify` runs.
// Without it a change showed on the cards only at the watcher's next wake-up,
// up to 30 minutes later. The refresh is best effort: the change itself has
// already succeeded, so nothing here may fail the command.
import { makeLogger } from './app-files.mjs';
import { refreshCards } from './notify.mjs';
import { listOwnKeys } from './registry.mjs';

export async function refreshAfterChange(deps) {
  // No folder for the tool's files means there is nothing to refresh into.
  if (!deps.app) return false;
  let registered;
  try { registered = (await listOwnKeys(deps.run)).scheme; } catch { return false; }
  // Not installed: the owner never asked for cards, so say nothing.
  if (!registered) return false;
  try {
    const res = await refreshCards(deps, deps.app, makeLogger(deps.app, deps.now));
    if (!res.installed) return false;
    deps.out('Cards updated.');
    return true;
  } catch (e) {
    deps.out('The change is done, but the cards could not be updated now; the watcher will update them.');
    return false;
  }
}
