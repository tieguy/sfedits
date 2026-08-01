# Place-Bot Platform Implementation Plan — Phase 2: Topic Store

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Durable, queryable topic/subscription storage on MariaDB, plus the in-RAM watch index the bot's hot path reads.

**Architecture:** Four tables — `topics`, `articles`, `topic_articles`, `subscriptions` — behind `lib/topic-store.js`. Topics deduplicate on a normalized filters hash so two users wanting the same feed share one row and one rebuild. Subscriptions carry per-user delivery, and a topic is garbage-collected when its last subscription leaves.

**Tech Stack:** MariaDB (ToolsDB in production, a podman container in tests), the official `mariadb` npm connector, mocha/chai.

**Scope:** Phase 2 of 5 (Plan A).

**Codebase verified:** 2026-07-23 04:27 PDT, branch `place-bot-platform`.

---

## Context the executing engineer needs

**Verified codebase facts:**

- There is **no database code anywhere in this repo**. No driver in `package.json`, no SQL, no `db/` or `migrations/` directory. This phase establishes the first pattern.
- `lib/config.js:37-57` defines `loadConfig({ path, env } = {})`. It resolves config from an explicit path, then `SFEDITS_CONFIG`, then `./config.json`. It performs **no schema validation** — modules read their own stanza on demand (`lib/watchlist-sync.js:126` reads `account.watchlist_source`; `lib/wikidata-claim-watch.js:309` reads `account.wikidata_claims`). A `topic_store` stanza follows the same convention and needs no changes to `lib/config.js`.
- Test convention for disposable state is a temp dir via `fs.mkdtempSync` (`test/watchlist-sync.test.js:38-45`). There is no precedent for containers or for skipping tests when infrastructure is unavailable — this phase introduces one, deliberately and visibly.

**External research findings:**

- Use the **official `mariadb` connector**, not `mysql2`. It is purpose-built for MariaDB, its Promise API is the default, and it supports pooling and a batch API. Source: <https://mariadb.com/docs/connectors/mariadb-connector-nodejs>
- **ToolsDB**: host `tools.db.svc.wikimedia.cloud`, credentials in `$HOME/replica.my.cnf`, tool-created databases must be named `{user}__{name}` (e.g. `s51234__sfedits`). Source: <https://wikitech.wikimedia.org/wiki/Help:Toolforge/Database>
- **Under the build service**, ToolsDB credentials are also exposed as the env vars `TOOL_TOOLSDB_USER` and `TOOL_TOOLSDB_PASSWORD`. This is the path the fork will use, since it deploys via build service. Both mechanisms are supported below.
- Toolforge connection budget is modest — a pool limit of 5 is the documented recommendation.

**Decision recorded:** tests run against a **real MariaDB in podman**, not SQLite and not mocks. The value of this phase is concentrated in the schema and the queries — the `UNIQUE` constraint that makes dedup work, the M:N join, the GC cascade. SQLite would run a different dialect than production, and mocks would verify nothing. Tests report as **pending** when the database is unreachable, so `npm test` is green on a machine that has never run a container — while a skipped database suite stays visible in the report and is never mistaken for a passing one.

---

## Task 1: Database dependency and test container

**Type:** Infrastructure — verify operationally, no unit tests.

**Files:**
- Modify: `package.json` (dependencies, and a new `scripts` entry)
- Create: `scripts/test-db.sh`

**Step 1: Install the driver**

```bash
npm install --save mariadb
```

**Step 2: Create the test database helper**

Create `scripts/test-db.sh`:

```bash
#!/usr/bin/env bash
#
# Disposable MariaDB for the topic-store tests.
#
# The topic store's value is in its schema and queries - the UNIQUE constraint
# that makes topic dedup work, the M:N join, the GC cascade. Testing that
# against SQLite or a mock would test a different thing, so the tests want a
# real MariaDB. This starts a throwaway one; the database suites report as
# pending when it is not running.
#
# Usage:
#   scripts/test-db.sh start
#   scripts/test-db.sh stop
#   scripts/test-db.sh status

set -euo pipefail

CONTAINER=sfedits-test-db
IMAGE=docker.io/library/mariadb:11
PORT=3307
ROOT_PASSWORD=sfedits-test
DATABASE=sfedits_test

case "${1:-status}" in
  start)
    if podman container exists "$CONTAINER" 2>/dev/null; then
      podman start "$CONTAINER" >/dev/null
    else
      podman run -d \
        --name "$CONTAINER" \
        -e MARIADB_ROOT_PASSWORD="$ROOT_PASSWORD" \
        -e MARIADB_DATABASE="$DATABASE" \
        -p "${PORT}:3306" \
        "$IMAGE" >/dev/null
    fi

    printf 'waiting for mariadb on port %s' "$PORT"
    for _ in $(seq 1 60); do
      if podman exec "$CONTAINER" mariadb-admin ping \
           -uroot -p"$ROOT_PASSWORD" --silent >/dev/null 2>&1; then
        echo " ready"
        echo
        echo "export SFEDITS_TEST_DB='mysql://root:${ROOT_PASSWORD}@127.0.0.1:${PORT}/${DATABASE}'"
        exit 0
      fi
      printf '.'
      sleep 1
    done
    echo " timed out" >&2
    exit 1
    ;;

  stop)
    podman stop "$CONTAINER" >/dev/null 2>&1 || true
    podman rm "$CONTAINER" >/dev/null 2>&1 || true
    echo "stopped and removed $CONTAINER"
    ;;

  status)
    if podman exec "$CONTAINER" mariadb-admin ping \
         -uroot -p"$ROOT_PASSWORD" --silent >/dev/null 2>&1; then
      echo "running on port $PORT"
    else
      echo "not running (start it with: scripts/test-db.sh start)"
      exit 1
    fi
    ;;

  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
```

Make it executable:

```bash
chmod +x scripts/test-db.sh
```

**Step 3: Fix the test glob BEFORE adding any file under `test/`**

**Do this step before Task 2. Skipping it silently disables the entire test suite, and every later phase gates on that suite.**

`package.json:30` currently reads:

```json
    "test": "mocha --colors --reporter spec --exit test/**/*.js",
```

The glob is **unquoted**, so `sh` expands it before mocha ever sees it — and without `globstar`, `**` degrades to `*`, making the pattern mean `test/*/*.js`. Today that matches nothing (`test/fixtures/` holds only JSON), so the unexpanded pattern falls through to mocha, which does its own recursive globbing. That is the only reason the suite currently works.

The moment a `.js` file exists in a subdirectory of `test/` — which Task 2 is about to create — the shell expands the pattern to *exactly that one file* and mocha runs only it. Verified on this machine:

```
$ mkdir -p test/helpers && echo "module.exports = {}" > test/helpers/probe.js
$ sh -c 'echo test/**/*.js'
test/helpers/probe.js
$ npm test
  0 passing (1ms)
```

The suite reports green while running zero tests. Quote the glob so mocha does the globbing, and ignore the helpers directory explicitly.

Replace the whole `scripts` block with:

