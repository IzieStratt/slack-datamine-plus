#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Mines Slack's native clients alongside the web miner. Writes build/platforms/<target>/*.txt, state in state/platforms.json.
//   node src/platforms.mjs [--only desktop,android,ios,notes] [--force] [--cache <dir>]
//
//   desktop  macOS (arm64 zip), Windows (msix), Linux (deb) from slack.com/api/desktop.latestRelease; reads each app.asar's bundles.
//   android  base APK from APKPure via `apkeep` (APKPURE is a mirror: the APK's v2/v3 signer must match ANDROID_CERT or nothing is written).
//   ios      App Store metadata (iPhone/iPad and Mac App Store listings, watch support). With `ipatool` signed in (IPATOOL=1), also the
//            IPA's unencrypted resources: Info.plist, en strings, extensions, frameworks, an embedded Watch app.
//   notes    the public release notes RSS for every platform, accumulated.
// Downloads are only parsed, never run. Nothing is written for a target whose download or check failed; the run exits 1 after the others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipEntries, zipRead, arMembers, unxz, tarFiles, asarFiles, apkSignerCerts } from './platforms/containers.mjs';
import { dexStrings, arscStrings, manifestInfo } from './platforms/android.mjs';
import { desktopJs, desktopLocale, androidDex, androidResources } from './platforms/extract.mjs';
import { plist, ipaCategories } from './platforms/ios.mjs';
import { parseNotes } from './platforms/notes.mjs';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const ONLY = new Set(arg('--only', 'desktop,android,ios,notes').split(','));
const FORCE = process.argv.includes('--force');
const CACHE = arg('--cache', path.join(os.tmpdir(), 'sdmp-platforms'));
const OUT = 'build/platforms', STATE = 'state/platforms.json';
// Google Play App Signing key Slack's APKs have been signed with since 2021 (checked across APKPure releases 26.04 → 26.11)
const ANDROID_CERT = process.env.ANDROID_CERT || '33533619756e8701a82e7887565b152dc348188711ebb5c48d073b2c942f7e41';
const UA = { 'user-agent': 'slack-datamine-plus (+https://github.com/IzieStratt/slack-datamine-plus)' };

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const log = (...a) => console.error(...a);
fs.mkdirSync(CACHE, { recursive: true });

async function getJson(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
async function getText(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); }
async function download(url, name) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return file;
  log(`  downloading ${url}`);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(`${file}.part`, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(`${file}.part`, file);
  return file;
}

