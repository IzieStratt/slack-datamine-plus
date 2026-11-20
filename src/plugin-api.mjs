#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Versioned, typed copies of build/components.json and build/redux.json for plugin authors (taut plugins and the like), written to
// build/plugin-api/. The JSON Schemas and TypeScript types live in packages/slack-client-surface/ (prepared, not published).
//   node src/plugin-api.mjs [--build-dir build] [--out build/plugin-api]
// mine.mjs calls writePluginApi() after it writes components/redux. The files only change when the build does (they carry its number).
//
// SCHEMA_VERSION is the shape, not the data: bump it (and add a new schema file, keeping the old one) on any breaking change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
const KINDS = ['thunk', 'selector', 'action', 'fetcher', 'middleware', 'reducer'];
const MODULE = /^[^:\s]+:[0-9a-f]{8}$/;
const SCHEMA_DIR = fileURLToPath(new URL('../packages/slack-client-surface/schema/', import.meta.url));
const schemaRef = (outDir, kind) => (outDir ? path.relative(outDir, path.join(SCHEMA_DIR, `${kind}.v${SCHEMA_VERSION}.schema.json`)).split(path.sep).join('/') : undefined);

export function componentsDoc(components, meta, outDir) {
  const out = {};
  for (const [name, modules] of Object.entries(components)) out[name] = { modules: modules.filter((m) => MODULE.test(m)) };
  return { $schema: schemaRef(outDir, 'components'), schemaVersion: SCHEMA_VERSION, kind: 'components', build: meta.buildNumber ?? null, capturedDate: meta.capturedDate ?? null, count: Object.keys(out).length, components: out };
}

export function reduxDoc(redux, meta, outDir) {
  const out = {};
  for (const [id, v] of Object.entries(redux)) {
    const i = id.indexOf(':');
    const kind = id.slice(0, i), name = id.slice(i + 1);
    if (!KINDS.includes(kind)) continue;
    out[id] = { kind, name, key: v.key, ...(v.description ? { description: v.description } : {}), modules: (v.modules ?? []).filter((m) => MODULE.test(m)) };
  }
  return { $schema: schemaRef(outDir, 'redux'), schemaVersion: SCHEMA_VERSION, kind: 'redux', build: meta.buildNumber ?? null, capturedDate: meta.capturedDate ?? null, count: Object.keys(out).length, redux: out };
}

// envelope fields first, then one entry per line so a new component is a one-line diff
export function serialize(doc, key) {
  const { [key]: entries, ...head } = doc;
  const lines = Object.entries(entries).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${Object.entries(head).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n ${JSON.stringify(key)}: {\n${lines.join(',\n')}\n }\n}\n`;
}

// Returns the files written (unchanged files are left alone). Missing inputs write nothing: the previous files stay.
export function writePluginApi(buildDir = 'build', outDir = path.join(buildDir, 'plugin-api')) {
  const read = (f) => (fs.existsSync(path.join(buildDir, f)) ? JSON.parse(fs.readFileSync(path.join(buildDir, f), 'utf8')) : null);
  const meta = read('meta.json') ?? {};
  const written = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const [src, key, make] of [['components.json', 'components', componentsDoc], ['redux.json', 'redux', reduxDoc]]) {
    const data = read(src);
    if (!data) continue;
    const file = path.join(outDir, `${key}.v${SCHEMA_VERSION}.json`);
    const text = serialize(make(data, meta, path.resolve(outDir)), key);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
    fs.writeFileSync(file, text);
    written.push(file);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const buildDir = arg('--build-dir', 'build');
  const w = writePluginApi(buildDir, arg('--out', path.join(buildDir, 'plugin-api')));
  console.log(w.length ? `plugin-api: ${w.join(', ')}` : 'plugin-api: unchanged');
}