```json
  "scripts": {
    "test": "mocha --colors --reporter spec --exit --ignore 'test/helpers/**' 'test/**/*.js'",
    "test:db:start": "scripts/test-db.sh start",
    "test:db:stop": "scripts/test-db.sh stop",
    "start": "node page-watch.js",
    "mastodon": "node utils/mastodon.js"
  },
```

Verify the fix holds with a subdirectory file present:

```bash
mkdir -p test/helpers && echo "module.exports = {}" > test/helpers/probe.js
npm test
rm -rf test/helpers
```
Expected: the full suite count from the end of Phase 1, **not** `0 passing`. If you see a small number, the quoting did not land.

**Step 4: Verify operationally**

Run:
```bash
npm run test:db:start
```
Expected: `waiting for mariadb on port 3307.... ready`, followed by an `export SFEDITS_TEST_DB=...` line.

Run:
```bash
scripts/test-db.sh status
```
Expected: `running on port 3307`

Run:
```bash
npm test
```
Expected: unchanged from the total you recorded at the end of Phase 1, 0 failing

**Step 5: Commit**

```bash
git add package.json package-lock.json scripts/test-db.sh
git commit -m "chore: add mariadb driver and disposable test database

Topic-store tests run against a real MariaDB rather than SQLite or mocks -
the schema constraints and joins are the thing under test, and a different
dialect would test a different thing."
```

---

## Task 2: Schema and migration runner

**Files:**
- Create: `db/migrations/001-initial-schema.sql`
- Create: `lib/db.js`
- Create: `test/db.test.js`

**Step 1: Write the schema**

Create `db/migrations/001-initial-schema.sql`:

```sql
-- Place-bot platform schema.
--
-- Two people who want the same feed share one topic, one rebuild, and one
-- diff render; they differ only in their subscription. That is the whole
-- reason topics and subscriptions are separate tables.
--
-- utf8mb4 throughout: article titles are arbitrary Unicode.

CREATE TABLE IF NOT EXISTS topics (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  region_qid      VARCHAR(32)     NOT NULL,
  filters_hash    CHAR(64)        NOT NULL,
  entity_filters  JSON            NULL,
  languages       JSON            NULL,
  strategy        VARCHAR(16)     NOT NULL DEFAULT 'auto',
  generation      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  display_name    VARCHAR(255)    NULL,
  last_built_at   DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The dedup key. Hash is over NORMALIZED inputs, so "Mission+places+en"
  -- and "Mission+en+places" collide into one row rather than two feeds.
  UNIQUE KEY uq_topic_region_filters (region_qid, filters_hash),
  KEY idx_topic_region (region_qid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS articles (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wikipedia     VARCHAR(32)     NOT NULL,
  title         VARCHAR(512)    NOT NULL,
  wikidata_qid  VARCHAR(32)     NULL,
  PRIMARY KEY (id),
  -- Identity is the QID, but the hot path matches on title, so both are
  -- indexed. utf8mb4_bin collation because MediaWiki titles are
  -- case-sensitive after the first character.
  -- NULL wikidata_qid bypasses this constraint entirely (SQL treats NULLs as
  -- distinct). Nothing in Plan A inserts a QID-less article, and identity in
  -- this design IS the QID - but if a later phase needs QID-less rows, it must
  -- add a new migration with a different uniqueness strategy rather than
  -- assuming this one covers them.
  UNIQUE KEY uq_article_wiki_qid (wikipedia, wikidata_qid),
  KEY idx_article_wiki_title (wikipedia, title(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS topic_articles (
  topic_id    BIGINT UNSIGNED NOT NULL,
  article_id  BIGINT UNSIGNED NOT NULL,
  source      VARCHAR(32)     NOT NULL,
  score       FLOAT           NULL,
  added_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at  DATETIME        NULL,
  PRIMARY KEY (topic_id, article_id, source),
  KEY idx_ta_article (article_id),
  KEY idx_ta_live (topic_id, removed_at),
  CONSTRAINT fk_ta_topic FOREIGN KEY (topic_id)
    REFERENCES topics (id) ON DELETE CASCADE,
  CONSTRAINT fk_ta_article FOREIGN KEY (article_id)
    REFERENCES articles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS subscriptions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  topic_id         BIGINT UNSIGNED NOT NULL,
  owner_user       VARCHAR(255)    NOT NULL,
  delivery_type    VARCHAR(32)     NOT NULL,
  delivery_config  JSON            NOT NULL,
  display_name     VARCHAR(255)    NULL,
  status           VARCHAR(16)     NOT NULL DEFAULT 'active',
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sub_topic (topic_id),
  KEY idx_sub_owner (owner_user),
  CONSTRAINT fk_sub_topic FOREIGN KEY (topic_id)
    REFERENCES topics (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL,
  applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Step 2: Write the failing test**

Create `test/db.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, before, after } = require('mocha')

const { connect, migrate, testDsn, describeWithDb } = require('./helpers/db-helper')

describeWithDb('db migrations', function() {
  this.timeout(30000)

  let pool

  before(async function() {
    pool = await connect(testDsn())
  })

  after(async function() {
    if (pool) await pool.end()
  })

  it('creates every table', async function() {
    await migrate(pool)

    const rows = await pool.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()')
    const tables = rows.map(r => String(r.t))

    for (const expected of
      ['topics', 'articles', 'topic_articles', 'subscriptions', 'schema_migrations']) {
      assert.include(tables, expected)
    }
  })

  it('is idempotent', async function() {
    await migrate(pool)
    await migrate(pool)

    const rows = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations')
    assert.equal(Number(rows[0].n), 1)
  })

  it('cascades topic deletion to memberships and subscriptions', async function() {
    await migrate(pool)

    const topic = await pool.query(
      `INSERT INTO topics (region_qid, filters_hash) VALUES (?, ?)`,
      ['Q62', 'a'.repeat(64)])
    const topicId = topic.insertId

    const article = await pool.query(
      `INSERT INTO articles (wikipedia, title, wikidata_qid) VALUES (?, ?, ?)`,
      ['en', 'Alpha', 'Q10'])

    await pool.query(
      `INSERT INTO topic_articles (topic_id, article_id, source) VALUES (?, ?, ?)`,
      [topicId, article.insertId, 'admin'])
    await pool.query(
      `INSERT INTO subscriptions (topic_id, owner_user, delivery_type, delivery_config)
       VALUES (?, ?, ?, ?)`,
      [topicId, 'Example', 'discord', JSON.stringify({ webhook_url: 'https://x/y' })])

    await pool.query('DELETE FROM topics WHERE id = ?', [topicId])

    const ta = await pool.query(
      'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ?', [topicId])
    const subs = await pool.query(
      'SELECT COUNT(*) AS n FROM subscriptions WHERE topic_id = ?', [topicId])

    assert.equal(Number(ta[0].n), 0)
    assert.equal(Number(subs[0].n), 0)
  })

  it('rejects a duplicate region + filters_hash', async function() {
    await migrate(pool)

    const hash = 'b'.repeat(64)
    await pool.query(
      'INSERT INTO topics (region_qid, filters_hash) VALUES (?, ?)', ['Q99', hash])

    try {
      await pool.query(
        'INSERT INTO topics (region_qid, filters_hash) VALUES (?, ?)', ['Q99', hash])
      assert.fail('expected a duplicate key error')
    } catch (error) {
      assert.equal(error.code, 'ER_DUP_ENTRY')
    }
  })
})
```

**Step 3: Write the test helper**

Create `test/helpers/db-helper.js`:

```javascript
/**
 * Test support for the MariaDB-backed topic store.
 *
 * The topic store is tested against a real MariaDB because its schema
 * constraints and joins ARE the behavior under test - SQLite would run a
 * different dialect and mocks would verify nothing.
 *
 * When the database is not reachable these suites report as PENDING, not as
 * failures, so `npm test` is green on a machine that has never run a container.
 * Pending is visible in the report, so a skipped database suite is never
 * mistaken for a passing one.
 *
 * Start the database with:  npm run test:db:start
 * Require it (fail instead of skip):  SFEDITS_REQUIRE_DB=1 npm test
 */

