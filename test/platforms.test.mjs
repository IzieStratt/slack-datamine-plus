// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipEntries, zipRead, asarFiles, arMembers, tarFiles } from '../src/platforms/containers.mjs';
import { dexStrings, stringPool } from '../src/platforms/android.mjs';
import { desktopJs, desktopLocale, androidDex } from '../src/platforms/extract.mjs';
import { bplist, xmlPlist, stringsFile, ipaCategories } from '../src/platforms/ios.mjs';
import { parseNotes } from '../src/platforms/notes.mjs';

// minimal zip writer: one deflated and one stored entry
function zip(files) {
  const locals = [], cds = []; let off = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? zlib.deflateRawSync(data) : data, n = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, n, body); cds.push(c, n); off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(cds), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('zip: reads stored and deflated entries', () => {
  const z = zip([['a.txt', Buffer.from('hello'), false], ['dir/b.txt', Buffer.from('world'.repeat(50)), true]]);
  const e = zipEntries(z);
  assert.equal(zipRead(z, e.get('a.txt')).toString(), 'hello');
  assert.equal(zipRead(z, e.get('dir/b.txt')).toString(), 'world'.repeat(50));
});

test('asar: walks the header and slices files', () => {
  const a = Buffer.from('AAA'), b = Buffer.from('{"x":1}');
  const header = Buffer.from(JSON.stringify({ files: { dist: { files: { 'main.bundle.cjs': { size: 3, offset: '0' } } }, 'package.json': { size: b.length, offset: '3' }, 'x.node': { size: 1, unpacked: true } } }));
  const pad = (4 - (header.length % 4)) % 4;
  const pre = Buffer.alloc(16); pre.writeUInt32LE(4, 0); pre.writeUInt32LE(header.length + pad + 8, 4); pre.writeUInt32LE(header.length + pad + 4, 8); pre.writeUInt32LE(header.length, 12);
  const f = asarFiles(Buffer.concat([pre, header, Buffer.alloc(pad), a, b]));
  assert.deepEqual([...f.keys()], ['dist/main.bundle.cjs', 'package.json']);
  assert.equal(f.get('package.json').toString(), '{"x":1}');
});

test('ar + tar: finds a member file', () => {
  const body = Buffer.from('data'), hdr = Buffer.alloc(512);
  hdr.write('./usr/lib/x', 0); hdr.write('0000004', 124); hdr.write('0', 156);
  const tar = Buffer.concat([hdr, body, Buffer.alloc(508), Buffer.alloc(1024)]);
  const arh = Buffer.from('data.tar        ' + ' '.repeat(32) + String(tar.length).padEnd(10) + '`\n');
  const ar = Buffer.concat([Buffer.from('!<arch>\n'), arh, tar]);
  const m = arMembers(ar);
  assert.equal(tarFiles(m.get('data.tar')).get('usr/lib/x').toString(), 'data');
});

test('dex: reads the string pool', () => {
  const strs = ['android_new_composer', 'chat.postMessage', 'slack://open'];
  const data = Buffer.concat(strs.map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s), Buffer.from([0])])));
  const h = Buffer.alloc(0x70); h.write('dex\n035\0', 0, 'latin1'); h.writeUInt32LE(strs.length, 0x38); h.writeUInt32LE(0x70, 0x3c);
  const ids = Buffer.alloc(strs.length * 4); let p = 0x70 + ids.length;
  strs.forEach((s, i) => { ids.writeUInt32LE(p, i * 4); p += s.length + 2; });
  assert.deepEqual(dexStrings(Buffer.concat([h, ids, data])), strs);
});

test('resource string pool: utf8 and utf16', () => {
  for (const utf8 of [true, false]) {
    const strs = ['Send', 'Huddle'];
    const enc = strs.map((s) => (utf8 ? Buffer.from([s.length, s.length, ...Buffer.from(s), 0]) : Buffer.concat([Buffer.from([s.length, 0]), Buffer.from(s, 'utf16le'), Buffer.alloc(2)])));
    const h = Buffer.alloc(28 + strs.length * 4);
    h.writeUInt16LE(1, 0); h.writeUInt32LE(strs.length, 8); h.writeUInt32LE(utf8 ? 0x100 : 0, 16); h.writeUInt32LE(h.length, 20);
    let o = 0; enc.forEach((b, i) => { h.writeUInt32LE(o, 28 + i * 4); o += b.length; });
    assert.deepEqual(stringPool(Buffer.concat([h, ...enc]), 0), strs);
  }
});

