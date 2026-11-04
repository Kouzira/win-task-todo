// Finds a task by name: exact (case-insensitive) or a failure that lists the
// nearest names, so a typo never silently acts on a different task.

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim();

export function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function closest(name, tasks, limit = 5) {
  const q = norm(name);
  return tasks
    .map((t) => {
      const n = norm(t.name);
      const contains = n.includes(q) || q.includes(n);
      return { t, score: (contains ? 0 : 100) + levenshtein(q, n) };
    })
    .filter((x) => x.score < 100 || x.score <= 100 + Math.max(3, Math.floor(q.length / 2)))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.t);
}

// Returns { task } on an exact hit, { ambiguous } when the same name exists
// under several folders, or { missing: [nearest...] }.
export function findTask(name, tasks) {
  const q = norm(name);
  const hits = tasks.filter((t) => norm(t.name) === q);
  if (hits.length === 1) return { task: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return { missing: closest(name, tasks) };
}