const fs = require('fs')
const path = require('path')
const { describe, before } = require('mocha')

const mariadb = require('mariadb')

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations')

/** DSN for the disposable test database, overridable by env. */
function testDsn() {
  return process.env.SFEDITS_TEST_DB
    || 'mysql://root:sfedits-test@127.0.0.1:3307/sfedits_test'
}

/**
 * describe() for a suite that needs the database.
 *
 * The skip decision cannot be made at suite-definition time - mocha builds the
 * tree synchronously and reachability is an async question. So the suite is
 * always defined, and its before() hook calls this.skip() when the database is
 * not reachable. Calling this.skip() inside before() marks the whole suite
 * PENDING, which is exactly the intent: visible in the report, not a failure.
 *
 * The consequence that matters: `npm test` is green on a machine with no
 * container running and no environment variable set. A developer who has never
 * heard of podman can still run the suite, and a skipped database suite is
 * never mistaken for a passing one because mocha prints it as pending.
 *
 * Set SFEDITS_REQUIRE_DB=1 to turn unreachability back into a hard failure -
 * use that in any environment where the database is supposed to be up and a
 * silent skip would hide a real regression.
 */
function describeWithDb(title, fn) {
  return describe(title, function() {
    const suite = this

    before(async function() {
      // Set the timeout INSIDE the hook. mocha stamps a hook's timeout when the
      // hook is created, and `this.timeout(30000)` in the suite body runs after
      // this before() was registered - so without this line the probe keeps the
      // 2000ms default and TIMES OUT rather than skipping, which is precisely
      // the red-on-a-fresh-clone outcome this mechanism exists to prevent.
      this.timeout(20000)

      const reachable = await canConnect(testDsn())
      if (reachable) return

      if (process.env.SFEDITS_REQUIRE_DB === '1') {
        throw new Error(
          `SFEDITS_REQUIRE_DB=1 but the database at ${testDsn()} is unreachable`)
      }

      console.log(
        `\n  [skipping "${title}": no database at ${testDsn()}.` +
        '\n   Start one with: npm run test:db:start]\n')
      suite.ctx.skip()
    })

    fn.call(this)
  })
}

/** Can we reach the database? Never throws. */
async function canConnect(dsn) {
  let pool = null
  try {
    // Fail fast. The connector's default acquireTimeout is ~10s, which turns
    // "no database" into a ten-second stall per suite instead of an instant
    // skip. Measured: 10009ms against a refused port with the defaults.
    pool = mariadb.createPool({
      ...parseDsn(dsn),
      connectionLimit: 1,
      connectTimeout: 1000,
      initializationTimeout: 1000,
      acquireTimeout: 2000
    })
    const conn = await pool.getConnection()
    conn.release()
    return true
  } catch {
    return false
  } finally {
    if (pool) await pool.end().catch(() => {})
  }
}

/** Parse a mysql:// DSN into connector options. */
function parseDsn(dsn) {
  const url = new URL(dsn)
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: 5,
    // Return BIGINT as JS numbers; our ids stay far below 2^53.
    bigIntAsNumber: true
  }
}

async function connect(dsn) {
  const pool = mariadb.createPool(parseDsn(dsn))
  try {
    const conn = await pool.getConnection()
    conn.release()
  } catch (error) {
    await pool.end().catch(() => {})
    throw new Error(
      `Cannot reach the test database at ${dsn}: ${error.message}\n` +
      'Start it with: npm run test:db:start')
  }
  return pool
}

/** Apply every migration not already recorded. Safe to call repeatedly. */
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(64) NOT NULL,
      applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  const applied = new Set(
    (await pool.query('SELECT version FROM schema_migrations')).map(r => String(r.version)))

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (applied.has(version)) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    // The connector sends one statement per query() call unless multipleStatements
    // is enabled; splitting keeps that off, which is the safer default.
    for (const statement of sql.split(/;\s*$/m).map(s => s.trim()).filter(Boolean)) {
      await pool.query(statement)
    }

    await pool.query('INSERT INTO schema_migrations (version) VALUES (?)', [version])
  }
}

/**
 * Drop all rows, preserving schema. Used between tests.
 *
 * All six statements run on ONE explicitly-held connection: FOREIGN_KEY_CHECKS
 * is a session variable, so a pooled `pool.query()` per statement can land the
 * TRUNCATE of a parent table on a connection where checks are still enabled,
 * failing with ER_TRUNCATE_ILLEGAL_FK. That failure is order-dependent - it
 * passes locally and fails under concurrency, which is the worst kind.
 */
async function truncateAll(pool) {
  const conn = await pool.getConnection()
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of ['topic_articles', 'subscriptions', 'articles', 'topics']) {
      await conn.query(`TRUNCATE TABLE ${table}`)
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1')
  } finally {
    conn.release()
  }
}

module.exports = {
  connect, migrate, truncateAll, testDsn, describeWithDb, canConnect, parseDsn
}
```

**Prerequisite:** Task 1 Step 3 must already have quoted the test glob and added `--ignore 'test/helpers/**'`. If it did not, creating this file reduces `npm test` to zero tests while still reporting green. Step 4 verifies this.

**Step 4: Run test to verify it fails, then passes**

Run:
```bash
npm run test:db:start
npx mocha --colors --reporter spec --exit test/db.test.js
```
Expected first run: FAIL — `Cannot find module './helpers/db-helper'` if the helper is not yet written, or migration errors if the SQL has a typo.

After both files exist, expected: PASS, 0 failing.

Then confirm the helper file does not disturb the full run:

```bash
npm test
```
Expected: the Phase 1 total plus the 4 new db tests, 0 failing.

**This is the check that catches the glob trap.** If the number DROPS instead of rising - especially to a very small number - the shell expanded the glob and mocha ran only the helper directory. Go back to Task 1 Step 3 and confirm the quoted glob landed in `package.json`.

Then confirm the skip path works — **stop the database and run the full suite**:

```bash
npm run test:db:stop
npm test
```
Expected: green, 0 failing, with the database suites reported as **pending** and a
`[skipping "db migrations": no database at ...]` line explaining why. This is the
check that a fresh clone with no container still passes.

Then confirm the opt-in strictness:

```bash
SFEDITS_REQUIRE_DB=1 npm test
```
Expected: **fails**, because the database is supposed to be up. Restart it with
`npm run test:db:start` before continuing.

**Step 5: Commit**

```bash
git add db/migrations/001-initial-schema.sql test/db.test.js test/helpers/db-helper.js
git commit -m "feat: topic store schema and migration runner

