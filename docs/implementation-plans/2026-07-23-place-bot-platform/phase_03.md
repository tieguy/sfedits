# Place-Bot Platform Implementation Plan — Phase 3: Rebuild Job and Title Resolution

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Keep topic article sets and their title index fresh, detect page renames before they silently break matching, and surface newly created articles as a signal.

**Architecture:** `lib/title-resolver.js` maps QIDs to current titles, preferring Toolforge's Wiki Replicas (a plain SQL join, no rate limits) and falling back to the MediaWiki API off-Toolforge. `scripts/rebuild-topics.js` walks every topic, re-runs the Phase 1 resolver, and set-diffs against stored membership — which yields rename detection and the new-article signal as byproducts rather than as separate features.

**Tech Stack:** MariaDB (Wiki Replicas + ToolsDB), MediaWiki Action API, mocha/chai/nock.

**Scope:** Phase 3 of 5 (Plan A).

**Codebase verified:** 2026-07-23 04:27 PDT, branch `place-bot-platform`.

---

## Context the executing engineer needs

**Verified codebase facts:**

- `lib/title-resolver.js` and `scripts/rebuild-topics.js` do **not** exist.
- Nothing in the repo detects page moves. `grep` for `movetitle` / `logging` returns nothing.
- `lib/compare-diff.js:291-295` already queries the API for **title → QID** via `&prop=pageprops&ppprop=wikibase_item`. Phase 3 needs the opposite direction (QID → titles across languages), which does not exist yet. Read that block before writing Task 1 — reuse its User-Agent and error-handling shape.
- Standalone script conventions in `scripts/`: `#!/usr/bin/env node` shebang, an explicit stage/mode argument rather than implicit state (`node scripts/reassess.js cohort|all`), and JSON output cached under `data/`. `scripts/reassess.js` has tests (`test/reassess.test.js`, 13 tests) but only for its pure helper functions, not its I/O. Follow that split.

**External research findings — these contain two silent-bug traps:**

- **`page_title` is `varbinary`.** The Node MariaDB driver returns it as a **Buffer**, not a string. Comparing a Buffer to a string title always fails, and `JSON.stringify` on it produces `{"type":"Buffer","data":[...]}`. Every value read from a replica must be explicitly decoded with `.toString('utf8')`. Source: <https://www.mediawiki.org/wiki/Manual:Page_props_table>, <https://github.com/sidorares/node-mysql2/issues/668>
- **Replica titles use underscores, not spaces.** `page_title` stores `Caf%C3%A9_du_Nord`-style underscored text; the EventStreams feed and the API emit spaces. Normalizing in one direction only is how a title index silently matches nothing.
- **`logging` user columns are redacted** on the replicas. Use the `logging_userindex` view when filtering by user. For move detection we do not need the user, so plain `logging` is fine.
- Move records: `log_type='move'`, `log_action` is `move` or `move_redir`. **`log_title` is the OLD title** (the page as it was named when logged); the NEW title lives inside `log_params`, JSON-encoded under the key **`4::target`** on MediaWiki ≥ 1.27 (not `target_title` — that name appears in some third-party docs and is wrong), with a legacy newline-delimited format on older records whose first line is the target. Source: <https://www.mediawiki.org/wiki/Manual:Logging_table>
- Wiki Replicas hostnames: `{wiki}.analytics.db.svc.wikimedia.cloud` (long queries, slow) and `{wiki}.web.db.svc.wikimedia.cloud` (5-minute timeout, fast). Database name is `{wiki}_p`, e.g. `enwiki_p`. A nightly rebuild is a batch job, so use **analytics**. Source: <https://wikitech.wikimedia.org/wiki/Wiki_Replicas>
- Replicas lag production by seconds to minutes. Irrelevant for a nightly pass; do not put them in the per-edit path.

---

## Task 1: Title resolution via the MediaWiki API

The API path is the development fallback and the correctness reference. It is written first because it can be tested with nock, off Toolforge.

**Files:**
- Create: `lib/title-resolver.js`
- Create: `test/title-resolver.test.js`

**Step 1: Write the failing test**

