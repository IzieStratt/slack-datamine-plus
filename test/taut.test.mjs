import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanTaut } from '../src/taut-usage.mjs';
import { candidates, checkTaut, renderReport, similarity } from '../src/taut-watch.mjs';

test('taut-usage: finds lookups by kind, handles generics and counts runtime-built names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taut-'));
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'A.tsx'), [
    "this.api.patchComponent<Props>('BaseAvatarStack', (O) => O)",
    "this.api.redux.patchThunk('markLastRead', f); this.api.redux.waitForThunkCreator('submitView'); x.dispatchThunk(\"enqueueToast\", {})",
    "this.api.byMeta('setLocalDraft'); this.api.byName('getInputProxy'); this.api.rtm.on('view_opened', h); this.api.experiments.set('reskin', 'off')",
    'this.api.patchComponent(name, f); this.api.byMeta(variable)',
  ].join('\n'));
  const r = scanTaut(dir);
  const got = r.uses.map((u) => `${u.kind}:${u.name}`).sort();
  assert.deepEqual(got, ['byMeta:setLocalDraft', 'byName:getInputProxy', 'component:BaseAvatarStack', 'experiment:reskin', 'rtm:view_opened', 'thunk:enqueueToast', 'thunk:markLastRead', 'thunk:submitView']);
  assert.equal(r.dynamic, 2);
  assert.equal(r.uses[0].file, path.join('plugins', 'A.tsx'));
});

test('taut-watch: similarity ranks renames and word reorders above unrelated names', () => {
  assert.ok(similarity('BaseAvatarStack', 'AvatarStackBase') > similarity('BaseAvatarStack', 'ChannelView'));
  assert.ok(similarity('chatDeleteFetcher', 'chatDeleteFetchers') > 0.6);
  const c = candidates('BaseAvatarStack', [{ name: 'AvatarStackBase' }, { name: 'ChannelView' }, { name: 'BaseAvatarStack' }]);
  assert.deepEqual(c.map((x) => x.name), ['AvatarStackBase']); // the name itself and unrelated ones are left out
});

const inv = { components: { AvatarStackBase: ['a:1'], Panel: ['p:1'] }, redux: { 'thunk:other': { key: 'k', description: 'does other', modules: ['o:1'] } }, experiments: { exp_a: ['on'] } };
const uses = [
  { kind: 'component', name: 'BaseAvatarStack', file: 'plugins/H.tsx', line: 3 },
  { kind: 'component', name: 'Panel', file: 'plugins/P.tsx', line: 9 },
  { kind: 'byMeta', name: 'getAll', file: 'plugins/E.tsx', line: 59 },
  { kind: 'rtm', name: 'view_opened', file: 'plugins/O.tsx', line: 1 },
  { kind: 'rtm', name: 'message', file: 'plugins/O.tsx', line: 2 },
  { kind: 'experiment', name: 'exp_gone', file: 'plugins/X.tsx', line: 4 },
  { kind: 'thunk', name: 'brandNew', file: 'plugins/N.tsx', line: 5 },
];
const presence = { watched: ['component:BaseAvatarStack', 'component:Panel', 'byMeta:getAll', 'rtm:view_opened', 'rtm:message'], found: { 'component:Panel': { forms: ['displayName'], modules: ['p:2'] }, 'rtm:message': { forms: ['string'], modules: [] }, 'fn:getAll': { forms: ['arrow'], modules: ['m:9'] } } };

test('taut-watch: missing, changed and unchecked are told apart', () => {
  const r = checkTaut(uses, { ...inv, presence }, { hashes: { 'component:Panel': ['p:1'] } });
  assert.deepEqual(r.missing.map((m) => `${m.kind}:${m.name}`).sort(), ['byMeta:getAll', 'component:BaseAvatarStack', 'experiment:exp_gone', 'rtm:view_opened']);
  assert.equal(r.missing.find((m) => m.name === 'BaseAvatarStack').candidates[0].name, 'AvatarStackBase');
  assert.ok(r.missing.find((m) => m.name === 'getAll').plain, 'a byMeta name that still exists as a plain function says so');
  assert.deepEqual(r.changed.map((c) => c.name), ['Panel']); // module hash p:1 -> p:2
  assert.deepEqual(r.unchecked.map((u) => u.name), ['brandNew']); // not in the miner's watch list yet: not judged
  assert.equal(r.checked, 6);
  const md = renderReport({ ...r, dynamic: 2, events: [{ build: 'b1', date: '2026-10-23', names: ['Panel'] }], build: 'b1' });
  assert.ok(md.includes('**BaseAvatarStack** (component)') && md.includes('`AvatarStackBase`') && md.includes('plain function') && md.includes('build `b1`'));
});

test('taut-watch: wrapped component names are looked up by what they wrap', () => {
  const p = { watched: ['component:Serialized(Panel)'], found: { 'component:Serialized(Panel)': { forms: ['displayName'], modules: ['p:1'] } } };
  const r = checkTaut([{ kind: 'component', name: 'Serialized(Panel)', file: 'a.ts', line: 1 }], { ...inv, presence: p }, {});
  assert.equal(r.missing.length, 0);
});