Four tables plus a migrations ledger. The UNIQUE on (region_qid,
filters_hash) is what makes two identical bot requests share one feed;
FK cascades are what make topic GC a single DELETE."
```

---

## Task 3: Filter normalization and hashing

**Files:**
- Create: `lib/topic-store.js`
- Create: `test/topic-store.test.js`

This is a pure function with no I/O, so it is tested without the database.

**Step 1: Write the failing test**

Create `test/topic-store.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it } = require('mocha')

const { normalizeFilters, filtersHash } = require('../lib/topic-store')

describe('topic-store', function() {
  this.timeout(30000)

  describe('normalizeFilters', function() {
    it('sorts and lowercases languages', function() {
      const normalized = normalizeFilters({ languages: ['ES', 'en', 'de'] })
      assert.deepEqual(normalized.languages, ['de', 'en', 'es'])
    })

    it('sorts entity filters', function() {
      const normalized = normalizeFilters({ entityFilters: ['Q5', 'Q515', 'Q43229'] })
      assert.deepEqual(normalized.entityFilters, ['Q43229', 'Q5', 'Q515'])
    })

    it('drops duplicates', function() {
      const normalized = normalizeFilters({
        languages: ['en', 'en', 'es'],
        entityFilters: ['Q5', 'Q5']
      })
      assert.deepEqual(normalized.languages, ['en', 'es'])
      assert.deepEqual(normalized.entityFilters, ['Q5'])
    })

    it('represents "no filter" as null, not an empty array', function() {
      const normalized = normalizeFilters({})
      assert.isNull(normalized.languages)
      assert.isNull(normalized.entityFilters)
    })

    it('treats an empty array as no filter', function() {
      const normalized = normalizeFilters({ languages: [], entityFilters: [] })
      assert.isNull(normalized.languages)
      assert.isNull(normalized.entityFilters)
    })

    it('defaults strategy to auto', function() {
      assert.equal(normalizeFilters({}).strategy, 'auto')
      assert.equal(normalizeFilters({ strategy: 'admin' }).strategy, 'admin')
    })
  })

  describe('connectionOptions', function() {
    const { connectionOptions } = require('../lib/topic-store')
    // NOTE: connectionOptions and parseJsonColumn are implemented in Task 4.
    // These describes are written here with the rest of the pure-function
    // tests, but they will not pass until Task 4 lands - see Step 4.

    it('falls back to the Toolforge build-service env vars', function() {
      const options = connectionOptions(
        { database: 's51234__sfedits' },
        { TOOL_TOOLSDB_USER: 's51234', TOOL_TOOLSDB_PASSWORD: 'secret' })

      assert.equal(options.user, 's51234')
      assert.equal(options.password, 'secret')
      assert.equal(options.host, 'tools.db.svc.wikimedia.cloud')
    })

    it('prefers explicit config over the environment', function() {
      const options = connectionOptions(
        { database: 'local', user: 'root', password: 'local-pw', host: '127.0.0.1' },
        { TOOL_TOOLSDB_USER: 'ignored', TOOL_TOOLSDB_PASSWORD: 'ignored' })

      assert.equal(options.user, 'root')
      assert.equal(options.host, '127.0.0.1')
    })

    it('throws a directive error when credentials are absent everywhere', function() {
      try {
        connectionOptions({ database: 'x' }, {})
        assert.fail('expected connectionOptions to throw')
      } catch (error) {
        assert.include(error.message, 'TOOL_TOOLSDB_USER')
      }
    })

    it('defaults the pool to the documented Toolforge budget', function() {
      const options = connectionOptions(
        { database: 'x' }, { TOOL_TOOLSDB_USER: 'u', TOOL_TOOLSDB_PASSWORD: 'p' })
      assert.equal(options.connectionLimit, 5)
    })
  })

  describe('parseJsonColumn', function() {
    const { parseJsonColumn } = require('../lib/topic-store')

    it('passes an already-parsed value through', function() {
      assert.deepEqual(parseJsonColumn(['en', 'es']), ['en', 'es'])
    })

    it('parses a raw JSON string', function() {
      assert.deepEqual(parseJsonColumn('["en","es"]'), ['en', 'es'])
    })

    it('returns null rather than throwing on garbage', function() {
      assert.isNull(parseJsonColumn('not json'))
      assert.isNull(parseJsonColumn(null))
    })
  })

  describe('filtersHash', function() {
    it('collides for the same selection in a different order', function() {
      const a = filtersHash({ languages: ['en', 'es'], entityFilters: ['Q5', 'Q515'] })
      const b = filtersHash({ languages: ['es', 'en'], entityFilters: ['Q515', 'Q5'] })
      assert.equal(a, b)
    })

    it('differs when the selection differs', function() {
      const a = filtersHash({ languages: ['en'] })
      const b = filtersHash({ languages: ['en', 'es'] })
      assert.notEqual(a, b)
    })

    it('differs when the strategy differs', function() {
      assert.notEqual(
        filtersHash({ languages: ['en'], strategy: 'admin' }),
        filtersHash({ languages: ['en'], strategy: 'geo' }))
    })

    it('is a 64-character hex digest', function() {
      assert.match(filtersHash({ languages: ['en'] }), /^[0-9a-f]{64}$/)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/topic-store.test.js
```
Expected: FAIL — `Cannot find module '../lib/topic-store'`

**Step 3: Write the implementation**

Create `lib/topic-store.js`:

```javascript
/**
 * Topic store: the durable, queryable source of truth for what each bot
 * watches and where its posts go.
 *
 * Two people who ask for the same feed get one topic row between them - one
 * rebuild, one diff render per edit - and differ only in their subscription.
 * That dedup is enforced by a UNIQUE index over (region_qid, filters_hash),
 * where the hash is taken over NORMALIZED inputs so that selection order
 * cannot accidentally mint a second identical feed.
 *
 * The bot's hot path never queries this store per edit. It loads an in-RAM
 * index at startup and reloads it when a generation bumps; see getWatchIndex().
 *
 * Storage is MariaDB (ToolsDB in production). Not SQLite: Toolforge's NFS-backed
 * home storage is the documented bad case for it, and the topic/subscription
 * model is relational anyway.
 *
 * @see docs/design-plans/2026-07-23-place-bot-platform.md
 */

const crypto = require('crypto')

/**
 * Reduce a filter selection to canonical form.
 *
 * Order must not matter and case must not matter, or "Mission+en+places" and
 * "Mission+places+EN" would hash differently and split one shared feed into
 * two identical ones. Empty is normalized to null - "no language filter" and
 * "an empty list of languages" are the same request.
 *
 * @param {Object} filters
 * @param {string[]} [filters.languages]
 * @param {string[]} [filters.entityFilters] - class QIDs
 * @param {string} [filters.strategy]
 * @returns {{languages: string[]|null, entityFilters: string[]|null, strategy: string}}
 */
function normalizeFilters(filters = {}) {
  const dedupeSort = (values, transform = v => v) => {
    if (!Array.isArray(values) || values.length === 0) return null
    const set = new Set(values.map(v => transform(String(v).trim())).filter(Boolean))
    if (set.size === 0) return null
    return Array.from(set).sort()
  }

  return {
    languages: dedupeSort(filters.languages, v => v.toLowerCase()),
    entityFilters: dedupeSort(filters.entityFilters),
    strategy: filters.strategy || 'auto'
  }
}

/**
 * Stable hash of a normalized selection. This is the dedup key.
 * @returns {string} 64-char hex sha256
 */
function filtersHash(filters = {}) {
  const normalized = normalizeFilters(filters)
  const canonical = JSON.stringify([
    normalized.strategy,
    normalized.entityFilters,
    normalized.languages
  ])
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

module.exports = {
  normalizeFilters,
  filtersHash
}
```

**Step 4: Run test to verify the hashing tests pass**

Run:
```bash
npx mocha --colors --reporter spec --exit test/topic-store.test.js \
  --grep 'normalizeFilters|filtersHash'
```
Expected: PASS, 0 failing.

The `connectionOptions` and `parseJsonColumn` describes in this file will still
fail — those functions arrive in Task 4. Run the full file at the end of Task 4,
not now. This is the one place in the plan where a task deliberately leaves a
test red; it is called out here so it is not mistaken for a mistake.

**Step 5: Commit**

```bash
git add lib/topic-store.js test/topic-store.test.js
git commit -m "feat: normalized filter hashing for topic dedup

Order and case cannot mint a duplicate feed: the hash is over sorted,
lowercased, deduplicated inputs, with empty normalized to null."
```

---

## Task 4: Topic and subscription persistence

**Files:**
- Modify: `lib/topic-store.js` (append the store class, extend exports)
- Modify: `test/topic-store.test.js` (append a DB-backed describe block)

**Step 1: Write the failing test**

Append to `test/topic-store.test.js`. Add these requires at the top of the file, after the existing ones:

```javascript
const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const { createTopicStore } = require('../lib/topic-store')
```

Then append this block at the end of the file, outside the existing `describe('topic-store', ...)`:

```javascript
describeWithDb('topic-store (database)', function() {
  this.timeout(30000)

  let pool
  let store

  before(async function() {
    pool = await connect(testDsn())
    await migrate(pool)
    store = createTopicStore({ pool })
  })

  beforeEach(async function() {
    await truncateAll(pool)
  })

  after(async function() {
    if (pool) await pool.end()
  })

  describe('upsertTopic', function() {
    it('creates a topic and returns its id', async function() {
      const topic = await store.upsertTopic('Q62', {
        languages: ['en'], entityFilters: ['Q515'], strategy: 'admin'
      })

      assert.isNumber(topic.id)
      assert.equal(topic.regionQid, 'Q62')
      assert.isTrue(topic.created)
    })

    it('returns the existing topic when the selection matches in another order',
      async function() {
        const first = await store.upsertTopic('Q62',
          { languages: ['en', 'es'], entityFilters: ['Q5', 'Q515'] })
        const second = await store.upsertTopic('Q62',
          { languages: ['es', 'en'], entityFilters: ['Q515', 'Q5'] })

        assert.equal(first.id, second.id)
        assert.isTrue(first.created)
        assert.isFalse(second.created)

        const rows = await pool.query('SELECT COUNT(*) AS n FROM topics')
        assert.equal(Number(rows[0].n), 1)
      })

    it('returns languages and filters as arrays, not raw JSON strings',
      async function() {
        const created = await store.upsertTopic('Q62', {
          languages: ['en', 'es'], entityFilters: ['Q515']
        })
        const fetched = await store.getTopic(created.id)

        assert.isArray(fetched.languages,
          'a raw string here would blow up the rebuild with "languages.map is not a function"')
        assert.deepEqual(fetched.languages, ['en', 'es'])
        assert.deepEqual(fetched.entityFilters, ['Q515'])
      })

    it('creates distinct topics for genuinely different selections', async function() {
      const a = await store.upsertTopic('Q62', { languages: ['en'] })
      const b = await store.upsertTopic('Q62', { languages: ['en', 'es'] })
      assert.notEqual(a.id, b.id)
    })
  })

  describe('setTopicArticles', function() {
    it('inserts memberships and shares article rows across topics', async function() {
      const a = await store.upsertTopic('Q62', { languages: ['en'] })
      const b = await store.upsertTopic('Q62', { languages: ['en', 'es'] })

      const articles = [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ]
      await store.setTopicArticles(a.id, articles)
      await store.setTopicArticles(b.id, articles)

      const articleRows = await pool.query('SELECT COUNT(*) AS n FROM articles')
      const membershipRows = await pool.query('SELECT COUNT(*) AS n FROM topic_articles')

      assert.equal(Number(articleRows[0].n), 2, 'article rows are shared, not duplicated')
      assert.equal(Number(membershipRows[0].n), 4)
    })

    it('marks departed articles removed rather than deleting them', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })

      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ])
      const diff = await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q30', wikipedia: 'en', title: 'Gamma', source: 'admin' }
      ])

      assert.deepEqual(diff.added, ['Q30'])
      assert.deepEqual(diff.removed, ['Q20'])

      const live = await pool.query(
        'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ? AND removed_at IS NULL',
        [topic.id])
      assert.equal(Number(live[0].n), 2)

      const gone = await pool.query(
        'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ? AND removed_at IS NOT NULL',
        [topic.id])
      assert.equal(Number(gone[0].n), 1)
    })

    it('revives an article that returns to the topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const alpha = [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]

      await store.setTopicArticles(topic.id, alpha)
      await store.setTopicArticles(topic.id, [])
      const diff = await store.setTopicArticles(topic.id, alpha)

      assert.deepEqual(diff.added, ['Q10'])

      const live = await pool.query(
        'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ? AND removed_at IS NULL',
        [topic.id])
      assert.equal(Number(live[0].n), 1)
    })

    it('bumps the generation for a rename, not only for adds and removes',
      async function() {
        const topic = await store.upsertTopic('Q62', { languages: ['en'] })
        await store.setTopicArticles(topic.id, [
          { qid: 'Q10', wikipedia: 'en', title: 'Old Name', source: 'admin' }
        ])
        const before = await store.getTopic(topic.id)

        const diff = await store.setTopicArticles(topic.id, [
          { qid: 'Q10', wikipedia: 'en', title: 'New Name', source: 'admin' }
        ])

        assert.deepEqual(diff.added, [], 'a rename is not an addition')
        assert.deepEqual(diff.removed, [], 'a rename is not a removal')
        assert.equal(diff.renamed, 1)

        const after = await store.getTopic(topic.id)
        assert.isAbove(Number(after.generation), Number(before.generation),
          'without this bump a running bot keeps matching the dead title')
      })

    it('bumps the generation on every change', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const before = await store.getTopic(topic.id)

      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])

      const after = await store.getTopic(topic.id)
      assert.isAbove(Number(after.generation), Number(before.generation))
    })
  })

  describe('subscriptions', function() {
    it('adds a subscription and lists it by topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const sub = await store.addSubscription(topic.id, {
        ownerUser: 'Tieguy',
        deliveryType: 'discord',
        deliveryConfig: { webhook_url: 'https://discord.test/hook' },
        displayName: 'SF edits'
      })

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 1)
      assert.equal(subs[0].id, sub.id)
      assert.equal(subs[0].deliveryConfig.webhook_url, 'https://discord.test/hook')
    })

    it('lets two owners subscribe to one topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })
      await store.addSubscription(topic.id, {
        ownerUser: 'B', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://b' }
      })

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 2)

      const topics = await pool.query('SELECT COUNT(*) AS n FROM topics')
      assert.equal(Number(topics[0].n), 1, 'one shared topic, two subscriptions')
    })

    it('omits non-active subscriptions from delivery lists', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const sub = await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })

      await store.setSubscriptionStatus(sub.id, 'broken')

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 0)

      const all = await store.subscriptionsForTopic(topic.id, { includeInactive: true })
      assert.equal(all.length, 1)
      assert.equal(all[0].status, 'broken')
    })
  })

  describe('topic garbage collection', function() {
    it('deletes a topic when its last subscription goes away', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const first = await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })
      const second = await store.addSubscription(topic.id, {
        ownerUser: 'B', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://b' }
      })

      await store.removeSubscription(first.id)
      let remaining = await pool.query('SELECT COUNT(*) AS n FROM topics WHERE id = ?',
        [topic.id])
      assert.equal(Number(remaining[0].n), 1, 'topic survives while another sub references it')

      await store.removeSubscription(second.id)
      const collected = await store.collectOrphanTopics()
      assert.deepEqual(collected, [topic.id])

      remaining = await pool.query('SELECT COUNT(*) AS n FROM topics WHERE id = ?', [topic.id])
      assert.equal(Number(remaining[0].n), 0)
    })

    it('keeps the original owner leaving from breaking everyone else', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const creator = await store.addSubscription(topic.id, {
        ownerUser: 'Creator', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })
      await store.addSubscription(topic.id, {
        ownerUser: 'Follower', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://b' }
      })

      await store.removeSubscription(creator.id)
      await store.collectOrphanTopics()

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 1)
      assert.equal(subs[0].ownerUser, 'Follower')
    })
  })
})
```

Add `before`, `beforeEach`, and `after` to the mocha destructure at the top of `test/topic-store.test.js`:

```javascript
const { describe, it, before, beforeEach, after } = require('mocha')
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run test:db:start
npx mocha --colors --reporter spec --exit test/topic-store.test.js
```
Expected: FAIL — `createTopicStore is not a function`

**Step 3: Write the implementation**

Append to `lib/topic-store.js`, before `module.exports`:

```javascript
const mariadb = require('mariadb')

