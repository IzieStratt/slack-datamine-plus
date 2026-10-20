// SPDX-License-Identifier: AGPL-3.0-only
// Observed request parameters. Slack's client defines API calls as "fetchers":
//   en=(0,S.r)("slackbotProjectsCreateFetcher","slackbot.projects.create")
// and the arguments appear where the fetcher variable is called: en({name:t,channel_id:n,...r}).
// This collects the object-literal keys passed at those call sites. Keys are REAL (seen in Slack's own code) but the set is
// partial: spread args (...r), computed keys, and values built elsewhere are not visible, and nothing says which are required.

const FETCHER_RE = /(?:^|[,;{}(\s])([A-Za-z_$][\w$]*)=\(0,[\w$.]+(?:\([^()]*\))?[\w$.]*\)\("([A-Za-z0-9_]+(?:Fetcher|Api|Request))","([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*){1,6})"/g;

// Index of the matching close brace for the open brace at `start`, skipping strings, templates and regex-ish noise.
function matchBrace(s, start) {
  let depth = 0, quote = null;
  for (let i = start; i < s.length && i < start + 4000; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (quote === '`' && ch === '$' && s[i + 1] === '{') { const j = matchBrace(s, i + 1); if (j < 0) return -1; i = j; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

// Top-level `key:value`, shorthand `key`, and quoted `"key":value` entries of an object literal body. Spread entries are skipped.
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, quote = null, start = 0;
  const flush = (end) => {
    const part = body.slice(start, end).trim();
    start = end + 1;
    if (!part || part.startsWith('...')) return;
    const m = part.match(/^(?:"([A-Za-z_][\w.-]*)"|'([A-Za-z_][\w.-]*)'|([A-Za-z_$][\w$]*))\s*(?::([\s\S]*))?$/);
    if (!m) return; // computed [k]: v, methods, etc.
    keys.push({ key: m[1] ?? m[2] ?? m[3], value: (m[4] ?? '').trim() });
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) flush(i);
  }
  flush(body.length);
  return keys;
}

// Very rough type hint from the value expression; 'unknown' unless the literal is obvious.
function typeHint(v) {
  if (/^(!0|!1|true|false)$/.test(v)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)$/.test(v)) return 'string';
  if (/^\[/.test(v)) return 'array';
  if (/^\{/.test(v)) return 'object';
  return 'unknown';
}

const IGNORE_KEYS = new Set(['token', 'cache', 'signal', 'abortSignal', 'meta', 'metadata']);

// Returns Map<method, Map<key, {sites:number, types:Set<string>}>>. A method with call sites but no keyed args maps to an empty Map.
export function extractParams(js) {
  const out = new Map();
  const vars = new Map(); // variable -> method (last definition wins within one chunk)
  for (const m of js.matchAll(FETCHER_RE)) vars.set(m[1], m[3]);
  for (const [v, method] of vars) {
    const keys = out.get(method) ?? new Map();
    out.set(method, keys);
    // only the dispatch form  d(fetcher({...}))  - bare  fetcher({...})  is usually a reused local name in another scope
    const call = new RegExp(`(?<![\\w$])[A-Za-z_$][\\w$]*\\(${v.replace(/\$/g, '\\$')}\\(\\{`, 'g');
    for (const c of js.matchAll(call)) {
      const open = c.index + c[0].length - 1;
      const close = matchBrace(js, open);
      if (close < 0) continue;
      for (const { key, value } of topLevelKeys(js.slice(open + 1, close))) {
        if (IGNORE_KEYS.has(key)) continue;
        const e = keys.get(key) ?? { sites: 0, types: new Set() };
        e.sites++; e.types.add(typeHint(value));
        keys.set(key, e);
      }
    }
  }
  return out;
}

// Fold one chunk's result into the running total.
export function mergeParams(total, part) {
  for (const [method, keys] of part) {
    const t = total.get(method) ?? new Map();
    total.set(method, t);
    for (const [k, e] of keys) {
      const x = t.get(k) ?? { sites: 0, types: new Set() };
      x.sites += e.sites; e.types.forEach((ty) => x.types.add(ty));
      t.set(k, x);
    }
  }
  return total;
}

// JSON-friendly: { key: { sites, type } } with a single type when all hints agree, else 'unknown'.
export function serializeParams(keys) {
  const out = {};
  for (const [k, e] of [...keys].sort((a, b) => b[1].sites - a[1].sites || a[0].localeCompare(b[0]))) {
    const known = [...e.types].filter((t) => t !== 'unknown');
    out[k] = { sites: e.sites, type: known.length === 1 && e.types.size === 1 ? known[0] : 'unknown' };
  }
  return out;
}
