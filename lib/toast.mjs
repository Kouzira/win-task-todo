// The toasts of the tool: one card per own task, each posted under that
// task's own AppUserModelID, and the question asked when a card is dismissed.
// Building the text and the XML is pure and tested; only postToasts and
// cardHistory start a process.
//
// Why a card is replaced by tag and not updated through data binding:
// NotificationData and ToastNotifier.Update do work from Windows PowerShell
// 5.1, but an update only changes bound text and only while the toast is still
// in the Notification Center, and it cannot switch a card between silent and
// popping up. So every post is a whole new toast with the card's Tag, which
// Windows treats as a replacement of that card, and SuppressPopup keeps a
// routine replacement silent.
import { createHash } from 'node:crypto';
import { APP_IDS_SNIPPET, APP_PREFIX, SCHEME } from './registry.mjs';
import { resultWords } from './results.mjs';
import { payload, parseJson } from './ps.mjs';

export { SCHEME };
export const OPEN_URI = `${SCHEME}:open`;
export const GROUP = 'today';
export const ASK_GROUP = 'ask';
export const TAG_PATTERN = /^c[0-9a-f]{15}$/;

// Every character with a meaning in XML text or attributes is replaced, and
// characters XML 1.0 cannot carry at all are dropped, so a task name can never
// close an element, open a new one or break LoadXml.
export function xmlEscape(text) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const sha = (text) => createHash('sha1').update(text).digest('hex');

// A tag per task from its folder and name, hashed so that any name fits the
// 16 characters older Windows builds allow and carries nothing but hex. The
// task's AppUserModelID is built from the same hash.
export const cardTag = (row) => `c${sha(`${row.path ?? '\\'}${row.name}`).slice(0, 15)}`;
export const appIdOf = (tag) => `${APP_PREFIX}${tag.slice(1)}`;
export const askTag = (tag) => `q${tag.slice(1)}`;
export const openUri = (tag) => `${OPEN_URI}/${tag}`;

// "code 0xC000013A" reads better inside "Failed at 09:27 (...)" than "Failed, code ...".
export function failureReason(code) {
  const words = resultWords(code);
  const m = /^Failed, (code .*)$/.exec(words) ?? /^Failed \((code .*)\)$/.exec(words);
  return m ? m[1] : lowerFirst(words);
}

// The skip status is the tool's own sentence ("Skipped 17:20, re-enabled at
// 17:21"), so reading the time back out of it is safe.
const backAt = (status) => /re-enabled at (\d{2}:\d{2})/.exec(String(status))?.[1];

// The status line of a card. It holds absolute times only: a toast's text is
// fixed between posts, so a countdown ("2 h left") would be wrong minutes
// later. `task ui` and `task list` redraw, so the countdown stays there.
export function cardText(row) {
  switch (row.kind) {
    case 'done': return `Done at ${row.at}`;
    case 'failed': return `Failed at ${row.at} (${failureReason(row.lastResult)})`;
    case 'pending': return `Runs today at ${row.at}`;
    case 'running': return `Running since ${row.at}`;
    case 'skipped': return backAt(row.status) ? `Skipped today, back on at ${backAt(row.status)}` : 'Skipped today';
    default: return null;
  }
}

// Own tasks that could have a card today. Off, nothing today, and the watcher
// itself never do; a skip whose run is on another day says " on <date>".
export const todayRows = (rows) => rows.filter((r) => !r.watcher && (
  ['done', 'failed', 'pending', 'running'].includes(r.kind) || (r.kind === 'skipped' && !/ on \d{4}-/.test(r.status))));

// A card is two lines, the task name as the bold title and the status under
// it, with no buttons and no header. The name repeats the small grey label
// Windows puts above the card; that is accepted, because the label alone is
// hard to read. A click on its body
// opens the list; Windows removes a clicked toast just as the X does, so the
// URI names the card and the handler records the click, and the card's
// disappearance is then not taken for a dismissal.
export function cardXml(row, text = cardText(row)) {
  return `<toast activationType="protocol" launch="${openUri(cardTag(row))}">`
    + `<visual><binding template="ToastGeneric"><text>${xmlEscape(row.name)}</text><text>${xmlEscape(text)}</text></binding></visual></toast>`;
}