Create `test/title-resolver.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { titlesForQidsViaApi, normalizeTitle } = require('../lib/title-resolver')

describe('title-resolver', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('normalizeTitle', function() {
    it('converts underscores to spaces', function() {
      assert.equal(normalizeTitle('Cafe_du_Nord'), 'Cafe du Nord')
    })

    it('decodes a Buffer from the replicas', function() {
      assert.equal(normalizeTitle(Buffer.from('Café_du_Nord', 'utf8')), 'Café du Nord')
    })

    it('collapses repeated whitespace and trims', function() {
      assert.equal(normalizeTitle('  Alpha__Beta  '), 'Alpha Beta')
    })

    it('returns null for empty input', function() {
      assert.isNull(normalizeTitle(''))
      assert.isNull(normalizeTitle(null))
    })
  })

  describe('titlesForQidsViaApi', function() {
    it('maps QIDs to current titles per wiki', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              eswiki: { site: 'eswiki', title: 'Alfa' }
            } },
            Q20: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Beta' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10', 'Q20'], { languages: ['en', 'es'] })

      assert.deepEqual(result.get('Q10'), [
        { wikipedia: 'en', title: 'Alpha' },
        { wikipedia: 'es', title: 'Alfa' }
      ])
      assert.deepEqual(result.get('Q20'), [{ wikipedia: 'en', title: 'Beta' }])
    })

    it('filters to the requested languages', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              dewiki: { site: 'dewiki', title: 'Alpha (DE)' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10'], { languages: ['en'] })
      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('ignores non-wikipedia sitelinks', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              enwikiquote: { site: 'enwikiquote', title: 'Alpha' },
              commonswiki: { site: 'commonswiki', title: 'Category:Alpha' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10'], {})
      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('batches requests at 50 ids, the API limit', async function() {
      const qids = Array.from({ length: 120 }, (_, i) => `Q${i + 1}`)
      let calls = 0

      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .times(3)
        .reply(200, function() {
          calls++
          return { entities: {} }
        })

      await titlesForQidsViaApi(qids, {})
      assert.equal(calls, 3)
    })

    it('omits entities the API reports as missing', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, { entities: { Q99: { missing: '' } } })

      const result = await titlesForQidsViaApi(['Q99'], {})
      assert.isFalse(result.has('Q99'))
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/title-resolver.test.js
```
Expected: FAIL — `Cannot find module '../lib/title-resolver'`

**Step 3: Write the implementation**

Create `lib/title-resolver.js`:

```javascript
/**
 * QID -> current article titles.
 *
 * Membership identity is the QID, because Wikipedia renames articles
 * constantly and a title-keyed list silently stops matching when it happens.
 * But the edit feed emits titles, so the bot still matches on a title index -
 * one derived from QIDs and refreshed on the rebuild cadence.
 *
 * Two backends:
 *  - replicas: on Toolforge, a plain SQL join against page_props. No API rate
 *    limits, and page-move detection comes from the same database.
 *  - api: everywhere else (development, CI). Correct but rate-limited.
 *
 * Resolution is a BATCH-time concern. Neither backend belongs in the per-edit
 * hot path, which stays an in-RAM lookup.
 *
 * @see https://wikitech.wikimedia.org/wiki/Wiki_Replicas
 */

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
const USER_AGENT = 'sfedits-title-resolver/1.0 (https://github.com/tieguy/sfedits)'

/** wbgetentities caps at 50 ids per request. */
const API_BATCH_SIZE = 50

/**
 * Canonical title form: spaces, not underscores; decoded from Buffer if the
 * replicas handed one over.
 *
 * Both traps live here. page_title is varbinary, so the driver returns a
 * Buffer that will never compare equal to a string; and replica titles are
 * underscored while EventStreams and the API emit spaces. Normalizing in only
 * one direction is how a title index silently matches nothing at all.
 */
function normalizeTitle(value) {
  if (value === null || value === undefined) return null
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  const normalized = text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

/** "enwiki" -> "en"; anything that is not a Wikipedia returns null. */
function siteToWikipedia(site) {
  const match = /^([a-z_]+)wiki$/.exec(site)
  if (!match) return null
  return match[1].replace(/_/g, '-')
}

function chunk(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Resolve QIDs to titles using the Wikidata API.
 *
 * @param {string[]} qids
 * @param {Object} [options]
 * @param {string[]} [options.languages] - wiki codes; omit for all Wikipedias
 * @returns {Promise<Map<string, Array<{wikipedia, title}>>>}
 */
async function titlesForQidsViaApi(qids, options = {}) {
  const { languages = null } = options
  const wanted = languages ? new Set(languages) : null
  const result = new Map()

  for (const batch of chunk(qids, API_BATCH_SIZE)) {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'sitelinks',
      format: 'json',
      formatversion: '2'
    })

    const response = await fetch(`${WIKIDATA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) {
      throw new Error(`Wikidata API returned ${response.status}`)
    }

    const data = await response.json()

    for (const [qid, entity] of Object.entries(data.entities || {})) {
      if (!entity || entity.missing !== undefined) continue

      const titles = []
      for (const sitelink of Object.values(entity.sitelinks || {})) {
        const wikipedia = siteToWikipedia(sitelink.site)
        if (!wikipedia) continue
        if (wanted && !wanted.has(wikipedia)) continue

        const title = normalizeTitle(sitelink.title)
        if (title) titles.push({ wikipedia, title })
      }

      if (titles.length > 0) result.set(qid, titles)
    }
  }

  return result
}