const DEFAULT_CONNECTION_LIMIT = 5

/**
 * Build connector options from a topic_store config stanza.
 *
 * Toolforge supplies ToolsDB credentials two ways depending on how the tool is
 * deployed: as env vars under the build service, or in ~/replica.my.cnf on the
 * older grid. Both are supported so a developer can run against a local
 * container with neither.
 *
 * Config (global stanza in config.json):
 *   "topic_store": {
 *     "host": "tools.db.svc.wikimedia.cloud",
 *     "database": "s51234__sfedits",
 *     "user": "s51234",              // omit to read TOOL_TOOLSDB_USER
 *     "password": "...",             // omit to read TOOL_TOOLSDB_PASSWORD
 *     "connection_limit": 5
 *   }
 */
function connectionOptions(stanza = {}, env = process.env) {
  const user = stanza.user || env.TOOL_TOOLSDB_USER
  const password = stanza.password || env.TOOL_TOOLSDB_PASSWORD

  if (!user || !password) {
    throw new Error(
      'topic_store needs a user and password, from config or from ' +
      'TOOL_TOOLSDB_USER / TOOL_TOOLSDB_PASSWORD')
  }

  return {
    host: stanza.host || 'tools.db.svc.wikimedia.cloud',
    port: stanza.port || 3306,
    database: stanza.database,
    user,
    password,
    connectionLimit: stanza.connection_limit || DEFAULT_CONNECTION_LIMIT,
    bigIntAsNumber: true
  }
}

