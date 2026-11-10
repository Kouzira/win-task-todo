# task

A small command line tool for reading and managing Windows Task Scheduler in plain English. There is no GUI, no menu and nothing to install beyond Node 22 and the PowerShell that ships with Windows.

By default only the owner's own tasks are shown (for example Daily backup, Nightly cleanup). Tasks from Microsoft, Adobe, AMD, Realtek, HP and other vendors are hidden unless `--all` is added. Result codes are turned into words, for example "Succeeded" or "Machine not ready (battery, network...)".

## Adding it to PATH

Run this once in PowerShell, then reopen the terminal window:

```powershell
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';D:\Projects\win-task-todo', 'User')
```

After that, type `task` anywhere (the command runs through `task.cmd` in this folder). Until PATH is set, use `node D:\Projects\win-task-todo\tasks.mjs`.

## Commands

| Command | What it does |
| :- | :- |
| `task` or `task list` | Table of own tasks: Name, Schedule, Next run, Last run, Result, State, sorted by next run |
| `task list --all` | Also system and vendor tasks (adds a Type column, a few seconds slower) |
| `task list --json` | The same data as JSON for scripts |
| `task list --project <label>` | Only the tasks with that project label (see "Project labels") |
| `task show <name>` | Details of one task: command, arguments, working directory, schedule in words, account, runs, result, path |
| `task add <name> <command> <schedule>` | Creates a task; always prints the plan and asks `Create this task? (y/N)`. Options: `--cwd <dir>`, `--log`, `--project <label>` |
| `task on <name>`, `task off <name>` | Turn on, turn off |
| `task run <name>` | Run now |
| `task delete <name>` | Delete; always asks `Delete this task? (y/N)` |
| `task skip <name>`, `task unskip <name>` | Skip the next run of a task and let it turn itself back on, or undo that |
| `task ui` | The day's task list, full screen, with commands typed after a `/` |
| `task log <name>` | Last run, result, and the tail of the task's log file, if a log folder is set (see "Task logs") |
| `task notify` | Posts or updates the card of every task that runs today in the Notification Center, once, then exits |
| `task watch` | The watcher that keeps the cards current, started at logon (`--install`, `--status`, `--stop`, `--uninstall`) |
| `task doctor` | Checks, read only, why a card may not show, and how to fix it (see "task doctor") |
| `task help [command]` | Short help, or the usage of one command |

Every command also accepts `--help` or `-h`, in any position (`task notify --help`, `task watch --install -h`). It prints the usage and does nothing else: no task is touched, no card is posted, nothing is installed.

After `add`, `on`, `off`, `delete`, `skip` and `unskip` succeed, the cards are refreshed at once (see "Cards after a change").

At every `(y/N)` question, type `y` to agree or `n` to cancel. Pressing Enter alone does not answer: the question keeps waiting, because in cmd an empty line sometimes arrives by itself and used to cancel the question.

Task names are case-insensitive but must match in full. A wrong name makes the command fail and list similar names.

Options: `--yes` skips the confirmation question, `--dry-run` (for `add` and `skip`) prints the plan and stops, `--all`, `--json`, `--help` / `-h`. Options with a value, written `--cwd D:\scripts` or `--cwd=D:\scripts`: `--cwd` and `--project` (for `add`; `--project` also for `list`). `--log` (for `add`) takes no value.

## Examples

```powershell
task add backup "D:\scripts\backup.ps1" "weekdays 18:00" --dry-run
task add reminder "echo hi" "mon,wed 09:30"
task show "Daily backup"
task off "Nightly cleanup"
```

A command that starts with `powershell` or `pwsh`, or ends with `.ps1`, runs with `-NoProfile -ExecutionPolicy Bypass`. Any other command runs as typed through `cmd.exe /c`.

