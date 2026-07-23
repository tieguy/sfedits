# Place-Bot Platform Implementation Plan — Phase 1: Region Resolver

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Turn a Wikidata place QID into a set of article QIDs plus a class×language count histogram, at every region scale, without hitting WDQS timeouts.

**Architecture:** A new `lib/region.js` dispatches between two membership strategies — a transitive `P131*` closure for administrative entities, and an OSM-polygon point-in-polygon filter for informal neighborhoods. Both run on a shared SPARQL helper extracted from the existing `lib/wikidata-claim-watch.js`, which already proved the per-chunk anchoring trick that keeps WDQS from timing out.

**Tech Stack:** Node 20+ (global fetch), Wikidata Query Service (SPARQL), Overpass API (OSM boundaries), `@turf/boolean-point-in-polygon`, mocha/chai/nock.

**Scope:** Phase 1 of 5 (Plan A) from `docs/design-plans/2026-07-23-place-bot-platform.md`.

**Codebase verified:** 2026-07-23 04:27 PDT, branch `place-bot-platform`, baseline 244 passing / 1 pending.

---

## Context the executing engineer needs

**Testing conventions in this repo** (follow these exactly; do not introduce new ones):

- Mocha is configured entirely by the `npm test` script in `package.json:30`: `mocha --colors --reporter spec --exit test/**/*.js`. There is no `.mocharc`.
- Assertions use **chai's `assert` style**, not `expect`: `const { assert } = require('chai')`.
- HTTP is mocked with **nock v14**, which intercepts global `fetch` directly. Always `nock.cleanAll()` in `afterEach`. See `test/wikidata-claim-watch.test.js:134-153` for the SPARQL POST mocking pattern.
- Modules that need a writable directory take it as a destructured option: `fn(config, { dataDir })`. Tests create it with `fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-'))` in `beforeEach` and `fs.rmSync(dataDir, { recursive: true, force: true })` in `afterEach`. See `test/watchlist-sync.test.js:38-45`.
- Suites set `this.timeout(5000)` at the `describe` level.

**Critical external-research findings that shape this phase:**

- **WDQS has degraded significantly as of 2026.** Queries that ran in under a second historically now take 9–27 seconds or time out. The service budget is 60 seconds of query time per minute per (IP, User-Agent) pair, burst 120s; errors are capped at 30/minute. **Chunking is a correctness requirement here, not an optimization.** Source: <https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/query_limits>
- Throttling is **not** signalled by a documented header. It surfaces as a non-200 status or a body containing "Query timeout limit reached". Code must treat both as retryable.
- POST (not GET) is required for large queries — already what `sparqlSelect` does.
- `wikibase:around` radius is **kilometres only**, no other units. Source: <https://en.wikibooks.org/wiki/SPARQL/SERVICE_-_around_and_box>
- Overpass API is preferred over the raw OSM API for boundary fetching: ~1M requests/day, signals quota exhaustion with HTTP 429, and a descriptive User-Agent is mandatory. Source: <https://operations.osmfoundation.org/policies/api/>
- `@turf/boolean-point-in-polygon` correctly handles MultiPolygon and interior holes; the lighter `point-in-polygon` package does not reliably. Use turf.

**Verified codebase facts:**

- `lib/region.js` does **not** exist.
- `lib/wikidata-claim-watch.js:155-172` defines `sparqlSelect(query)`. It is **not** in `module.exports` (`lib/wikidata-claim-watch.js:404-414` exports `parseClaimEdit`, `matchClaim`, `RateCap`, `refreshTargetSets`, `fetchLabels`, `handleWikidataEdit`, `startClaimWatch`, `BAY_AREA_COUNTIES`, `DEFAULT_PROPERTIES`). Nothing outside the module calls it, so moving it is safe.
- `sparqlSelect` returns **one column only** — line 170 does `Object.values(b)[0].value`. The region resolver needs multi-column rows, so Task 2 adds a separate `sparqlRows()` rather than changing the existing single-column contract.
- The per-chunk anchoring pattern lives at `lib/wikidata-claim-watch.js:193-197` (places) and `:204-210` (positions), looping over `BAY_AREA_COUNTIES` (`:43-53`).
- `lib/geolocation.js` is **IP** geolocation via MaxMind. It has nothing to do with coordinates or polygons. There is no existing OSM/Overpass/polygon code anywhere in the repo.
- `test/wikidata-claim-watch.test.js` currently covers `refreshTargetSets` with a `.times(9)` nock scope (one per county). Refactoring `sparqlSelect` out must keep those tests green.

---

## Task 1: Add geo dependency

**Type:** Infrastructure — verify operationally, no unit tests.

**Files:**
- Modify: `package.json` (dependencies block, currently `package.json:8-19`)

**Step 1: Install the dependency**

```bash
npm install --save @turf/boolean-point-in-polygon
```

**Step 2: Verify operationally**

Run:
```bash
node -e "
const m = require('@turf/boolean-point-in-polygon')
const fn = typeof m === 'function' ? m : m.default
console.log('bare:', typeof m, 'default:', typeof m.default, 'resolved:', typeof fn)
"
```
Expected: `resolved: function`

Turf v7 ships dual ESM/CJS builds, so under `require()` the function may sit on `.default` depending on the resolved version. Do **not** branch on this in a later task — Task 5 uses a single deterministic interop line that works either way.

Run:
```bash
npm test
```
Expected: 244 passing, 1 pending, 0 failing (unchanged baseline)

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @turf/boolean-point-in-polygon for region geo filtering"
```

---

## Task 2: Extract the shared SPARQL helper

**Type:** Functionality — refactor with existing tests as the safety net, plus new tests for new behavior.

**Files:**
- Create: `lib/sparql.js`
- Modify: `lib/wikidata-claim-watch.js:155-172` (remove `sparqlSelect`, import from `lib/sparql`)
- Create: `test/sparql.test.js`

**Step 1: Write the failing test**

Create `test/sparql.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { sparqlSelect, sparqlRows, sparqlChunked } = require('../lib/sparql')

const WDQS = 'https://query.wikidata.org'

function bindings(rows) {
  return {
    results: {
      bindings: rows
    }
  }
}

