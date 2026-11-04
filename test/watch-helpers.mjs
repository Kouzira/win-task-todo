// Fakes for the card, the watcher and the URI handler: an in-memory copy of
// the tool's folder, timers the test fires by hand, and a runner that answers
// the toast, history, registry and process scripts from memory and passes
// scheduler scripts on to the fake of helpers.mjs. Nothing here reaches the
// real notifications, registry or Task Scheduler.
import assert from 'node:assert/strict';
import { isRegistryScript } from '../lib/registry.mjs';
import { GROUP, isHistoryScript, isPostScript } from '../lib/toast.mjs';
import { INFO, TASKS, fakeDeps } from './helpers.mjs';

export const WATCHER = {
  name: 'win-task-todo watch', path: '\\', state: 'Ready', author: '',
  // The description is as an older install wrote it (Vietnamese second line); only the first line is the marker.
  description: 'tasks-watcher:win-task-todo\nTạo bởi công cụ tasks: watcher', userId: 'alice', runLevel: 'Limited', logonType: 'Interactive',
  actions: [{ execute: 'C:\\Windows\\System32\\conhost.exe', arguments: '--headless "C:\\Tools\\node.exe" "D:\\Projects\\win-task-todo\\tasks.mjs" watch', workingDirectory: '' }],
  triggers: [{ type: 'Logon', enabled: true }],
};

export const decode = (script) => {
  const m = /FromBase64String\('([^']+)'\)/.exec(script);
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
};

export function memoryFiles(init = {}) {
  const store = new Map(Object.entries(init));
  const watchers = new Set();
  const changed = (n) => { for (const w of [...watchers]) w(n); };
  return {
    dir: 'C:\\mem\\win-task-todo',
    store,
    read: (n) => (store.has(n) ? String(store.get(n)) : null),
    write: (n, t) => { store.set(n, t); changed(n); },
    append: (n, t) => store.set(n, (store.get(n) ?? '') + t),
    size: (n) => (store.has(n) ? Buffer.byteLength(store.get(n)) : 0),
    pathOf: (n) => `C:\\mem\\win-task-todo\\${n}`,
    rename: (a, b) => { if (store.has(a)) { store.set(b, store.get(a)); store.delete(a); } },
    claim: (a, b) => { if (!store.has(a)) return false; store.set(b, store.get(a)); store.delete(a); return true; },
    remove: (n) => { store.delete(n); },
    exists: (n) => store.has(n),
    list: () => [...store.keys()],
    createExclusive: (n, t) => { if (store.has(n)) return false; store.set(n, t); return true; },
    watch: (name, cb) => { const w = (n) => { if (n === name) cb(); }; watchers.add(w); return () => watchers.delete(w); },
  };
}

export function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
    clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
  };
}

export const flush = () => new Promise((r) => setImmediate(r));

// opts: everything fakeDeps takes, plus files, installed, setting, cmdlines
// (pid to command line), alive (a Set of pids), clock ({ now: Date }).
export function toastDeps(opts = {}) {
  const base = fakeDeps({ tasks: opts.tasks ?? TASKS, info: opts.info ?? INFO, answer: opts.answer ?? 'n', now: opts.now });
  const clock = opts.clock ?? { now: opts.now ?? new Date('2026-11-04T12:00:00') };
  // center: the card tags now in the simulated Notification Center; ids: the
  // per-task IDs in the simulated registry; blocked: IDs whose notifications
  // are turned off.
  // opts.share: another toastDeps whose simulated Windows and records this one
  // continues, so a test can change the scheduler data between refreshes.
  const sim = opts.share?.sim ?? { center: new Set(), ids: new Set(opts.ids ?? []), blocked: new Set(), installed: opts.installed ?? true };
  const shared = opts.share?.captured;
  const posts = shared?.posts ?? [];
  const history = shared?.history ?? [];
  const removed = shared?.removed ?? [];
  const registered = shared?.registered ?? [];
  const unregistered = shared?.unregistered ?? [];
  const registry = [];
  const launched = [];
  const killed = [];
  const cmdlines = opts.cmdlines ?? {};
  const alive = opts.alive ?? new Set();
  const run = async (script) => {
    if (isHistoryScript(script)) {
      const d = decode(script);
      history.push(d);
      if (!sim.installed) return JSON.stringify({ installed: false });
      const cards = [d.cards].flat();
      return JSON.stringify({
        installed: true,
        tags: cards.filter((c) => sim.center.has(c.tag) && !sim.blocked.has(c.app)).map((c) => c.tag),
        blocked: cards.filter((c) => sim.blocked.has(c.app)).map((c) => c.tag),
      });
    }
    if (isPostScript(script)) {
      const d = decode(script);
      if (!sim.installed) return JSON.stringify({ installed: false });
      for (const a of d.register) {
        assert.match(a.id, /^WinTaskTodo\.[0-9a-f]{15}$/);
        sim.ids.add(a.id);
        registered.push(a);
      }
      for (const id of d.unregister) { sim.ids.delete(id); unregistered.push(id); }
      for (const t of d.toasts) assert.ok(sim.ids.has(t.app), `toast under an unregistered ID ${t.app}`);
      posts.push(d.toasts);
      removed.push(...d.remove.map((r) => r.tag));
      for (const r of d.remove) sim.center.delete(r.tag);
      for (const t of d.toasts) if (t.group === GROUP) sim.center.add(t.tag);
      const settings = Object.fromEntries(d.toasts.map((t) => [t.app, sim.blocked.has(t.app) ? 'DisabledForApplication' : 'Enabled']));
      return JSON.stringify({ installed: true, settings });
    }
    if (script.includes('GetSubKeyNames')) return JSON.stringify({ ids: [...sim.ids], scheme: sim.installed });
    if (isRegistryScript(script)) {
      registry.push({ script, data: decode(script) });
      return '{"ok":true}';
    }
    if (script.includes('Win32_Process')) return JSON.stringify({ cmd: cmdlines[decode(script).pid] ?? null });
    if (script.includes('Get-Process -Id')) return JSON.stringify({ ws: 41 * 1048576 });
    return base.run(script);
  };
  const deps = {
    ...base,
    run,
    now: () => clock.now,
    app: opts.files ?? memoryFiles(),
    systemRoot: 'C:\\Windows',
    pid: opts.pid ?? 4242,
    bootMinute: () => 1000,
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => killed.push(pid),
    random: (n) => Buffer.alloc(n, 0xab),
    timers: opts.timers ?? fakeTimers(),
    launch: async (cmd, args, o = {}) => { launched.push({ cmd, args, ...o }); return opts.launchOk ? opts.launchOk(cmd) : true; },
    onStopSignal: () => {},
  };
  deps.sim = sim;
  deps.clock = clock;
  deps.captured = { ...base.captured, posts, history, registry, launched, killed, removed, registered, unregistered };
  return deps;
}

export const TOKEN = 'ab'.repeat(16);
