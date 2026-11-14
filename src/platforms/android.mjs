// SPDX-License-Identifier: AGPL-3.0-only
// Static readers for an Android APK: the DEX string pools (every string constant in the app's code) and resources.arsc (string
// resources by name, default locale). Pure functions on Buffers; the APK is never installed or run.

const uleb = (buf, p) => {
  let v = 0, shift = 0, b;
  do { b = buf[p++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [v >>> 0, p];
};

// MUTF-8 is UTF-8 except NUL is 0xC0 0x80 and supplementary chars are surrogate pairs; utf8 decoding is close enough for mining.
export function dexStrings(buf) {
  if (buf.toString('latin1', 0, 4) !== 'dex\n') throw new Error('dex: bad magic');
  const n = buf.readUInt32LE(0x38), off = buf.readUInt32LE(0x3c);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let p = buf.readUInt32LE(off + i * 4);
    [, p] = uleb(buf, p);
    const end = buf.indexOf(0, p);
    out[i] = buf.toString('utf8', p, end);
  }
  return out;
}

// AndroidManifest.xml is binary XML whose first chunk after the 8-byte header is its string pool: every tag, attribute and value.
// Permissions and hardware features are recognisable by shape, so the pool is enough without walking the element tree.
export function manifestInfo(buf) {
  const pool = stringPool(buf, 8);
  const out = { permissions: new Set(), features: new Set(), schemes: new Set() };
  for (const s of pool) {
    if (/^[A-Za-z0-9_.]+\.permission\.[A-Za-z0-9_.]+$/.test(s)) out.permissions.add(s);
    else if (/^android\.(hardware|software)\.[a-z0-9_.]+$/.test(s)) out.features.add(s);
  }
  return out;
}

// ---- resources.arsc ----
const RES_STRING_POOL = 0x0001, RES_TABLE = 0x0002, RES_PACKAGE = 0x0200, RES_TYPE = 0x0201;

export function stringPool(buf, start) {
  const count = buf.readUInt32LE(start + 8), flags = buf.readUInt32LE(start + 16);
  const stringsStart = start + buf.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(start + 28 + i * 4);
    if (utf8) {
      p += buf[p] & 0x80 ? 2 : 1; // utf-16 length
      let len = buf[p++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | buf[p++];
      out[i] = buf.toString('utf8', p, p + len);
    } else {
      let len = buf.readUInt16LE(p); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      out[i] = buf.toString('utf16le', p, p + len * 2);
    }
  }
  return out;
}

// name -> value for every `string` resource in the default configuration (no locale, no qualifiers that change the language),
// plus `plurals` as name.quantity when present in the default config. Values of other configs are ignored.
export function arscStrings(buf) {
  if (buf.readUInt16LE(0) !== RES_TABLE) throw new Error('arsc: bad header');
  let p = buf.readUInt16LE(2), globals = null;
  const out = new Map();
  while (p < buf.length) {
    const type = buf.readUInt16LE(p), hsize = buf.readUInt16LE(p + 2), size = buf.readUInt32LE(p + 4);
    if (type === RES_STRING_POOL && !globals) globals = stringPool(buf, p);
    else if (type === RES_PACKAGE) readPackage(buf, p, hsize, size, globals, out);
    p += size;
  }
  return out;
}

function readPackage(buf, start, hsize, size, globals, out) {
  const typeNames = stringPool(buf, start + buf.readUInt32LE(start + 268));
  const keys = stringPool(buf, start + buf.readUInt32LE(start + 276));
  for (let p = start + hsize; p < start + size;) {
    const type = buf.readUInt16LE(p), h = buf.readUInt16LE(p + 2), csize = buf.readUInt32LE(p + 4);
    if (type === RES_TYPE) {
      const id = buf[p + 8], flags = buf[p + 9], count = buf.readUInt32LE(p + 12), entries = p + buf.readUInt32LE(p + 16);
      const cfg = p + 20; // ResTable_config; bytes 8..11 are language + country
      const name = typeNames[id - 1];
      const defaultLang = buf.readUInt16LE(cfg + 8) === 0;
      // only default-config values; skip qualifiers like night/sw600dp too, since they repeat names (first wins anyway)
      if ((name === 'string' || name === 'plurals') && defaultLang) {
        const sparse = flags & 0x01, off16 = flags & 0x02;
        for (let i = 0; i < count; i++) {
          let eoff;
          if (sparse) { eoff = buf.readUInt16LE(p + h + i * 4 + 2) * 4; }
          else if (off16) { const v = buf.readUInt16LE(p + h + i * 2); if (v === 0xffff) continue; eoff = v * 4; }
          else { const v = buf.readUInt32LE(p + h + i * 4); if (v === 0xffffffff) continue; eoff = v; }
          const e = entries + eoff;
          const eflags = buf.readUInt16LE(e + 2);
          if (eflags & 0x0008) { // compact entry: u16 key index, u16 flags (high byte = data type), u32 data
            const ck = keys[buf.readUInt16LE(e)];
            if ((eflags >> 8) === 0x03 && !out.has(ck)) out.set(ck, globals[buf.readUInt32LE(e + 4)]);
            continue;
          }
          const key = keys[buf.readUInt32LE(e + 4)];
          if (eflags & 0x0001) { // complex (plurals): parent u32, count u32, then (name u32, Res_value) pairs
            const n = buf.readUInt32LE(e + 12);
            for (let k = 0; k < n; k++) {
              const m = e + 16 + k * 12;
              const q = { 0x01000004: 'other', 0x01000005: 'zero', 0x01000006: 'one', 0x01000007: 'two', 0x01000008: 'few', 0x01000009: 'many' }[buf.readUInt32LE(m)];
              if (q && buf[m + 7] === 0x03) { const full = `${key}.${q}`; if (!out.has(full)) out.set(full, globals[buf.readUInt32LE(m + 8)]); }
            }
          } else if (buf[e + 8 + 3] === 0x03 && !out.has(key)) out.set(key, globals[buf.readUInt32LE(e + 8 + 4)]);
        }
      }
    }
    p += csize;
  }
}
