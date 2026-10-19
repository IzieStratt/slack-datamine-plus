# slack-datamine-plus

Scheduled miner for Slack's web client bundle.

> **License:** [AGPL-3.0](LICENSE). Free software for everyone: individuals, schools, non-profits and companies alike.

Why it exists: [`3kh0/slack-datamine`](https://github.com/3kh0/slack-datamine) is great, but since 2026-07-24 its chunk discovery has found 14 chunks instead of ~1,500, so its recent builds list ~250 methods instead of ~1,750. This miner crawls from the client HTML, treats the known-bad `gantry-v2.<hash>.min.js` names (403 on the CDN even in old builds) as "phantom", and **refuses to write anything** if fewer than `MIN_CHUNKS` (300) real chunks were fetched, so a broken parse can't silently erase the history.

## If this helped you

If this helped you in any way, I'd love for you to shoot me an email at SlackDataminePlus@izie.top, (if theres any improvements you want lmk!) a link back to this repo, or a star all tell me people actually use this, plus they make me smile :) This isn't something you're forced to do, the license is still AGPL-3.0, it's just a request.

## ReDocumented
If you're looking for a list of all the weird and badly/undocumented API methods in Slack check out https://vs.izie.top/redocumented.