module.exports = {
  titlesForQidsViaApi,
  normalizeTitle,
  siteToWikipedia,
  WIKIDATA_API,
  API_BATCH_SIZE
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/title-resolver.test.js
```
Expected: PASS — 10 passing

**Step 5: Commit**

```bash
git add lib/title-resolver.js test/title-resolver.test.js
git commit -m "feat: resolve QIDs to current titles via the Wikidata API

normalizeTitle handles the two traps that silently break a title index:
varbinary Buffers from the replicas, and underscore-vs-space titles."
```

---

## Task 2: Title resolution and move detection via Wiki Replicas

**Files:**
- Modify: `lib/title-resolver.js` (append replica functions, extend exports)
- Modify: `test/title-resolver.test.js` (append a DB-backed describe block)

The replicas are not reachable off Toolforge, so these tests run against the **same podman MariaDB from Phase 2**, seeded with minimal `page` / `page_props` / `logging` tables that mirror the real schema. That verifies the SQL and the Buffer decoding — the parts that actually break — without pretending to test Toolforge connectivity.

**Step 1: Write the failing test**

Append to `test/title-resolver.test.js`:

```javascript
const { connect, testDsn, describeWithDb } = require('./helpers/db-helper')
const { titlesForQidsViaReplica, movesSince } = require('../lib/title-resolver')

describeWithDb('title-resolver (replica SQL)', function() {
  this.timeout(30000)

  let pool

  before(async function() {
    pool = await connect(testDsn())

    // Minimal stand-ins for the replica schema. Types match production:
    // page_title and log_title are varbinary, which is what makes the driver
    // hand back Buffers.
    await pool.query('DROP TABLE IF EXISTS page_props')
    await pool.query('DROP TABLE IF EXISTS page')
    await pool.query('DROP TABLE IF EXISTS logging')

    await pool.query(`
      CREATE TABLE page (
        page_id        INT UNSIGNED NOT NULL PRIMARY KEY,
        page_namespace INT NOT NULL,
        page_title     VARBINARY(255) NOT NULL
      ) ENGINE=InnoDB`)
    await pool.query(`
      CREATE TABLE page_props (
        pp_page     INT UNSIGNED NOT NULL,
        pp_propname VARBINARY(60) NOT NULL,
        pp_value    BLOB NOT NULL,
        PRIMARY KEY (pp_page, pp_propname)
      ) ENGINE=InnoDB`)
    await pool.query(`
      CREATE TABLE logging (
        log_id        INT UNSIGNED NOT NULL PRIMARY KEY,
        log_type      VARBINARY(32) NOT NULL,
        log_action    VARBINARY(32) NOT NULL,
        log_timestamp BINARY(14) NOT NULL,
        log_namespace INT NOT NULL,
        log_title     VARBINARY(255) NOT NULL,
        log_params    BLOB NULL
      ) ENGINE=InnoDB`)

    // Bind the accented title as a parameter. MariaDB does NOT recognize \x
    // as an escape (its set is \0 \' \" \b \n \r \t \Z \\ \% \_), so a
    // literal like 'Caf\xc3\xa9' silently stores the bytes "Cafxc3xa9" - which
    // would make this fixture corrupt and defeat the very decoding it tests.
    await pool.query(
      'INSERT INTO page (page_id, page_namespace, page_title) VALUES (?, ?, ?)',
      [1, 0, Buffer.from('Café_du_Nord', 'utf8')])
    await pool.query(
      `INSERT INTO page (page_id, page_namespace, page_title) VALUES
       (2, 0, 'Alpha'), (3, 1, 'Talk_page')`)
    await pool.query(
      `INSERT INTO page_props (pp_page, pp_propname, pp_value) VALUES
       (1, 'wikibase_item', 'Q10'), (2, 'wikibase_item', 'Q20'),
       (3, 'wikibase_item', 'Q30')`)
  })

  after(async function() {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS page_props')
      await pool.query('DROP TABLE IF EXISTS page')
      await pool.query('DROP TABLE IF EXISTS logging')
      await pool.end()
    }
  })

  describe('titlesForQidsViaReplica', function() {
    it('joins page_props to page and decodes varbinary titles', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q10', 'Q20'], 'en')

      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Café du Nord' }])
      assert.deepEqual(result.get('Q20'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('returns strings, never Buffers', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q10'], 'en')
      assert.isString(result.get('Q10')[0].title)
    })

    it('restricts to mainspace', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q30'], 'en')
      assert.isFalse(result.has('Q30'))
    })

    it('omits QIDs with no local page', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q999'], 'en')
      assert.isFalse(result.has('Q999'))
    })
  })

  describe('movesSince', function() {
    beforeEach(async function() {
      await pool.query('TRUNCATE TABLE logging')
    })

    it('reads the new title out of the JSON log_params', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES (1, 'move', 'move', '20260722120000', 0, 'Old_Name', ?)`,
        [JSON.stringify({ '4::target': 'New Name', '5::noredir': '0' })])

      const moves = await movesSince(pool, '20260722000000')

      assert.equal(moves.length, 1)
      assert.deepEqual(moves[0], { from: 'Old Name', to: 'New Name' })
    })

    it('handles the legacy newline-delimited log_params', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES (2, 'move', 'move_redir', '20260722120000', 0, 'Legacy_Old', 'Legacy New\n0')`)

      const moves = await movesSince(pool, '20260722000000')

      assert.equal(moves.length, 1)
      assert.deepEqual(moves[0], { from: 'Legacy Old', to: 'Legacy New' })
    })

    it('ignores non-move log entries and older timestamps', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES
           (3, 'delete', 'delete', '20260722120000', 0, 'Gone', NULL),
           (4, 'move', 'move', '20260701120000', 0, 'Ancient', ?)`,
        [JSON.stringify({ '4::target': 'Ancient New' })])

      const moves = await movesSince(pool, '20260722000000')
      assert.equal(moves.length, 0)
    })

    it('ignores moves out of mainspace', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES (5, 'move', 'move', '20260722120000', 1, 'Talk_Old', ?)`,
        [JSON.stringify({ '4::target': 'Talk:New' })])

      const moves = await movesSince(pool, '20260722000000')
      assert.equal(moves.length, 0)
    })
  })
})
```

Add `before`, `beforeEach`, `after` to the mocha destructure at the top of the file:

```javascript
const { describe, it, before, beforeEach, after, afterEach } = require('mocha')
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run test:db:start
npx mocha --colors --reporter spec --exit test/title-resolver.test.js
```
Expected: FAIL — `titlesForQidsViaReplica is not a function`

**Step 3: Write the implementation**

Append to `lib/title-resolver.js`, before `module.exports`:

```javascript
const mariadb = require('mariadb')

