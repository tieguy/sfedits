# Deploying to Toolforge

Written 2026-07-29, for the place-bot platform work on branch
`place-bot-platform`. Every command below runs on the Toolforge bastion as the
tool account unless it says otherwise.

Three processes come out of one build:

| Process | What it is | How it runs |
|---|---|---|
| `web` | coverage page + `/create` form | webservice |
| `bot` | the edit watcher | continuous job |
| rebuild | nightly topic refresh | scheduled job |

## 0. Before you start

**Merge the work to a deployable branch.** The build service builds from a git
URL and a branch, so `place-bot-platform` has to be somewhere it can fetch.
Per `CLAUDE.md`, `integration` is the fork's deployable base:

```bash
# on your machine, in the main checkout
git checkout integration
git merge place-bot-platform
npm test                      # 487 passing, 1 pending with the test db up
git push fork integration
```

Never push to `origin` — that is Finn's upstream.

**The tool is `san-francisco-edit-stream`** (settled 2026-07-29), so the
webservice is at `https://san-francisco-edit-stream.toolforge.org` and build
images are `tool-san-francisco-edit-stream/tool-san-francisco-edit-stream`.
That matches what `public/server.js`'s `toolinfo.json` already advertises.
The short form `sfedits` is the **GitHub repo** name and the local checkout —
not the tool.

**This document uses ad-hoc `toolforge jobs run` commands.**
`toolforge-jobs.yaml` declares the same jobs and loads them in one shot with
`toolforge jobs load toolforge-jobs.yaml`. Prefer it — it keeps job definitions
in git and its `command:` values are Procfile entry names, so they cannot drift
from the Procfile. The individual commands below remain the fallback and the
explanation of what each job is for.

**If the `autoupdate` poller is already running on Toolforge, pushing to
`fork/integration` deploys.** That job polls the branch every 15 minutes and
rebuilds when the SHA moves — build, then migrate on the new image, then restart
the bot and the webservice, then record the SHA. A failed build or migration
records nothing and retries on the next tick, so a push is a deploy but a bad
push is not a broken deploy. Step 5 below is only needed for the **first**
deploy, before the poller exists.

## 1. Create the tool and log in

Create the tool at <https://toolsadmin.wikimedia.org/tools/> (one-time, in a
browser). Then:

```bash
ssh login.toolforge.org
become san-francisco-edit-stream
```

## 2. Create the ToolsDB database

**Done for this tool 2026-07-31: the database is `s57894__sfedits`.** The rest
of this section is how it was arrived at, and what a different operator would
do.

The topic store needs a database, and tool-created databases must be named
`{user}__{name}` — the `{user}` prefix is assigned per tool, so it is never the
same as the example in someone else's documentation. Find yours:

```bash
sql tools "SELECT SUBSTRING_INDEX(USER(), \"@\", 1)"   # -> s57894 for this tool
grep user $HOME/replica.my.cnf                          # same value
```

Then create it, substituting your own prefix:

```bash
sql tools "CREATE DATABASE s57894__sfedits CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
```

The collation is not optional: `utf8mb4_bin` matches
`db/migrations/001-initial-schema.sql`, because MediaWiki titles are
case-sensitive after the first character.

Two things about the `sql` helper, each of which costs a confusing error:

- It takes the query as **one positional argument**. `--execute "..."` is parsed
  as query words and silently joined.
- Its first argument is `tools` or a wiki name — **not** a database name.
  `sql s57894__sfedits "SHOW TABLES"` returns "Could not find requested
  database", which is the helper refusing the argument, not ToolsDB saying the
  database is missing. To look inside it: `sql tools "SHOW TABLES FROM
  s57894__sfedits"`.

The database name here must match `topic_store.database` in `SFEDITS_CONFIG`
exactly. A mismatch surfaces as a connection failure in the bot's logs and
reads like a credentials problem.

## 3. Write the config

`SFEDITS_CONFIG` is the whole config as one JSON string, so nothing sensitive
lands in git. Build it in a file first — it is long, and `toolforge envvars
create` prompts for the value rather than taking it on the command line:

```bash
cat > /tmp/sfedits-config.json <<'JSON'
{
  "accounts": [
    {
      "template": "{{page}} was edited by {{name}}",
      "discord": { "webhook_url": "https://discord.com/api/webhooks/…" },
      "pii_blocking": { "enabled": false },
      "watchlist_source": {
        "project": "California/San Francisco Bay Area task force",
        "importance": ["Top", "High"]
      }
    }
  ],
  "topic_store": {
    "host": "tools.db.svc.wikimedia.cloud",
    "database": "s57894__sfedits",
    "connection_limit": 5,
    "max_posts_per_hour": 20
  },
  "web": {
    "invite_codes": ["pick-something-unguessable"],
    "max_articles": 5000
  }
}
JSON

toolforge envvars create SFEDITS_CONFIG < /tmp/sfedits-config.json
rm /tmp/sfedits-config.json
```

Notes that matter:

- **No `user`/`password` under `topic_store`.** The build service injects
  `TOOL_TOOLSDB_USER` and `TOOL_TOOLSDB_PASSWORD`, and `lib/topic-store.js`
  reads those when the config omits them. Keeping credentials out of the config
  is the entire reason `SFEDITS_CONFIG` exists.
- `pii_blocking.enabled: false` is deliberate and settled — this fork relies on
  the revdel sweeper, not the Presidio sidecar. See the design plan.
- **`web.invite_codes` is what opens `/create`.** Omit the whole `web` stanza to
  deploy with the form closed; the coverage page runs either way.
- Confirm afterwards with `toolforge envvars list` (it shows names, not values).

## 4. Build

```bash
toolforge build start https://github.com/tieguy/sfedits --ref integration
toolforge build show                 # watch until it reports success
```