describe('sparql', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('sparqlSelect', function() {
    it('returns bare QIDs from the first column', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { p: { value: 'http://www.wikidata.org/entity/Q62' } },
        { p: { value: 'http://www.wikidata.org/entity/Q100' } }
      ]))

      const result = await sparqlSelect('SELECT ?p WHERE { }')
      assert.deepEqual(result, ['Q62', 'Q100'])
    })
  })

  describe('sparqlRows', function() {
    it('returns every column, stripping entity prefixes', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: { value: 'http://www.wikidata.org/entity/Q1' },
          article: { value: 'https://en.wikipedia.org/wiki/Balmy_Alley' },
          cls: { value: 'http://www.wikidata.org/entity/Q1500350' }
        }
      ]))

      const rows = await sparqlRows('SELECT ?item ?article ?cls WHERE { }')
      assert.deepEqual(rows, [{
        item: 'Q1',
        article: 'https://en.wikipedia.org/wiki/Balmy_Alley',
        cls: 'Q1500350'
      }])
    })

    it('omits unbound optional columns', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { item: { value: 'http://www.wikidata.org/entity/Q1' } }
      ]))

      const rows = await sparqlRows('SELECT ?item ?article WHERE { }')
      assert.deepEqual(rows, [{ item: 'Q1' }])
    })
  })

  describe('sparqlChunked', function() {
    it('runs one query per chunk and concatenates the rows', async function() {
      const seen = []
      nock(WDQS).post('/sparql', body => {
        seen.push(decodeURIComponent(String(body)))
        return true
      }).times(3).reply(200, bindings([
        { item: { value: 'http://www.wikidata.org/entity/Q1' } }
      ]))

      const rows = await sparqlChunked(
        ['Q62', 'Q107146', 'Q108058'],
        qid => `SELECT ?item WHERE { ?item wdt:P131* wd:${qid} }`
      )

      assert.equal(rows.length, 3)
      assert.equal(seen.length, 3)
      assert.isTrue(seen.some(q => q.includes('wd:Q107146')))
    })

    it('retries a chunk that times out, then succeeds', async function() {
      nock(WDQS).post('/sparql').reply(500, 'Query timeout limit reached')
      nock(WDQS).post('/sparql').reply(200, bindings([
        { item: { value: 'http://www.wikidata.org/entity/Q9' } }
      ]))

      const rows = await sparqlChunked(['Q62'], qid => `SELECT ?item WHERE { wd:${qid} }`,
        { retries: 1, retryDelayMs: 0 })

      assert.deepEqual(rows, [{ item: 'Q9' }])
    })

    it('reports which chunks failed after exhausting retries', async function() {
      nock(WDQS).post('/sparql').times(2).reply(500, 'Query timeout limit reached')

      const failed = []
      const rows = await sparqlChunked(['Q62'], qid => `SELECT ?item WHERE { wd:${qid} }`,
        { retries: 1, retryDelayMs: 0, onChunkError: (chunk) => failed.push(chunk) })

      assert.deepEqual(rows, [])
      assert.deepEqual(failed, ['Q62'])
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/sparql.test.js
```
Expected: FAIL — `Cannot find module '../lib/sparql'`

**Step 3: Write the implementation**

Create `lib/sparql.js`:

```javascript
/**
 * Shared Wikidata Query Service access.
 *
 * Extracted from lib/wikidata-claim-watch.js, which learned the hard way that
 * a single query spanning nine counties times out while nine queries anchored
 * at one county each do not. WDQS degraded further through 2026 - queries that
 * were sub-second historically now run 9-27s - and the service budget is 60s
 * of query time per minute per (IP, User-Agent). So chunking is a correctness
 * requirement, not a tuning knob, and every caller that can chunk should.
 *
 * @see https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/query_limits
 */

const SPARQL_URL = 'https://query.wikidata.org/sparql'
const USER_AGENT = 'sfedits-region/1.0 (https://github.com/tieguy/sfedits)'
const ENTITY_PREFIX = 'http://www.wikidata.org/entity/'
const QUERY_TIMEOUT_MS = 60000

const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 2000

/** Strip the entity URI prefix so callers deal in bare QIDs. */
function bareQid(value) {
  return value.startsWith(ENTITY_PREFIX) ? value.slice(ENTITY_PREFIX.length) : value
}

/**
 * Execute a SPARQL SELECT and return the raw bindings.
 * @throws {Error} on non-200, with the body text attached for timeout detection
 */
async function sparqlRaw(query) {
  const response = await fetch(SPARQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/sparql-results+json'
    },
    body: new URLSearchParams({ format: 'json', query }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error = new Error(`SPARQL returned ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  const data = await response.json()
  return data.results.bindings
}

/**
 * Single-column SELECT returning bare QIDs. Preserves the exact contract the
 * claim watcher has always relied on.
 * @returns {Promise<string[]>}
 */
async function sparqlSelect(query) {
  const bindings = await sparqlRaw(query)
  return bindings.map(b => bareQid(Object.values(b)[0].value))
}

/**
 * Multi-column SELECT. Entity URIs are reduced to bare QIDs; everything else
 * (sitelink URLs, labels, counts) passes through as-is. Unbound OPTIONAL
 * columns are simply absent from the row object.
 * @returns {Promise<Object[]>}
 */
async function sparqlRows(query) {
  const bindings = await sparqlRaw(query)
  return bindings.map(binding => {
    const row = {}
    for (const [key, cell] of Object.entries(binding)) {
      row[key] = bareQid(cell.value)
    }
    return row
  })
}

/** WDQS signals overload by status and by body text, not by header. */
function isRetryable(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  if (error.status && error.status >= 500) return true
  return Boolean(error.body && /timeout|too many requests/i.test(error.body))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Run one query per chunk, sequentially, concatenating the rows.
 *
 * Sequential on purpose: the WDQS budget is query-seconds per minute, so
 * firing chunks in parallel spends the same budget faster and gets throttled.
 *
 * A chunk that fails after its retries does not fail the whole call - it is
 * reported through onChunkError and omitted. A partial region list is more
 * useful than none, and the caller decides whether to treat it as fatal.
 *
 * @param {string[]} chunks - anchors (QIDs, classes) to build queries from
 * @param {(chunk: string) => string} buildQuery
 * @param {Object} [options]
 * @param {number} [options.retries=2]
 * @param {number} [options.retryDelayMs=2000]
 * @param {(chunk: string, error: Error) => void} [options.onChunkError]
 * @returns {Promise<Object[]>}
 */
async function sparqlChunked(chunks, buildQuery, options = {}) {
  const {
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    onChunkError = null
  } = options

  const rows = []

  for (const chunk of chunks) {
    let lastError = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const chunkRows = await sparqlRows(buildQuery(chunk))
        rows.push(...chunkRows)
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < retries && isRetryable(error)) {
          if (retryDelayMs > 0) await sleep(retryDelayMs)
          continue
        }
        break
      }
    }

    if (lastError) {
      if (onChunkError) onChunkError(chunk, lastError)
      else console.error(`SPARQL chunk ${chunk} failed: ${lastError.message}`)
    }
  }

  return rows
}

module.exports = {
  sparqlSelect,
  sparqlRows,
  sparqlChunked,
  isRetryable,
  SPARQL_URL,
  USER_AGENT
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/sparql.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Rewire the claim watcher to the shared helper**

In `lib/wikidata-claim-watch.js`, delete the local `sparqlSelect` definition at lines 155-172 and add the import alongside the other requires near the top of the file (after `const path = require('path')`, currently line 36):

```javascript
const { sparqlSelect } = require('./sparql')
```

Then delete the now-unused `SPARQL_URL` constant at line 39. Leave `WIKIDATA_API` (line 40) and `USER_AGENT` (line 38) alone — `fetchLabels` still uses both.

**Step 6: Verify the refactor changed nothing observable**

Run:
```bash
npm test
```
Expected: the baseline 244 plus the 6 new sparql tests, 0 failing. Verify the delta rather than trusting an absolute number: no pre-existing test may fail. In particular `test/wikidata-claim-watch.test.js`'s "builds place and position sets from SPARQL and writes a cache" and "falls back to the cache when SPARQL fails" must still pass, since they exercise `sparqlSelect` through `refreshTargetSets`.

**Step 7: Commit**

```bash
git add lib/sparql.js lib/wikidata-claim-watch.js test/sparql.test.js
git commit -m "refactor: extract shared SPARQL helper with chunking and retry

sparqlSelect moves out of wikidata-claim-watch unchanged. Adds sparqlRows
for multi-column results and sparqlChunked, which encodes the per-anchor
chunking the claim watcher already relied on plus retry handling for the
degraded 2026 WDQS."
```

---

## Task 3: Region descriptor resolution

**Files:**
- Create: `lib/region.js`
- Create: `test/region.test.js`

**Step 1: Write the failing test**

Create `test/region.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { resolveRegion } = require('../lib/region')

const WDQS = 'https://query.wikidata.org'

function bindings(rows) {
  return { results: { bindings: rows } }
}

function entity(qid) {
  return { value: `http://www.wikidata.org/entity/${qid}` }
}

describe('region', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('resolveRegion', function() {
    it('classifies an administrative entity as the admin strategy', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q62049'),          // consolidated city-county
          label: { value: 'San Francisco' },
          osm: { value: '111968' },
          coord: { value: 'Point(-122.4194 37.7749)' }
        }
      ]))

      const region = await resolveRegion('Q62')

      assert.equal(region.qid, 'Q62')
      assert.equal(region.strategy, 'admin')
      assert.equal(region.label, 'San Francisco')
      assert.equal(region.osmRelationId, '111968')
      assert.deepEqual(region.centroid, { lon: -122.4194, lat: 37.7749 })
    })

    it('classifies an informal neighborhood as the geo strategy', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'),         // neighborhood
          label: { value: 'Mission District' },
          osm: { value: '2222222' },
          coord: { value: 'Point(-122.4148 37.7599)' }
        }
      ]))

      const region = await resolveRegion('Q1917571')

      assert.equal(region.strategy, 'geo')
      assert.equal(region.label, 'Mission District')
    })

    it('honors an explicit strategy override', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'),
          label: { value: 'Mission District' },
          coord: { value: 'Point(-122.4148 37.7599)' }
        }
      ]))

      const region = await resolveRegion('Q1917571', { strategy: 'admin' })

      assert.equal(region.strategy, 'admin')
    })

    it('throws a descriptive error when the QID is not a place', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))

      try {
        await resolveRegion('Q42')
        assert.fail('expected resolveRegion to throw')
      } catch (error) {
        assert.include(error.message, 'Q42')
        assert.include(error.message, 'not a usable place')
      }
    })

    it('falls back to geo when an informal region has no coordinate', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q123705'), label: { value: 'Nowhere' } }
      ]))

      try {
        await resolveRegion('Q999')
        assert.fail('expected resolveRegion to throw')
      } catch (error) {
        assert.include(error.message, 'no coordinate')
      }
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: FAIL — `Cannot find module '../lib/region'`

