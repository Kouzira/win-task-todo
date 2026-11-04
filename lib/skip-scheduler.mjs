// The one-time helper task that brings a skipped task back. It is a separate
// task on purpose: once it exists, Windows itself re-enables the skipped task
// even if this tool is closed, crashed or the machine was off at that minute.
import { createHash } from 'node:crypto';
import { payload } from './ps.mjs';

const HELPER_SCRIPT = `
$inv = [Globalization.CultureInfo]::InvariantCulture
$at = [datetime]::ParseExact($p.at, 'yyyy-MM-dd HH:mm', $inv)
$end = [datetime]::ParseExact($p.end, 'yyyy-MM-dd HH:mm', $inv)
$action = New-ScheduledTaskAction -Execute $p.execute -Argument $p.arguments
$trigger = New-ScheduledTaskTrigger -Once -At $at
$trigger.EndBoundary = $end.ToString('s')
$principal = New-ScheduledTaskPrincipal -UserId $p.user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $p.name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $p.description -Force | Out-Null
'{"ok":true}'
`;

// Task Scheduler accepts any name; only a very long one is a
// problem, and then a short hash keeps the name unique while the real task
// name stays readable in the description.
export function helperName(name) {
  const full = `task re-enable ${name}`;
  if (full.length <= 120) return full;
  return `task re-enable ${createHash('sha1').update(name).digest('hex').slice(0, 10)}`;
}

export async function registerHelper(run, spec) {
  await run(payload(spec) + HELPER_SCRIPT);
}
