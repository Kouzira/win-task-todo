#!/usr/bin/env node
// Entry point of the runner that `task add --log` puts in the scheduled
// action. All the work is in lib/runner.mjs.
import { parseRunnerArgs, runLogged } from './lib/runner.mjs';

const opts = parseRunnerArgs(process.argv.slice(2));
if (!opts) {
  process.stderr.write('Usage: node run-logged.mjs --log <file> --exe <program> --args <arguments>\n');
  process.exitCode = 2;
} else {
  runLogged(opts).then((code) => { process.exitCode = code; });
}
