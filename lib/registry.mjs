// The only registry keys the tool ever writes, all under HKCU (no admin):
// the wintasktodo: URI scheme that a click on a card or a question button
// launches, written by `task notify --install`, and one AppUserModelID per
// task, HKCU\Software\Classes\AppUserModelId\WinTaskTodo.<15 hex>, written by
// a refresh when a task first gets a card. Windows 11 stacks the toasts of
// one app and shows only the newest, so each task is its own "app" (with the
// task's name as DisplayName) and every card stays visible. Uninstall removes
// the scheme and every ID of that exact form, and nothing else.
//
// The .NET Registry API is used instead of New-Item -Force, which on the
// registry provider recreates an existing key and would wipe its values.
// CreateSubKey opens a key that exists and creates one that does not.
import { parseJson, payload } from './ps.mjs';

export const SCHEME = 'wintasktodo';
export const APP_PREFIX = 'WinTaskTodo.';
export const SCHEME_KEY = `Software\\Classes\\${SCHEME}`;
export const COMMAND_KEY = `${SCHEME_KEY}\\shell\\open\\command`;
export const AUMID_ROOT = 'Software\\Classes\\AppUserModelId';
// WinTaskTodo alone was the single ID of an earlier version; uninstall still
// recognises it so that nothing the tool ever wrote is left behind.
export const OWN_ID = /^WinTaskTodo(\.[0-9a-f]{15})?$/;
export const TASK_ID = /^WinTaskTodo\.[0-9a-f]{15}$/;

// conhost --headless runs node with no window at all; a click on a card would
// otherwise flash a console on screen. %1 is the URI, passed as one argument
// that `task uri` checks against the few forms it allows.
export function uriCommand(deps) {
  const conhost = `${deps.systemRoot ?? 'C:\\Windows'}\\System32\\conhost.exe`;
  return `"${conhost}" --headless "${deps.nodePath}" "${deps.scriptPath}" uri "%1"`;
}

export function installKeys(deps) {
  return [
    { path: SCHEME_KEY, values: [{ name: '', value: `URL:${SCHEME}` }, { name: 'URL Protocol', value: '' }] },
    { path: COMMAND_KEY, values: [{ name: '', value: uriCommand(deps) }] },
  ];
}

export function installPlanLines(deps) {
  const lines = ['Write to the current user\'s registry (HKCU, no admin needed):'];
  for (const k of installKeys(deps)) {
    lines.push(`  HKCU\\${k.path}`);
    for (const v of k.values) lines.push(`    ${v.name || '(default)'} = ${v.value === '' ? '(empty)' : v.value}`);
  }
  lines.push(`After that, each task with a card gets its own key HKCU\\${AUMID_ROOT}\\WinTaskTodo.<id> (DisplayName is the task name) when its first card is posted.`);
  return lines;
}

export function uninstallPlanLines(ids) {
  return [
    'Delete from the registry (HKCU), together with their subkeys:',
    `  HKCU\\${SCHEME_KEY}`,
    ...ids.map((id) => `  HKCU\\${AUMID_ROOT}\\${id} (and its cards in the Notification Center)`),
  ];
}

// Registers and unregisters per-task IDs inside another script (the post
// script), so a refresh still costs one PowerShell call. Every ID is checked
// against the exact form again here, as a second line of defence.
export const APP_IDS_SNIPPET = `
$cu = [Microsoft.Win32.Registry]::CurrentUser
if ($p.register) { foreach ($a in @($p.register)) {
  if ([string]$a.id -notmatch '^WinTaskTodo\\.[0-9a-f]{15}$') { throw 'Invalid ID' }
  $k = $cu.CreateSubKey('${AUMID_ROOT}\\' + $a.id)
  $k.SetValue('DisplayName', [string]$a.name, [Microsoft.Win32.RegistryValueKind]::String)
  $k.Close()
} }
if ($p.unregister) { foreach ($id in @($p.unregister)) {
  if ([string]$id -notmatch '^WinTaskTodo\\.[0-9a-f]{15}$') { throw 'Invalid ID' }
  [Windows.UI.Notifications.ToastNotificationManager]::History.Clear([string]$id)
  $cu.DeleteSubKeyTree('${AUMID_ROOT}\\' + $id, $false)
} }
`;

const INSTALL_SCRIPT = `
$cu = [Microsoft.Win32.Registry]::CurrentUser
foreach ($k in @($p.keys)) {
  $key = $cu.CreateSubKey([string]$k.path)
  foreach ($v in @($k.values)) { $key.SetValue([string]$v.name, [string]$v.value, [Microsoft.Win32.RegistryValueKind]::String) }
  $key.Close()
}
'{"ok":true}'
`;

const LIST_SCRIPT = `
$cu = [Microsoft.Win32.Registry]::CurrentUser
$root = $cu.OpenSubKey('${AUMID_ROOT}')
$names = @(if ($root) { $root.GetSubKeyNames() | Where-Object { $_ -match '^WinTaskTodo(\\.[0-9a-f]{15})?$' } })
$scheme = [bool]$cu.OpenSubKey('${SCHEME_KEY}')
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ ids = $names; scheme = $scheme })
`;

const UNINSTALL_SCRIPT = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$cu = [Microsoft.Win32.Registry]::CurrentUser
foreach ($id in @($p.ids)) {
  if ([string]$id -notmatch '^WinTaskTodo(\\.[0-9a-f]{15})?$') { throw 'Invalid ID' }
  [Windows.UI.Notifications.ToastNotificationManager]::History.Clear([string]$id)
  $cu.DeleteSubKeyTree('${AUMID_ROOT}\\' + $id, $false)
}
$cu.DeleteSubKeyTree('${SCHEME_KEY}', $false)
'{"ok":true}'
`;

export async function writeKeys(run, deps) {
  await run(payload({ keys: installKeys(deps) }) + INSTALL_SCRIPT);
}

// The tool's IDs now in the registry, and whether the scheme is installed.
export async function listOwnKeys(run) {
  const r = parseJson(await run(LIST_SCRIPT)) ?? {};
  return { ids: [r.ids ?? []].flat().map(String).filter((id) => OWN_ID.test(id)), scheme: Boolean(r.scheme) };
}

export async function removeKeys(run, ids) {
  await run(payload({ ids: ids.filter((id) => OWN_ID.test(id)) }) + UNINSTALL_SCRIPT);
}

export const isRegistryScript = (script) => script.includes('[Microsoft.Win32.Registry]::CurrentUser') && !script.includes('$notifier');
