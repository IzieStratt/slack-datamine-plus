// SPDX-License-Identifier: AGPL-3.0-only
// Richer diffs for the changes feed: likely renames (a value removed and a very similar one added in the same category on the same
// day) and API signature changes (the observed parameter set of a method that exists on both sides changed). Pure, so it can be tested.

// Levenshtein distance with an early exit once it cannot stay under `max`.
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// camelCase, snake_case, kebab-case and dotted names compare as the same words
const norm = (s) => s.toLowerCase().replace(/[-_.\s]+/g, '');

// 0..1, 1 = same once case and separators are ignored; 0 for anything below RENAME_MIN
export function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return 1;
  const len = Math.max(x.length, y.length);
  const max = Math.floor(len * (1 - RENAME_MIN));
  const d = editDistance(x, y, max);
  return d > max ? 0 : 1 - d / len; // past the cutoff the exact distance is unknown, and it no longer matters
}

export const RENAME_MIN = 0.85; // below this two names are just two names
const MIN_LEN = 6; // short values (`get`, `list`) are similar to too much
const MAX_PAIRS = 250_000; // added × removed above this is a mass change (a regenerated list); skip the comparison

// Pairs each removed value with its most similar added value (each used once, best pairs first). Values that stay paired are
// still in the caller's added/removed lists; this only says which ones look like the same thing under a new name.
export function detectRenames(added, removed, { min = RENAME_MIN } = {}) {
  if (!added.length || !removed.length || added.length * removed.length > MAX_PAIRS) return [];
  const pairs = [];
  for (const r of removed) {
    if (r.length < MIN_LEN) continue;
    for (const a of added) {
      if (a.length < MIN_LEN) continue;
      const s = similarity(r, a);
      if (s >= min) pairs.push({ from: r, to: a, score: s });
    }
  }
  pairs.sort((p, q) => q.score - p.score || p.from.localeCompare(q.from) || p.to.localeCompare(q.to));
  const usedFrom = new Set(), usedTo = new Set(), out = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
    usedFrom.add(p.from); usedTo.add(p.to);
    out.push({ from: p.from, to: p.to });
  }
  return out.sort((p, q) => p.from.localeCompare(q.from));
}

export const renameLine = ({ from, to }) => `${from} → ${to}`;

// build/api-args.txt lines are "method: a, b, c"
export function parseArgsLines(text) {
  const out = new Map();
  for (const l of (text ?? '').split('\n')) {
    const m = l.match(/^([^:\s]+): (.*)$/);
    if (m) out.set(m[1], new Set(m[2].split(', ').filter(Boolean)));
  }
  return out;
}

// Methods whose parameter set changed between two snapshots, from one or more [before, after] sources of method -> Set(param). A method only
// counts when both sides have a non-empty set in the same source: an empty set means "no call site found this build", not "no params".
// Returns sorted lines like "chat.postMessage: +thread_ts −as_user".
export function signatureChanges(sources) {
  const byMethod = new Map();
  for (const [before, after] of sources) {
    for (const [method, now] of after) {
      const was = before.get(method);
      if (!was || !was.size || !now.size) continue;
      const e = byMethod.get(method) ?? { plus: new Set(), minus: new Set() };
      for (const k of now) if (!was.has(k)) e.plus.add(k);
      for (const k of was) if (!now.has(k)) e.minus.add(k);
      byMethod.set(method, e);
    }
  }
  // a key that one source gained and another source lost is the two sources disagreeing, not a change
  return [...byMethod].map(([m, { plus, minus }]) => {
    const p = [...plus].filter((k) => !minus.has(k)).sort(), n = [...minus].filter((k) => !plus.has(k)).sort();
    return p.length || n.length ? `${m}: ${[...p.map((k) => `+${k}`), ...n.map((k) => `−${k}`)].join(' ')}` : null;
  }).filter(Boolean).sort();
}
