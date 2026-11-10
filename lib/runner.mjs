// The runner behind `task add --log`. The scheduled action is
//   node run-logged.mjs --log <file> --exe <program> --args <argument string>
// and this module does the work: it starts the program with exactly that
// argument string, copies its output into the log, writes a timestamp line
// before the run and an `exit <code>` line after it, and ends with the same
// exit code, so Task Scheduler still sees a failure as a failure. The file
// system, the child process and the clock are injected for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LOG_CAP, stamp } from './app-files.mjs';

export function parseRunnerArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--log', '--exe', '--args'].includes(key) || argv[i + 1] === undefined) return null;
    out[key.slice(2)] = argv[i + 1];
  }
  return out.log && out.exe && 'args' in out ? out : null;
}

export const realRunnerIo = {
  size: (f) => { try { return fs.statSync(f).size; } catch { return 0; } },
  mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
  append: (f, data) => fs.appendFileSync(f, data),
  rename: (a, b) => fs.renameSync(a, b),
  remove: (f) => { try { fs.unlinkSync(f); } catch { /* nothing to remove */ } },
};

// The old log becomes <file>.1 (one old file is kept), so the log stays near
// the cap instead of growing without end.
export function rotate(io, file, cap = LOG_CAP) {
  if (io.size(file) <= cap) return false;
  io.remove(`${file}.1`);
  io.rename(file, `${file}.1`);
  return true;
}

// Resolves with the exit code the runner itself should end with.
export async function runLogged(opts, { io = realRunnerIo, start = spawn, now = () => new Date() } = {}) {
  const { log, exe, args } = opts;
  const write = (text) => { try { io.append(log, text); } catch { /* a log that cannot be written must not stop the task */ } };
  try { io.mkdir(path.dirname(log)); rotate(io, log); } catch { /* the program still runs */ }
  write(`=== ${stamp(now())} ===\n`);
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      write(`exit ${code}\n`);
      resolve(code);
    };
    let child;
    try {
      // windowsVerbatimArguments hands the argument string over untouched,
      // which is what the scheduler does for the original action. It also
      // stops node quoting the program name, so argv0 carries the quotes a
      // path with spaces needs.
      const program = exe.replace(/^"+|"+$/g, '');
      const argv0 = /\s/.test(program) ? `"${program}"` : program;
      child = start(program, args ? [args] : [], { argv0, windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { write(`could not start ${exe}: ${e.message}\n`); finish(1); return; }
    child.stdout?.on('data', (d) => write(d));
    child.stderr?.on('data', (d) => write(d));
    child.on('error', (e) => { write(`could not start ${exe}: ${e.message}\n`); finish(1); });
    child.on('close', (code, signal) => finish(typeof code === 'number' ? code : (signal ? 1 : 0)));
  });
}
