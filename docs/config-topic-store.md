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