/** Mainspace only - the bot watches articles, not talk or project pages. */
const NS_MAIN = 0

/**
 * Connect to a Wiki Replica for one wiki.
 *
 * analytics rather than web: a rebuild is a batch job, and the web endpoint's
 * 5-minute timeout is aimed at interactive queries. Credentials come from the
 * same place as ToolsDB.
 *
 * @param {string} wikipedia - language code, e.g. "en"
 * @param {Object} [options]
 */
function connectReplica(wikipedia, options = {}) {
  const env = options.env || process.env
  const dbname = `${wikipedia.replace(/-/g, '_')}wiki`

  const user = options.user || env.TOOL_REPLICA_USER || env.TOOL_TOOLSDB_USER
  const password = options.password || env.TOOL_REPLICA_PASSWORD || env.TOOL_TOOLSDB_PASSWORD

  if (!user || !password) {
    throw new Error(
      'Wiki Replica access needs TOOL_REPLICA_USER / TOOL_REPLICA_PASSWORD ' +
      '(or the TOOLSDB equivalents)')
  }

  return mariadb.createPool({
    host: options.host || `${dbname}.analytics.db.svc.wikimedia.cloud`,
    port: options.port || 3306,
    database: `${dbname}_p`,
    user,
    password,
    connectionLimit: options.connectionLimit || 2,
    bigIntAsNumber: true
  })
}