export const cancelUri = (token) => `${SCHEME}:cancel-today/${token}`;
export const askLine = (at) => `Cancel today's run at ${at}?`;

// Posted under the task's own ID, so Windows names the task above it. [Keep]
// is the system dismiss action: it closes the question and never reaches the
// tool, so it needs no URI and cannot cancel anything.
export function askXml(name, at, token) {
  return `<toast activationType="protocol" launch="${OPEN_URI}"><visual><binding template="ToastGeneric"><text>${xmlEscape(name)}</text><text>${xmlEscape(askLine(at))}</text></binding></visual>`
    + `<actions><action content="Cancel today" activationType="protocol" arguments="${xmlEscape(cancelUri(token))}"/>`
    + '<action content="Keep" activationType="system" arguments="dismiss"/></actions></toast>';
}

const LOAD = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
if (-not (Test-Path 'HKCU:\\Software\\Classes\\${SCHEME}')) { '{"installed":false}'; return }
$manager = [Windows.UI.Notifications.ToastNotificationManager]
`;

// IDs are registered before anything is shown under them; removals and
// unregistrations come first, so a card taken out never lingers.
const POST_SCRIPT = `${LOAD}${APP_IDS_SNIPPET}
if ($p.remove) { foreach ($r in @($p.remove)) { $manager::History.Remove([string]$r.tag, [string]$p.group, [string]$r.app) } }
$settings = @{}
if ($p.toasts) {
  foreach ($t in @($p.toasts)) {
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($t.xml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $toast.Tag = $t.tag
    $toast.Group = $t.group
    $toast.SuppressPopup = [bool]$t.suppress
    if ($t.expires) { $toast.ExpirationTime = [DateTimeOffset]::Parse($t.expires, [Globalization.CultureInfo]::InvariantCulture) }
    $notifier = $manager::CreateToastNotifier([string]$t.app)
    $notifier.Show($toast)
    $settings[[string]$t.app] = [string]$notifier.Setting
  }
}
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ installed = $true; settings = [pscustomobject]$settings })
`;

// For each { app, tag } asked about: whether that card is still in the
// Notification Center, and whether its app may show notifications at all.
const HISTORY_SCRIPT = `${LOAD}
$tags = @()
$blocked = @()
foreach ($c in @($p.cards)) {
  if ([string]$manager::CreateToastNotifier([string]$c.app).Setting -ne 'Enabled') { $blocked += [string]$c.tag; continue }
  if (@($manager::History.GetHistory([string]$c.app) | Where-Object { $_.Tag -eq $c.tag -and $_.Group -eq $p.group }).Count) { $tags += [string]$c.tag }
}
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ installed = $true; tags = $tags; blocked = $blocked })
`;

// toasts: [{ xml, tag, group, app, suppress, expires? }]; remove: [{ tag, app }];
// register: [{ id, name }]; unregister: [id]. Returns { installed, settings }.
export async function postToasts(run, { toasts = [], remove = [], register = [], unregister = [] }) {
  const r = parseJson(await run(payload({ group: GROUP, toasts, remove, register, unregister }) + POST_SCRIPT));
  return r ?? { installed: false };
}

// cards: [{ app, tag }]. Returns { installed, tags, blocked }.
export async function cardHistory(run, cards) {
  const r = parseJson(await run(payload({ group: GROUP, cards }) + HISTORY_SCRIPT)) ?? { installed: false };
  return { ...r, tags: [r.tags ?? []].flat(), blocked: [r.blocked ?? []].flat() };
}

export const isPostScript = (script) => script.includes('$notifier.Show(');
export const isHistoryScript = (script) => script.includes('History.GetHistory(');
