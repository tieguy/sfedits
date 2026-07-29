# `topic_store` configuration

Optional. Without it the bot runs on account watchlists alone, exactly as it
did before the place-bot platform work.

```json
{
  "topic_store": {
    "host": "tools.db.svc.wikimedia.cloud",
    "port": 3306,
    "database": "s51234__sfedits",
    "connection_limit": 5
  }
}
```

`user` and `password` may be set here, but on Toolforge they are better left
out — the build service injects `TOOL_TOOLSDB_USER` and `TOOL_TOOLSDB_PASSWORD`,
and `lib/topic-store.js` reads those when the config omits them. Keeping
credentials out of `config.json` is why `SFEDITS_CONFIG` exists.

Local development against the test container:

```json
{
  "topic_store": {
    "host": "127.0.0.1",
    "port": 3307,
    "database": "sfedits_test",
    "user": "root",
    "password": "sfedits-test"
  }
}
```

Start that container with `npm run test:db:start`.

## Operational notes

- The index refreshes every 60 seconds, but only rebuilds when the store's
  generation has actually moved — an idle bot does one cheap `SUM(generation)`
  query a minute, not a full index rebuild.
- A failed refresh keeps the previous index and logs. The bot degrades to
  slightly stale rather than to watching nothing.
- Topics with no active subscription are excluded from the index. There is
  nowhere to deliver them, so matching them would only waste a render.
- Migrations are applied by `lib/db.js`'s `migrate(pool)`. They are immutable
  once shipped: a schema change adds `db/migrations/002-*.sql` rather than
  editing `001`, which is already recorded in `schema_migrations`.

## Delivery limits

```json
{
  "topic_store": {
    "max_posts_per_hour": 20,
    "rate_window_ms": 3600000
  }
}
```

Both are optional; the defaults are 20 posts per hour per subscription.

The cap is per **subscription**, not per topic or per bot. Two people
subscribed to the same busy topic each get their own budget, so one
oversized bot cannot consume another's.

When a subscription exceeds its cap, posts are suppressed and counted. Once
the window rolls over, the subscriber gets a single summary embed —
"…and N more edits not shown (rate cap)" — which names the likely cause,
since an oversized region is what usually produces it.

## Webhook URLs

Delivery URLs are allowlisted: `https` only, to `discord.com`,
`discordapp.com`, `ptb.discord.com`, or `canary.discord.com`, with a path under
`/api/webhooks/`. Anything else is refused before a request is made.

This is not tidiness. From Phase 5 on the URL is a string a stranger typed, and
fetching an arbitrary URL from a Toolforge-resident process is a server-side
request forgery primitive — `http://127.0.0.1:…`, link-local metadata
endpoints, and `*.svc.wikimedia.cloud` are all reachable from inside Cloud
Services and not from outside. The check runs at delivery time, not only at
insert, because the process making the request is the only place it cannot be
bypassed.

## Broken subscriptions

A subscription whose webhook returns a 4xx (other than 429) five times in a
row is marked `status = 'broken'` and stops receiving posts.
`subscriptionsForTopic()` filters to active subscriptions, so quarantine takes
effect immediately and survives a restart.

Transient failures — 5xx, timeouts, 429 — never count toward this. Discord
having a bad hour must not disable a working bot.

**The subscriber is not currently told their bot went quiet.** This is a known
gap, deferred deliberately: see "Credential death" in
`docs/design-plans/2026-07-23-place-bot-platform.md`. The likely answer is a
low-frequency notice to the creator's user talk page, but a bot that edits
talk pages is itself subject to bot-editing norms and needs its own design.

To re-enable a repaired subscription:

```sql
UPDATE subscriptions SET status = 'active' WHERE id = ?;
```
