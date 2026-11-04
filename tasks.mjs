#!/usr/bin/env node
// Entry point only: everything real lives in lib/, so tests can drive the
// same code with a fake PowerShell runner instead of the live scheduler.
import { main } from './lib/cli.mjs';
import { realDeps } from './lib/deps.mjs';

main(process.argv.slice(2), realDeps()).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`Unexpected error: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  },
);
