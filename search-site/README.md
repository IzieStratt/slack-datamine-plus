# Search page (not deployed)

`node src/search-page.mjs` writes `search-site/dist/index.html`: one self-contained page (no external requests, data inlined) to
search every list tracked in `build/history.tsv`, with first-seen / removed dates and, for API methods and flags, the platforms from
`build/cross-platform.json`. `dist/` is git-ignored. Open it straight from disk to try it.

How it would be published (not wired up): the live site is personal-site, so the `feed` workflow would run
`node src/search-page.mjs --out personal-site/website/public/__subdomains/slackdatamineplus/search.html`
before its "Publish" step (history.tsv is already committed by `mine`), and the feed page's links would gain `['search', 'Search']` (the site serves `search.html` as `/search`).
The page is ~2.7 MB (~0.5 MB gzipped); if that is too heavy, split the inlined JSON out per category and fetch it on demand.