**Step 3: Write the implementation**

Create `lib/region.js` with this content (later tasks append to this same file):

```javascript
/**
 * Region resolver: a Wikidata place QID in, an article set out.
 *
 * Two membership strategies, chosen by scale rather than by preference. There
 * is no single query that works from "Balmy Alley" to "California":
 *
 *  - admin: the region is a real administrative entity, so P131* returns its
 *    whole hierarchy in one relational hop. Coordinate-free, so it catches
 *    items with no precise point, and it never scans a polygon.
 *  - geo: the region is an informal neighborhood with no administrative
 *    sub-entities, so membership means "inside this boundary". Only viable
 *    because the candidate set around one neighborhood is small.
 *
 * @see docs/design-plans/2026-07-23-place-bot-platform.md
 */

const { sparqlRows, sparqlChunked } = require('./sparql')

/**
 * Wikidata classes that mean "this is an administrative entity with
 * sub-entities", so P131* will return a populated hierarchy. Anything else
 * place-like falls through to the spatial strategy.
 */
const ADMIN_CLASSES = new Set([
  'Q6256',      // country
  'Q7275',      // state
  'Q35657',     // U.S. state
  'Q28575',     // county
  'Q13220204',  // county of a U.S. state
  'Q62049',     // consolidated city-county
  'Q515',       // city
  'Q1093829',   // city of the United States
  'Q15284',     // municipality
  'Q3957',      // town
  'Q532',       // village
  'Q56061'      // administrative territorial entity
])

/** Parse a WKT point literal as emitted by WDQS. */
function parsePoint(wkt) {
  const match = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt || '')
  if (!match) return null
  return { lon: Number(match[1]), lat: Number(match[2]) }
}

/**
 * Resolve a place QID into a descriptor: what it is, where it is, and which
 * membership strategy applies.
 *
 * @param {string} qid - e.g. "Q62"
 * @param {Object} [options]
 * @param {'auto'|'admin'|'geo'} [options.strategy='auto']
 * @returns {Promise<{qid, label, classes, strategy, osmRelationId, centroid}>}
 * @throws {Error} when the QID is not a place, or a geo region has no coordinate
 */
async function resolveRegion(qid, options = {}) {
  const { strategy: requested = 'auto' } = options

  const rows = await sparqlRows(`
    SELECT ?cls ?label ?osm ?coord WHERE {
      wd:${qid} wdt:P31 ?cls .
      OPTIONAL { wd:${qid} wdt:P402 ?osm }
      OPTIONAL { wd:${qid} wdt:P625 ?coord }
      OPTIONAL {
        wd:${qid} rdfs:label ?label .
        FILTER(LANG(?label) = "en")
      }
    }
  `)

  if (rows.length === 0) {
    throw new Error(`${qid} is not a usable place: no instance-of (P31) statement`)
  }

  const classes = rows.map(r => r.cls).filter(Boolean)
  const label = rows.find(r => r.label)?.label || qid
  const osmRelationId = rows.find(r => r.osm)?.osm || null
  const centroid = parsePoint(rows.find(r => r.coord)?.coord)

  const strategy = requested === 'auto'
    ? (classes.some(c => ADMIN_CLASSES.has(c)) ? 'admin' : 'geo')
    : requested

  if (strategy === 'geo' && !centroid) {
    throw new Error(
      `${qid} (${label}) needs the geo strategy but has no coordinate (P625) to seed from`)
  }

  return { qid, label, classes, strategy, osmRelationId, centroid }
}

module.exports = {
  resolveRegion,
  ADMIN_CLASSES,
  parsePoint
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Commit**

```bash
git add lib/region.js test/region.test.js
git commit -m "feat: resolve a place QID into a region descriptor

