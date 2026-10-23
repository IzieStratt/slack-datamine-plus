// SPDX-License-Identifier: AGPL-3.0-only
// The client's front-end surface, for people who patch it (taut plugins and the like):
//   components  React components with a name:  `X.displayName="HuddleInviteJoinModal"`
//   redux       thunks, actions, selectors, fetchers, middleware and reducers, all registered as `x.meta={name,key,description}`
// Both are matched per webpack module so each entry can say which module defines it and carry a short hash of that module's code
// ("id:hash"). The hash only says "this module's code changed"; it changes for any edit in the module, so it is context, not an alarm.
import crypto from 'node:crypto';
import { modules } from './extras.mjs';

const DISPLAY = /\.displayName="([A-Za-z_$][\w$]{2,80})"/g;
const META = /\.meta=\{name:"(\w{2,80})",key:"(\w+)"(?:,description:"((?:[^"\\]|\\.)*)")?/g;
const KINDS = ['thunk', 'selector', 'action', 'fetcher', 'middleware', 'reducer'];
const kindOf = (key) => KINDS.find((k) => key.startsWith(`create${k[0].toUpperCase()}${k.slice(1)}`));
const hash = (src) => crypto.createHash('sha1').update(src).digest('hex').slice(0, 8);

export const emptyFrontend = () => ({ components: new Map(), redux: new Map() });

export function scanFrontend(js, into = emptyFrontend()) {
  for (const { id, src } of modules(js)) {
    if (!src.includes('.displayName="') && !src.includes('.meta={name:"')) continue;
    let h;
    const at = () => `${id}:${(h ??= hash(src))}`;
    for (const m of src.matchAll(DISPLAY)) {
      const set = into.components.get(m[1]) ?? new Set();
      into.components.set(m[1], set);
      set.add(at());
    }
    for (const m of src.matchAll(META)) {
      const kind = kindOf(m[2]);
      if (!kind) continue;
      const k = `${kind}:${m[1]}`;
      if (!into.redux.has(k)) into.redux.set(k, { key: m[2], description: m[3] ? m[3].replace(/\\(["\\])/g, '$1') : undefined, modules: new Set() });
      into.redux.get(k).modules.add(at());
    }
  }
  return into;
}

// plain objects for build/components.json and build/redux.json, plus the sorted lists the changes feed diffs
export function finishFrontend({ components, redux }) {
  const cmp = Object.fromEntries([...components].sort(([a], [b]) => a.localeCompare(b)).map(([n, set]) => [n, [...set].sort().slice(0, 3)]));
  const red = Object.fromEntries([...redux].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { key: v.key, ...(v.description ? { description: v.description } : {}), modules: [...v.modules].sort().slice(0, 3) }]));
  return { components: cmp, redux: red, componentNames: Object.keys(cmp), reduxNames: Object.keys(red) };
}
