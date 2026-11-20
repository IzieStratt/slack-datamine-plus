import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentsDoc, reduxDoc, serialize, writePluginApi } from '../src/plugin-api.mjs';

const schema = (k) => JSON.parse(fs.readFileSync(new URL(`../packages/slack-client-surface/schema/${k}.v1.schema.json`, import.meta.url), 'utf8'));

// the parts of the JSON Schema these files rely on (no validator dependency): required keys, consts, module and key patterns
function check(doc, k) {
  const s = schema(k);
  for (const r of s.required) assert.ok(r in doc, `missing ${r}`);
  assert.equal(doc.schemaVersion, s.properties.schemaVersion.const);
  assert.equal(doc.kind, s.properties.kind.const);
  assert.equal(doc.count, Object.keys(doc[k]).length);
  const entry = s.properties[k].additionalProperties;
  const mod = new RegExp(k === 'components' ? s.$defs.modules.items.pattern : entry.properties.modules.items.pattern);
  for (const [id, v] of Object.entries(doc[k])) {
    for (const r of entry.required) assert.ok(r in v, `${id}: missing ${r}`);
    for (const f of Object.keys(v)) assert.ok(f in entry.properties, `${id}: unexpected ${f}`);
    assert.ok(v.modules.every((m) => mod.test(m)), id);
    if (k === 'redux') { assert.match(id, new RegExp(s.properties.redux.propertyNames.pattern)); assert.equal(id, `${v.kind}:${v.name}`); }
  }
}

const components = { HuddleModal: ['Ab/1:0123abcd', 'zz:89abcdef'], Broken: ['no-hash'] };
const redux = { 'thunk:openModal': { key: 'createThunkOpenModal', description: 'Opens "a" modal', modules: ['x:00000000'] }, 'action:setX': { key: 'createActionSetX', modules: ['y:11111111'] }, 'weird:thing': { key: 'k', modules: [] } };
const meta = { buildNumber: 'c07ab895506f', capturedDate: '2026-11-15' };

test('plugin-api docs follow their schema and drop malformed entries', () => {
  const c = componentsDoc(components, meta), r = reduxDoc(redux, meta);
  check(c, 'components'); check(r, 'redux');
  assert.deepEqual(c.components.Broken.modules, []);
  assert.deepEqual(Object.keys(r.redux), ['thunk:openModal', 'action:setX']);
  assert.equal(r.redux['thunk:openModal'].description, 'Opens "a" modal');
  assert.deepEqual(JSON.parse(serialize(r, 'redux')), JSON.parse(JSON.stringify(r)), 'line-per-entry serialization is plain JSON');
});

test('writePluginApi writes once, then leaves unchanged files alone; $schema points at the package schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdmp-plugin-api-'));
  try {
    fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify(components));
    fs.writeFileSync(path.join(dir, 'redux.json'), JSON.stringify(redux));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    assert.equal(writePluginApi(dir).length, 2);
    assert.deepEqual(writePluginApi(dir), []);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-api/redux.v1.json'), 'utf8'));
    assert.ok(fs.existsSync(path.resolve(dir, 'plugin-api', doc.$schema)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the committed build/plugin-api files (when present) match their schema', () => {
  for (const k of ['components', 'redux']) {
    const f = new URL(`../build/plugin-api/${k}.v1.json`, import.meta.url);
    if (fs.existsSync(f)) check(JSON.parse(fs.readFileSync(f, 'utf8')), k);
  }
});