/**
 * Resolve QIDs to titles with one SQL join instead of N API calls.
 *
 * page_props stores each page's Wikidata item locally on every wiki, so this
 * needs no cross-database join and no network round trip per QID.
 *
 * @param {Object} pool - a mariadb pool for one wiki's replica
 * @param {string[]} qids
 * @param {string} wikipedia - language code, used to label results
 * @returns {Promise<Map<string, Array<{wikipedia, title}>>>}
 */
async function titlesForQidsViaReplica(pool, qids, wikipedia) {
  const result = new Map()
  if (qids.length === 0) return result

  for (const batch of chunk(qids, 500)) {
    const placeholders = batch.map(() => '?').join(',')
    const rows = await pool.query(
      `SELECT pp.pp_value AS qid, p.page_title AS title
       FROM page_props pp
       JOIN page p ON p.page_id = pp.pp_page
       WHERE pp.pp_propname = 'wikibase_item'
         AND p.page_namespace = ?
         AND pp.pp_value IN (${placeholders})`,
      [NS_MAIN, ...batch])

    for (const row of rows) {
      // pp_value is a BLOB and page_title a varbinary: both arrive as Buffers.
      const qid = normalizeTitle(row.qid)
      const title = normalizeTitle(row.title)
      if (!qid || !title) continue

      const existing = result.get(qid) || []
      existing.push({ wikipedia, title })
      result.set(qid, existing)
    }
  }

  return result
}

/**
 * Extract the destination title from a move log entry.
 *
 * MediaWiki >= 1.27 stores log_params as JSON keyed "4::target"; older rows
 * use a newline-delimited string whose first line is the target. Both appear
 * on the replicas because the table is never rewritten.
 */
function parseMoveTarget(params) {
  const text = Buffer.isBuffer(params) ? params.toString('utf8') : String(params || '')
  if (!text) return null

  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      return normalizeTitle(parsed['4::target'] || parsed.target_title || null)
    } catch {
      return null
    }
  }

  return normalizeTitle(text.split('\n')[0])
}

/**
 * Page moves in mainspace since a timestamp.
 *
 * This is what keeps a title-keyed index from silently going dead. A rebuild
 * would eventually catch a rename anyway, by way of the QID resolving to a new
 * title - but the move log catches it in one cheap query rather than by
 * diffing every title in the region.
 *
 * @param {Object} pool - a mariadb pool for one wiki's replica
 * @param {string} sinceTimestamp - MediaWiki format, e.g. "20260722000000"
 * @returns {Promise<Array<{from: string, to: string}>>}
 */
async function movesSince(pool, sinceTimestamp) {
  const rows = await pool.query(
    `SELECT log_title, log_params
     FROM logging
     WHERE log_type = 'move'
       AND log_action IN ('move', 'move_redir')
       AND log_namespace = ?
       AND log_timestamp >= ?
     ORDER BY log_timestamp`,
    [NS_MAIN, sinceTimestamp])

  const moves = []
  for (const row of rows) {
    const from = normalizeTitle(row.log_title)
    const to = parseMoveTarget(row.log_params)
    if (from && to) moves.push({ from, to })
  }
  return moves
}
```

Update the exports block:

```javascript
module.exports = {
  titlesForQidsViaApi,
  titlesForQidsViaReplica,
  connectReplica,
  movesSince,
  parseMoveTarget,
  normalizeTitle,
  siteToWikipedia,
  WIKIDATA_API,
  API_BATCH_SIZE
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/title-resolver.test.js
```
Expected: PASS — 19 passing

**Step 5: Commit**

```bash
git add lib/title-resolver.js test/title-resolver.test.js
git commit -m "feat: replica-backed title resolution and page-move detection

One SQL join replaces N API calls for QID->title. Move detection reads both
the modern JSON log_params and the legacy newline format, since the logging
table carries both forever."
```

---

## Task 3: The rebuild job

**Files:**
- Create: `lib/rebuild.js`
- Create: `scripts/rebuild-topics.js`
- Create: `test/rebuild.test.js`

The rebuild logic lives in `lib/rebuild.js` so it can be tested; `scripts/rebuild-topics.js` is a thin CLI over it. This mirrors how `scripts/reassess.js` keeps its testable helpers separable.

**Step 1: Write the failing test**

Create `test/rebuild.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, before, beforeEach, after } = require('mocha')

const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const { createTopicStore } = require('../lib/topic-store')
const { rebuildTopic, rebuildAll } = require('../lib/rebuild')

