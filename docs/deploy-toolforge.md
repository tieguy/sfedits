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
npm test                      # 656 passing, 0 pending with the test db up
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

Each successful deploy is also appended (SHA, time, and the PR titles it
shipped, via the GitHub compare API) to `$HOME/data/changelog.json`, which the
webservice serves at [/changelog](https://san-francisco-edit-stream.toolforge.org/changelog) —
so "has my PR gone live?" is answerable from a browser instead of a bastion
shell.

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

The database name here must match `topic_store.database` in `config.base.json`
exactly. A mismatch surfaces as a connection failure in the bot's logs and
reads like a credentials problem.

## 3. Stage secrets as environment variables

**Non-secret config** is committed in `config.base.json`. **Secrets live in
environment variables on Toolforge**, set once and managed separately from
git. There are four:

```bash
# The three real secrets (only needed if stanzas exist in config.base.json):
toolforge envvars create SFEDITS_DISCORD_WEBHOOK_URL        # from accounts[0].discord.webhook_url
toolforge envvars create SFEDITS_BLUESKY_PASSWORD          # from accounts[0].bluesky.password
toolforge envvars create SFEDITS_MASTODON_ACCESS_TOKEN     # from accounts[0].mastodon.access_token

# The configuration-level secret (always needed):
toolforge envvars create SFEDITS_INVITE_CODES              # comma-separated codes for /create
```

**Note:** The deployed account is Discord-only. `SFEDITS_BLUESKY_PASSWORD` and
`SFEDITS_MASTODON_ACCESS_TOKEN` are documented for completeness — they are
required only if their corresponding stanzas are added to `config.base.json`.
`SFEDITS_DISCORD_WEBHOOK_URL` and `SFEDITS_INVITE_CODES` are always needed.

Confirm afterwards with `toolforge envvars list` (it shows names, not values).

### Changing config later

The non-secret config lives in `config.base.json` in the repo. Edit it and push;
autoupdate redeploys within 15 minutes.

For secrets, use `toolforge envvars` — each one is independent, so change only
what needs changing:

```bash
umask 077                      # anything written below is 0600
toolforge envvars show --raw SFEDITS_INVITE_CODES
```

**`--raw` is required.** Without it `envvars show` prints a decorated table and
the value is wrapped in quotes, which is confusing.

To update:

```bash
toolforge envvars delete SFEDITS_INVITE_CODES
toolforge envvars create SFEDITS_INVITE_CODES
# (or if you want to script it:)
echo "new-code-1,new-code-2" | toolforge envvars create SFEDITS_INVITE_CODES
```

Between delete and create the variable does not exist. Harmless before
anything is running; once the bot is live, a restart in that window starts it
without that credential.

### Phase 3 cutover check: SFEDITS_CONFIG must be deleted after config split

**This phase rejects `SFEDITS_CONFIG` at startup.** If the old envvar still
exists when the new code starts, every process exits immediately.

**Before pushing this branch to `fork/integration`:**

1. Verify `config.base.json` reflects the deployed config. Values observable from
   `/api/topics.json` are mostly recoverable, but template strings and other
   non-observable values are not:

```bash
# If SFEDITS_CONFIG still exists (it should, until you push):
toolforge envvars show SFEDITS_CONFIG --raw | jq > /tmp/deployed-config.json
# Then diff /tmp/deployed-config.json against config.base.json in the repo
# Reconcile any differences before proceeding
```

2. Stage the four new secret envvars on Toolforge (documented above).

## 4. Build

```bash
toolforge build start https://github.com/tieguy/sfedits --ref integration
toolforge build show                 # watch until it reports success
```

The buildpack reads `Procfile` for `web` and `bot`, and `engines.node` from
`package.json` (now `>=22` — http-cookie-agent@8's own engines floor;
`.node-version` pins 22). Diff rendering uses only satori and resvg (no Chromium
fetched). The `Dockerfile` in the repo is **not** used by the build service — it
is for local container runs only.

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

## 10. Rollout runbook (for the config split to `fork/integration`)

**DO NOT EXECUTE without explicit operator go.** The push to `fork/integration`
is a live deploy within 15 minutes via `autoupdate`. The new code rejects
`SFEDITS_CONFIG`, so order and timing matter.

### Phase 3 cutover: Six-step rollout

**1. Before pushing** — stage the secrets on Toolforge from the current
`SFEDITS_CONFIG` blob (if you haven't already, see section 3 above):

```bash
# Extract the current values
toolforge envvars show SFEDITS_CONFIG --raw | jq -r '.accounts[0].discord.webhook_url' \
  | toolforge envvars create SFEDITS_DISCORD_WEBHOOK_URL

# (Repeat for .accounts[0].bluesky.password and .mastodon.access_token if those stanzas exist)

# And for invite codes
toolforge envvars show SFEDITS_CONFIG --raw | jq -r '.web.invite_codes | join(",")' \
  | toolforge envvars create SFEDITS_INVITE_CODES
```

Also: **KEEP a copy of the `SFEDITS_CONFIG` blob value somewhere safe (NOT in
the repo) for rollback.** The old code reads it; a revert will need it.

**Do NOT delete `SFEDITS_CONFIG` yet** — the running (old) code still reads it.

**2. Merge and test locally:**

```bash
# FETCH FIRST — the local integration branch can be stale (it was, during the
# dry run of this very runbook: fork/integration had a merged PR local didn't).
git fetch fork
git checkout integration
git merge fork/integration     # fast-forward local to the deployed state
git merge delivery-merge
SFEDITS_REQUIRE_DB=1 npm test
# Expected: 676 passing, 0 pending — verified by a trial merge against
# fork/integration@b8e5f9e (656 on delivery-merge + 10 toolforge-api tests +
# 10 claim-watch tests from PR #10; send-alert's test is deleted with its script).
```

**Merge conflicts (verified by trial merge; expect 4):**

Use a trial worktree to verify before pushing (git worktree add .../merge-trial
<temp branch from fork/integration>; merge delivery-merge there; resolve; test;
remove the worktree).

1. **page-watch.js** (content conflict): integration has platform-direct
   code (bluesky, mastodon, discord modules), delivery-merge has the unified
   `deliveryPost` abstraction. **Resolution:** take delivery-merge's version.

2. **scripts/send-alert.js** (modify/delete): integration modified it to read
   SFEDITS_CONFIG via lib/config.js, delivery-merge deleted it in Phase 1
   (PII screening removal). **Resolution:** accept the deletion.

3. **test/posting.test.js** (content conflict): integration added a Bluesky
   300-grapheme truncation test there; that feature and its tests were PORTED
   onto delivery-merge (lib/bluesky-utils.js `fitBlueskyText`, wired in
   lib/bluesky-platform.js), so **Resolution:** take delivery-merge's version —
   nothing is lost.

4. **config.json.template** (modify/delete): deleted by the Phase 3 config
   split. **Resolution:** accept the deletion.

Also `git rm` **test/send-alert.test.js** (its script was deleted; integration
still carries the test file and it fails against the merge result).

**DB note:** Each test run now creates its own throwaway database on the
shared container (LUI-103), so concurrent runs from different worktrees and
branch-specific migrations no longer collide, and there is no reason to
restart the container between runs — `npm run test:db:stop` mid-run **kills
other sessions' suites** (stop also removes the container), so avoid it
unless the container itself is wedged.

**3. On explicit operator go: Push to fork.**

```bash
git push fork integration
# Migration 002 runs via autoupdate
```

**IMPORTANT:** `autoupdate` runs every 15 minutes. The tick that picks up this
push will build the new image, then run its migrate step while `SFEDITS_CONFIG`
is still set. The new code rejects it, so **that tick FAILS**. This is expected
and not an outage signal. Delete `SFEDITS_CONFIG` immediately after the push
(within the same window), and the NEXT tick (≤15 min later) lands the deploy
successfully.

```bash
toolforge envvars delete SFEDITS_CONFIG
```

**4. Verify the deploy:**

```bash
# Check that /changelog shows the new SHA
curl -s https://san-francisco-edit-stream.toolforge.org/changelog | jq '.deploys[0]'

# Check web and bot logs
toolforge webservice buildservice logs      # should show recent restarts
toolforge jobs logs bot                     # watch for '✓ Watchlist sync: N articles' with N>0
```

Look for these lines in the bot log:
- `✓ Watchlist sync: N articles from "…"` (proves config was loaded)
- `filtered:` / `filter-pass:` lines (proves edit filters are working)

Observe one real Discord post (the deployed account is Discord-only).

**Caution (LUI-109):** Watch for `✓ Watchlist sync: 0 articles` or a failed sync — it means the bot came up while the webservice (which serves its watchlist) was unreachable, and the bot will watch nothing for `refresh_hours` (24h). As of LUI-115, `autoupdate` restarts the webservice **before** the bot and waits twice, each bounded by `SFEDITS_WEB_WAIT_TIMEOUT` (default 120s, so worst case ~2×): first for a genuinely **new** webservice pod to report Ready (pod-UID tracking via the k8s API — a URL probe alone can be answered by the old, dying pod), then for the watchlist URL itself to answer. So this should no longer happen on automated deploys — but the probe timing out is alerted, not fatal, so still check the sync line. Manual remedy if it does occur: restart the webservice **first** (`toolforge webservice buildservice restart`), then the bot (`toolforge jobs restart bot`), then re-check the sync line.

**5. After verification: Delete SFEDITS_CONFIG permanently.**

```bash
# Confirm it is actually gone (step 3 deleted it, but verify)
toolforge envvars list | grep SFEDITS_CONFIG

# If it is still there (it shouldn't be), delete it:
toolforge envvars delete SFEDITS_CONFIG

# Restart both processes once more and re-check the watchlist-sync line
# (proves nothing still needed the blob)
toolforge webservice buildservice restart
toolforge jobs restart bot
toolforge jobs logs bot | grep "Watchlist sync"
```

**6. Rollback path (if needed before soak is over):**

```bash
# Revert the merge commit and push
git revert -m 1 <merge-commit-sha>
git push fork integration
# autoupdate redeploys the old code within 15 minutes

# The old code reads SFEDITS_CONFIG, so recreate it from your saved copy:
cat > /tmp/sfedits-config.json <<'JSON'
<paste the blob value>
JSON
toolforge envvars create SFEDITS_CONFIG < /tmp/sfedits-config.json
rm /tmp/sfedits-config.json

# Verify rollback
toolforge jobs logs bot | grep "Watchlist sync"
```

## Redeploying

For routine updates (no config split, autoupdate already running):

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
