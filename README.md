# slack-datamine-plus

Scheduled miner for Slack's web client bundle. Tracks every API method name ever seen, with `first_seen`, `last_seen` and `removed`, and feeds the [ReDocumented](https://vs.izie.top/redocumented) catalog.

Why it exists: [`3kh0/slack-datamine`](https://github.com/3kh0/slack-datamine) is great, but since 2026-07-24 its chunk discovery has found 14 chunks instead of ~1,500, so its recent builds list ~250 methods instead of ~1,750. This miner crawls from the client HTML, treats the known-bad `gantry-v2.<hash>.min.js` names (403 on the CDN even in old builds) as "phantom", and **refuses to write anything** if fewer than `MIN_CHUNKS` (300) real chunks were fetched, so a broken parse can't silently erase the history.

## How it runs

`.github/workflows/mine.yml` runs at :00 and :40 every hour (GitHub cron can't do true 40-minute steps). Each run fetches the authed client HTML, reads the build number, and stops in seconds if that build was already mined. New builds get a full crawl, and `build/`, `state/` and a tag are committed.

## Setup

1. Repo **Settings -> Secrets and variables -> Actions**: add secret `SLACK_D_COOKIE` (the `d` cookie of a throwaway account; it is a full login session, never paste it anywhere else).
2. Optional variable `SLACK_CLIENT_URL`: a workspace client URL like `https://app.slack.com/client/T0000000/C0000000` if the default `https://app.slack.com/client` doesn't land on a workspace.
3. Public repo = unlimited Actions minutes. Private = 2,000 free minutes/month; at 36 runs/day plus full crawls that is tight, so use a slower cron.

## Files

- `state/methods.json`: `name -> {first_build, first_seen, last_build, last_seen, removed}`
- `build/api-methods.txt`: names in the latest build; `build/api-candidates.txt`: dotted strings from unknown namespaces; `build/meta.json`
- `src/namespaces.txt`: namespaces to match (seeded from the ReDocumented catalog; add new ones when `api-candidates.txt` shows them)

## Local

```sh
npm test
SLACK_D_COOKIE=... node src/mine.mjs            # live
node src/mine.mjs --html page.html               # saved client HTML
node src/mine.mjs --from-dir decoded/ --build N  # offline replay
```

## Status

Written without access to a live authed session, so the HTML discovery step is **untested against Slack**; the extractor and state logic are tested (unit tests, and a replay over 400 decoded chunks of build 128106 recovering 397 names). If the first run exits 2 or 3, download the `debug` artifact and open an issue/PR with what it shows.