Classifies by P31 into the admin or geo membership strategy, and carries
the OSM relation and centroid the spatial path needs."
```

---

## Task 4: Administrative containment strategy

**Files:**
- Modify: `lib/region.js` (append `articlesByAdmin`, extend `module.exports`)
- Modify: `test/region.test.js` (append a `describe` block)

**Step 1: Write the failing test**

Append to `test/region.test.js`, inside the top-level `describe('region', ...)` block:

```javascript
  describe('articlesByAdmin', function() {
    const { articlesByAdmin } = require('../lib/region')

    it('returns one article row per sitelink, chunked by sub-entity', async function() {
      // chunk discovery query
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))
      // one closure query per chunk
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q20'),
          cls: entity('Q5'),
          article: { value: 'https://es.wikipedia.org/wiki/Beta' },
          lang: { value: 'es' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', label: 'San Francisco', strategy: 'admin' },
        { languages: ['en', 'es'] })

      assert.equal(articles.length, 2)
      assert.deepEqual(articles[0], {
        qid: 'Q10',
        cls: 'Q515',
        lang: 'en',
        wikipedia: 'en',
        title: 'Alpha',
        source: 'admin'
      })
      assert.equal(articles[1].title, 'Beta')
      assert.equal(articles[1].wikipedia, 'es')
    })

    it('decodes percent-encoded and underscored titles', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q30'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Caf%C3%A9_du_Nord' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(articles[0].title, 'Café du Nord')
    })

    it('deduplicates an item reachable through two sub-entities', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))
      const dupe = {
        item: entity('Q10'),
        cls: entity('Q515'),
        article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
        lang: { value: 'en' }
      }
      nock(WDQS).post('/sparql').reply(200, bindings([dupe]))
      nock(WDQS).post('/sparql').reply(200, bindings([dupe]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(articles.length, 1)
    })

    it('queries the region directly when it has no sub-entities', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      nock(WDQS).post('/sparql', body =>
        decodeURIComponent(String(body)).includes('wd:Q1917571')
      ).reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q1917571', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(articles.length, 1)
    })
  })
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: FAIL — `articlesByAdmin is not a function`

**Step 3: Write the implementation**

Append to `lib/region.js`, before `module.exports`:

```javascript
/**
 * Turn a sitelink URL into a (wikipedia, title) pair.
 * "https://en.wikipedia.org/wiki/Caf%C3%A9_du_Nord" -> { wikipedia: 'en', title: 'Café du Nord' }
 */
function parseSitelink(url) {
  const match = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i.exec(url || '')
  if (!match) return null
  return {
    wikipedia: match[1],
    title: decodeURIComponent(match[2]).replace(/_/g, ' ')
  }
}

/** VALUES clause for a language filter, or empty string for "all languages". */
function languageFilter(languages) {
  if (!languages || languages.length === 0) return ''
  const values = languages.map(l => `"${l}"`).join(' ')
  return `VALUES ?lang { ${values} }`
}

/**
 * Find the region's immediate sub-entities, to use as chunk anchors.
 *
 * Anchoring each closure query at one sub-entity is what keeps a county- or
 * state-scale query inside the WDQS budget - the same trick the Bay Area claim
 * watcher uses to avoid a nine-county union timing out.
 */
async function subEntities(regionQid) {
  const rows = await sparqlRows(`
    SELECT ?sub WHERE { ?sub wdt:P131 wd:${regionQid} }
  `)
  return rows.map(r => r.sub).filter(Boolean)
}

/**
 * Administrative containment: everything whose located-in chain reaches the
 * region, with its Wikipedia articles in the requested languages.
 *
 * @param {Object} region - descriptor from resolveRegion()
 * @param {Object} [options]
 * @param {string[]} [options.languages] - wiki language codes; omit for all
 * @param {(chunk: string, error: Error) => void} [options.onChunkError]
 * @returns {Promise<Array<{qid, cls, lang, wikipedia, title, source}>>}
 */
async function articlesByAdmin(region, options = {}) {
  const { languages = null, onChunkError = null } = options

  // Chunk on sub-entities when there are any; otherwise the region is small
  // enough (or flat enough) to query in one shot anchored at itself.
  const subs = await subEntities(region.qid)
  const anchors = subs.length > 0 ? subs : [region.qid]

  const rows = await sparqlChunked(anchors, anchor => `
    SELECT ?item ?cls ?article ?lang WHERE {
      ?item wdt:P131* wd:${anchor} .
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
      ${languageFilter(languages)}
    }
  `, { onChunkError })

  const seen = new Set()
  const articles = []

  for (const row of rows) {
    const sitelink = parseSitelink(row.article)
    if (!sitelink) continue

    const key = `${sitelink.wikipedia}:${sitelink.title}`
    if (seen.has(key)) continue
    seen.add(key)

    articles.push({
      qid: row.item,
      cls: row.cls,
      lang: row.lang,
      wikipedia: sitelink.wikipedia,
      title: sitelink.title,
      source: 'admin'
    })
  }

  return articles
}
```

