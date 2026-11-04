// Words for Task Scheduler's LastTaskResult. Sources: the SCHED_S_* and
// SCHED_E_* constants in Microsoft's taskschd.h / winerror.h ("Task Scheduler
// Error and Success Constants"). The API returns the value as an unsigned
// 32-bit number in some places and as a signed one in others (-1225786 and
// 4293741510 are the same code), so everything is folded to unsigned first.

const WORDS = new Map([
  [0x0, 'Succeeded'],
  [0x41300, 'Ready'], // SCHED_S_TASK_READY (267008)
  [0x41301, 'Running'], // SCHED_S_TASK_RUNNING (267009)
  [0x41302, 'Disabled'], // SCHED_S_TASK_DISABLED
  [0x41303, 'Never run'], // SCHED_S_TASK_HAS_NOT_RUN (267011)
  [0x41304, 'No trigger'], // SCHED_S_TASK_NO_VALID_TRIGGERS
  [0x41306, 'Stopped'], // SCHED_S_TASK_TERMINATED
  [0x8004131f, 'Already running'], // SCHED_E_ALREADY_RUNNING
  [0x800710e0, 'Machine not ready (battery, network...)'], // ERROR_REQUEST_REFUSED, returned when battery or network conditions block the run
]);

export function toUnsigned(code) {
  if (code === null || code === undefined || code === '') return null;
  const n = typeof code === 'number' ? code : Number(code);
  if (!Number.isFinite(n)) return null;
  return n >>> 0;
}

export function hex(code) {
  return '0x' + toUnsigned(code).toString(16).toUpperCase().padStart(8, '0');
}

export function resultWords(code) {
  const u = toUnsigned(code);
  if (u === null) return 'Unknown';
  if (WORDS.has(u)) return WORDS.get(u);
  if (u === 1) return 'Failed (code 1)';
  return `Failed, code ${hex(u)}`;
}
