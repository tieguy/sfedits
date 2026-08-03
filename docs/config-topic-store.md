# `topic_store` configuration

Optional. Without it the bot runs on account watchlists alone, exactly as it
did before the place-bot platform work.

```json
{
  "topic_store": {
    "host": "tools.db.svc.wikimedia.cloud",
    "port": 3306,
    "database": "s57894__sfedits",
    "connection_limit": 5
  }
}
```

`user` and `password` may be set here, but on Toolforge they are better left
out — the build service injects `TOOL_TOOLSDB_USER` and `TOOL_TOOLSDB_PASSWORD`,
and `lib/topic-store.js` reads those when the config omits them. Keeping
secrets out of git is why they live in environment variables; non-secret config
lives in the committed `config.base.json`.

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

## Edit filters (per-subscription)

Subscriptions can filter edits before rendering and posting. Each subscription
has its own filters, independent of the topic and of other subscriptions to the
same topic.

Filters live in the `edit_filters` column (JSON) on the subscription row. They
default to `null` (no filtering). Set them via direct database UPDATE, or
programmatically via `lib/topic-store.js`'s `setSubscriptionFilters` method:

```sql
UPDATE subscriptions SET edit_filters = JSON_OBJECT('bots', false, 'minor', false)
  WHERE id = ?;
```

Schema:

```jsonc
{
  "bots": false,           // Drop bot edits (true/absent = allow)
  "minor": false,          // Drop minor edits (true/absent = allow)
  "min_delta": 0,          // Drop edits with |delta| < this (0/absent = allow all)
  "cosmetic_only": false   // Drop cosmetic-only diffs (true = drop, false/absent = allow)
}
```

**Polarity note:** `bots` and `minor` are "allow?" booleans (`false` = drop that
class). `min_delta` is a floor (drop smaller edits). `cosmetic_only` is an
opt-in switch (`true` = drop cosmetic-only, `false`/absent = allow). Absent or
`null` = no filtering for that field.

**normalizeEditFilters:** The `min_delta` field is coerced to a Number, so the
string `"100"` is accepted and treated as the number 100. Unknown delta or
missing delta passes (conservative bias — if filtering is unclear, post). All
filters are case-sensitive per field.

**Default (SF account):** `{ "bots": false, "minor": false }` — SF edits bot
drops bot edits and minor edits, matching the historical watchlist behavior.
Other subscriptions can override with different rules.

The filter is **not** part of `filters_hash`, so two subscriptions with
different `edit_filters` to the same region-filter pair share one topic row —
the topic's articles are resolved once, each edit is rendered once, but
delivery is filtered per subscription.

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

## Self-serve bot creation (`/create`)

```json
{
  "web": {
    "invite_codes": ["sfba-alpha-2026"],
    "max_articles": 5000
  }
}
```

`/create` and its APIs stay **off** unless both a `topic_store` stanza and at
least one invite code are configured — a deployment with neither runs as the
read-only coverage page it always was. An empty `invite_codes` list closes
creation rather than opening it.

`max_articles` (default 5,000) is the region-size refusal. It is not tidiness:
California resolves cleanly to 24,346 English articles in about 16 seconds, so
nothing about the query itself stops someone from pointing a firehose at their
own Discord channel. The estimate shown before submission comes from the same
histogram the refusal uses.

Codes are shared secrets, not accounts. Revoking one: remove it from the list
and run `toolforge envvars create SFEDITS_INVITE_CODES <new-list>`, then restart
the webservice. **Wikimedia OAuth replaces this** — see Phase 6 in the design
plan; the form's shape does not change when it lands, only where `owner_user`
comes from.

Two people who ask for the same place with the same languages get **one topic
and two subscriptions**: the region is resolved once, each edit is rendered
once, and the second person is told they joined rather than created.