Update the exports block at the end of `lib/region.js`:

```javascript
module.exports = {
  resolveRegion,
  articlesByAdmin,
  parseSitelink,
  ADMIN_CLASSES,
  parsePoint
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Commit**

```bash
git add lib/region.js test/region.test.js
git commit -m "feat: administrative containment strategy for region membership

P131* closure chunked per sub-entity so county and state scale stays inside
the WDQS budget. Dedupes items reachable through more than one sub-entity."
```

---

## Task 5: Geographic containment strategy

**Files:**
- Create: `lib/osm-boundary.js`
- Modify: `lib/region.js` (append `articlesByGeo`, extend exports)
- Create: `test/osm-boundary.test.js`
- Modify: `test/region.test.js` (append a `describe` block)

**Step 1: Write the failing test for boundary fetching**

Create `test/osm-boundary.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { fetchBoundary } = require('../lib/osm-boundary')

const OVERPASS = 'https://overpass-api.de'

describe('osm-boundary', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  it('builds a GeoJSON polygon from an Overpass relation', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        id: 2222222,
        members: [{
          type: 'way',
          role: 'outer',
          geometry: [
            { lat: 37.75, lon: -122.42 },
            { lat: 37.77, lon: -122.42 },
            { lat: 37.77, lon: -122.40 },
            { lat: 37.75, lon: -122.40 }
          ]
        }]
      }]
    })

    const polygon = await fetchBoundary('2222222')

    assert.equal(polygon.type, 'Feature')
    assert.equal(polygon.geometry.type, 'Polygon')
    // ring is closed
    const ring = polygon.geometry.coordinates[0]
    assert.deepEqual(ring[0], ring[ring.length - 1])
  })

  it('builds a MultiPolygon when the relation has several outer ways', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 }, { lat: 1, lon: 0 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 5, lon: 5 }, { lat: 6, lon: 5 }, { lat: 6, lon: 6 }, { lat: 5, lon: 5 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('333')
    assert.equal(polygon.geometry.type, 'MultiPolygon')
    assert.equal(polygon.geometry.coordinates.length, 2)
  })

  it('throws when the relation has no usable geometry', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, { elements: [] })

    try {
      await fetchBoundary('404404')
      assert.fail('expected fetchBoundary to throw')
    } catch (error) {
      assert.include(error.message, '404404')
    }
  })

  it('surfaces Overpass quota exhaustion distinctly', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(429, 'rate limited')

    try {
      await fetchBoundary('555')
      assert.fail('expected fetchBoundary to throw')
    } catch (error) {
      assert.include(error.message, 'rate limit')
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/osm-boundary.test.js
```
Expected: FAIL — `Cannot find module '../lib/osm-boundary'`

**Step 3: Write the boundary implementation**

Create `lib/osm-boundary.js`:

```javascript
/**
 * Fetch an OSM boundary polygon as GeoJSON, given the relation id that
 * Wikidata's P402 points at.
 *
 * Overpass rather than the raw OSM API: the OSM API's /full endpoint is
 * explicitly not for bulk use and caps concurrency at two, while Overpass is
 * built for exactly this query shape, allows ~1M requests/day, and signals
 * quota exhaustion cleanly with HTTP 429.
 *
 * A descriptive User-Agent is mandatory under OSM Foundation policy, and
 * faking another app's is grounds for a block.
 *
 * @see https://operations.osmfoundation.org/policies/api/
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const USER_AGENT = 'sfedits-region/1.0 (https://github.com/tieguy/sfedits)'
const TIMEOUT_MS = 60000

/** Close a linear ring if Overpass returned it open. */
function closeRing(ring) {
  if (ring.length === 0) return ring
  const [first] = ring
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, first]
  }
  return ring
}

/**
 * @param {string|number} relationId - OSM relation id from Wikidata P402
 * @returns {Promise<Object>} GeoJSON Feature with a Polygon or MultiPolygon
 * @throws {Error} on rate limit, transport failure, or missing geometry
 */
async function fetchBoundary(relationId) {
  const query = `[out:json][timeout:60];relation(${relationId});out geom;`

  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })

  if (response.status === 429) {
    throw new Error(`Overpass rate limit hit fetching relation ${relationId}`)
  }
  if (!response.ok) {
    throw new Error(`Overpass returned ${response.status} for relation ${relationId}`)
  }

  const data = await response.json()
  const relation = (data.elements || []).find(e => e.type === 'relation')

  const rings = (relation?.members || [])
    .filter(m => m.type === 'way' && m.role === 'outer' && Array.isArray(m.geometry))
    .map(m => closeRing(m.geometry.map(p => [p.lon, p.lat])))
    .filter(ring => ring.length >= 4)

  if (rings.length === 0) {
    throw new Error(`OSM relation ${relationId} has no usable outer boundary geometry`)
  }

  const geometry = rings.length === 1
    ? { type: 'Polygon', coordinates: [rings[0]] }
    : { type: 'MultiPolygon', coordinates: rings.map(ring => [ring]) }

  return { type: 'Feature', properties: { osmRelationId: String(relationId) }, geometry }
}

