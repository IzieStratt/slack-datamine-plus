// SPDX-License-Identifier: AGPL-3.0-only
// Text extractors for the native clients. Each returns Map<category, Set<string>>; categories become build/platforms/<p>/<category>.txt.
import { extractMethods } from '../lib.mjs';

const add = (m, c, v) => { if (v) (m.get(c) ?? m.set(c, new Set()).get(c)).add(v); };
const SLACK_HOST = /(?:^|\.)(?:slack|slack-edge|slackb|slack-gov|slack-edge-gov|slack-msgs|slack-imgs|slack-files|slackhq)\.com$/;
const URL_RE = /https?:\/\/([a-z0-9.-]+)(\/[A-Za-z0-9_\-./{}:%]*)?/g;
// trackers, ICU, analytics, and other ids that look like API names
const METHOD_JUNK = /^(google|app\.(start|lifecycle|version|vitals)|client\.flush)\b|\.(asar|unpacked)\b|\.(eu|mil|com|gov|net|org|io)$/;

function urls(text, m) {
  for (const u of text.matchAll(URL_RE)) {
    if (!SLACK_HOST.test(u[1])) continue;
    add(m, 'hosts', u[1]);
    add(m, 'urls', (u[0].replace(/[.:/]+$/, '')));
  }
}

function methods(text, m) {
  for (const x of extractMethods(text).known) if (!METHOD_JUNK.test(x)) add(m, 'api-methods', x);
}

// ---- desktop (Electron) ----
// main.bundle.cjs, the preloads and the small window bundles. Minified TypeScript, so enums and action types survive as literals.
export function desktopJs(js, m = new Map()) {
  methods(js, m);
  for (const x of js.matchAll(/\+\s*"([a-z][a-zA-Z]+\.[a-zA-Z][a-zA-Z0-9.]+)"/g)) if (!/\.(js|json|html|cjs|png|svg|mp3|css|asar|node)$/.test(x[1]) && !METHOD_JUNK.test(x[1])) add(m, 'api-methods', x[1]); // url + "desktop.features"
  for (const x of js.matchAll(/[\w$]\.([A-Z][A-Z0-9_]{2,})="\1"/g)) add(m, 'redux-actions', x[1]);
  for (const x of js.matchAll(/\[[\w$]+\.([A-Za-z][A-Za-z0-9_]*)=(-?\d+)\]="\1"/g)) add(m, 'enums', `${x[1]}=${x[2]}`);
  for (const x of js.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\["([A-Z][A-Z0-9_]+)"\])/g)) add(m, 'env-vars', x[1] ?? x[2]);
  for (const x of js.matchAll(/slack:\/\/[A-Za-z0-9_\-/]+/g)) add(m, 'deep-links', x[0]);
  for (const x of js.matchAll(/accelerator:"([^"]{1,40})"/g)) add(m, 'accelerators', x[1]);
  for (const x of js.matchAll(/ipc(?:Main|Renderer)\.(?:handle|handleOnce|on|once|invoke|send|sendSync)\("([^"]{2,80})"/g)) add(m, 'ipc-channels', x[1]);
  for (const x of js.matchAll(/exposeInMainWorld\("([^"]+)"/g)) add(m, 'window-globals', x[1]);
  for (const x of js.matchAll(/(?:appendSwitch|hasSwitch|getSwitchValue|removeSwitch)\("([a-z][a-z0-9-]+)"|"--([a-z][a-z0-9-]{2,40})(?:=[^"]*)?"/g)) add(m, 'cli-switches', x[1] ?? x[2]);
  urls(js, m);
  return m;
}

// dist/resources/locales/en/desktop_<area>_en_GB.json: { key: "text" } (sometimes nested)
export function desktopLocale(area, json, m = new Map()) {
  const walk = (o, pre) => { for (const [k, v] of Object.entries(o)) typeof v === 'object' && v ? walk(v, `${pre}${k}.`) : add(m, 'strings-en', `${pre}${k}=${String(v).replace(/\n/g, '\\n')}`); };
  walk(JSON.parse(json), `${area}.`);
  return m;
}

// ---- Android ----
// `strings` is every DEX string constant; `known` is the web client's experiment + feature-flag names (to see which ones Android reads).
export function androidDex(strings, known = new Set(), m = new Map()) {
  methods(strings.map((s) => JSON.stringify(s)).join('\n'), m);
  for (const s of strings) {
    if (/^android_[a-z0-9_]{3,}$/.test(s)) add(m, 'feature-flags', s);
    else if (known.has(s) && s.includes('_')) add(m, 'shared-flags', s);
    if (/^slack:\/\/[A-Za-z0-9_\-/?=&.]*$/.test(s)) add(m, 'deep-links', s.replace(/[?&]$/, ''));
    if (/^https?:\/\//.test(s) && s.length < 200) urls(s, m);
  }
  return m;
}

export function androidResources(res, m = new Map()) {
  for (const [k, v] of res) add(m, 'strings-en', `${k}=${v.replace(/\n/g, '\\n')}`);
  return m;
}
