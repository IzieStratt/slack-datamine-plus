# slack-datamine-plus

Scheduled miner for Slack's web client bundle. Tracks every API method name ever seen, with `first_seen`, `last_seen` and `removed`, and feeds the [ReDocumented](https://vs.izie.top/redocumented) catalog.

Why it exists: [`3kh0/slack-datamine`](https://github.com/3kh0/slack-datamine) is great, but since 2026-07-24 its chunk discovery has found 14 chunks instead of ~1,500, so its recent builds list ~250 methods instead of ~1,750. This miner crawls from the client HTML, treats the known-bad `gantry-v2.<hash>.min.js` names (403 on the CDN even in old builds) as "phantom", and **refuses to write anything** if fewer than `MIN_CHUNKS` (300) real chunks were fetched, so a broken parse can't silently erase the history.

## How it runs

`.github/workflows/mine.yml` runs at :00 and :40 every hour (GitHub cron can't do true 40-minute steps). Commits are authored as Izie with a `Co-Authored-By: GitHub Actions <automated-tools@izie.top>` trailer. Each run fetches the authed client HTML, reads the build number, and stops in seconds if that build was already mined. New builds get a full crawl, and `build/`, `state/` and a tag are committed. When something changed for ReDocumented (new methods, newly removed, back in the bundle) the run also pushes branch `datamine/update` to `IzieStratt/personal-site` and opens a PR, or updates the one already open (`src/sync-redocumented.mjs`).

## Setup

1. Repo **Settings -> Secrets and variables -> Actions**: add secret `SLACK_D_COOKIE` (the `d` cookie of a throwaway account; it is a full login session, never paste it anywhere else).
2. Secret `REDOC_TOKEN`: a fine-grained personal access token limited to `IzieStratt/personal-site` with **Contents: read/write** and **Pull requests: read/write**. Used to open/update the ReDocumented PR (`GITHUB_TOKEN` can't write to another repo).
3. Optional variable `SLACK_CLIENT_URL` (defaults to `https://app.slack.com/client/E09V59WQY1E`, the Hack Club org): the page to load with the `d` cookie. If it doesn't land on the client, try a full client URL like `https://app.slack.com/client/E09V59WQY1E/C0000000`.
4. Public repo = unlimited Actions minutes. Private = 2,000 free minutes/month; at 36 runs/day plus full crawls that is tight, so use a slower cron.

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

Mined live from GitHub Actions since 2026-10-19 (build ids are the first 12 hex chars of Slack's `version_uid`; Slack's client shell no longer exposes a numeric build number). The current bundle yields ~600 method names, far fewer than the ~1,750 older builds listed; "removed" therefore means "no longer in the bundle the miner can read", not "gone from Slack's API". Guards: the run aborts (writes nothing) if fewer than 300 chunks are fetched, or if the method count falls below 60% of the previous build's.

Security notes: the `d` cookie is only ever sent over HTTPS to `slack.com` hosts and the run aborts rather than follow a redirect elsewhere; failed runs upload only a redacted summary (no page body) and keep it 3 days; `REDOC_TOKEN` is not persisted in the checkout and is only present in the final push/PR step; actions are pinned to commit SHAs.
