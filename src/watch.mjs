// SPDX-License-Identifier: AGPL-3.0-only
// Targeted evidence for names someone looks up in the client by name (the lookups src/taut-usage.mjs finds in Taut). The inventories only
// know the shapes the miner extracts wholesale; Taut resolves names in more shapes than that, so for exactly these names we search every
// shape it can resolve, and keep which shapes matched and the defining module as "id:hash".
//   component        displayName="N" | function N( | class N | N=memo(...)/forwardRef(...)
//   thunk / byMeta   .meta={name:"N"...} | registered as ("N",N) | fetcher made as r("N","api.method")
//   byName           function N( | N=(...)=> | N=function | class N      (Taut matches a function export by its own name)
import crypto from 'node:crypto';
import { modules } from './extras.mjs';

const ID = '(?:^|[^\\w$.])';
const FORMS = {
  component: [['displayName', (n) => `\\.displayName="${n}"`], ['function', (n) => `function ${n}\\(`], ['class', (n) => `class ${n}\\b`], ['memo', (n) => `${ID}${n}=\\(0,[\\w$]+\\.(?:memo|forwardRef)\\)`]],
  redux: [['meta', (n) => `\\.meta=\\{name:"${n}"`], ['registered', (n) => `\\("${n}",${n}\\)`], ['fetcher', (n) => `\\)\\("${n}","[\\w.]+"\\)`]],
  fn: [['function', (n) => `function ${n}\\(`], ['arrow', (n) => `${ID}${n}=(?:async\\s*)?(?:\\([^)]{0,120}\\)|[\\w$]+)=>`], ['assigned', (n) => `${ID}${n}=function`], ['class', (n) => `class ${n}\\b`]],
  rtm: [['string', (n) => `"${n}"`]], // websocket event type: only the quoted string, weak but enough to notice one vanishing
};
const GROUP = { component: 'component', thunk: 'redux', byMeta: 'redux', byName: 'fn', rtm: 'rtm' };
const esc = (n) => n.replace(/[$.*+?^${}()|[\]\\]/g, '\\$&');

// watch: [{kind, name}]. Returns the shared map for the miner to keep filling chunk by chunk.
export const emptyPresence = () => new Map();
export function scanWatched(js, watch, into = emptyPresence()) {
  let mods = null;
  const moduleAt = (i) => {
    mods ??= modules(js);
    let lo = 0, hi = mods.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (mods[mid].start <= i) { best = mods[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best && i < best.start + best.src.length ? `${best.id}:${crypto.createHash('sha1').update(best.src).digest('hex').slice(0, 8)}` : null;
  };
  for (const { kind, name } of watch) {
    const group = GROUP[kind], base = name.match(/^[\w$]+\((.+)\)$/)?.[1] ?? name; // Serialized(Name): look for the wrapped name
    if (!group || !/^[\w$]+$/.test(base) || !js.includes(base)) continue;
    for (const [form, make] of FORMS[group]) {
      const m = new RegExp(make(esc(base))).exec(js);
      if (!m) continue;
      const e = into.get(`${kind}:${name}`) ?? { forms: new Set(), modules: new Set() };
      into.set(`${kind}:${name}`, e);
      e.forms.add(form);
      const mod = moduleAt(m.index + m[0].length - 1);
      if (mod) e.modules.add(mod);
    }
    // a thunk/byMeta name that is no longer registered may still exist as a plain function: remember that, it changes what the fix is
    if (group === 'redux') for (const [form, make] of FORMS.fn) {
      const m = new RegExp(make(esc(base))).exec(js);
      if (!m) continue;
      const e = into.get(`fn:${name}`) ?? { forms: new Set(), modules: new Set() };
      into.set(`fn:${name}`, e);
      e.forms.add(form);
      const mod = moduleAt(m.index + m[0].length - 1);
      if (mod) e.modules.add(mod);
    }
  }
  return into;
}

export function finishPresence(into, watch) {
  const found = {};
  for (const [k, v] of [...into].sort(([a], [b]) => a.localeCompare(b))) found[k] = { forms: [...v.forms].sort(), modules: [...v.modules].sort().slice(0, 3) };
  return { watched: [...new Set(watch.filter((w) => GROUP[w.kind]).map((w) => `${w.kind}:${w.name}`))].sort(), found };
}
