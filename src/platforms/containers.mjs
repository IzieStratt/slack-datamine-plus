// SPDX-License-Identifier: AGPL-3.0-only
// Dependency-free readers for the containers Slack's native clients ship in: zip (msix, macOS zip, apk, xapk), Debian .deb (ar + tar.xz via
// the system `xz`), Electron asar, and the APK v2/v3 signing block. Everything works on Buffers; nothing here is ever executed.
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

// ---- zip ----
// Reads the central directory (zip64 included), so local headers with streamed sizes (bit 3) are fine.
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip: no end of central directory');
  let count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) { // zip64
    const loc = eocd - 20;
    if (buf.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip: zip64 locator missing');
    const z = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(z + 32)); cdOff = Number(buf.readBigUInt64LE(z + 48));
  }
  const out = new Map();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), off = buf.readUInt32LE(p + 42);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    for (let x = p + 46 + nl; x < p + 46 + nl + xl;) { // zip64 extra field: only the 0xffffffff fields are present, in this order
      const id = buf.readUInt16LE(x), len = buf.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (off === 0xffffffff) { off = Number(buf.readBigUInt64LE(q)); }
      }
      x += 4 + len;
    }
    out.set(name, { name, method, csize, usize, off });
    p += 46 + nl + xl + cl;
  }
  return out;
}

export function zipRead(buf, e) {
  const nl = buf.readUInt16LE(e.off + 26), xl = buf.readUInt16LE(e.off + 28);
  const data = buf.subarray(e.off + 30 + nl + xl, e.off + 30 + nl + xl + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip: unsupported method ${e.method} for ${e.name}`);
}

// ---- ar (.deb) + tar ----
export function arMembers(buf) {
  if (buf.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error('ar: bad magic');
  const out = new Map();
  for (let p = 8; p + 60 <= buf.length;) {
    const name = buf.toString('latin1', p, p + 16).trim().replace(/\/$/, '');
    const size = parseInt(buf.toString('latin1', p + 48, p + 58).trim(), 10);
    out.set(name, buf.subarray(p + 60, p + 60 + size));
    p += 60 + size + (size % 2);
  }
  return out;
}

export function unxz(buf) {
  return execFileSync('xz', ['-dc'], { input: buf, maxBuffer: 1 << 30 });
}

export function tarFiles(buf, want = () => true) {
  const out = new Map();
  let longName = null;
  for (let p = 0; p + 512 <= buf.length;) {
    if (buf[p] === 0) break;
    let name = buf.toString('utf8', p, p + 100).replace(/\0.*$/s, '');
    const prefix = buf.toString('utf8', p + 345, p + 500).replace(/\0.*$/s, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(buf.toString('latin1', p + 124, p + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(buf[p + 156] || 48);
    const body = buf.subarray(p + 512, p + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else {
      if (longName) { name = longName; longName = null; }
      name = name.replace(/^\.\//, '');
      if ((type === '0' || type === '\0') && want(name)) out.set(name, body);
    }
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ---- asar ----
// header: uint32 4, uint32 headerPickleSize, uint32 payloadSize, uint32 jsonLength, json; files start at 8 + headerPickleSize.
export function asarFiles(buf) {
  const pickle = buf.readUInt32LE(4), jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen));
  const base = 8 + pickle, out = new Map();
  const walk = (node, dir) => {
    for (const [k, v] of Object.entries(node.files ?? {})) {
      const p = dir ? `${dir}/${k}` : k;
      if (v.files) walk(v, p);
      else if (!v.unpacked && !v.link && v.offset !== undefined) {
        const off = base + Number(v.offset);
        out.set(p, buf.subarray(off, off + v.size));
      }
    }
  };
  walk(header, '');
  return out;
}

// ---- APK signing block (v2 0x7109871a, v3 0xf05368c0) ----
// Returns the SHA-256 of each signer's first certificate. Used to refuse an APK from a mirror that was not signed by Slack's key.
export function apkSignerCerts(buf, crypto) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.toString('latin1', cd - 16, cd) !== 'APK Sig Block 42') return [];
  const size = Number(buf.readBigUInt64LE(cd - 24));
  const start = cd - size - 8;
  const certs = new Set();
  for (let p = start + 8; p < cd - 24;) {
    const len = Number(buf.readBigUInt64LE(p)), id = buf.readUInt32LE(p + 8);
    if (id === 0x7109871a || id === 0xf05368c0) {
      // value: len-prefixed sequence of signers; signer: len signedData; signedData: len digests, len certificates (len-prefixed DER)
      let q = p + 12;
      const signersEnd = q + 4 + buf.readUInt32LE(q); q += 4;
      while (q < signersEnd) {
        const signerLen = buf.readUInt32LE(q); const s = q + 4;
        const sd = s + 4; // signedData
        const digestsLen = buf.readUInt32LE(sd);
        const certsAt = sd + 4 + digestsLen;
        const certLen = buf.readUInt32LE(certsAt + 4);
        if (certLen) certs.add(crypto.createHash('sha256').update(buf.subarray(certsAt + 8, certsAt + 8 + certLen)).digest('hex'));
        q = s + signerLen;
      }
    }
    p += 8 + len;
  }
  return [...certs];
}