After the plan and before the question, `add` checks the command and prints one `Warning:` line for each problem it finds: a shell variable left unfilled in the text (such as `C:\Folder$script`, where the shell that built the line never set `script`), or a full Windows path (`C:\Tools\app\run.mjs`) that does not exist. The warning is advice only: with `--yes` the task is still created, and `--dry-run` prints the warnings too, because the file may be about to be written. Paths that only receive output (after `>`, `>>` or `--log`), folders ending in a backslash, wildcards, and anything the checker cannot read with confidence are not reported.

```
Warning: The path C:\Tools\app\run.mjs does not exist. The task may fail when it runs.
```

Schedule forms (case-insensitive):

- `daily 10:00`
- `weekdays 10:00` (Monday to Friday)
- `mon,wed 09:30`
- `once 2026-11-05 10:00` (the date may also be written 05/11/2026)
- `at logon`

## Task logs

`task log <name>` always shows the last run and its result. To also show the end of a log file, tell the tool where the logs are, in one of two ways (the environment variable wins):

```powershell
[Environment]::SetEnvironmentVariable('TASK_LOG_DIR', 'D:\Scripts\logs', 'User')
```

or a file `%LOCALAPPDATA%\win-task-todo\config.json`:

```json
{ "logDir": "D:\\Scripts\\logs" }
```

Without either, `task log` says that no log folder is set and how to set one. A log is matched to a task by file name (`.log` or `.txt`, case-insensitive): the base name of the script the task runs (`backup.ps1` matches `backup.log`), or the task name with spaces written as hyphens (`Daily backup` matches `daily-backup.log`). The newest matching file wins. Only the end of the file is read.

## Working directory, logging and project labels for a new task

```powershell
task add backup "D:\scripts\backup.ps1" "weekdays 18:00" --cwd D:\scripts --log --project "Office tools"
```

**`--cwd <dir>`** sets the working directory the task starts in; without it `task show` prints "(default)". The folder must be a full path and must exist, otherwise the command stops before anything is created. The plan shows it on a `Working dir:` line.

**`--log`** makes the task write its output and its exit code to a log file that `task log` already reads: `<log folder>\<task name with spaces as hyphens>.log`, so the task "Daily backup" writes `Daily-backup.log`. The log folder is the one described in "Task logs" (`TASK_LOG_DIR`, then `config.json`); without one the command says how to set it and creates nothing. The plan shows the file on a `Log:` line.

To do this the scheduled action is not the command itself but `node run-logged.mjs`, a small runner in this folder. The task's real program and arguments are handed to it as two quoted arguments (`--exe` and `--args`), and it starts the program with exactly the argument string Task Scheduler would have used. Each run adds a line `=== 2026-11-04 10:00:00 ===`, then the program's output (standard output and error together), then `exit <code>`. The runner ends with the program's exit code, so the result shown by `task list` is the program's own. Before a run, a log larger than about 1 MB becomes `<name>.log.1` (one old file is kept), so the log stays near that size. The action holds the full paths of `node.exe` and of the runner, so if either is moved, add the task again. A task made without `--log` is exactly as before.

**`--project <label>`** is described next.

## Project labels

`task add --project <label>` keeps a label (one line, up to 60 characters) in the task's description, on a line `tasks-project:<label>` after the marker `Created by the tasks tool`. Tasks made before labels existed have no such line and still count as the tool's own.

- `task list --project <label>` shows only the tasks with that label (case-insensitive).
- `task list` adds a Project column only when at least one task has a label, so a list without labels looks as it always did. `task list --json` always has a `project` field (`null` when there is none).
- `task show <name>` prints a `Project` row.

## Cards after a change

The watcher sleeps up to 30 minutes between refreshes, so a change used to show on the cards only at its next wake-up. Now `add`, `on`, `off`, `delete`, `skip` and `unskip` refresh the cards themselves right after the change succeeded, with the same function as `task notify`, and print one line, `Cards updated.` Not after `--dry-run`, not when the question was answered no, and not after `run`. It is best effort: only when the notification part is installed (otherwise nothing is said), and if the refresh fails the command still succeeds and says that the watcher will update the cards later.

