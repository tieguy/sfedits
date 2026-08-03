# SF Edits

A Wikipedia edit monitoring bot that watches for edits to San Francisco-related articles and posts screenshots to Bluesky and Mastodon. Includes geolocation enrichment for anonymous edits.

Based on [anon](https://github.com/edsu/anon), originally created for @congressedits.

## Architecture

**Three-service architecture (Node.js + MariaDB):**

1. **Bot service** (Node.js)
   - Monitors Wikipedia EventStreams feed for real-time edits
   - Watches configured SF-related articles via task-force dynamic watchlists and custom lists
   - Renders diff images via satori and resvg (headless, no browser)
   - Delivers posts through a unified delivery layer (Discord, Bluesky, Mastodon) with per-subscription edit filters
   - Syncs with MariaDB topic store for multi-region, multi-subscriber support

2. **Web service** (Node.js/Express)
   - Public coverage page listing monitored places
   - Self-serve `/create` form (invite-code gated) for multi-region subscriptions
   - Webservice API for watchlist and topic status
   - Admin console disabled (would need Bluesky DM auth; current deployment is Discord-only)

3. **Database** (MariaDB, Toolforge ToolsDB)
   - Persistent subscriptions and topic store
   - Schema migrations via Procfile `migrate` entry
   - Topics (region + filters) and subscriptions (user + webhook + edit_filters)

The old droplet deployment (docker-compose, `deploy.sh`, Dockerfiles) was
removed 2026-08-03 — it had been broken since the PII/Puppeteer removals.
Toolforge is the only supported deployment path; git history keeps the files.

## How it works

1. Bot detects Wikipedia edit
2. Fetches diff HTML and verifies it matches the claimed article
3. Enriches IP with country flag, takes screenshot, posts to both platforms

## Setup

### 1. Create configuration

**Non-secret config** is committed in `config.base.json`. **Secrets** come from
environment variables, never from `config.json` (which is gitignored and local
only). The loader reads `config.base.json`, merges any local `config.json`
overrides, then reads secrets from env vars.

**For local development:** Create `config.json` with only the fields you want
to override (most commonly, secrets):

```json
{
  "accounts": [
    {
      "discord": {
        "webhook_url": "https://discord.com/api/webhooks/…"
      }
    }
  ]
}
```

To develop with Bluesky or Mastodon in addition, add them the same way (they're
omitted from `config.base.json` since production runs Discord-only):

```json
{
  "accounts": [
    {
      "bluesky": {
        "identifier": "your-username.bsky.social",
        "password": "your-app-password"
      },
      "mastodon": {
        "instance": "https://your-instance.social",
        "access_token": "your-access-token",
        "visibility": "unlisted"
      },
      "discord": {
        "webhook_url": "https://discord.com/api/webhooks/…"
      }
    }
  ]
}
```

**For Toolforge:** Secrets are injected via environment variables (set via
`toolforge envvars`). The bot reads them at startup and merges them into the
config:

```bash
# Set once on Toolforge (not in the code):
toolforge envvars create SFEDITS_DISCORD_WEBHOOK_URL "https://discord.com/api/webhooks/…"
toolforge envvars create SFEDITS_INVITE_CODES "code1,code2"
# Only if the corresponding stanzas are in config.base.json:
# toolforge envvars create SFEDITS_BLUESKY_PASSWORD "your-password"
# toolforge envvars create SFEDITS_MASTODON_ACCESS_TOKEN "your-token"
```

### 2. Run locally

```bash
npm install
node page-watch.js --noop  # Test mode - doesn't post
```

Node 22+ is required (`engines` enforces it; `.node-version` pins 22 for
deployment). The `overrides` block in `package.json` forcing
`http-cookie-agent@^8` and `undici@^7` is **load-bearing**: m3api pins
`http-cookie-agent@^6`, which silently hangs every Wikimedia API request —
no error, no timeout — on Node ≥ 24 (bundled undici ≥ 7). Do not drop or
relax those overrides in an audit fix or dependency bump.

### 3. Deploy to Toolforge

The primary deployment target is Toolforge (Wikimedia Cloud Services). See
`docs/deploy-toolforge.md` for the full runbook.

**TL;DR:**

1. Ensure `config.base.json` reflects the desired non-secret config
2. Set secrets via `toolforge envvars`: `SFEDITS_DISCORD_WEBHOOK_URL`,
   `SFEDITS_INVITE_CODES`, etc.
3. Push to `fork/integration` — `autoupdate` builds and deploys within 15 minutes
4. Migrations run automatically via the `migrate` Procfile entry
5. Check `/changelog` for deploy history

## Toolforge Management

**View logs:**
```bash
ssh login.toolforge.org
become san-francisco-edit-stream

toolforge jobs logs bot
toolforge jobs logs web
```

**Change config:**
- Non-secret: Edit `config.base.json` and push to `fork/integration`
- Secrets: Use `toolforge envvars delete/create` to update secrets

**Restart processes:**
```bash
toolforge webservice buildservice restart
toolforge jobs restart bot
toolforge jobs restart rebuild-topics
```

**Monitor deployment:**
```bash
# Check autoupdate progress
toolforge jobs logs autoupdate

# View deployment history
curl -s https://san-francisco-edit-stream.toolforge.org/changelog | jq '.deploys[:5]'
```

## Configuration

**Structure:** `config.base.json` (committed) + `config.json` (gitignored, local
dev only) + environment variables (Toolforge secrets).

1. Load `config.base.json` from the repo
2. Merge `config.json` overrides (if present locally)
3. Inject secrets from environment variables (`SFEDITS_DISCORD_WEBHOOK_URL`,
   `SFEDITS_BLUESKY_PASSWORD`, `SFEDITS_MASTODON_ACCESS_TOKEN`,
   `SFEDITS_INVITE_CODES`)

**Important:** Never commit `config.json` — it's gitignored and holds your local
credentials. Never commit secrets to the repo; use environment variables instead.

**Array replacement:** When `config.json` contains an `accounts` array, it
**replaces** the base array wholesale — list every account you want to keep.
For example, overlaying `{"accounts":[{"discord":{"webhook_url":"..."}}]}` over
a two-account base yields one account, not two.

**Delivery layer:** Each account has a `deliveries` array specifying where edits
go (platform webhook/credentials). Two kinds of edit filters exist:
- **Config-level** (per delivery, in `config.base.json`): `deliveries[].edit_filters` — 
  optional filters hardcoded in the config.
- **Subscription-level** (per topic subscriber, in the database): independent of 
  config — set via `lib/topic-store.js` or direct SQL. See `docs/config-topic-store.md`.

### Edit Collapsing

When someone does an intense editing session on a watched article, posting every revision floods the feed. Edit collapsing (on by default) throttles this to at most two posts per 15-minute window per article/editor:

- The **first edit** in a burst posts immediately, as before.
- Further edits to the **same article by the same editor** within the next 15 minutes are buffered.
- When the window closes, the buffer posts as **one combined post** ("edited 5 times by...") whose diff link and rendered image span all the buffered revisions (`?diff=<newest>&oldid=<pre-burst>`).
- If the burst is still going, a new window opens, so sustained activity produces at most one combined post per window.
- On Bluesky and Mastodon, combined posts are **threaded as replies** to the burst's first post (`reply.root`/`reply.parent` refs on Bluesky, `in_reply_to_id` on Mastodon), so a long session reads as one thread. The thread root stays the first post; each combined post replies to the previous one. If a post fails or is blocked on one platform, later posts thread under the last one that succeeded there (or post standalone if none did). Discord posts via incoming webhook, which cannot create replies, so collapsed posts appear there as ordinary messages — collapsing still cuts the message count.

Configure per account with the optional `collapse` stanza:

```json
"collapse": {
  "enabled": true,
  "window_minutes": 15,
  "template": "{{{page}}} Wikipedia article edited {{count}} times by {{{name}}} {{&url}}"
}
```

- `enabled`: set to `false` to post every edit individually (pre-collapsing behavior).
- `window_minutes`: collapse window length (default 15).
- `template`: Mustache template for combined posts; `{{count}}` is the number of collapsed edits. Defaults to the template shown above.

Buffered edits and thread refs are held in memory, so restarting the bot drops any not-yet-posted buffer, and a burst spanning a restart starts a fresh thread. Combined posts go through the same diff verification as single-edit posts, applied to the combined diff. For the revdel sweeper, a combined post is recorded in the post log under **every** revision it covers, so hiding any one of them on-wiki takes the combined post down.

### Dynamic Watchlist (WikiProject task forces)

Instead of (or in addition to) hard-coding articles in `watchlist`, an account
can pull its article list from a WikiProject / task force via the
[PageAssessments API](https://www.mediawiki.org/wiki/Extension:PageAssessments):

```json
"watchlist_source": {
  "project": "California/San Francisco Bay Area task force",
  "wikipedia": "English Wikipedia",
  "importance": ["Top", "High"],
  "refresh_hours": 24
}
```

- `project` - the PageAssessments project name (task force banners on article
  talk pages register articles under this name)
- `importance` - optional filter; large task forces tag 10,000+ articles, so
  filtering to Top/High keeps the bot from becoming a firehose. Omit to watch
  everything.
- `refresh_hours` - how often to re-fetch the list (default 24)

The fetched list is cached to `data/watchlist-<project>.json`, so restarts and
Wikipedia API outages fall back to the last good list. Static `watchlist`
entries are always honored in addition to the dynamic list.

### Discord Setup

To post to a Discord channel, create an incoming webhook (channel settings →
Integrations → Webhooks → New Webhook) and add it to the account:

```json
"discord": {
  "webhook_url": "https://discord.com/api/webhooks/..."
}
```

Discord posts are rich embeds (no platform length squeeze): article title
and Wikidata description, editor link, change counts, quoted added/removed
excerpts, the article's lead image as a thumbnail, and the diff screenshot.

No bot user or OAuth setup is needed - webhooks are per-channel URLs. Posts
include the edit screenshot as an attachment, with the article and editor as
clickable links.

### Bluesky Setup

To set up Bluesky posting:

1. Go to Bluesky Settings → App Passwords → Add App Password
2. Copy the app password to your config.json

### Mastodon Setup

To set up Mastodon posting:

1. Go to your Mastodon instance's settings → Development → New Application
2. When selecting scopes, choose:
   - `write:media` - upload media files
   - `write:statuses` - publish posts
3. Copy the access token to your config.json

**Post visibility:** community instances often want bots posting `unlisted` so
automated posts stay off the local timeline (posts still appear on the bot's
profile, to followers, and in threads). Set it per account:

```json
"mastodon": {
  "instance": "https://sfba.social",
  "access_token": "your-access-token",
  "visibility": "unlisted"
}
```

Accepted values are Mastodon's: `public`, `unlisted`, `private` (followers
only). Omit the key to use the server's default (normally public). This
applies to regular posts and collapsed/threaded posts.

## Monitored Articles

Currently configured to monitor SF political figures across **10 language Wikipedias**:
- **English**: SF Board of Supervisors, mayors, city officials, state legislators
- **Arabic, Chinese, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish**: Translations of major political figures

The config includes:
- Current and recent SF mayors (Breed, Newsom, Lee, etc.)
- All current Board of Supervisors members
- Key city officials (DA, Sheriff, Police Commission)
- Major historical figures (Feinstein, Moscone, Willie Brown)
- State/federal legislators (Pelosi, Wiener, Harris)
- Corruption scandals and investigations

Use the translation scripts to expand to additional languages or discover new articles to monitor.

## Development

### Testing

The codebase has comprehensive test coverage to ensure reliability:

```bash
npm test  # Run all tests (~3 seconds)
```

**Test suite:**
- **72 passing tests** covering posting flow, text transformations, and URL helpers
- **Integration test** that mocks Bluesky/Mastodon APIs and validates end-to-end posting
- **Unit tests** for platform modules, text pipeline, geolocation, facet building, and URL generation

Tests use:
- `mocha` + `chai` for test framework and assertions
- `nock` for HTTP API mocking (Bluesky, Mastodon)
- `proxyquire` for dependency injection
- `sinon` for function stubbing

**When to run tests:**
- Before committing changes
- After modifying posting flow or text transformations
- Before refactoring or extracting code to `lib/`

### Local Development

```bash
npm install                 # Install dependencies
npm test                    # Run tests
node page-watch.js --noop   # Test mode - doesn't post
node page-watch.js --verbose # Show all edit activity
```

A plain clone pulls the live production watchlist from `config.base.json` (harmless with `--noop`). To change the watchlist locally, override `watchlist_source` in your `config.json`.

**Test mode (`--noop`):**
- Monitors Wikipedia edits in real-time
- Logs what would be posted
- Doesn't actually post to Bluesky/Mastodon
- Useful for testing config changes

## Scripts

### `scripts/find-categories.js`

Analyzes Wikipedia categories for all articles in your config to help identify patterns for finding equivalent articles across different language Wikipedias.

```bash
node scripts/find-categories.js
```

This script:
- Fetches categories for each article in your English Wikipedia watchlist
- Helps identify common category patterns (e.g., "San Francisco Board of Supervisors members")
- Useful for expanding monitoring to other language Wikipedias

### `scripts/find-articles-in-categories.js`

Finds all Wikipedia articles within specified categories. Can be used standalone or piped from the category finder to discover related articles.

```bash
# Use with specific categories
node scripts/find-articles-in-categories.js "Mayors of San Francisco" "California politicians"

# Pipe from category finder to discover articles in all found categories
node scripts/find-categories.js | node scripts/find-articles-in-categories.js
```

This script:
- Takes category names as input and finds all articles in those categories
- Supports piping from find-categories.js output
- Useful for discovering related political figures to add to your watchlist
- Provides summary of unique articles across all categories

### `scripts/find-translations.js`

Finds all Wikipedia language translations for articles in your config. Helps discover equivalent articles across different language Wikipedias.

```bash
node scripts/find-translations.js
```

This script:
- Analyzes all articles in your current config
- Finds translations in other language Wikipedias
- Shows language codes and translated article titles
- Useful for expanding monitoring to multiple language Wikipedias

## License

CC0 - Public Domain