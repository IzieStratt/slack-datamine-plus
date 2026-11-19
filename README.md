# slack-datamine-plus

Scheduled miner for Slack's web client bundle.

> **License:** [AGPL-3.0](LICENSE). Free software for everyone: individuals, schools, non-profits and companies alike.

Why it exists: [`3kh0/slack-datamine`](https://github.com/3kh0/slack-datamine) is great, but since 2026-07-24 its chunk discovery has found 14 chunks instead of ~1,500, so its recent builds list ~250 methods instead of ~1,750. This miner crawls from the client HTML, treats the known-bad `gantry-v2.<hash>.min.js` names (403 on the CDN even in old builds) as "phantom", and **refuses to write anything** if fewer than `MIN_CHUNKS` (300) real chunks were fetched, so a broken parse can't silently erase the history.

## What gets mined

The crawl starts from the signed-in client page's webpack manifest and also from the entry scripts the public workspace client page lists (`modern.vendor`, `application`, `rollup-core_*`, `TS.web`: the legacy web client, most method names, and the icon glyph set in `build/icons.json`, which the site turns into https://sdmp.izie.top/icons.pdf).

Each run writes to `build/`: `api-methods.txt`, `chunks.txt`, `meta.json` (with per-category counts), and one sorted list per category: `errors`, `scopes`, `slash-commands`, `dev-commands`, `analytics-events`, `workflow`, `notification-types`, `trace-spans`, `icons`, `shortcuts`, `feature-flags`, `ui-strings`, `enums`, `ai-enums`, `mcp-enums`, `blockkit-enums`, `block-registry` (every registered Block Kit renderer, the fields its component reads, and the experiment-gated `prototype` candidates), `design-tokens`, `paths`, `hosts`, `components`, `redux`.

`components.json` / `redux.json` are for people who patch the client (taut plugins and the like): React components by display name, and thunks, actions, fetchers, middleware, reducers and selectors by name with their internal key, the description the client gives them, and the defining module as `id:hash` (the hash changes with any edit to that module's code). Observed method params are in `state/params.json`.

The rspack-era extractors ported from [3kh0/slack-datamine](https://github.com/3kh0/slack-datamine) (GPL-3.0, see `src/upstream/NOTICE.md`) run on the same chunks and add: `api-args`, `api-errors`, `error-codes`, `rtm-events`, `message-subtypes`, `client-routes`, `deep-links`, `internal-urls`, `oauth-scopes`, `analytics-event-ids`, `analytics-enums`, `key-bindings`, `slack-debug`, `workflow-trigger-types`, `workflow-types`, `slackbot-entry-points`, `plan-features`, `megaphones`, `help-articles`, `lottie-animations`, `sounds`, `assets`, `chunk-names`, `session-toggles`, `feature-access`, `prefs`, `strings-en-US` / `strings-untranslated` (the en-US translation table matched against every string literal), and `api-methods-upstream.txt` / `experiments-upstream.txt` (their method and experiment lists, kept apart from ours). Files this miner also writes (`slash-commands`, `analytics-events`, `trace-spans`, `dev-commands`, `notification-types`, `feature-flags`, `ui-strings`) are unions of both.

Experiments are found like [taut](https://github.com/jeremy46231/taut)'s Experiments plugin does it (`plugins/Experiments.tsx`, `scanCode`): locate the module exporting `getGroupForUser`, map its minified export keys, then regex every `(0,x.key)(state,"name")` call and the group strings it is compared to. Result: `build/experiments.json` (`name -> groups`) and `experiments.txt`. Lists are regex heuristics, so expect some noise (mainly `errors`).

## Native clients (desktop, Android, iOS)

`src/platforms.mjs` (workflow `platforms`, every 3 hours) mines Slack's other clients into `build/platforms/<target>/`. It only downloads a client when its version changed (`state/platforms.json`), and nothing it downloads is run.

- `desktop/`: macOS (arm64 zip), Windows (msix) and Linux (deb) builds from `slack.com/api/desktop.latestRelease`, read straight out of each `app.asar`: `api-methods`, `redux-actions` (the desktop store's action types), `enums` (client types, IPC codes, ...), `env-vars`, `cli-switches`, `deep-links`, `accelerators`, `ipc-channels`, `window-globals` (what the preloads expose to the web client), `hosts`/`urls`, `strings-en` (the desktop locale files), `dependencies`, `bundle-files`, and `platform-only` (values only some of the three builds ship). `info.txt` has the versions, commit and Electron version.
- `android/`: the base APK of the latest release from APKPure via [`apkeep`](https://github.com/EFForg/apkeep). APKPure is a mirror, so the APK's v2/v3 signer has to be Slack's Play signing key (`ANDROID_CERT` in `src/platforms.mjs`) or nothing is written. From the DEX string pools, `resources.arsc` and the manifest: `api-methods`, `feature-flags` (`android_*`), `shared-flags` (web experiment/flag names the app also reads), `strings-en` (every string resource), `permissions`, `hardware-features`, `libraries` (AndroidX and other `META-INF/*.version`), `native-libs`, `deep-links`, `hosts`/`urls`.
- `ios/`: App Store metadata for the iPhone/iPad app and the Mac App Store listing (version, minimum OS, size, languages, and whether an Apple Watch or Vision Pro app is listed; there is no watchOS app today). App Store binaries are FairPlay-encrypted, so code-level lists (methods, flags) can't be read. With [`ipatool`](https://github.com/majd/ipatool) signed in and `IPATOOL=1`, a local run also reads the IPA's unencrypted resources: `url-schemes`, `permission-prompts`, `background-modes`, `activity-types`, `extensions`, `frameworks`, `watch-app` and `strings-en`. Metadata-only runs keep what an IPA run found.
- `release-notes/`: one line per bullet of slack.com's release notes RSS for mac, windows, linux, android and ios, accumulated.

The feed reports these as `<target>/<category>` (e.g. `android/feature-flags`); a category's first appearance only shows its count.

## What is authenticated

Not everything here comes from public files. The webpack manifest (and with it the ~1,800 async chunks) is read from the signed-in Hack Club enterprise-grid client page (`SLACK_CLIENT_URL`, default `https://app.slack.com/client/E09V59WQY1E`) with the `SLACK_D_COOKIE` secret. The entry scripts (`modern.vendor`, `application`, ...) come from a public client page. Debug output is redacted and never includes the page itself. `src/icon-notes.json` holds hand-written notes about single icons shown in the icons gallery.

## Health and new sources

A run can succeed while a whole source is missing. So every run writes `build/health.json`:
- `problems`: an expected source was not found (no entry scripts, no icon glyph set, no experiments selector), or methods/chunks/a category dropped sharply against the previous build. The workflow opens a `mine-health` issue and fails the run once per change; it closes by itself when a run is clean.
- `notices`: the source inventory (`build/sources.txt`: page assets with their hashes stripped, plus chunk-name families) gained or lost an entry. That opens a `mine-sources` issue (never fails the run). Scripts listed on the public client pages are mined in the same run.

## Taut watch

`src/taut-usage.mjs` reads [Taut](https://github.com/jeremy46231/taut)'s source for the names it looks up in Slack's client (components, thunks, `byMeta`/`byName` lookups, websocket events, experiments). `mine` records how each name is defined in the current build (`build/taut-presence.json`, every code shape Taut can resolve), and the `taut-watch` workflow, which runs after every mine, keeps one `taut-watch` issue up to date: names that went missing (with the closest names now, and a note when a name still exists but is no longer registered with `.meta`), and modules whose code changed. No AI and no secrets beyond the repo's own token. Set the repo variable `TAUT_REPO` to watch a fork.

## If this helped you

If this helped you in any way, I'd love for you to shoot me an email at SlackDataminePlus@izie.top, (if theres any improvements you want lmk!) a link back to this repo, or a star all tell me people actually use this, plus they make me smile :) This isn't something you're forced to do, the license is still AGPL-3.0, it's just a request.

## ReDocumented
If you're looking for a list of all the weird and badly/undocumented API methods in Slack check out https://vs.izie.top/redocumented.

## Daily changes feed

`src/feed.mjs` (workflow `feed`) posts one item a day with what was added/removed per category to https://sdmp.izie.top/feed.xml (files live in personal-site under `website/public/__subdomains/slackdatamineplus/`).
Each item links to its own day (`https://sdmp.izie.top/#2026-10-28`), has a short plain-text `<description>` (counts per category plus any watch-keyword hits, which is what Slack's native RSS bot and reader previews show), the full lists in `<content:encoded>` (with the "…and N more" expanders turned into a link to the site, to keep the feed small), and a `<category>` per category with changes. The feed carries the latest 14 items; the site keeps 90 days. The rendering lives in `src/feed-lib.mjs`.