test('desktop extractors', () => {
  const js = 'A.SET_THEME="SET_THEME",q[q.MACOS_ELECTRON=4]="MACOS_ELECTRON";o6({url:e+"desktop.features"});process.env.SLACK_DEBUG_LEVEL;"slack://open";{accelerator:"Command+K"};contextBridge.exposeInMainWorld("desktop",x);app.commandLine.appendSwitch("enable-features");"https://app.slack.com/x"';
  const m = desktopJs(js);
  assert.ok(m.get('redux-actions').has('SET_THEME'));
  assert.ok(m.get('enums').has('MACOS_ELECTRON=4'));
  assert.ok(m.get('api-methods').has('desktop.features'));
  assert.ok(m.get('env-vars').has('SLACK_DEBUG_LEVEL'));
  assert.ok(m.get('deep-links').has('slack://open'));
  assert.ok(m.get('accelerators').has('Command+K'));
  assert.ok(m.get('window-globals').has('desktop'));
  assert.ok(m.get('cli-switches').has('enable-features'));
  assert.ok(m.get('hosts').has('app.slack.com'));
  assert.ok(desktopLocale('menu', '{"a":{"b":"Quit"}}').get('strings-en').has('menu.a.b=Quit'));
});

test('android extractor: flags, shared flags, methods', () => {
  const m = androidDex(['android_new_composer', 'chat.postMessage', 'google.c.a.e', 'huddle_jukebox', 'access'], new Set(['huddle_jukebox', 'access']));
  assert.ok(m.get('feature-flags').has('android_new_composer'));
  assert.deepEqual([...m.get('shared-flags')], ['huddle_jukebox']);
  assert.ok(m.get('api-methods').has('chat.postMessage'));
  assert.ok(!m.get('api-methods').has('google.c.a.e'));
});

// bplist00 with { CFBundleIdentifier: "com.x", n: 5, ok: true, l: ["a"] }
function makeBplist() {
  const objs = [];
  const str = (s) => Buffer.concat([Buffer.from([0x50 | s.length]), Buffer.from(s, 'latin1')]);
  objs.push(Buffer.from([0xd4, 1, 2, 3, 4, 5, 6, 7, 8]));
  objs.push(str('CFBundleIdentifier'.slice(0, 14)).length && Buffer.concat([Buffer.from([0x5f, 0x10, 18]), Buffer.from('CFBundleIdentifier')]));
  objs.push(str('n'), str('ok'), str('l'), str('com.x'), Buffer.from([0x10, 5]), Buffer.from([0x09]), Buffer.from([0xa1, 9]));
  objs.push(str('a'));
  const head = Buffer.from('bplist00'); let off = 8; const offs = [];
  for (const o of objs) { offs.push(off); off += o.length; }
  const t = Buffer.alloc(32); t[6] = 1; t[7] = 1; t.writeBigUInt64BE(BigInt(objs.length), 8); t.writeBigUInt64BE(0n, 16); t.writeBigUInt64BE(BigInt(off), 24);
  return Buffer.concat([head, ...objs, Buffer.from(offs), t]);
}

test('plists and .strings', () => {
  assert.deepEqual(bplist(makeBplist()), { CFBundleIdentifier: 'com.x', n: 5, ok: true, l: ['a'] });
  assert.deepEqual(xmlPlist('<plist><dict><key>A</key><string>b &amp; c</string><key>T</key><true/><key>L</key><array><string>x</string></array></dict></plist>'), { A: 'b & c', T: true, L: ['x'] });
  const s = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"hi" = "Hello \\"you\\"";\n', 'utf16le')]);
  assert.deepEqual(stringsFile(s), [['hi', 'Hello "you"']]);
});

test('ipa categories from Info.plist and strings', () => {
  const info = '<plist><dict><key>CFBundleIdentifier</key><string>com.tinyspeck.chatlyio</string><key>CFBundleShortVersionString</key><string>26.11.20</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>slack</string></array></dict></array><key>NSCameraUsageDescription</key><string>Take photos</string></dict></plist>';
  const files = new Map([
    ['Payload/Slack.app/Info.plist', () => Buffer.from(info)],
    ['Payload/Slack.app/en.lproj/Localizable.strings', () => Buffer.from('"send" = "Send";')],
    ['Payload/Slack.app/Watch/SlackWatch.app/Info.plist', () => Buffer.from('<plist><dict><key>CFBundleIdentifier</key><string>com.x.watch</string><key>CFBundleShortVersionString</key><string>1</string></dict></plist>')],
  ]);
  const { meta, categories } = ipaCategories(files);
  assert.equal(meta.version, '26.11.20');
  assert.ok(categories.get('url-schemes').has('slack'));
  assert.ok(categories.get('permission-prompts').has('NSCameraUsageDescription=Take photos'));
  assert.ok(categories.get('strings-en').has('Localizable.send=Send'));
  assert.ok(categories.get('watch-app').has('com.x.watch@1'));
});

test('release notes rss', () => {
  const xml = '<rss><channel><item><title>Slack 26.11.20 (11/11/26)</title><content:encoded><![CDATA[<h3>Bug Fixes</h3><ul><li>Fixed  the <b>thing</b> &amp; more.</li></ul>]]></content:encoded></item></channel></rss>';
  assert.deepEqual(parseNotes(xml), ['26.11.20 (11/11/26) · Bug Fixes: Fixed the thing & more.']);
});