## task skip and task unskip

Windows has no way to skip one run, so the tool does it in two steps. Step one creates a one-time helper task named `task re-enable <name>`, scheduled one minute after the skipped run, which turns the task back on. Step two turns the task off. Because the helper lives in Task Scheduler, the task comes back even if the tool was closed or the machine was off at that minute (a machine that wakes late still catches up within a day). If creating the helper fails, nothing is turned off. Windows deletes the helper itself once it has expired, and it is hidden from the default list (`--all` shows it with the type "Helper").

`skip` prints the plan and asks `(y/N)`; `--yes` skips the question and `--dry-run` only prints the plan. It refuses a task that has no next run, is off, or is a system task. `unskip` turns the task on at once and deletes the helper task; with no helper task it says so and only turns the task on.

In the list, a skipped task has the state "Skipped 17:20, re-enabled at 17:21". If the re-enable time has passed and the task is still off, the state is "Off (not re-enabled yet)" so the owner knows to act.

```powershell
task skip "Report sync" --dry-run
task unskip "Report sync"
```

## task ui

A full terminal screen; closing it returns the terminal to how it was (also on Ctrl+C or an error). It must run in a real terminal; when output is redirected the command reports an error and exits with code 1.

The layout follows the Claude Code terminal. The top part is the list: a header "Schedule, <day> <date>", then one row per own task sorted by next run, with its state (Done, Failed, Waiting with the time left, Off, Skipped, No run today), time, name and schedule in words. The selected row is highlighted and the list scrolls when it is longer than the screen. The bottom part is a status line (the result or error of the last action), the input between two thin rules, and a line of key hints. The input always takes text: type a command starting with `/` and press Enter to run it. Typing never loses the selected row. The list refreshes every 60 seconds without clearing what is being typed, and redraws when the window is resized.

The old single-letter shortcuts (`a`, `d`, `s`, `u`, `r`, `l`, `g`, `q`, Space, `j`, `k`) are gone, because letters now go into the input. The commands below do the same work.

Typing `/` shows the command list right above the input with a short description (when there is not enough room it shows what fits and a line counting the rest); typing more letters filters it, up to six rows. While this list is open (the input starts with `/` and has no space yet), the arrow keys move the highlighted command instead of the selected task. Close the list with Esc, or type a space after the command name; the arrows then select tasks as usual.

| Key | What it does |
| :- | :- |
| Up, Down | Command list open: change the highlighted command (wrapping). Otherwise: select a task, also while typing |
| Enter | Command list open: run the highlighted command on the selected task. Empty input: details of the selected task (like `task show`). Other text: run the typed command |
| Tab | Fill the highlighted command into the input, then type a task name if needed |
| Backspace | Delete one character |
| Esc | Clear the input (closes the command list), close the detail panel, cancel a pending question |
| Ctrl+C | Quit at any time |

| Command | What it does |
| :- | :- |
| `/show` | Task details, like Enter |
| `/add` | Asks Name, Command, Schedule in turn on the input line, prints the plan like `task add`, then `y/N` |
| `/add <name> \| <command> \| <schedule>` | Goes straight to the plan, separated by ` \| ` (a vertical bar with a space on each side) |
| `/delete` | Delete, asks `y/N` |
| `/off`, `/on` | Turn off, turn on, asks `y/N` |
| `/run` | Run now, asks `y/N` |
| `/skip` | Skip the next run, prints the plan, then asks `y/N` |
| `/unskip` | Undo a skip, asks `y/N` |
| `/log` | Tail of the log file |
| `/refresh` or `/g` | Reload now |
| `/help` | List commands and keys |
| `/quit` or `/q` | Quit |

