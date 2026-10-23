// SPDX-License-Identifier: AGPL-3.0-only
// Did this run find everything it should? A mine run can "succeed" while a whole source is missing (an entry script no longer listed, a
// module that changed shape, a chunk that moved), which silently freezes whole categories. checkHealth() names those gaps; mine.mjs writes
// them to build/health.json and the workflow turns them into a GitHub issue plus a failed run.
const DROP = 0.7; // a category that loses more than 30% between builds is flagged
const MIN_PREV = 20; // ...but only once it had at least this many entries (tiny lists fluctuate)

export function checkHealth(prev, cur) {
  const problems = [];
  if (!cur.entryScripts) problems.push('The public client page listed no entry scripts (modern.vendor, application, rollup-core_*, TS.web), so most of the client was not mined.');
  else if (cur.entryFetched < cur.entryScripts) problems.push(`Only ${cur.entryFetched} of ${cur.entryScripts} entry scripts could be fetched.`);
  if (!cur.iconGlyphs) problems.push('The icon glyph set was not found, so build/icons.json and the icons PDF were not refreshed.');
  if (!cur.experimentsSelector) problems.push('The experiments selector module was not found, so experiments were not refreshed.');
  if (prev?.apiMethods && cur.apiMethods < prev.apiMethods * 0.85) problems.push(`API methods dropped from ${prev.apiMethods} to ${cur.apiMethods}.`);
  if (prev?.chunks && cur.chunks < prev.chunks * 0.8) problems.push(`Chunks fetched dropped from ${prev.chunks} to ${cur.chunks}.`);
  for (const [cat, before] of Object.entries(prev?.mined ?? {})) {
    if (!(before >= MIN_PREV)) continue;
    const now = cur.mined?.[cat] ?? 0;
    if (now < before * DROP) problems.push(`${cat} dropped from ${before} to ${now}.`);
  }
  return problems;
}
