// Tiny argument parser: no dependency, and only the flags the tool knows,
// so a typo such as --yess is reported instead of silently ignored.
const FLAGS = new Set(['all', 'json', 'yes', 'dry-run', 'help', 'install', 'uninstall', 'status', 'stop']);
const SHORT = { y: 'yes', h: 'help', a: 'all' };

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const unknown = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (FLAGS.has(name)) flags[name] = true;
      else unknown.push(a);
    } else if (/^-[a-z]$/i.test(a) && SHORT[a[1].toLowerCase()]) {
      flags[SHORT[a[1].toLowerCase()]] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, unknown };
}