/**
 * MariaDB implements JSON as LONGTEXT, and whether the connector auto-parses
 * it depends on driver options and on the server's column-format flag. Treat
 * both shapes as possible everywhere, or a rebuild will hand a raw '["en"]'
 * string to code expecting an array and die on `.map is not a function`.
 */
function parseJsonColumn(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Rows come back with snake_case columns; callers deal in camelCase. */
function rowToTopic(row) {
  return {
    id: Number(row.id),
    regionQid: String(row.region_qid),
    filtersHash: String(row.filters_hash),
    entityFilters: parseJsonColumn(row.entity_filters),
    languages: parseJsonColumn(row.languages),
    strategy: String(row.strategy),
    generation: Number(row.generation),
    displayName: row.display_name || null,
    lastBuiltAt: row.last_built_at || null
  }
}

function rowToSubscription(row) {
  return {
    id: Number(row.id),
    topicId: Number(row.topic_id),
    ownerUser: String(row.owner_user),
    deliveryType: String(row.delivery_type),
    deliveryConfig: parseJsonColumn(row.delivery_config),
    displayName: row.display_name || null,
    status: String(row.status)
  }
}

/**
 * @param {Object} options
 * @param {Object} [options.pool] - an existing mariadb pool (tests pass one)
 * @param {Object} [options.config] - topic_store stanza, used when no pool given
 */
function createTopicStore({ pool: existingPool = null, config = null, env = process.env } = {}) {
  const pool = existingPool || mariadb.createPool(connectionOptions(config, env))

  /**
   * Find or create the topic for a region + filter selection.
   * @returns {Promise<{id, regionQid, created}>}
   */
  async function upsertTopic(regionQid, filters = {}) {
    const normalized = normalizeFilters(filters)
    const hash = filtersHash(filters)

    const existing = await pool.query(
      'SELECT * FROM topics WHERE region_qid = ? AND filters_hash = ?', [regionQid, hash])

    if (existing.length > 0) {
      return { ...rowToTopic(existing[0]), created: false }
    }

    try {
      const result = await pool.query(
        `INSERT INTO topics
           (region_qid, filters_hash, entity_filters, languages, strategy, display_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          regionQid,
          hash,
          normalized.entityFilters ? JSON.stringify(normalized.entityFilters) : null,
          normalized.languages ? JSON.stringify(normalized.languages) : null,
          normalized.strategy,
          filters.displayName || null
        ])

      const created = await pool.query('SELECT * FROM topics WHERE id = ?', [result.insertId])
      return { ...rowToTopic(created[0]), created: true }
    } catch (error) {
      // Lost a race with a concurrent creator; the UNIQUE index did its job.
      if (error.code !== 'ER_DUP_ENTRY') throw error
      const raced = await pool.query(
        'SELECT * FROM topics WHERE region_qid = ? AND filters_hash = ?', [regionQid, hash])
      return { ...rowToTopic(raced[0]), created: false }
    }
  }

  async function getTopic(topicId) {
    const rows = await pool.query('SELECT * FROM topics WHERE id = ?', [topicId])
    return rows.length > 0 ? rowToTopic(rows[0]) : null
  }

  async function topicsForRegion(regionQid) {
    const rows = await pool.query(
      'SELECT * FROM topics WHERE region_qid = ? ORDER BY id', [regionQid])
    return rows.map(rowToTopic)
  }

  /**
   * Find or create the shared article row for a (wikipedia, qid) pair.
   *
   * @param {Object} article
   * @param {Object} [options]
   * @param {boolean} [options.reportTitleChange] - return whether the title
   *   moved instead of the row id; callers use this to detect renames
   * @returns {Promise<number|boolean>}
   */
  async function upsertArticle(article, { reportTitleChange = false } = {}) {
    const existing = await pool.query(
      'SELECT id, title FROM articles WHERE wikipedia = ? AND wikidata_qid = ?',
      [article.wikipedia, article.qid])

    if (existing.length > 0) {
      // Titles change; the QID is the identity, so keep the title current.
      const changed = String(existing[0].title) !== article.title
      if (changed) {
        await pool.query('UPDATE articles SET title = ? WHERE id = ?',
          [article.title, existing[0].id])
      }
      return reportTitleChange ? changed : Number(existing[0].id)
    }

    const result = await pool.query(
      'INSERT INTO articles (wikipedia, title, wikidata_qid) VALUES (?, ?, ?)',
      [article.wikipedia, article.title, article.qid])
    return reportTitleChange ? true : Number(result.insertId)
  }

  /**
   * Replace a topic's membership with the given set, as a diff.
   *
   * Departed articles are marked removed rather than deleted, so provenance
   * survives and a returning article can be revived. The generation bump is
   * what tells a running bot its in-RAM index is stale.
   *
   * @returns {Promise<{added: string[], removed: string[], unchanged: number}>}
   */
  async function setTopicArticles(topicId, articles) {
    const desired = new Map()
    for (const article of articles) {
      desired.set(`${article.wikipedia}:${article.qid}`, article)
    }

    const currentRows = await pool.query(
      `SELECT ta.article_id, ta.removed_at, a.wikipedia, a.wikidata_qid
       FROM topic_articles ta
       JOIN articles a ON a.id = ta.article_id
       WHERE ta.topic_id = ?`, [topicId])

    const current = new Map()
    for (const row of currentRows) {
      current.set(`${row.wikipedia}:${row.wikidata_qid}`, {
        articleId: Number(row.article_id),
        removed: row.removed_at !== null
      })
    }

    const added = []
    const removed = []
    let unchanged = 0
    let renamedCount = 0

    for (const [key, article] of desired) {
      const existing = current.get(key)

      if (existing && !existing.removed) {
        unchanged++
        // A pure rename lands here: the (wikipedia, qid) key is unchanged, so
        // it is neither an add nor a remove - only the title moved. It still
        // has to bump the generation, or a running bot keeps matching the OLD
        // title until some unrelated add/remove happens to bump the counter.
        // Silently matching a dead title is the exact failure rename detection
        // exists to prevent.
        const titleChanged = await upsertArticle(article, { reportTitleChange: true })
        if (titleChanged) renamedCount++
        continue
      }

      const articleId = await upsertArticle(article)

      if (existing) {
        await pool.query(
          `UPDATE topic_articles SET removed_at = NULL, added_at = CURRENT_TIMESTAMP
           WHERE topic_id = ? AND article_id = ?`, [topicId, articleId])
      } else {
        await pool.query(
          `INSERT INTO topic_articles (topic_id, article_id, source, score)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE removed_at = NULL`,
          [topicId, articleId, article.source || 'admin', article.score ?? null])
      }
      added.push(article.qid)
    }

    for (const [key, existing] of current) {
      if (desired.has(key) || existing.removed) continue
      await pool.query(
        `UPDATE topic_articles SET removed_at = CURRENT_TIMESTAMP
         WHERE topic_id = ? AND article_id = ?`, [topicId, existing.articleId])
      removed.push(key.split(':')[1])
    }

    if (added.length > 0 || removed.length > 0 || renamedCount > 0) {
      await pool.query(
        `UPDATE topics SET generation = generation + 1, last_built_at = CURRENT_TIMESTAMP
         WHERE id = ?`, [topicId])
    }

    return { added, removed, unchanged, renamed: renamedCount }
  }

  async function addSubscription(topicId, subscription) {
    const result = await pool.query(
      `INSERT INTO subscriptions
         (topic_id, owner_user, delivery_type, delivery_config, display_name)
       VALUES (?, ?, ?, ?, ?)`,
      [
        topicId,
        subscription.ownerUser,
        subscription.deliveryType,
        JSON.stringify(subscription.deliveryConfig),
        subscription.displayName || null
      ])
    return { id: Number(result.insertId), topicId }
  }

  async function subscriptionsForTopic(topicId, { includeInactive = false } = {}) {
    const sql = includeInactive
      ? 'SELECT * FROM subscriptions WHERE topic_id = ? ORDER BY id'
      : `SELECT * FROM subscriptions WHERE topic_id = ? AND status = 'active' ORDER BY id`
    const rows = await pool.query(sql, [topicId])
    return rows.map(rowToSubscription)
  }

  async function setSubscriptionStatus(subscriptionId, status) {
    await pool.query('UPDATE subscriptions SET status = ? WHERE id = ?',
      [status, subscriptionId])
  }

  async function removeSubscription(subscriptionId) {
    await pool.query('DELETE FROM subscriptions WHERE id = ?', [subscriptionId])
  }

  /**
   * Delete topics no subscription references any more.
   *
   * Topic lifetime is deliberately decoupled from any one owner: if the person
   * who created a feed deletes their subscription, everyone else's keeps
   * working. Only when the last one leaves does the topic go.
   *
   * @returns {Promise<number[]>} ids of collected topics
   */
  async function collectOrphanTopics() {
    const rows = await pool.query(
      `SELECT t.id FROM topics t
       LEFT JOIN subscriptions s ON s.topic_id = t.id
       WHERE s.id IS NULL`)

    const ids = rows.map(r => Number(r.id))
    if (ids.length === 0) return []

    await pool.query(
      `DELETE FROM topics WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    return ids
  }

  async function close() {
    await pool.end()
  }

  return {
    pool,
    upsertTopic,
    getTopic,
    topicsForRegion,
    upsertArticle,
    setTopicArticles,
    addSubscription,
    subscriptionsForTopic,
    setSubscriptionStatus,
    removeSubscription,
    collectOrphanTopics,
    close
  }
}
```

Update the exports block:

```javascript
module.exports = {
  createTopicStore,
  connectionOptions,
  parseJsonColumn,
  normalizeFilters,
  filtersHash
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/topic-store.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Commit**

```bash
git add lib/topic-store.js test/topic-store.test.js
git commit -m "feat: topic and subscription persistence

Article rows are shared across topics; departures are marked removed rather
than deleted so provenance survives and returning articles revive. Topics
outlive their creator and are collected only when the last subscription
leaves."
```

---

## Task 5: The in-RAM watch index

**Files:**
- Modify: `lib/topic-store.js` (append `getWatchIndex`, extend the returned object)
- Modify: `test/topic-store.test.js` (append a describe block)

**Step 1: Write the failing test**

Append inside `describeWithDb('topic-store (database)', ...)`:

```javascript
  describe('getWatchIndex', function() {
    it('maps wikipedia -> title -> topic ids', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'es', title: 'Beta', source: 'admin' }
      ])

      const index = await store.getWatchIndex()

      assert.deepEqual(Array.from(index.byWiki.get('en').get('Alpha')), [topic.id])
      assert.deepEqual(Array.from(index.byWiki.get('es').get('Beta')), [topic.id])
    })

    it('lists every topic watching a shared article', async function() {
      const a = await store.upsertTopic('Q62', { languages: ['en'] })
      const b = await store.upsertTopic('Q62', { languages: ['en', 'es'] })
      const shared = [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]

      await store.setTopicArticles(a.id, shared)
      await store.setTopicArticles(b.id, shared)

      const index = await store.getWatchIndex()
      const topics = Array.from(index.byWiki.get('en').get('Alpha')).sort()

      assert.deepEqual(topics, [a.id, b.id].sort())
    })

    it('excludes articles that have left the topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])
      await store.setTopicArticles(topic.id, [])

      const index = await store.getWatchIndex()
      assert.isUndefined(index.byWiki.get('en'))
    })

    it('excludes topics with no active subscription', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])

      let index = await store.getWatchIndex({ requireSubscription: true })
      assert.equal(index.byWiki.size, 0, 'no subscribers means nothing to deliver')

      await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })

      index = await store.getWatchIndex({ requireSubscription: true })
      assert.deepEqual(Array.from(index.byWiki.get('en').get('Alpha')), [topic.id])
    })

    it('reports a generation that changes when any topic rebuilds', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const before = await store.getWatchIndex()

      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])

      const after = await store.getWatchIndex()
      assert.notEqual(after.generation, before.generation)
    })
  })
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/topic-store.test.js
```
Expected: FAIL — `store.getWatchIndex is not a function`

**Step 3: Write the implementation**

Append inside `createTopicStore`, before its `return` block:

```javascript
  /**
   * Build the index the bot's hot path matches against.
   *
   * Shape is Map<wikipedia, Map<title, Set<topicId>>> so a match is two hash
   * lookups regardless of how many titles are watched - the same O(1) cost the
   * bot has always had with a static watchlist, just sourced from the store.
   *
   * The generation is the sum of every topic's generation. It is not
   * meaningful as a number; it only has to change when anything rebuilds, so a
   * running bot can notice its index is stale without diffing the whole thing.
   *
   * @param {Object} [options]
   * @param {boolean} [options.requireSubscription=false] - skip topics nobody
   *   is subscribed to; a rebuild job wants them, delivery does not
   * @returns {Promise<{byWiki: Map, generation: number, topicCount: number, titleCount: number}>}
   */
  async function getWatchIndex({ requireSubscription = false } = {}) {
    const subscriptionJoin = requireSubscription
      ? `JOIN subscriptions s ON s.topic_id = t.id AND s.status = 'active'`
      : ''

    const rows = await pool.query(`
      SELECT DISTINCT a.wikipedia, a.title, t.id AS topic_id
      FROM topic_articles ta
      JOIN articles a ON a.id = ta.article_id
      JOIN topics t ON t.id = ta.topic_id
      ${subscriptionJoin}
      WHERE ta.removed_at IS NULL
    `)

    const byWiki = new Map()
    const topics = new Set()
    let titleCount = 0

    for (const row of rows) {
      const wikipedia = String(row.wikipedia)
      const title = String(row.title)
      const topicId = Number(row.topic_id)

      let titles = byWiki.get(wikipedia)
      if (!titles) {
        titles = new Map()
        byWiki.set(wikipedia, titles)
      }

      let topicIds = titles.get(title)
      if (!topicIds) {
        topicIds = new Set()
        titles.set(title, topicIds)
        titleCount++
      }
      topicIds.add(topicId)
      topics.add(topicId)
    }

    const generationRow = await pool.query(
      'SELECT COALESCE(SUM(generation), 0) AS g FROM topics')

    return {
      byWiki,
      generation: Number(generationRow[0].g),
      topicCount: topics.size,
      titleCount
    }
  }
```

Add `getWatchIndex` to the returned object:

```javascript
  return {
    pool,
    upsertTopic,
    getTopic,
    topicsForRegion,
    upsertArticle,
    setTopicArticles,
    getWatchIndex,
    addSubscription,
    subscriptionsForTopic,
    setSubscriptionStatus,
    removeSubscription,
    collectOrphanTopics,
    close
  }
```

**Step 4: Run the full suite**

Run:
```bash
npx mocha --colors --reporter spec --exit test/topic-store.test.js
```
Expected: PASS, 0 failing — every test in this file green

Run:
```bash
npm test
```
Expected: the Phase 1 total plus every test written in this phase, 0 failing

Verify the offline path one more time:

```bash
npm run test:db:stop
npm test
```
Expected: green with 0 failing and the database suites pending — **no environment
variable needed**. Restart the container afterwards for the next phase.

**Step 5: Commit**

```bash
git add lib/topic-store.js test/topic-store.test.js
git commit -m "feat: in-RAM watch index from the topic store

Map<wikipedia, Map<title, Set<topicId>>> so the hot path stays two hash
lookups. Generation is a change-detector, not a number with meaning."
```

---

## Phase 2 Done When

- `npm run test:db:start` brings up MariaDB and `npm test` is green, with a total equal to the Phase 1 total plus this phase's new tests, and no pre-existing test failing.
- `npm test` with the container **stopped** is also green, with database suites reported as pending rather than failing or silently absent — no environment variable required.
- `npm test` still reports the Phase 1 total after `test/helpers/` exists (the glob fix from Task 1 Step 3 held).
- Two differently-ordered filter selections for the same region produce exactly one `topics` row.
- Removing the last subscription lets `collectOrphanTopics()` delete the topic; removing a non-last one does not.
- `getWatchIndex()` returns a populated `Map<wikipedia, Map<title, Set<topicId>>>` excluding removed articles.

**Note for the executing engineer:** every migration in `db/migrations/` must remain re-runnable. If a later phase needs a schema change, add `002-*.sql` — never edit `001-initial-schema.sql`, since it will already be recorded in `schema_migrations` on any database that has run it.