module.exports = { fetchBoundary, OVERPASS_URL }
```

**Step 4: Run boundary tests**

Run:
```bash
npx mocha --colors --reporter spec --exit test/osm-boundary.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Write the failing test for the geo strategy**

Append to `test/region.test.js`, inside the top-level `describe('region', ...)`:

```javascript
  describe('articlesByGeo', function() {
    const { articlesByGeo } = require('../lib/region')

    const SQUARE = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-122.43, 37.74], [-122.43, 37.78], [-122.39, 37.78],
          [-122.39, 37.74], [-122.43, 37.74]
        ]]
      }
    }

    it('keeps candidates inside the polygon and drops those outside', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },      // inside
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        },
        {
          item: entity('Q20'), cls: entity('Q515'),
          coord: { value: 'Point(-122.50 37.90)' },      // outside
          article: { value: 'https://en.wikipedia.org/wiki/Outside' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(articles.length, 1)
      assert.equal(articles[0].title, 'Inside')
      assert.equal(articles[0].source, 'geo')
    })

    it('drops candidates with an unparseable coordinate', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'not a point' },
          article: { value: 'https://en.wikipedia.org/wiki/Bogus' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(articles.length, 0)
    })
  })
```

**Step 6: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: FAIL — `articlesByGeo is not a function`

**Step 7: Write the geo strategy**

Append to `lib/region.js`, before `module.exports`. Add the turf import at the top of the file alongside the `./sparql` require. This one line handles both interop shapes, so no decision is deferred to the engineer:

```javascript
// Turf v7 ships dual ESM/CJS builds; under require() the function is on
// .default in some resolutions and bare in others.
const turfPointInPolygon = require('@turf/boolean-point-in-polygon')
const booleanPointInPolygon =
  typeof turfPointInPolygon === 'function' ? turfPointInPolygon : turfPointInPolygon.default
```

Then append:

```javascript
/** Default radius for the candidate seed, in km. wikibase:around takes km only. */
const DEFAULT_SEED_RADIUS_KM = 5

/**
 * Geographic containment: seed candidates from a radius around the centroid,
 * then filter by the actual boundary.
 *
 * The radius seed exists because there is no way to ask WDQS "give me
 * everything inside this arbitrary polygon" - the polygon lives in OSM, not
 * Wikidata. So we over-fetch a disc that covers the neighborhood and discard
 * what falls outside. This only works because neighborhoods are small; it is
 * exactly why administrative regions use the relational strategy instead.
 *
 * @param {Object} region - descriptor from resolveRegion(), needs a centroid
 * @param {Object} options
 * @param {Object} options.boundary - GeoJSON Feature from fetchBoundary()
 * @param {string[]} [options.languages]
 * @param {number} [options.radiusKm]
 * @returns {Promise<Array<{qid, cls, lang, wikipedia, title, source}>>}
 */
async function articlesByGeo(region, options) {
  const {
    boundary,
    languages = null,
    radiusKm = DEFAULT_SEED_RADIUS_KM
  } = options

  if (!boundary) {
    throw new Error(`${region.qid} needs a boundary polygon for the geo strategy`)
  }
  if (!region.centroid) {
    throw new Error(`${region.qid} needs a centroid to seed the geo strategy`)
  }

  const { lon, lat } = region.centroid

  const rows = await sparqlRows(`
    SELECT ?item ?cls ?coord ?article ?lang WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radiusKm}" .
      }
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
      ${languageFilter(languages)}
    }
  `)

  const seen = new Set()
  const articles = []

  for (const row of rows) {
    const point = parsePoint(row.coord)
    if (!point) continue

    const inside = booleanPointInPolygon([point.lon, point.lat], boundary)
    if (!inside) continue

    const sitelink = parseSitelink(row.article)
    if (!sitelink) continue

    const key = `${sitelink.wikipedia}:${sitelink.title}`
    if (seen.has(key)) continue
    seen.add(key)

    articles.push({
      qid: row.item,
      cls: row.cls,
      lang: row.lang,
      wikipedia: sitelink.wikipedia,
      title: sitelink.title,
      source: 'geo'
    })
  }

  return articles
}
```

Update the exports block:

```javascript
module.exports = {
  resolveRegion,
  articlesByAdmin,
  articlesByGeo,
  parseSitelink,
  ADMIN_CLASSES,
  parsePoint,
  DEFAULT_SEED_RADIUS_KM
}
```

**Step 8: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js test/osm-boundary.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 9: Commit**

```bash
git add lib/osm-boundary.js lib/region.js test/osm-boundary.test.js test/region.test.js
git commit -m "feat: geographic containment strategy for informal regions

Overpass boundary fetch plus a wikibase:around candidate seed filtered by
point-in-polygon. Handles multipolygon boundaries and discards candidates
with unusable coordinates."
```

---

## Task 6: Count histogram

**Files:**
- Modify: `lib/region.js` (append `regionHistogram`, `countFromHistogram`, extend exports)
- Modify: `test/region.test.js` (append a `describe` block)

**Step 1: Write the failing test**

Append to `test/region.test.js`, inside the top-level `describe('region', ...)`:

```javascript
  describe('regionHistogram', function() {
    const { regionHistogram, countFromHistogram } = require('../lib/region')

    it('returns class x language cells, not articles', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))      // sub-entities
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q515'), lang: { value: 'en' }, count: { value: '120' } },
        { cls: entity('Q5'), lang: { value: 'en' }, count: { value: '80' } },
        { cls: entity('Q515'), lang: { value: 'es' }, count: { value: '30' } }
      ]))

      const histogram = await regionHistogram({ qid: 'Q62', strategy: 'admin' })

      assert.equal(histogram.cells.length, 3)
      assert.deepEqual(histogram.cells[0], { cls: 'Q515', lang: 'en', count: 120 })
      assert.equal(histogram.total, 230)
    })

    it('sums matching cells client-side with no further queries', function() {
      const histogram = {
        cells: [
          { cls: 'Q515', lang: 'en', count: 120 },
          { cls: 'Q5', lang: 'en', count: 80 },
          { cls: 'Q515', lang: 'es', count: 30 }
        ],
        total: 230
      }

      assert.equal(
        countFromHistogram(histogram, { classes: ['Q515'], languages: ['en'] }), 120)
      assert.equal(
        countFromHistogram(histogram, { classes: ['Q515'], languages: ['en', 'es'] }), 150)
      assert.equal(
        countFromHistogram(histogram, { classes: ['Q515', 'Q5'], languages: ['en'] }), 200)
      assert.equal(countFromHistogram(histogram, {}), 230)
    })

    it('buckets the polygon-filtered list for a geo region', async function() {
      const SQUARE = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-122.43, 37.74], [-122.43, 37.78], [-122.39, 37.78],
            [-122.39, 37.74], [-122.43, 37.74]
          ]]
        }
      }

      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },      // inside
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        },
        {
          item: entity('Q20'), cls: entity('Q515'),
          coord: { value: 'Point(-122.50 37.90)' },      // outside
          article: { value: 'https://en.wikipedia.org/wiki/Outside' },
          lang: { value: 'en' }
        }
      ]))

      const histogram = await regionHistogram(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(histogram.total, 1,
        'the count must respect the polygon, not the radius seed')
      assert.deepEqual(histogram.cells, [{ cls: 'Q515', lang: 'en', count: 1 }])
    })

    it('refuses a geo histogram with no boundary', async function() {
      try {
        await regionHistogram(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } }, {})
        assert.fail('expected regionHistogram to throw')
      } catch (error) {
        assert.include(error.message, 'boundary')
      }
    })

    it('marks the histogram partial when a chunk fails', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q515'), lang: { value: 'en' }, count: { value: '10' } }
      ]))
      nock(WDQS).post('/sparql').times(3).reply(500, 'Query timeout limit reached')

      const histogram = await regionHistogram({ qid: 'Q62', strategy: 'admin' },
        { retries: 2, retryDelayMs: 0 })

      assert.isTrue(histogram.partial)
      assert.equal(histogram.total, 10)
    })
  })
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: FAIL — `regionHistogram is not a function`

**Step 3: Write the implementation**

Append to `lib/region.js`, before `module.exports`:

```javascript
/**
 * Count articles bucketed by entity class and language.
 *
 * This exists so the create flow can show a live count without re-querying on
 * every checkbox toggle: one aggregation returns a few hundred cells no matter
 * how big the region is, and every subsequent toggle is a local sum over those
 * cells. It is an estimate by design - a region big enough to time out returns
 * partial: true, and the dry run remains the source of truth.
 *
 * Counts pages, not distinct items, because pages are what drive post volume.
 *
 * @param {Object} region - descriptor from resolveRegion()
 * @param {Object} [options]
 * @param {number} [options.retries]
 * @param {number} [options.retryDelayMs]
 * @returns {Promise<{cells: Array<{cls, lang, count}>, total: number, partial: boolean}>}
 */
async function regionHistogram(region, options = {}) {
  const { retries, retryDelayMs } = options

  // The geo strategy's membership test is a client-side polygon filter, so
  // there is no SPARQL aggregation that can answer it - the polygon lives in
  // OSM, not Wikidata. Bucket the actual article list instead. That is only
  // affordable because geo regions are small by construction (10^2-10^3); it
  // is exactly why administrative regions do not use this path.
  if (region.strategy === 'geo') {
    if (!options.boundary) {
      throw new Error(
        `${region.qid} needs a boundary polygon to compute a geo histogram`)
    }

    const articles = await articlesByGeo(region, {
      boundary: options.boundary,
      languages: options.languages,
      radiusKm: options.radiusKm
    })

    const merged = new Map()
    for (const article of articles) {
      const key = `${article.cls}|${article.lang}`
      merged.set(key, (merged.get(key) || 0) + 1)
    }

    const cells = Array.from(merged.entries()).map(([key, count]) => {
      const [cls, lang] = key.split('|')
      return { cls, lang, count }
    })

    return {
      cells,
      total: cells.reduce((sum, cell) => sum + cell.count, 0),
      partial: false
    }
  }

  const subs = await subEntities(region.qid)
  const anchors = subs.length > 0 ? subs : [region.qid]

  let partial = false

  const rows = await sparqlChunked(anchors, anchor => `
    SELECT ?cls ?lang (COUNT(DISTINCT ?article) AS ?count) WHERE {
      ?item wdt:P131* wd:${anchor} .
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
    }
    GROUP BY ?cls ?lang
  `, {
    retries,
    retryDelayMs,
    onChunkError: () => { partial = true }
  })

  // Chunks are per sub-entity, so the same (class, language) cell can appear
  // once per chunk. Merge them.
  const merged = new Map()
  for (const row of rows) {
    const key = `${row.cls}|${row.lang}`
    const count = Number(row.count) || 0
    merged.set(key, (merged.get(key) || 0) + count)
  }

  const cells = Array.from(merged.entries()).map(([key, count]) => {
    const [cls, lang] = key.split('|')
    return { cls, lang, count }
  })

  const total = cells.reduce((sum, cell) => sum + cell.count, 0)

  return { cells, total, partial }
}

/**
 * Sum the histogram cells matching a filter selection. Pure and synchronous -
 * this is what makes toggling filters feel instant in the create flow.
 *
 * @param {Object} histogram - from regionHistogram()
 * @param {Object} [selection]
 * @param {string[]} [selection.classes] - class QIDs; omit for all
 * @param {string[]} [selection.languages] - language codes; omit for all
 * @returns {number}
 */