describeWithDb('rebuild', function() {
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

  /** Stub resolver standing in for lib/region.js, which Phase 1 tests cover. */
  function resolverReturning(articles) {
    return async () => ({
      region: { qid: 'Q62', label: 'San Francisco', strategy: 'admin' },
      articles
    })
  }

  it('populates an empty topic and reports every article as new', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    const result = await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ])
    })

    assert.deepEqual(result.added.sort(), ['Q10', 'Q20'])
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.newArticles.sort(), ['Q10', 'Q20'])
  })

  it('reports only genuinely new QIDs on a later rebuild', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])
    })

    const result = await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ])
    })

    assert.deepEqual(result.added, ['Q20'])
    assert.deepEqual(result.newArticles, ['Q20'],
      'a QID seen before is not a new article, even if it left and came back')
  })

  it('does not report a returning article as new', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })
    const alpha = [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]

    await rebuildTopic(store, topic.id, { resolver: resolverReturning(alpha) })
    await rebuildTopic(store, topic.id, { resolver: resolverReturning([]) })
    const result = await rebuildTopic(store, topic.id, { resolver: resolverReturning(alpha) })

    assert.deepEqual(result.added, ['Q10'])
    assert.deepEqual(result.newArticles, [])
  })

  it('follows a rename without losing membership', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Old Name', source: 'admin' }
      ])
    })

    const result = await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'New Name', source: 'admin' }
      ])
    })

    assert.deepEqual(result.added, [], 'a rename is not an addition')
    assert.deepEqual(result.removed, [], 'a rename is not a removal')
    assert.deepEqual(result.renamed, [{ qid: 'Q10', from: 'Old Name', to: 'New Name' }])

    const index = await store.getWatchIndex()
    assert.isTrue(index.byWiki.get('en').has('New Name'))
    assert.isFalse(index.byWiki.get('en').has('Old Name'))
  })

  it('leaves the topic untouched when the resolver fails', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])
    })
    const before = await store.getTopic(topic.id)

    const result = await rebuildTopic(store, topic.id, {
      resolver: async () => { throw new Error('WDQS exploded') }
    })

    assert.isFalse(result.ok)
    assert.include(result.error, 'WDQS exploded')

    const after = await store.getTopic(topic.id)
    assert.equal(after.generation, before.generation,
      'a failed rebuild must not empty a working watchlist')

    const index = await store.getWatchIndex()
    assert.isTrue(index.byWiki.get('en').has('Alpha'))
  })

  it('refuses a partial result rather than deleting the missing articles',
    async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })

      await rebuildTopic(store, topic.id, {
        resolver: resolverReturning([
          { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
          { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
        ])
      })

      const result = await rebuildTopic(store, topic.id, {
        resolver: async () => ({
          region: { qid: 'Q62', strategy: 'admin' },
          articles: [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }],
          partial: true
        })
      })

      assert.isFalse(result.ok)
      assert.include(result.error, 'partial')

      const index = await store.getWatchIndex()
      assert.isTrue(index.byWiki.get('en').has('Beta'), 'Beta survives a partial rebuild')
    })

  it('rebuilds every topic and keeps going after one fails', async function() {
    const good = await store.upsertTopic('Q62', { languages: ['en'] })
    const bad = await store.upsertTopic('Q99', { languages: ['en'] })

    const results = await rebuildAll(store, {
      resolver: async (regionQid) => {
        if (regionQid === 'Q99') throw new Error('nope')
        return {
          region: { qid: regionQid, strategy: 'admin' },
          articles: [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]
        }
      }
    })

    assert.equal(results.length, 2)
    assert.isTrue(results.find(r => r.topicId === good.id).ok)
    assert.isFalse(results.find(r => r.topicId === bad.id).ok)
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/rebuild.test.js
```
Expected: FAIL — `Cannot find module '../lib/rebuild'`

**Step 3: Write the implementation**

Create `lib/rebuild.js`:

```javascript
/**
 * Topic rebuild: re-resolve a region and set-diff against stored membership.
 *
 * Two useful signals fall out of the diff rather than needing their own
 * machinery:
 *  - a QID that has never been seen in this topic before IS the "something in
 *    this place just got a Wikipedia article" signal
 *  - a QID whose title changed IS a rename, which is what keeps the
 *    title-keyed hot-path index from silently going dead
 *
 * The job refuses to apply an incomplete result. A partial or failed resolve
 * that got written through would empty a working watchlist, and a bot that
 * silently stops posting is worse than one that logs an error.
 */

const { articlesForRegion } = require('./region')

/** Default resolver: the real Phase 1 region resolver. */
async function defaultResolver(regionQid, topic) {
  let partial = false
  const result = await articlesForRegion(regionQid, {
    strategy: topic.strategy,
    languages: topic.languages,
    onChunkError: () => { partial = true }
  })
  return { ...result, partial }
}

/**
 * Rebuild one topic.
 *
 * @param {Object} store - from createTopicStore()
 * @param {number} topicId
 * @param {Object} [options]
 * @param {Function} [options.resolver] - (regionQid, topic) => {articles, partial}
 * @returns {Promise<{ok, topicId, added, removed, renamed, newArticles, error}>}
 */
async function rebuildTopic(store, topicId, options = {}) {
  const { resolver = defaultResolver } = options

  const topic = await store.getTopic(topicId)
  if (!topic) {
    return { ok: false, topicId, error: `topic ${topicId} does not exist` }
  }

  let resolved
  try {
    resolved = await resolver(topic.regionQid, topic)
  } catch (error) {
    return { ok: false, topicId, error: error.message }
  }

  if (resolved.partial) {
    return {
      ok: false,
      topicId,
      error: `resolve for ${topic.regionQid} was partial; refusing to apply ` +
        'an incomplete article set over a working one'
    }
  }

  // Snapshot QID -> title BEFORE the write.
  //
  // This ordering is load-bearing. setTopicArticles() calls upsertArticle(),
  // which does `UPDATE articles SET title = ?` - so after the write, every
  // stored title is already the new one and a rename is undetectable. The
  // snapshot has to be keyed by QID, not by title, because the title is
  // exactly the thing that changed.
  const priorTitles = await titlesByQid(store, topicId)
  // Keys are "wiki:qid"; the new-article test only cares about the QID.
  const knownQids = new Set(
    Array.from(priorTitles.keys()).map(key => key.slice(key.indexOf(':') + 1)))

  const diff = await store.setTopicArticles(topicId, resolved.articles)

  const renamed = []
  for (const article of resolved.articles) {
    const previous = priorTitles.get(`${article.wikipedia}:${article.qid}`)
    if (previous && previous !== article.title) {
      renamed.push({ qid: article.qid, from: previous, to: article.title })
    }
  }

  // A rename shows up in the diff as an add; strip it back out so callers
  // are not told an article joined when it only changed name.
  const renamedQids = new Set(renamed.map(r => r.qid))
  const added = diff.added.filter(qid => !renamedQids.has(qid))
  const removed = diff.removed.filter(qid => !renamedQids.has(qid))

  const newArticles = added.filter(qid => !knownQids.has(qid))

  return { ok: true, topicId, added, removed, renamed, newArticles }
}

/**
 * Every ('wiki:qid' -> title) this topic currently holds, INCLUDING departed
 * articles.
 *
 * Serves two purposes at once, both of which need the pre-write state:
 *  - its values are the old titles, for rename detection
 *  - its keys are every QID ever seen in this topic, so "new article" means
 *    never-before-seen rather than merely absent-last-night. An article that
 *    leaves and comes back must not re-trigger the new-article signal.
 */
async function titlesByQid(store, topicId) {
  const rows = await store.pool.query(
    `SELECT a.wikipedia, a.wikidata_qid AS qid, a.title
     FROM topic_articles ta
     JOIN articles a ON a.id = ta.article_id
     WHERE ta.topic_id = ?`, [topicId])

  const titles = new Map()
  for (const row of rows) {
    titles.set(`${row.wikipedia}:${row.qid}`, String(row.title))
  }
  return titles
}

/**
 * Rebuild every topic. One topic's failure never stops the others - a single
 * bad region should not take the whole nightly pass down.
 *
 * Sequential on purpose: rebuilds are SPARQL-heavy and the WDQS budget is
 * shared, so running them in parallel just spends it faster.
 *
 * @returns {Promise<Array>} one result object per topic
 */
async function rebuildAll(store, options = {}) {
  const rows = await store.pool.query('SELECT id FROM topics ORDER BY id')
  const results = []

  for (const row of rows) {
    results.push(await rebuildTopic(store, Number(row.id), options))
  }

  return results
}

module.exports = { rebuildTopic, rebuildAll, defaultResolver }
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/rebuild.test.js
```
Expected: PASS — 7 passing

**Step 5: Write the CLI wrapper**

Create `scripts/rebuild-topics.js`:

```javascript
#!/usr/bin/env node
/**
 * Nightly topic rebuild.
 *
 * On Toolforge this runs as a scheduled job:
 *   toolforge jobs run rebuild-topics \
 *     --command "node scripts/rebuild-topics.js all" \
 *     --image <build-service-image> --schedule '@daily' --mem 1Gi
 *
 * Usage:
 *   node scripts/rebuild-topics.js all            rebuild every topic
 *   node scripts/rebuild-topics.js topic <id>     rebuild one topic
 *   node scripts/rebuild-topics.js gc             collect orphaned topics
 */

const { loadConfig } = require('../lib/config')
const { createTopicStore } = require('../lib/topic-store')
const { rebuildTopic, rebuildAll } = require('../lib/rebuild')

function reportOne(result) {
  if (!result.ok) {
    console.error(`topic ${result.topicId}: FAILED - ${result.error}`)
    return
  }

  const parts = [
    `+${result.added.length}`,
    `-${result.removed.length}`,
    `~${result.renamed.length} renamed`
  ]
  console.log(`topic ${result.topicId}: ${parts.join(' ')}`)

  for (const rename of result.renamed) {
    console.log(`  renamed ${rename.qid}: "${rename.from}" -> "${rename.to}"`)
  }
  if (result.newArticles.length > 0) {
    console.log(`  new articles: ${result.newArticles.join(', ')}`)
  }
}

async function main() {
  const [mode, argument] = process.argv.slice(2)

  if (!mode || !['all', 'topic', 'gc'].includes(mode)) {
    console.error('usage: rebuild-topics.js all | topic <id> | gc')
    process.exit(2)
  }

  const config = loadConfig()
  if (!config.topic_store) {
    console.error('config has no topic_store stanza')
    process.exit(1)
  }

  const store = createTopicStore({ config: config.topic_store })

  try {
    if (mode === 'gc') {
      const collected = await store.collectOrphanTopics()
      console.log(collected.length > 0
        ? `collected ${collected.length} orphaned topic(s): ${collected.join(', ')}`
        : 'no orphaned topics')
      return
    }

    if (mode === 'topic') {
      if (!argument) {
        console.error('topic mode needs a topic id')
        process.exit(2)
      }
      reportOne(await rebuildTopic(store, Number(argument)))
      return
    }

    const results = await rebuildAll(store)
    results.forEach(reportOne)

    const failed = results.filter(r => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} topics rebuilt`)
    if (failed > 0) process.exitCode = 1
  } finally {
    await store.close()
  }
}

main().catch(error => {
  console.error('rebuild-topics failed:', error.message)
  process.exit(1)
})
```

Make it executable:

```bash
chmod +x scripts/rebuild-topics.js
```

**Step 6: Verify the CLI operationally**

Run:
```bash
node scripts/rebuild-topics.js
```
Expected: prints the usage line and exits 2.

Run:
```bash
SFEDITS_CONFIG='{"accounts":[]}' node scripts/rebuild-topics.js all
```
Expected: `config has no topic_store stanza`, exit 1.

Run:
```bash
npm test
```
Expected: the Phase 2 total plus every test written in this phase, 0 failing

**Step 7: Commit**

```bash
git add lib/rebuild.js scripts/rebuild-topics.js test/rebuild.test.js
git commit -m "feat: nightly topic rebuild with set-diff

Renames, new-article signals, and departures all fall out of one diff. A
failed or partial resolve is refused rather than applied - emptying a
working watchlist is a worse failure than logging an error."
```

---

## Phase 3 Done When

- `npm test` is green, with no pre-existing test failing.
- A rebuild against a seeded topic correctly reports adds, removals, and renames, and a rename is reported as neither an add nor a remove.
- A returning article is not re-reported as a new article.
- A failed or partial resolve leaves the stored membership and generation untouched.
- `node scripts/rebuild-topics.js` handles `all`, `topic <id>`, and `gc`.

**Manual verification against live data before Phase 4:**

```bash
node -e "
const { titlesForQidsViaApi } = require('./lib/title-resolver')
;(async () => {
  const titles = await titlesForQidsViaApi(['Q62', 'Q1917571'], { languages: ['en', 'es'] })
  console.log(JSON.stringify(Object.fromEntries(titles), null, 2))
})()
"
```

Expected: San Francisco and the Mission District with their real current titles in both languages. If a title comes back with underscores or as a Buffer-shaped object, `normalizeTitle` is not being applied on some path — fix that before Phase 4 builds an index on top of it.