A command acts on the selected task unless a name follows (typed as it is, or in quotes; case-insensitive but it must match in full). An unknown command shows one line, "Unknown command: /xyz. Type /help.", and changes nothing. A write command shows its plan in the list area and turns the input into a question, for example `Delete this task? (y/N) ›`: press `y` (with or without Enter) to agree, any other key cancels with "Cancelled". Every write uses the very same functions as the command line, and the list reloads when it is done.

```powershell
task ui
```

Examples to type inside the screen:

```text
/delete
/off "Nightly cleanup"
/skip Report sync
/add reminder | echo hi | mon,wed 09:30
```

## task notify

Every own task has its own card in the Windows Notification Center. Each task is registered as its own "app" named after the task, because Windows 11 stacks the notifications of one app and shows only the newest one with a "+N notifications" line. This way every card is visible at once. A card has two lines: the task name as the bold title (Windows also shows a small grey label with the same name above it, and the repeat is accepted because the label alone is hard to read), and a status line:

```text
Report sync       Runs today at 17:20
Backup                Failed at 13:05 (code 0xC000013A)
Reminder              Skipped today, back on at 18:01
Nightly cleanup    Running since 09:27
```

The status line holds absolute times only. A toast's text is fixed between posts, so a countdown would be wrong a few minutes later. The countdown ("Waiting, 2 h 15 min left") stays in `task ui` and `task list`, which redraw.

### When a card appears and leaves

- A task with a run still to come today, running now, skipped today, or failed today has a card, posted silently (no banner, no sound). Each refresh replaces only that task's card, also silently.
- When a run ends, that task's card pops up as a banner with the default Windows notification sound:
  - "Done at 17:20": the card leaves the Notification Center by itself after about 90 seconds, long enough to see the banner. If the task has another run later in the day, the "Runs today at ..." card comes back silently afterwards.
  - "Failed at 17:20 (<result>)": the card stays until the owner closes it.
- There is one banner per run, even if the watcher restarts.
- When the watcher starts (at logon), a task already done today has no card; a task that already failed today has a "Failed" card, posted silently. No banner appears at logon.
- A task that is off, a task with no run today, helper tasks and the watcher have no card. The card of a task with nothing left today is removed by the tool.

Windows can still keep a card quiet or hide its banner: Do not disturb (Focus) mode, and the notification settings of each task. Check Settings > System > Notifications: turn Do not disturb off if it is on, then find the task name in the app list below and make sure notifications, "Show notification banners" and "Play a sound when a notification arrives" are all selected. `task notify` says which tasks Windows is blocking.

### Clicking a card

