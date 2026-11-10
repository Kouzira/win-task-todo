// Canned scheduler data and a fake dependency set. The fake runner answers
// from memory and records every script, so no test can reach the real
// Task Scheduler; a script it does not recognise throws.
export const USER = { name: 'alice', domain: 'PC-01', profile: 'C:\\Users\\alice' };

const task = (name, path, over = {}) => ({
  name, path, state: 'Ready', author: '', description: '', userId: 'alice', runLevel: 'Limited', logonType: 'Interactive',
  actions: [], triggers: [], ...over,
});

const weekdays = (h) => ({ type: 'Weekly', enabled: true, startBoundary: `2026-10-06T${h}:00+07:00`, daysOfWeek: 62, weeksInterval: 1 });
const pwsh = 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';

export const TASKS = [
  task('Daily backup', '\\', { actions: [{ execute: pwsh, arguments: '-NoProfile -File "D:\\Scripts\\backup.ps1"', workingDirectory: 'D:\\Scripts' }], triggers: [weekdays('10:00')] }),
  task('Report sync', '\\', { actions: [{ execute: pwsh, arguments: '-NoProfile -File "D:\\Scripts\\report-sync.ps1"', workingDirectory: 'D:\\Scripts' }], triggers: [weekdays('17:20')] }),
  task('Nightly cleanup', '\\', { author: 'PC-01\\alice', actions: [{ execute: 'cmd.exe', arguments: '"D:\\Scripts\\cleanup.bat"', workingDirectory: '' }], triggers: [{ type: 'Daily', enabled: true, startBoundary: '2026-10-01T01:00:00+07:00', daysInterval: 1 }] }),
  task('Launch Adobe CCXProcess', '\\', { author: 'PC-01\\alice', actions: [{ execute: '"C:\\Program Files\\Adobe\\Adobe Creative Cloud Experience\\CCXProcess.exe"', arguments: '' }], triggers: [{ type: 'Logon', enabled: true }] }),
  task('StartCN', '\\', { author: 'Advanced Micro Devices', userId: '', actions: [{ execute: '"C:\\Program Files\\AMD\\CNext\\CNext\\cncmd.exe"', arguments: 'startwithdelay' }], triggers: [{ type: 'Logon', enabled: true }] }),
  task('RtkAudUService64_BG', '\\', { author: 'Realtek', userId: '', actions: [{ execute: '""C:\\WINDOWS\\System32\\DriverStore\\FileRepository\\x\\RtkAudUService64.exe""', arguments: '-background' }] }),
  task('PlatformExperiencesHelper_Daily', '\\', { actions: [{ execute: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\PlatformExperiencesHelper\\platform_experiences_helper.exe', arguments: '' }] }),
  task('Printer Health Monitor', '\\HP\\HP Print Scan Doctor\\', { author: 'HP Inc.', userId: '', actions: [{ execute: 'C:\\Program Files\\HPPrintScanDoctor\\HPPrinterHealthMonitor.exe', arguments: '' }] }),
  task('SoftLandingCreativeManagementTask', '\\SoftLanding\\S-1-5-21-1\\', { actions: [] }),
  task('Test service', '\\Microsoft\\Windows\\Foo\\', { author: 'Microsoft Corporation', actions: [{ execute: 'C:\\Windows\\system32\\foo.exe', arguments: '' }] }),
];

export const INFO = {
  '\\Daily backup': { lastRun: '2026-11-04T10:00:00', nextRun: '2026-11-05T10:00:00', lastResult: 0 },
  '\\Report sync': { lastRun: '2026-11-03T17:30:00', nextRun: '2026-11-04T17:20:00', lastResult: -1073741510 },
  '\\Nightly cleanup': { lastRun: '2026-11-04T09:27:00', nextRun: '2026-11-05T01:00:00', lastResult: 267009 },
};

const decode = (script) => {
  const m = /FromBase64String\('([^']+)'\)/.exec(script);
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
};

export function fakeDeps({ tasks = TASKS, info = INFO, answer = 'n', now = new Date('2026-11-04T12:00:00'), logs, failOn = null, dirs = [], env = {} } = {}) {
  const out = [];
  const err = [];
  const writes = [];
  const asked = [];
  const run = async (script) => {
    if (failOn && failOn.test(script)) throw new Error('PowerShell reported an error: simulated');
    if (script.includes('Get-ScheduledTask |')) return JSON.stringify(tasks);
    if (script.includes('Get-ScheduledTaskInfo')) {
      const items = decode(script).items;
      return JSON.stringify(items.map((i) => ({
        path: i.path, name: i.name, ...(info[i.path + i.name] ?? { lastRun: null, nextRun: null, lastResult: null }),
      })));
    }
    if (/Register-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Start-ScheduledTask|Unregister-ScheduledTask/.test(script)) {
      writes.push({ script, data: decode(script) });
      return '';
    }
    throw new Error('Script not recognised by the fake');
  };
  return {
    run,
    out: (l = '') => out.push(l),
    err: (l = '') => err.push(l),
    ask: async (q) => { asked.push(q); return answer; },
    user: USER,
    now: () => now,
    nodePath: 'C:\\Tools\\node.exe',
    scriptPath: 'D:\\Projects\\win-task-todo\\tasks.mjs',
    runnerPath: 'D:\\Projects\\win-task-todo\\run-logged.mjs',
    dirExists: (d) => dirs.includes(d),
    env,
    logs: logs ?? { dir: null, list: async () => [], tail: async () => [] },
    captured: { out, err, writes, asked },
  };
}
