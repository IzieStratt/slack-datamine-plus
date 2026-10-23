# slack-datamine-plus

Scheduled miner for Slack's web client bundle.

> **License:** [AGPL-3.0](LICENSE). Free software for everyone: individuals, schools, non-profits and companies alike.

Why it exists: [`3kh0/slack-datamine`](https://github.com/3kh0/slack-datamine) is great, but since 2026-07-24 its chunk discovery has found 14 chunks instead of ~1,500, so its recent builds list ~250 methods instead of ~1,750. This miner crawls from the client HTML, treats the known-bad `gantry-v2.<hash>.min.js` names (403 on the CDN even in old builds) as "phantom", and **refuses to write anything** if fewer than `MIN_CHUNKS` (300) real chunks were fetched, so a broken parse can't silently erase the history.

## What gets mined

The crawl starts from the signed-in client page's webpack manifest and also from the entry scripts the public workspace client page lists (`modern.vendor`, `application`, `rollup-core_*`, `TS.web`: the legacy web client, most method names, and the icon glyph set in `build/icons.json`, which the site turns into https://slackdatamineplus.izie.top/icons.pdf).

Each run writes to `build/`: `api-methods.txt`, `chunks.txt`, `meta.json` (with per-category counts), and one sorted list per category: `errors`, `scopes`, `slash-commands`, `dev-commands`, `analytics-events`, `workflow`, `notification-types`, `trace-spans`, `icons`, `shortcuts`, `feature-flags`, `ui-strings`, `enums`, `ai-enums`, `mcp-enums`, `blockkit-enums`, `design-tokens`, `paths`, `hosts`. Observed method params are in `state/params.json`.

Experiments are found like [taut](https://github.com/jeremy46231/taut)'s Experiments plugin does it (`plugins/Experiments.tsx`, `scanCode`): locate the module exporting `getGroupForUser`, map its minified export keys, then regex every `(0,x.key)(state,"name")` call and the group strings it is compared to. Result: `build/experiments.json` (`name -> groups`) and `experiments.txt`. Lists are regex heuristics, so expect some noise (mainly `errors`).

## If this helped you

If this helped you in any way, I'd love for you to shoot me an email at SlackDataminePlus@izie.top, (if theres any improvements you want lmk!) a link back to this repo, or a star all tell me people actually use this, plus they make me smile :) This isn't something you're forced to do, the license is still AGPL-3.0, it's just a request.

## ReDocumented
If you're looking for a list of all the weird and badly/undocumented API methods in Slack check out https://vs.izie.top/redocumented.

## Daily changes feed

`src/feed.mjs` (workflow `feed`) posts one item a day with what was added/removed per category to https://slackdatamineplus.izie.top/feed.xml (files live in personal-site under `website/public/__subdomains/slackdatamineplus/`).
