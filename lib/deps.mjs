// The real-world side of the dependencies the commands receive. Tests build
// their own object with the same shape and a fake runner.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { bootMinute, isAlive, realAppFiles } from './app-files.mjs';
import { fileURLToPath } from 'node:url';
import { realRunner } from './ps.mjs';
import { realLogStore } from './logs.mjs';

export function realDeps(env = process.env) {
  return {
    run: realRunner(),
    out: (line = '') => process.stdout.write(line + '\n'),
    err: (line = '') => process.stderr.write(line + '\n'),
    // Only a typed answer counts: an empty line is ignored and the question
    // waits, while a closed stdin still counts as no. In cmd.exe, through the
    // launcher, the question was answered by an empty line the owner never
    // typed, at once with `task delete` and later after the PowerShell fetch
    // with `task run` (both seen on 4 November); a 0.4 second window caught
    // the first case and missed the second, so no timing rule is used.
    ask: (question) => new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      let hinted = false;
      const finish = (a) => { answered = true; rl.close(); resolve(a); };
      rl.on('line', (a) => {
        if (a.trim()) { finish(a); return; }
        if (!hinted) { hinted = true; process.stdout.write('Type y to confirm or n to cancel: '); }
      });
      rl.on('close', () => { if (!answered) resolve(''); });
      process.stdout.write(question);
    }),
    user: {
      name: env.USERNAME || '',
      domain: env.USERDOMAIN || '',
      profile: env.USERPROFILE || '',
    },
    now: () => new Date(),
    // Absolute paths, so the re-enable helper task needs neither PATH nor a working directory.
    nodePath: process.execPath,
    scriptPath: fileURLToPath(new URL('../tasks.mjs', import.meta.url)),
    logs: realLogStore(env),
    app: realAppFiles(env),
    systemRoot: env.SystemRoot || 'C:\\Windows',
    pid: process.pid,
    bootMinute,
    isAlive,
    kill: (pid) => { try { process.kill(pid); } catch { /* already gone */ } },
    random: (n) => randomBytes(n),
    timers: { setTimeout, clearTimeout },
    // Starts a program detached from this one and resolves true once it
    // runs, false when it cannot be found (no Windows Terminal, for example).
    launch: (cmd, args, { verbatim = false } = {}) => new Promise((resolve) => {
      let child;
      try { child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim }); }
      catch { resolve(false); return; }
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    }),
    // Ctrl+C, Ctrl+Break and closing the console window stop the watcher
    // cleanly. A shutdown ends it without a signal; the lock it leaves is then
    // recognised as stale by its boot time.
    onStopSignal: (stop) => { for (const s of ['SIGINT', 'SIGBREAK', 'SIGHUP']) process.once(s, stop); },
  };
}