A card has no buttons. Clicking it (anywhere except Windows' own X button) opens `task ui` in a new Windows Terminal window, or a cmd window if Windows Terminal is not installed. Windows removes the clicked card from the Notification Center; the tool records the click and posts the card again silently, with no question. Stopping and turning off the watcher is only done from the command line (`task watch --stop`, `task watch --uninstall`) or in `task ui`.

### Installing

Install once, no admin needed:

```powershell
task notify --install
```

The command prints what it will write and asks `y/N` before writing the key `HKCU\Software\Classes\wintasktodo` with `shell\open\command` (so a click on a card can call the tool, run hidden through `conhost.exe --headless`). After that, each task is registered under a key `HKCU\Software\Classes\AppUserModelId\WinTaskTodo.<id>` (DisplayName is the task name) when its first card is posted; the key of a task that has been deleted from Task Scheduler is removed at the next refresh. `task notify --uninstall` lists, then deletes, the `wintasktodo` key and every `WinTaskTodo` or `WinTaskTodo.<id>` key under `AppUserModelId` (with their cards), nothing else. `--yes` skips the question.

### When a card is closed

Nothing is cancelled unless "Cancel today" is pressed. Clicking the X on a card, swiping it away or "Clear all" never cancels anything by itself, because the tool cannot tell those three apart. When the watcher sees that a card is gone (it checks each time it wakes and at least every five minutes), and the task still has a run today, it posts a separate question card for that task, with a banner. The title is the task name, the line under it is, for example, "Cancel today's run at 17:20?", and there are two buttons:

- "Cancel today": skips exactly that run of exactly that task, the way `task skip` does (helper task first, then turn off). Tomorrow the task runs as usual thanks to the helper task. The watcher is never cancelled.
- "Keep": closes the question and cancels nothing. Closing the question with its X, or doing nothing, also cancels nothing and leads to no further question.

A closed "Failed" card asks nothing, because there is nothing to cancel. A "Done" card leaves by itself, and a card the tool removes itself is never counted as closed. If "Clear all" removes many cards at once, every task with a run left today gets its own question. A closed card is not posted again until the end of the day, unless a run of that task ends.

Each "Cancel today" button carries a random one-time token (128 bits), tied to exactly one task and one run time, valid for 15 minutes; the question also disappears when the token expires, and an expired token is deleted. The token of one task cannot cancel another. A wrong, missing, expired or used token does nothing and is written to the log.

A safe way to try it: close the card of a task whose skipped run does not matter (or a test task made with `task add`), then press "Keep" to see the question without cancelling anything.

### The wintasktodo: URI

Any web page or document can launch a `wintasktodo:` URI, so the internal command `task uri` accepts exactly three forms: `wintasktodo:open`, `wintasktodo:open/<card tag>` (opens the list) and `wintasktodo:cancel-today/<token>` with a token exactly as described above. Everything else (parameters, paths, task names, odd characters) is ignored and written to `watch.log`. A web page that calls `open` can at most open the list and keep one question from being asked; it cancels, changes and reveals nothing.

## task watch

The watcher is a small hidden process: it posts the cards at the start, then sleeps until it is needed (one minute after the next run of a task today, every two minutes while a task is running, when a "Done" card has just left, at the start of a new day, or 30 minutes at most), and refreshes the cards. Between refreshes it does not read Task Scheduler; while cards exist, every five minutes it only asks Windows one question, whether the cards are still there (one PowerShell call of about 1.4 seconds).

```powershell
task watch --install     # create the task "win-task-todo watch" that runs at logon, and install the notification part too
task watch --status      # is the task there, is it on, is the watcher running, its pid and memory
task watch --stop        # stop the running watcher; it starts again at the next logon
task watch --uninstall   # stop the watcher, delete exactly that task, remove the notification part
task watch               # run the watcher right here in this window (Ctrl+C to stop)
```

`--install` prints the plan and asks `y/N`: one task named `win-task-todo watch`, run when the current account logs on, only when logged on, with limited rights, no run time limit, hidden through `conhost.exe --headless`, with the marker `tasks-watcher:win-task-todo` in the description so the tool recognises it; plus the keys of `task notify --install`. Windows ends the watcher when the machine shuts down or the user logs off.

Only one watcher runs at a time: the lock is `%LOCALAPPDATA%\win-task-todo\watch.pid`, and a second watcher reports that and exits. A lock left behind after a shutdown, or by a dead process, is recognised as stale and replaced. `--stop` places a stop file that the watcher notices at once; only if the watcher is hung and does not stop within ten seconds is the process ended.

In `task list` and `task ui`, the watcher task has the state "Watcher". `delete`, `off`, `on`, `run` and `skip` on it ask one more question that says plainly it is the watcher.

Stale cards: if the cards look out of date, read `watch.log` (the log below). A refresh that fails (Task Scheduler sometimes answers "One or more errors occurred" while a task is being changed) is logged with its message and the time of the next try, and the watcher retries after 30 seconds, then 60, then every 120 seconds until one succeeds, so a card is stale for about two minutes at most. One line, "refresh recovered after N failures", marks the end of such a run of errors.

Memory: the watcher is one Node process; measured on this machine on 4 November 2026 it used about 35 MB of working set when fresh and 38 MB after a few wake-ups. Between wake-ups it holds only a timer. Each refresh runs PowerShell a few times, about a second each, then exits.

The log is `%LOCALAPPDATA%\win-task-todo\watch.log`, at most about 1 MB; when full, the old file becomes `watch.log.1` (only one old file is kept). The state (which cards were posted, which runs were seen, which tasks have their own ID) is in `state.json` in the same folder.

## task doctor

`task doctor` explains why a card might not show. It is read only: it creates, changes and posts nothing (the registry is opened for reading, and Windows' toast history is only asked). It prints one line per check, marked `ok`, `info`, `WARN` or `FAIL`; a failing line has a `Fix:` line under it, and the last line is a verdict. The exit code is 1 when something failed, otherwise 0.

| Check | What a finding means |
| :- | :- |
| `task` on PATH | No `task.cmd` (or `task.exe`, `task.bat`) in a PATH folder: typing `task` fails. Cards do not need it. Warning. |
| Notification part | The `wintasktodo:` registry key is missing: no card can be posted. Fix: `task notify --install`. |
| Logon task | The task `win-task-todo watch` is missing or off: the watcher will not start at logon. |
| Watcher process | Not running, or `watch.pid` names a dead or foreign process (a stale lock, replaced by the next watcher). Fix: `task run "win-task-todo watch"`. |
| App ID per card | A task that should have a card today (not done, not off, not closed) has no `WinTaskTodo.<id>` key: Windows cannot show its card. Fix: `task notify`. |
| Windows notification settings | Read from `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<app id>`. A missing value means the Windows default, on. `Enabled=0` or `ShowInActionCenter=0` is a failure (the card cannot appear or stay in the Notification Center); `ShowBanner=0` is a warning (no banner, the card still appears there). `ToastEnabled=0` under `PushNotifications` means notifications are off for the whole account. Fix: Settings > System > Notifications. |
| Do not disturb / Focus | Not checked: Windows does not keep it where it can be read cheaply. The report names the setting to look at. |
| Toast history | Asks Windows whether it holds the card of each task that should have one. A card that was posted and is gone was closed or cleared (`task notify` posts it again); a card never posted needs `task notify`; a task Windows blocks is a failure. |
| Task commands | Reads the program and arguments of each of your own tasks (as `task show` does; the watcher, helper and system tasks are skipped) and reports a missing path or an unfilled variable, with the same rules as the warning in `task add`. One warning per task, with a `Fix:` line: delete the task and add it again with the right path. When none has a problem, one `ok` line. Nothing is changed. |
| Last refresh | The age of `state.json`, which every refresh writes. Beyond 35 minutes with a live watcher is a warning, because the watcher sleeps 30 minutes at most. A failed refresh still last in `watch.log` is a warning too. |

A routine card is posted silently: it sits in the Notification Center (Win+N) and gives no banner and no sound. Only the card of a run that has just ended pops up. If every line is `ok` and a card still seems missing, look in the Notification Center before looking for a banner.

## Safety

- It never runs with admin rights. A new task always belongs to the current account, runs only when logged on, with limited rights.
- System and vendor tasks (the `\Microsoft\` folder and tasks that are not the owner's) are protected: `on`, `off`, `run`, `delete` refuse them unless `--all` is added.
- How tasks are classified: a task that is not under `\Microsoft\` and has a command pointing to drive D: or the user folder, or was created by this tool, or has an author or account matching the user while the program is not in Program Files or Windows. The rules are in `lib/classify.mjs`.
- `add` refuses a name that already exists. `delete` always asks first.
- The registry is only written under HKCU: the `wintasktodo` key at `--install`, and one `WinTaskTodo.<id>` key for each task that has a card.
- The tests use a fake PowerShell with sample data; no test creates, changes, runs, turns off or deletes a real task, writes the registry or posts a notification. Run the tests with `node --test test/*.test.mjs`.

## License

MIT, see the file `LICENSE`.