The buildpack reads `Procfile` for `web` and `bot`, and `engines.node` from
`package.json` (now `>=20` — the codebase assumes global `fetch` and
`AbortSignal.timeout`). `.npmrc` sets `puppeteer_skip_download=true` so the
build does not pull ~150MB of Chromium for a renderer this fork never uses; the
native satori/resvg path is what runs. The `Dockerfile` in the repo is **not**
used by the build service — it is for local container runs only.

## 5. Migrate the database

Once, before anything starts, and again after any deploy that adds a migration:

```bash
toolforge jobs run migrate \
  --command "node scripts/migrate.js" \
  --image tool-san-francisco-edit-stream/tool-san-francisco-edit-stream:latest \
  --wait

toolforge jobs logs migrate
```

Expect `applied 1 migration(s); 1 total` the first time and `already up to
date` after. It is safe to re-run: every migration is recorded in
`schema_migrations` and skipped thereafter. `node scripts/migrate.js status`
lists what has been applied without changing anything.

## 6. Start the webservice

```bash
toolforge webservice buildservice start --mount=all
toolforge webservice status
```

Then check, from anywhere:

- `https://san-francisco-edit-stream.toolforge.org/` — the coverage page
- `https://san-francisco-edit-stream.toolforge.org/create` — the form. If it says "Bot creation is
  not enabled here", the `web.invite_codes` list is missing or empty, or
  `topic_store` is absent.
- `https://san-francisco-edit-stream.toolforge.org/api/places.json?q=mission` — place search

## 7. Start the bot

```bash
toolforge jobs run bot \
  --command "node page-watch.js" \
  --image tool-san-francisco-edit-stream/tool-san-francisco-edit-stream:latest \
  --continuous \
  --mem 1Gi

toolforge jobs logs bot
```

The log line to look for is `Topic index: N titles across M topics`. If that
line is missing entirely, the bot did not see a `topic_store` stanza and is
running on account watchlists alone — which is a valid mode, just not the one
you are deploying for.

## 8. Schedule the nightly rebuild

```bash
toolforge jobs run rebuild-topics \
  --command rebuild-topics \
  --image tool-san-francisco-edit-stream/tool-san-francisco-edit-stream:latest \
  --schedule "17 4 * * *" \
  --mem 1Gi
```

`rebuild-topics` is a Procfile entry, so the launcher resolves it and the
command cannot drift from the Procfile. Off-peak and off the hour on purpose:
WDQS is shared, and every tool scheduling `@daily` hits it at midnight
together.

This is what follows renames, picks up new articles, and drops departed ones.
Without it, a topic's list is frozen at whatever the create form resolved.

Optionally, weekly garbage collection of topics nobody subscribes to any more:

```bash
toolforge jobs run gc-topics \
  --command "node scripts/rebuild-topics.js gc" \
  --image tool-san-francisco-edit-stream/tool-san-francisco-edit-stream:latest \
  --schedule "0 4 * * 0"
```

## 9. Smoke test the whole loop

1. Open `/create`, enter your invite code, search a small place (the Mission
   District is `Q7469`, San Mateo County is `Q108101`), paste a **test** Discord
   webhook, submit.
2. Expect `Watching N articles in …`. Two people submitting the same place get
   one topic and two subscriptions — the second is told they joined.
3. Within a minute, `toolforge jobs logs bot` should show the topic index
   reloading with a larger title count.
4. Wait for a real edit to an article in that place and confirm the post lands
   with its embed intact.

Step 4 is the one thing no test covers. Everything up to the moment of posting
is exercised by the suite and was verified locally against a real database.

## Redeploying

```bash
toolforge build start https://github.com/tieguy/sfedits --ref integration
toolforge jobs restart bot
toolforge webservice buildservice restart
# only if the deploy adds a migration:
toolforge jobs run migrate --command "node scripts/migrate.js" \
  --image tool-san-francisco-edit-stream/tool-san-francisco-edit-stream:latest --wait
```

## Things that will go wrong

- **`/create` says it is not enabled.** `web.invite_codes` empty or absent, or
  no `topic_store`. An unconfigured deployment closes creation rather than
  opening it, on purpose.
- **`topic_store needs a user and password`.** The build service did not inject
  `TOOL_TOOLSDB_*`. Confirm the tool has a ToolsDB grant, or set `user` and
  `password` in the stanza as a fallback.
- **Every webhook is refused.** Delivery is allowlisted to `https` on
  `discord.com`, `discordapp.com`, `ptb.discord.com`, `canary.discord.com`,
  path under `/api/webhooks/`. This is the SSRF guard; extend
  `ALLOWED_WEBHOOK_HOSTS` deliberately rather than relaxing the check.
- **A subscription goes quiet.** Five consecutive 4xx (not 429) quarantines it:
  `UPDATE subscriptions SET status = 'active' WHERE id = ?;` after fixing the
  webhook. The subscriber is not currently notified — a known, deliberate gap.
- **Overpass 504s.** Boundary fetches against `overpass-api.de` were flaky in
  testing and took 50–55s against a 60s timeout. Geo-strategy regions are the
  only ones affected; a retry usually works.
- **A place resolves to far fewer articles than expected.** Check whether it took
  the geo strategy when it should have taken admin — see the P279 walk in
  `lib/region.js` and the go/no-go section of `EXECUTION-STATE.md`.

## What is not deployed

- **Wikimedia OAuth** (`lib/mw-oauth.js` exists but is not wired). The invite
  code is the alpha gate.
- **The admin console** (`admin/server.js`). Its Bluesky-DM login cannot work on
  a Discord-only account, so the web process deliberately serves only
  `public/server.js`.
- **The PII sidecar.** Settled: this fork uses the revdel sweeper instead.
