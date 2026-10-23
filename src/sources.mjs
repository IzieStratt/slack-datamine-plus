// SPDX-License-Identifier: AGPL-3.0-only
// What is the client made of? A source inventory, so a new bundle, page asset or chunk family is noticed instead of silently never mined.
//   asset:<name>.<ext>   script/stylesheet a client page references, hash stripped (modern.vendor.min.js, application.min.css, ...)
//   family:<prefix>      leading word of the webpack chunk names (client, lottie, vendors, ...) once it has MIN_FAMILY chunks
// build/sources.txt holds the sorted ids; the difference to the previous run is what mine.mjs reports.
export const MIN_FAMILY = 5;

// every `<name>.<hex hash>.<ext>` in a page: found by hash first, then the name read backwards (fast on big inputs)
export function pageAssets(text) {
  const out = new Map();
  for (const m of text.matchAll(/\.([0-9a-f]{16,})\.((?:[a-z0-9]+\.)*(?:js|css))(?![A-Za-z0-9])/g)) {
    let i = m.index;
    while (i > 0 && /[A-Za-z0-9_.-]/.test(text[i - 1])) i--; // names may contain dots (modern.vendor, TS.web)
    while (text[i] === '.' || text[i] === '-') i++;
    const name = text.slice(i, m.index);
    if (!name || /^(https?|www)$/.test(name)) continue;
    out.set(`${name}.${m[1]}.${m[2]}`, { file: `${name}.${m[1]}.${m[2]}`, name, ext: m[2] });
  }
  return [...out.values()];
}

export function chunkFamilies(names) {
  const count = new Map();
  for (const n of names) { const f = n.split(/[-_.]/)[0]; if (f) count.set(f, (count.get(f) ?? 0) + 1); }
  return [...count].filter(([, c]) => c >= MIN_FAMILY).map(([f]) => f);
}

export function sourceIds({ pages = [], chunks = [] }) {
  const ids = new Set();
  for (const html of pages) for (const a of pageAssets(html)) ids.add(`asset:${a.name}.${a.ext}`);
  for (const f of chunkFamilies(chunks)) ids.add(`family:${f}`);
  return [...ids].sort();
}

export function diffSources(prev, cur) {
  const a = new Set(prev), b = new Set(cur);
  return { added: cur.filter((x) => !a.has(x)), removed: prev.filter((x) => !b.has(x)) };
}