// Category files for one target. Refuses to write when a category that had >= 20 values lost more than half (a broken parse).
function writeTarget(target, cats, info) {
  const dir = path.join(OUT, target);
  fs.mkdirSync(dir, { recursive: true });
  for (const [c, set] of cats) {
    const f = path.join(dir, `${c}.txt`);
    const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
    if (before >= 20 && set.size < before / 2 && !FORCE) throw new Error(`${target}/${c}: ${before} -> ${set.size}, refusing (use --force)`);
  }
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.txt') && !cats.has(f.slice(0, -4)) && f !== 'info.txt') fs.rmSync(path.join(dir, f));
  for (const [c, set] of cats) fs.writeFileSync(path.join(dir, `${c}.txt`), [...set].sort().join('\n') + '\n');
  if (info) fs.writeFileSync(path.join(dir, 'info.txt'), Object.entries(info).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');
  log(`  ${target}: ${[...cats].map(([c, s]) => `${c} ${s.size}`).join(', ')}`);
}

const merge = (into, from) => { for (const [c, s] of from) { const t = into.get(c) ?? into.set(c, new Set()).get(c); s.forEach((v) => t.add(v)); } return into; };

// ---------- desktop ----------
const DESKTOP = {
  macos: { q: 'platform=darwin&arch=universal&variant=dmg', url: (v) => `https://downloads.slack-edge.com/desktop-releases/mac/arm64/${v}/Slack-${v}-macOS.zip` },
  windows: { q: 'platform=windows&arch=x64&variant=msix' },
  linux: { q: 'platform=linux&arch=x64&variant=deb' },
};

function appAsar(os_, file) {
  const buf = fs.readFileSync(file);
  if (os_ === 'linux') {
    const data = [...arMembers(buf)].find(([n]) => n.startsWith('data.tar'));
    if (!data[0].endsWith('.xz')) throw new Error(`deb: unsupported ${data[0]}`);
    const files = tarFiles(unxz(data[1]), (n) => n === 'usr/lib/slack/resources/app.asar');
    return { asar: files.get('usr/lib/slack/resources/app.asar') };
  }
  const z = zipEntries(buf);
  if (os_ === 'windows') return { asar: zipRead(buf, z.get('app/resources/app.asar')) };
  const res = 'Slack.app/Contents/Resources/';
  const electron = z.get('Slack.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist');
  return { asar: zipRead(buf, z.get(`${res}app.asar`)), electron: electron && plist(zipRead(buf, electron)).CFBundleVersion };
}

async function desktop() {
  const rel = {};
  for (const [os_, d] of Object.entries(DESKTOP)) {
    const r = await getJson(`https://slack.com/api/desktop.latestRelease?${d.q}`);
    if (!r.ok || !/^\d+\.\d+\.\d+$/.test(r.version)) throw new Error(`desktop.latestRelease ${os_}: ${JSON.stringify(r).slice(0, 200)}`);
    rel[os_] = { version: r.version, url: d.url ? d.url(r.version) : r.download_url };
  }
  const key = Object.values(rel).map((r) => r.version).join(' ');
  if (!FORCE && state.desktop?.versions === key) { log(`desktop: unchanged (${key})`); return; }
  const per = {}, info = {};
  for (const [os_, r] of Object.entries(rel)) {
    log(`desktop ${os_} ${r.version}`);
    const file = await download(r.url, `${os_}-${r.version}${path.extname(r.url)}`);
    const { asar, electron } = appAsar(os_, file);
    if (!asar) throw new Error(`${os_}: app.asar not found`);
    const files = asarFiles(asar);
    const cats = new Map();
    for (const [n, b] of files) {
      if (n.includes('node_modules/')) continue;
      if (/^dist\/[^/]+\.(c?js)$/.test(n)) desktopJs(b.toString('utf8'), cats);
      const loc = n.match(/^dist\/resources\/locales\/en\/desktop_([a-z]+)_en_GB\.json$/);
      if (loc) desktopLocale(loc[1], b.toString('utf8'), cats);
      if (n.startsWith('dist/') && !n.includes('/locales/')) (cats.get('bundle-files') ?? cats.set('bundle-files', new Set()).get('bundle-files')).add(n.slice(5).replace(/[0-9a-f]{16}(?=\.)/, ''));
    }
    const pkg = JSON.parse(files.get('package.json').toString('utf8'));
    cats.set('dependencies', new Set(Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }).map(([k, v]) => `${k}@${v}`)));
    per[os_] = cats;
    info[`${os_}-version`] = r.version;
    info.commit ??= pkg.commit;
    info['minimum-supported-version'] ??= pkg.desktopMinimumSupportedVersion;
    if (electron) info.electron = electron;
  }
  // one set for all three, plus what only some platforms ship (bundles are built per platform)
  const all = new Map(); for (const c of Object.values(per)) merge(all, c);
  const only = new Set();
  for (const [c, set] of all) {
    for (const v of set) {
      const has = Object.keys(per).filter((o) => per[o].get(c)?.has(v));
      if (has.length < Object.keys(per).length) only.add(`${has.join('+')}: ${c}: ${v}`);
    }
  }
  all.set('platform-only', only);
  writeTarget('desktop', all, info);
  state.desktop = { versions: key, date: new Date().toISOString() };
}

// ---------- android ----------
function apkeep(args) { return execFileSync(process.env.APKEEP || 'apkeep', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); }

