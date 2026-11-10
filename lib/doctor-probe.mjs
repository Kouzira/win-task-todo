// What `task doctor` reads from the machine. Every read is read only: the
// registry is opened without write access, and the toast history is only
// asked (toast.mjs, cardHistory). Nothing is created, changed or removed.
import path from 'node:path';
import { TASK_ID } from './registry.mjs';
import { parseJson, payload } from './ps.mjs';

const SETTINGS_ROOT = 'Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\';
const PUSH_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';

// OpenSubKey with one argument opens for reading only. A value or key that is
// absent comes back as null, which the decisions read as "the Windows default".
const SETTINGS_SCRIPT = `
# notification-settings-probe (read only)
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', 'Default')
$push = $root.OpenSubKey('${PUSH_KEY}')
$toast = if ($push) { $push.GetValue('ToastEnabled') } else { $null }
$apps = [ordered]@{}
foreach ($id in @($p.ids)) {
  if ([string]$id -notmatch '^WinTaskTodo\\.[0-9a-f]{15}$') { throw 'Invalid ID' }
  $k = $root.OpenSubKey('${SETTINGS_ROOT}' + $id)
  $apps[[string]$id] = [pscustomobject]@{
    Enabled = $(if ($k) { $k.GetValue('Enabled') } else { $null })
    ShowBanner = $(if ($k) { $k.GetValue('ShowBanner') } else { $null })
    ShowInActionCenter = $(if ($k) { $k.GetValue('ShowInActionCenter') } else { $null })
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ toastEnabled = $toast; apps = [pscustomobject]$apps })
`;

export const isSettingsScript = (script) => script.includes('notification-settings-probe');

// ids: the app IDs of the tasks with a card. Returns { toastEnabled, apps }.
export async function readNotificationSettings(run, ids) {
  const safe = ids.filter((id) => TASK_ID.test(id));
  const r = parseJson(await run(payload({ ids: safe }) + SETTINGS_SCRIPT)) ?? {};
  return { toastEnabled: r.toastEnabled ?? null, apps: r.apps && typeof r.apps === 'object' ? r.apps : {} };
}

// The first task.cmd, task.exe or task.bat in a PATH folder, or null.
export function findOnPath(env, exists) {
  const dirs = String(env?.PATH ?? env?.Path ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    for (const name of ['task.cmd', 'task.exe', 'task.bat']) {
      const file = path.win32.join(dir, name);
      if (exists(file)) return file;
    }
  }
  return null;
}
