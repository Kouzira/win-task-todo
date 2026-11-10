// Turns the command string given to `task add` into an executable plus
// arguments for the scheduler. PowerShell commands and .ps1 files run with
// -NoProfile -ExecutionPolicy Bypass so a task behaves the same unattended as
// at a prompt; anything else goes through cmd.exe /c exactly as typed.

const PS_FLAGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];

export function buildAction(command) {
  const s = String(command ?? '').trim();
  const ps = /^(powershell|pwsh)(?:\.exe)?(?:\s+(.*))?$/i.exec(s);
  if (ps) {
    const rest = (ps[2] ?? '').trim();
    const flags = [];
    if (!/(^|\s)-NoProfile\b/i.test(rest)) flags.push('-NoProfile');
    if (!/(^|\s)-ExecutionPolicy\b/i.test(rest)) flags.push('-ExecutionPolicy', 'Bypass');
    return { execute: `${ps[1].toLowerCase()}.exe`, arguments: [...flags, rest].filter(Boolean).join(' ') };
  }
  if (/\.ps1"?$/i.test(s)) {
    const file = s.replace(/^"|"$/g, '');
    return { execute: 'powershell.exe', arguments: `${PS_FLAGS.join(' ')} -File "${file}"` };
  }
  return { execute: 'cmd.exe', arguments: `/c ${s}` };
}

// One argument in the form Windows' command line parsing (and so node) reads
// back unchanged: quotes around it, backslashes doubled only where they sit in
// front of a quote, and every inner quote escaped.
export function quoteArg(value) {
  const s = String(value ?? '');
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// The action that runs `action` through the logging runner (lib/runner.mjs,
// started by run-logged.mjs). The original executable and argument string are
// handed over as two separate quoted arguments, so the runner starts the
// program with exactly the command line the scheduler would have given it.
export function wrapWithLog(action, { nodePath, runnerPath, logFile }) {
  return {
    execute: nodePath,
    arguments: [quoteArg(runnerPath), '--log', quoteArg(logFile), '--exe', quoteArg(action.execute), '--args', quoteArg(action.arguments)].join(' '),
  };
}