async function android() {
  const versions = apkeep(['-l', '-d', 'apk-pure', '-a', 'com.Slack']).split(/[\s,|]+/).filter((v) => /^\d+(\.\d+){2,3}$/.test(v));
  const latest = versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  if (!latest) throw new Error('apkeep: no versions listed');
  if (!FORCE && state.android?.version === latest) { log(`android: unchanged (${latest})`); return; }
  log(`android ${latest}`);
  const dir = path.join(CACHE, `android-${latest}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(`${dir}.part`, { recursive: true });
    apkeep(['-d', 'apk-pure', '-o', 'acknowledge_dangers=true', '-a', `com.Slack@${latest}`, `${dir}.part`]);
    fs.renameSync(`${dir}.part`, dir);
  }
  const got = fs.readdirSync(dir).find((f) => /\.x?apk$/.test(f));
  let buf = fs.readFileSync(path.join(dir, got)), splits = [];
  if (got.endsWith('.xapk')) { // bundle of split APKs: base is <package>.apk
    const z = zipEntries(buf);
    splits = [...z.keys()].filter((n) => n.endsWith('.apk') && n !== 'com.Slack.apk').map((n) => zipRead(buf, z.get(n)));
    buf = zipRead(buf, z.get('com.Slack.apk'));
  }
  const certs = apkSignerCerts(buf, crypto);
  if (!certs.includes(ANDROID_CERT)) throw new Error(`android: signer ${certs.join(',') || 'none'} is not Slack's (${ANDROID_CERT}); not mining this APK`);
  for (const s of splits) if (!apkSignerCerts(s, crypto).includes(ANDROID_CERT)) throw new Error('android: a split APK has a different signer');
  const z = zipEntries(buf);
  const web = new Set(['build/experiments.txt', 'build/feature-flags.txt'].flatMap((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : [])).filter((s) => s.length > 5));
  const strings = new Set();
  for (const [n, e] of z) if (/^classes\d*\.dex$/.test(n)) for (const s of dexStrings(zipRead(buf, e))) strings.add(s);
  const cats = androidDex([...strings], web);
  androidResources(arscStrings(zipRead(buf, z.get('resources.arsc'))), cats);
  const mf = manifestInfo(zipRead(buf, z.get('AndroidManifest.xml')));
  cats.set('permissions', mf.permissions); cats.set('hardware-features', mf.features);
  const libs = new Set();
  for (const n of z.keys()) { const m = n.match(/^META-INF\/(.+)\.version$/); if (m) libs.add(`${m[1]}@${zipRead(buf, z.get(n)).toString('utf8').trim()}`); }
  cats.set('libraries', libs);
  const native = new Set();
  for (const s of [buf, ...splits]) for (const n of zipEntries(s).keys()) { const m = n.match(/^lib\/[^/]+\/(lib[^/]+\.so)$/); if (m) native.add(m[1]); }
  if (native.size) cats.set('native-libs', native);
  const vc = [...strings].length; // DEX string count as a sanity number
  writeTarget('android', cats, { version: latest, 'signer-sha256': ANDROID_CERT, 'dex-strings': vc, source: 'APKPure (signature checked)' });
  state.android = { version: latest, date: new Date().toISOString() };
}

// ---------- iOS / watchOS ----------
async function ios() {
  const look = async (q) => (await getJson(`https://itunes.apple.com/lookup?${q}&country=us`)).results?.[0];
  const ph = await look('bundleId=com.tinyspeck.chatlyio');
  const mas = await look('id=803453959');
  if (!ph?.version) throw new Error('itunes lookup: no Slack iOS result');
  const devices = ph.supportedDevices ?? [];
  const info = {
    version: ph.version, released: ph.currentVersionReleaseDate, 'minimum-ios': ph.minimumOsVersion, 'size-bytes': ph.fileSizeBytes,
    languages: (ph.languageCodesISO2A ?? []).join(' '), devices: devices.length,
    'watch-app': devices.some((d) => /watch/i.test(d)) ? 'yes' : 'no (no Apple Watch in supportedDevices)',
    'vision-pro': devices.some((d) => /vision/i.test(d)) ? 'yes' : 'no',
    'mac-app-store-version': mas?.version, 'mac-app-store-released': mas?.currentVersionReleaseDate, 'mac-app-store-minimum-macos': mas?.minimumOsVersion,
  };
  let cats = new Map([['app-store-features', new Set(ph.features ?? [])]]);
  if (process.env.IPATOOL === '1' && (FORCE || state.ios?.ipa !== ph.version)) {
    const file = path.join(CACHE, `ios-${ph.version}.ipa`);
    if (!fs.existsSync(file)) execFileSync('ipatool', ['download', '-b', 'com.tinyspeck.chatlyio', '--purchase', '-o', file, '--non-interactive'], { stdio: ['ignore', 'inherit', 'inherit'] });
    const buf = fs.readFileSync(file), z = zipEntries(buf);
    const files = new Map([...z].map(([n, e]) => [n, () => zipRead(buf, e)]));
    const r = ipaCategories(files);
    cats = merge(cats, r.categories);
    Object.assign(info, { 'ipa-build': r.meta.build, 'ipa-version': r.meta.version });
    state.ios = { ...state.ios, ipa: ph.version };
  } else if (process.env.IPATOOL !== '1' && fs.existsSync(path.join(OUT, 'ios'))) {
    // keep the IPA categories mined earlier (locally, with ipatool) instead of deleting them on a metadata-only run
    for (const f of fs.readdirSync(path.join(OUT, 'ios'))) if (f.endsWith('.txt') && f !== 'info.txt' && !cats.has(f.slice(0, -4))) cats.set(f.slice(0, -4), new Set(fs.readFileSync(path.join(OUT, 'ios', f), 'utf8').split('\n').filter(Boolean)));
    const prev = fs.existsSync(path.join(OUT, 'ios/info.txt')) ? fs.readFileSync(path.join(OUT, 'ios/info.txt'), 'utf8') : '';
    for (const k of ['ipa-build', 'ipa-version']) { const m = prev.match(new RegExp(`^${k}: (.+)$`, 'm')); if (m) info[k] = m[1]; }
  }
  writeTarget('ios', cats, info);
  state.ios = { ...state.ios, version: ph.version, date: new Date().toISOString() };
}

// ---------- release notes ----------
const NOTE_PLATFORMS = ['mac', 'windows', 'linux', 'android', 'ios'];

async function notes() {
  const cats = new Map();
  for (const p of NOTE_PLATFORMS) {
    const f = path.join(OUT, 'release-notes', `${p}.txt`);
    const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
    const now = parseNotes(await getText(`https://slack.com/release-notes/${p}/rss`));
    if (!now.length) throw new Error(`release notes ${p}: no items parsed`);
    cats.set(p, new Set([...prev, ...now])); // accumulated: items falling off the RSS are not "gone"
  }
  writeTarget('release-notes', cats);
}

const TARGETS = { desktop, android, ios, notes };
let failed = 0;
for (const [name, fn] of Object.entries(TARGETS)) {
  if (!ONLY.has(name)) continue;
  try { await fn(); } catch (e) { failed++; log(`✗ ${name}: ${e.message}`); }
}
fs.mkdirSync('state', { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');
process.exit(failed ? 1 : 0);
