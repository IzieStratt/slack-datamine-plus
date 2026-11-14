// SPDX-License-Identifier: AGPL-3.0-only
// iOS / watchOS. App Store binaries are FairPlay-encrypted (the Mach-O code is unreadable without a device), but an IPA's resources are
// not: Info.plist, every <lang>.lproj/*.strings, and an embedded Watch/ app if one exists. This reads those. Pure functions on Buffers.

// ---- binary plist (bplist00) ----
export function bplist(buf) {
  if (buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('bplist: bad magic');
  const t = buf.length - 32;
  const offSize = buf[t + 6], refSize = buf[t + 7];
  const num = Number(buf.readBigUInt64BE(t + 8)), top = Number(buf.readBigUInt64BE(t + 16)), table = Number(buf.readBigUInt64BE(t + 24));
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[p + i]; return v; };
  const offsets = Array.from({ length: num }, (_, i) => uint(table + i * offSize, offSize));
  const seen = new Set();
  const obj = (i) => {
    if (seen.has(i)) throw new Error('bplist: cycle');
    let p = offsets[i]; const m = buf[p++], hi = m >> 4;
    let len = m & 0xf;
    const ext = () => { if (len === 0xf) { const n = 1 << (buf[p] & 0xf); len = uint(p + 1, n); p += 1 + n; } };
    switch (hi) {
      case 0x0: return m === 0x09 ? true : m === 0x08 ? false : null;
      case 0x1: { const n = 1 << len; return n === 8 ? Number(buf.readBigInt64BE(p)) : uint(p, n); }
      case 0x2: return len === 3 ? buf.readDoubleBE(p) : buf.readFloatBE(p);
      case 0x3: return new Date((buf.readDoubleBE(p) + 978307200) * 1000).toISOString();
      case 0x4: ext(); return buf.subarray(p, p + len);
      case 0x5: ext(); return buf.toString('latin1', p, p + len);
      case 0x6: { ext(); const b = Buffer.from(buf.subarray(p, p + len * 2)); b.swap16(); return b.toString('utf16le'); }
      case 0x8: return uint(p, len + 1);
      case 0xa: { ext(); seen.add(i); const a = Array.from({ length: len }, (_, k) => obj(uint(p + k * refSize, refSize))); seen.delete(i); return a; }
      case 0xd: {
        ext(); seen.add(i); const o = {};
        for (let k = 0; k < len; k++) o[obj(uint(p + k * refSize, refSize))] = obj(uint(p + (len + k) * refSize, refSize));
        seen.delete(i); return o;
      }
      default: return null;
    }
  };
  return obj(top);
}

// XML plist, the subset Info.plist uses
export function xmlPlist(text) {
  const toks = [...text.matchAll(/<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\s*\/)?>([^<]*)/g)];
  let i = 0;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const val = () => {
    const [, close, tag, selfClose, body] = toks[i++];
    if (close) return undefined;
    if (tag === 'true' || tag === 'false') { if (!selfClose) i++; return tag === 'true'; }
    if (selfClose) return tag === 'dict' ? {} : tag === 'array' ? [] : tag === 'integer' || tag === 'real' ? 0 : '';
    if (tag === 'dict') { const o = {}; while (toks[i] && !(toks[i][1] && toks[i][2] === 'dict')) { const k = unesc(toks[i++][4]); i++; o[k] = val(); } i++; return o; }
    if (tag === 'array') { const a = []; while (toks[i] && !(toks[i][1] && toks[i][2] === 'array')) a.push(val()); i++; return a; }
    i++; // closing tag
    return tag === 'integer' || tag === 'real' ? Number(body) : unesc(body.trim());
  };
  const start = toks.findIndex((t) => !t[1] && (t[2] === 'dict' || t[2] === 'array'));
  i = start; return val();
}

export const plist = (buf) => (buf.toString('latin1', 0, 6) === 'bplist' ? bplist(buf) : xmlPlist(buf.toString('utf8')));

