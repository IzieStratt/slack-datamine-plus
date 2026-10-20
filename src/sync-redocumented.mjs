#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Apply state/ to a ReDocumented checkout (IzieStratt/personal-site).
//   node src/sync-redocumented.mjs <path-to-personal-site> [--state state/methods.json] [--params state/params.json] [--meta build/meta.json]
// Only touches undocumented entries. Every entry gets a `datamine` block (first_*); entries not in the current client also get last_*
// (frozen, so a name that stays absent never produces a diff). Observed parameters go into `params_observed`, never `params`
// (which is reserved for complete, sourced schemas). Exits 0 whether or not anything changed; the workflow checks `git status`.
import fs from 'node:fs';
import path from 'node:path';

const site = process.argv[2];
if (!site) { console.error('usage: sync-redocumented.mjs <personal-site checkout>'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const file = path.join(site, 'website/public/__subdomains/vs/redocumented/docs/data/methods.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const state = JSON.parse(fs.readFileSync(arg('state', 'state/methods.json'), 'utf8'));
const paramsFile = arg('params', 'state/params.json');
const observed = fs.existsSync(paramsFile) ? JSON.parse(fs.readFileSync(paramsFile, 'utf8')) : {};
const meta = JSON.parse(fs.readFileSync(arg('meta', 'build/meta.json'), 'utf8'));
const by = new Map(data.methods.map((m) => [m.name, m]));
// names the existence oracle said are not live dispatch targets (see ReDocumented datamine-2026-09.md)
const exclude = new Set(fs.readFileSync(new URL('./exclude.txt', import.meta.url), 'utf8').split('\n').filter(Boolean));
const OURS = 'IzieStratt/slack-datamine-plus (own miner)';
const added = [], newlyAbsent = [], returned = [], paramsAdded = [];

for (const [name, e] of Object.entries(state)) {
  let m = by.get(name);
  if (m?.status === 'documented' || exclude.has(name)) continue;
  if (!m) {
    m = {
      name, status: 'undocumented', tokens: 'unknown - not live-tested', verified: 'datamine-only (not oracle-tested)',
      purpose: '(inferred from name only; webpack string, not oracle-tested)',
      source: `${OURS}, first seen in client build ${e.first_build}`,
      params_known: false, params: null, params_source: null, response_known: false, response: null, response_source: null,
    };
    data.methods.push(m); by.set(name, m); added.push(name);
  }
  if (e.ours && !String(m.source).includes('slack-datamine-plus')) m.source = `${m.source} + ${OURS}`;

  const wasAbsent = !!(m.not_in_client || m.removed);
  delete m.removed; delete m.removed_note; // legacy names
  m.datamine = { first_build: e.first_build, first_seen: e.first_seen };
  if (e.absent) {
    m.datamine.last_build = e.last_build; m.datamine.last_seen = e.last_seen;
    m.not_in_client = true;
    m.not_in_client_note = `Not found in Slack's web client as of the latest mined build (last seen in build ${e.last_build}, ${e.last_seen}). The client no longer references it; that is not proof the API stopped answering.`;
    if (!wasAbsent) newlyAbsent.push(name);
  } else {
    delete m.not_in_client; delete m.not_in_client_note;
    if (wasAbsent) returned.push(name);
  }

  const o = observed[name];
  if (o && !m.params_known) {
    const next = o.params;
    if (JSON.stringify(m.params_observed) !== JSON.stringify(next)) paramsAdded.push(name);
    m.params_observed = next;
    m.params_observed_source = `Argument names seen at call sites in Slack's web client (build ${o.build}, ${o.seen}) by ${OURS}. They are real names as written in the client's JavaScript, but the set is partial (spread and computed arguments are invisible), says nothing about which are required, and camelCase client names may be snake_case on the wire. "sites" is how many call sites pass the key.`;
  }
}

data.methods.sort((a, b) => a.name.localeCompare(b.name));
const ms = data.methods;
const before = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).methods);
const changed = before !== JSON.stringify(ms);
if (changed) {
  data.generated = meta.capturedDate;
  data.counts = {
    documented: ms.filter((m) => m.status === 'documented').length,
    undocumented: ms.filter((m) => m.status === 'undocumented').length,
    total: ms.length,
    not_in_client: ms.filter((m) => m.not_in_client).length,
    params_observed: ms.filter((m) => m.params_observed).length,
    live_verified_undocumented: data.counts?.live_verified_undocumented ?? 0,
  };
  delete data.counts.removed;
  data.datamine_latest_build = { ...(data.datamine_latest_build || {}), build: meta.buildNumber, captured: meta.capturedDate };
  if (data.schema?.fields) {
    delete data.schema.fields.removed;
    data.schema.fields.not_in_client = "true if the method is no longer found in Slack's web client as of the latest mined build (it needs to be missing from several consecutive builds first). The client no longer references it; that does not mean the API stopped answering. Hidden in the explorer unless 'Show methods not in the current client' is on.";
    data.schema.fields.datamine = '{first_build, first_seen, last_build, last_seen} from the slack-datamine-plus miner and 3kh0/slack-datamine history, when the name appears in them.';
    data.schema.fields.params_observed = '{name: {sites, type}} argument names seen at call sites in the web client. Real but partial and unlabelled as required/optional; NOT a schema. See params_observed_source.';
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
}

fs.writeFileSync(arg('summary', 'sync-summary.json'), JSON.stringify({ added, newlyAbsent, returned, paramsAdded }, null, 1) + '\n');
console.log(`added ${added.length}, newly absent ${newlyAbsent.length}, returned ${returned.length}, params updated ${paramsAdded.length}`);
