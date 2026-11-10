// Tiny argument parser: no dependency, and only the flags the tool knows,
// so a typo such as --yess is reported instead of silently ignored.
const FLAGS = new Set(['all', 'json', 'yes', 'dry-run', 'help', 'install', 'uninstall', 'status', 'stop', 'log']);
// Options that take a value, as `--cwd D:\dir` or `--cwd=D:\dir`.
const VALUED = new Set(['cwd', 'project']);
const SHORT = { y: 'yes', h: 'help', a: 'all' };

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const unknown = [];
  const missing = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (VALUED.has(name)) {
        // The value is the next argument, whatever it looks like, so a folder
        // or a label that starts with a dash is still taken whole.
        const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined || value === '') missing.push(`--${name}`);
        else flags[name] = value;
      } else if (FLAGS.has(name) && eq < 0) flags[name] = true;
      else unknown.push(a);
    } else if (/^-[a-z]$/i.test(a) && SHORT[a[1].toLowerCase()]) {
      flags[SHORT[a[1].toLowerCase()]] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, unknown, missing };
}