// .strings: a bplist dict when compiled, otherwise `"key" = "value";` text (UTF-16 with BOM, or UTF-8)
export function stringsFile(buf) {
  if (buf.toString('latin1', 0, 6) === 'bplist') return Object.entries(bplist(buf)).filter(([, v]) => typeof v === 'string');
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2) : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le') : buf.toString('utf8');
  const out = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) out.push([m[1].replace(/\\"/g, '"'), m[2].replace(/\\"/g, '"')]);
  return out;
}

// Mach-O LC_ENCRYPTION_INFO(_64): is this binary still FairPlay-encrypted (cryptid != 0)? Fat binaries: first slice.
export function machoEncrypted(buf) {
  let p = 0;
  if (buf.readUInt32BE(0) === 0xcafebabe) p = buf.readUInt32BE(8 + 8);
  const magic = buf.readUInt32LE(p);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) return null;
  const ncmds = buf.readUInt32LE(p + 16);
  let c = p + (magic === 0xfeedfacf ? 32 : 28);
  for (let k = 0; k < ncmds; k++) {
    const cmd = buf.readUInt32LE(c), size = buf.readUInt32LE(c + 4);
    if (cmd === 0x21 || cmd === 0x2c) return buf.readUInt32LE(c + 16) !== 0;
    c += size;
  }
  return false;
}

// From the IPA's file map (name -> () => Buffer): categories for build/platforms/ios/.
export function ipaCategories(files) {
  const m = new Map(), add = (c, v) => (m.get(c) ?? m.set(c, new Set()).get(c)).add(v);
  const names = [...files.keys()];
  const app = names.map((n) => n.match(/^Payload\/([^/]+\.app)\/Info\.plist$/)?.[1]).find(Boolean);
  if (!app) throw new Error('ipa: no Payload/*.app/Info.plist');
  const root = `Payload/${app}/`;
  const info = plist(files.get(`${root}Info.plist`)());
  const meta = { bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, build: info.CFBundleVersion, minimumOS: info.MinimumOSVersion };
  for (const t of info.CFBundleURLTypes ?? []) for (const s of t.CFBundleURLSchemes ?? []) add('url-schemes', s);
  for (const k of Object.keys(info)) if (/UsageDescription$/.test(k)) add('permission-prompts', `${k}=${info[k]}`);
  for (const k of info.UIBackgroundModes ?? []) add('background-modes', k);
  for (const k of info.NSUserActivityTypes ?? []) add('activity-types', k);
  for (const k of info.BGTaskSchedulerPermittedIdentifiers ?? []) add('background-tasks', k);
  for (const k of info.LSApplicationQueriesSchemes ?? []) add('queried-schemes', k);
  for (const k of info.UIApplicationShortcutItems ?? []) add('home-screen-shortcuts', k.UIApplicationShortcutItemType);
  for (const n of names) {
    if (!n.startsWith(root)) continue;
    const rel = n.slice(root.length);
    const ext = rel.match(/^(PlugIns|Extensions)\/([^/]+)\.appex\/Info\.plist$/);
    if (ext) { const p = plist(files.get(n)()); add('extensions', `${p.CFBundleIdentifier} (${p.NSExtension?.NSExtensionPointIdentifier ?? p.EXAppExtensionAttributes?.EXExtensionPointIdentifier ?? '?'})`); }
    const fw = rel.match(/^Frameworks\/([^/]+)\.framework\/Info\.plist$/);
    if (fw) { const p = plist(files.get(n)()); add('frameworks', `${fw[1]}@${p.CFBundleShortVersionString ?? '?'}`); }
    if (/^Watch\/[^/]+\.app\/Info\.plist$/.test(rel)) { const p = plist(files.get(n)()); add('watch-app', `${p.CFBundleIdentifier}@${p.CFBundleShortVersionString}`); }
    const loc = rel.match(/^(?:.*\/)?(?:en|Base)\.lproj\/([^/]+)\.strings$/);
    if (loc && !rel.includes('.framework/')) for (const [k, v] of stringsFile(files.get(n)())) add('strings-en', `${loc[1]}.${k}=${v.replace(/\n/g, '\\n')}`);
  }
  return { meta, categories: m };
}