function countFromHistogram(histogram, selection = {}) {
  const { classes = null, languages = null } = selection
  const classSet = classes ? new Set(classes) : null
  const langSet = languages ? new Set(languages) : null

  return histogram.cells.reduce((sum, cell) => {
    if (classSet && !classSet.has(cell.cls)) return sum
    if (langSet && !langSet.has(cell.lang)) return sum
    return sum + cell.count
  }, 0)
}
```

Update the exports block:

```javascript
module.exports = {
  resolveRegion,
  articlesByAdmin,
  articlesByGeo,
  regionHistogram,
  countFromHistogram,
  parseSitelink,
  ADMIN_CLASSES,
  parsePoint,
  DEFAULT_SEED_RADIUS_KM
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Commit**

```bash
git add lib/region.js test/region.test.js
git commit -m "feat: class x language histogram for live region count estimates

One bounded aggregation per region; filter toggles become a local sum.
Marks the result partial when a chunk times out rather than lying."
```

---

## Task 7: Strategy dispatch

**Files:**
- Modify: `lib/region.js` (append `articlesForRegion`, extend exports)
- Modify: `test/region.test.js` (append a `describe` block)

**Step 1: Write the failing test**

Append to `test/region.test.js`, inside the top-level `describe('region', ...)`:

```javascript
  describe('articlesForRegion', function() {
    const { articlesForRegion } = require('../lib/region')

    it('takes the admin path for an administrative region', async function() {
      // resolveRegion
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q62049'), label: { value: 'San Francisco' } }
      ]))
      // subEntities
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      // closure
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))

      const result = await articlesForRegion('Q62', { languages: ['en'] })

      assert.equal(result.region.strategy, 'admin')
      assert.equal(result.articles.length, 1)
      assert.equal(result.articles[0].source, 'admin')
    })

    it('fetches a boundary and takes the geo path for a neighborhood', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'), label: { value: 'Mission District' },
          osm: { value: '2222222' },
          coord: { value: 'Point(-122.41 37.76)' }
        }
      ]))
      nock('https://overpass-api.de').post('/api/interpreter').reply(200, {
        elements: [{
          type: 'relation',
          members: [{
            type: 'way', role: 'outer',
            geometry: [
              { lat: 37.74, lon: -122.43 }, { lat: 37.78, lon: -122.43 },
              { lat: 37.78, lon: -122.39 }, { lat: 37.74, lon: -122.39 }
            ]
          }]
        }]
      })
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        }
      ]))

      const result = await articlesForRegion('Q1917571', { languages: ['en'] })

      assert.equal(result.region.strategy, 'geo')
      assert.equal(result.articles.length, 1)
      assert.equal(result.articles[0].source, 'geo')
    })

    it('refuses the geo strategy when the region has no OSM boundary', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'), label: { value: 'Vague Place' },
          coord: { value: 'Point(-122.41 37.76)' }
        }
      ]))

      try {
        await articlesForRegion('Q999', { languages: ['en'] })
        assert.fail('expected articlesForRegion to throw')
      } catch (error) {
        assert.include(error.message, 'no OSM boundary')
      }
    })
  })
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/region.test.js
```
Expected: FAIL — `articlesForRegion is not a function`

**Step 3: Write the implementation**

Add the boundary import at the top of `lib/region.js`, alongside the other requires:

```javascript
const { fetchBoundary } = require('./osm-boundary')
```

Append before `module.exports`:

```javascript
/**
 * Resolve a place QID to its article set, choosing the membership strategy by
 * region type. The single entry point callers should use.
 *
 * @param {string} qid
 * @param {Object} [options]
 * @param {'auto'|'admin'|'geo'} [options.strategy='auto']
 * @param {string[]} [options.languages]
 * @param {number} [options.radiusKm]
 * @param {(chunk: string, error: Error) => void} [options.onChunkError]
 * @returns {Promise<{region: Object, articles: Array}>}
 */
async function articlesForRegion(qid, options = {}) {
  const region = await resolveRegion(qid, { strategy: options.strategy || 'auto' })

  if (region.strategy === 'admin') {
    const articles = await articlesByAdmin(region, options)
    return { region, articles }
  }

  if (!region.osmRelationId) {
    throw new Error(
      `${qid} (${region.label}) needs the geo strategy but has no OSM boundary (P402)`)
  }

  const boundary = await fetchBoundary(region.osmRelationId)
  const articles = await articlesByGeo(region, { ...options, boundary })
  return { region, articles }
}
```

Update the exports block:

```javascript
module.exports = {
  articlesForRegion,
  resolveRegion,
  articlesByAdmin,
  articlesByGeo,
  regionHistogram,
  countFromHistogram,
  parseSitelink,
  ADMIN_CLASSES,
  parsePoint,
  DEFAULT_SEED_RADIUS_KM
}
```

**Step 4: Run the full suite**

Run:
```bash
npm test
```
Expected: 0 failing, and a total equal to the 244 baseline plus every test written in this phase (sparql + osm-boundary + region). Record the number you actually get — later phases gate on "baseline plus this phase's new tests", not on a number predicted here.

**Step 5: Commit**

```bash
git add lib/region.js test/region.test.js
git commit -m "feat: dispatch region membership by strategy

articlesForRegion resolves the region, picks admin or geo, and fetches the
OSM boundary only on the path that needs it."
```

---

## Phase 1 Done When

- `npm test` is green with no pre-existing tests broken — specifically `test/wikidata-claim-watch.test.js` still passes after `sparqlSelect` moved to `lib/sparql.js`.
- `articlesForRegion('Q62')` returns admin-strategy articles; `articlesForRegion(<Mission QID>)` returns geo-strategy articles filtered by polygon.
- A simulated WDQS timeout produces chunked retries and a complete-or-explicitly-partial result rather than an exception.
- `regionHistogram` cell count is bounded by (classes × languages) regardless of region size, and `countFromHistogram` performs zero I/O.

**Manual verification against live data before moving to Phase 2** (this repo's convention is to verify against real Wikipedia/Wikidata, not only fixtures):

```bash
node -e "
const { articlesForRegion, regionHistogram, resolveRegion } = require('./lib/region')
;(async () => {
  const region = await resolveRegion('Q62')
  console.log('region:', region.label, region.strategy, 'osm:', region.osmRelationId)
  const hist = await regionHistogram(region)
  console.log('histogram cells:', hist.cells.length, 'total:', hist.total, 'partial:', hist.partial)
  const { articles } = await articlesForRegion('Q62', { languages: ['en'] })
  console.log('articles:', articles.length)
  console.log('sample:', articles.slice(0, 5).map(a => a.title))
})()
"
```

Expect a few thousand English articles for San Francisco and a histogram of a few hundred cells. If `partial` is true at city scale, the chunking needs revisiting before Phase 2 depends on it — report this rather than proceeding.
