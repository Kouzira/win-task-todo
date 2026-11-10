// PowerShell scripts for the ScheduledTasks module and the JSON they return.
// Every function takes the runner as its first argument (see ps.mjs).
import { asArray, parseJson, payload } from './ps.mjs';

// Projected into plain objects inside PowerShell: serialising the raw CIM
// objects drags in whole class definitions and blows past any sane depth.
// The listing itself stays strict (a missing module must fail the refresh), but a
// task that cannot be read while it is being modified is skipped, not fatal.
const LIST_SCRIPT = `
$out = @(Get-ScheduledTask | ForEach-Object {
  $t = $_
  try { [pscustomobject]@{
    name = $t.TaskName
    path = $t.TaskPath
    state = [string]$t.State
    author = $t.Author
    description = $t.Description
    userId = $t.Principal.UserId
    runLevel = [string]$t.Principal.RunLevel
    logonType = [string]$t.Principal.LogonType
    actions = @($t.Actions | ForEach-Object {
      [pscustomobject]@{ execute = $_.Execute; arguments = $_.Arguments; workingDirectory = $_.WorkingDirectory }
    })
    triggers = @($t.Triggers | ForEach-Object {
      $r = $_
      [pscustomobject]@{
        type = ($r.CimClass.CimClassName -replace '^MSFT_Task','' -replace 'Trigger$','')
        enabled = $r.Enabled
        startBoundary = $r.StartBoundary
        endBoundary = $r.EndBoundary
        daysInterval = $r.DaysInterval
        weeksInterval = $r.WeeksInterval
        daysOfWeek = $r.DaysOfWeek
        userId = $r.UserId
        repetitionInterval = $r.Repetition.Interval
      }
    })
  } } catch { }
})
ConvertTo-Json -InputObject $out -Depth 6 -Compress
`;

const INFO_SCRIPT = `
$fmt = 'yyyy-MM-ddTHH:mm:ss'
$out = @($p.items | ForEach-Object {
  $i = $null
  try { $i = Get-ScheduledTaskInfo -TaskPath $_.path -TaskName $_.name -ErrorAction SilentlyContinue } catch { }
  [pscustomobject]@{
    path = $_.path
    name = $_.name
    lastRun = $(if ($i -and $i.LastRunTime) { $i.LastRunTime.ToString($fmt) } else { $null })
    nextRun = $(if ($i -and $i.NextRunTime) { $i.NextRunTime.ToString($fmt) } else { $null })
    lastResult = $(if ($i) { [int64]$i.LastTaskResult } else { $null })
  }
})
ConvertTo-Json -InputObject $out -Depth 4 -Compress
`;

const REGISTER_SCRIPT = `
$inv = [Globalization.CultureInfo]::InvariantCulture
$spec = @{ Execute = $p.execute }
if ($p.arguments) { $spec.Argument = $p.arguments }
if ($p.cwd) { $spec.WorkingDirectory = $p.cwd }
$action = New-ScheduledTaskAction @spec
if ($p.kind -eq 'daily') {
  $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($p.time, 'HH:mm', $inv))
} elseif ($p.kind -eq 'weekdays' -or $p.kind -eq 'weekly') {
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ([string[]]$p.days) -At ([datetime]::ParseExact($p.time, 'HH:mm', $inv))
} elseif ($p.kind -eq 'once') {
  $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::ParseExact($p.date + ' ' + $p.time, 'yyyy-MM-dd HH:mm', $inv))
} elseif ($p.kind -eq 'logon') {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $p.user
} else { throw 'Invalid schedule type' }
$principal = New-ScheduledTaskPrincipal -UserId $p.user -LogonType Interactive -RunLevel Limited
$extra = @{}
if ($p.noTimeLimit) { $extra.ExecutionTimeLimit = [TimeSpan]::Zero }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries @extra
Register-ScheduledTask -TaskName $p.name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $p.description | Out-Null
'{"ok":true}'
`;

const ACTIONS = {
  enable: 'Enable-ScheduledTask',
  disable: 'Disable-ScheduledTask',
  start: 'Start-ScheduledTask',
};

export async function fetchTasks(run) {
  const tasks = asArray(parseJson(await run(LIST_SCRIPT)));
  return tasks.map((t) => ({
    ...t,
    actions: asArray(t.actions),
    triggers: asArray(t.triggers),
  }));
}

export async function fetchInfo(run, tasks) {
  if (!tasks.length) return new Map();
  const items = tasks.map((t) => ({ path: t.path, name: t.name }));
  const rows = asArray(parseJson(await run(payload({ items }) + INFO_SCRIPT)));
  return new Map(rows.map((r) => [r.path + r.name, r]));
}

export const keyOf = (t) => t.path + t.name;

// spec.noTimeLimit lifts the scheduler's default limit of 72 hours, after
// which it would end a long-running task such as the watcher.
export async function registerTask(run, spec) {
  await run(payload(spec) + REGISTER_SCRIPT);
}

export async function taskAction(run, verb, task) {
  const cmd = ACTIONS[verb];
  await run(payload({ path: task.path, name: task.name }) + `${cmd} -TaskPath $p.path -TaskName $p.name | Out-Null`);
}

export async function unregisterTask(run, task) {
  await run(payload({ path: task.path, name: task.name })
    + 'Unregister-ScheduledTask -TaskPath $p.path -TaskName $p.name -Confirm:$false');
}
