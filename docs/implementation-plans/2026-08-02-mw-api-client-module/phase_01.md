# Shared Wikimedia API Client Module — Phase 1: Module + tests

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** `lib/mw-api.js` exists and is fully tested, with zero consumers changed.

**Architecture:** A CommonJS transport facade over two ESM libraries (m3api for the
Action API, m3api-rest for `/w/rest.php`) plus a compliant raw-fetch helper
(`wmFetch`/`wmFetchJson`) for endpoints no library covers. The ESM/CJS boundary is
contained inside the module via one lazy `await import()`. Retry semantics are ported
from the design branch's tested `apiGet` (429/Retry-After waits don't consume retry
attempts; separate cap).

**Tech Stack:** Node 20+ (global fetch), m3api v1.1.x, m3api-rest v0.2.x, mocha/chai/nock v14.

**Scope:** 5 phases from design `docs/design-plans/2026-08-02-mw-api-client-module.md`; this file is phase 1.

**Codebase verified:** 2026-08-02 (codebase-investigator + internet-researcher reports)

---

## Context for the implementor

- Repo is CommonJS (`package.json` has no `"type"` field). m3api and m3api-rest are
  **ESM-only** — they can only enter via dynamic `import()`. m3api's Node entry
  point is `'m3api/node.js'`, whose **Session class is the DEFAULT export**
  (`export default class NodeSession …`); its named exports are `ApiErrors`,
  `ApiWarnings`, `set`. Destructure as `{ default: Session }`. m3api-rest has
  named exports `getJson`, `postForJson`, `path`, etc.
- m3api-rest **builds its URL by swapping the session's `api.php` for `rest.php`
  and appending your path** (`session.apiUrl.replace(/api\.php$/, 'rest.php') + path`).
  So callers pass paths relative to `rest.php` — `/v1/revision/A/compare/B`,
  NOT `/w/rest.php/v1/...` (which would double the prefix). nock intercepts still
  match the full resulting path `/w/rest.php/v1/...`.
- `lib/user-agent.js` exports `userAgent(component)` → `sfedits-<component>/1.0 (<contact>) Node.js/<ver>`,
  honoring `SFEDITS_CONTACT`. Every request this module makes MUST build its UA there.
  Never write a UA string literal (CLAUDE.md rule: `grep -rn "USER_AGENT = '" lib/` must stay empty).
- Test conventions: mocha + chai `assert` + nock v14 (which intercepts global fetch
  natively). Suites do `nock.cleanAll()` in `afterEach`. Model file:
  `test/title-resolver.test.js`. Run the suite as `npm test` — never hand-type the
  mocha glob unquoted (shell expansion silently runs one file).
- `npm install` on this box needs `PUPPETEER_SKIP_DOWNLOAD=true` or puppeteer's
  postinstall tries (and fails) to download Chromium. Puppeteer is an optional
  fallback renderer; skipping is correct.
- Serial discipline: nothing in this module may fan requests out in parallel at
  Wikimedia hosts. (m3api's "automatic request combining" merges concurrent
  compatible calls into ONE http request; it never parallelizes. That is fine.)

### Retry semantics being ported (source of truth)

From `.worktrees/place-bot-platform-design/scripts/reassess.js:90-129` (`apiGet`),
proven by four tests in that branch's `test/reassess-api.test.js`:

- HTTP 429: wait and retry **without consuming a retry attempt**. Waits are counted
  separately and capped at `maxRateLimitWaits` (then throw `HTTP 429`).
  `Retry-After` header is authoritative when present (seconds); otherwise wait
  `rateLimitWaitMs`.
- Other failures (5xx, network, timeout): `tries` total attempts with linear
  backoff `backoffMs * attempt`; then throw (`HTTP <status>` for HTTP errors).
- **One deliberate improvement over apiGet** (per Wikimedia API etiquette: "never
  retry a permanent 4xx"): non-429 4xx statuses throw `HTTP <status>` immediately
  without retrying. apiGet retried them; the tests only ever asserted 5xx retry
  behavior, so the ported tests still pass unchanged.
- Action-API-specific maxlag handling from apiGet is NOT ported into `wmFetch`:
  Action API traffic goes through m3api, which handles maxlag/Retry-After natively.
  `wmFetch` is for non-Action endpoints (pageviews, RESTBase, thumbnails, WDQS).

---

## Task 1: Add m3api + m3api-rest dependencies

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json` (generated)

**Step 1: Install**

```bash
cd /var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/mw-api-client-module
PUPPETEER_SKIP_DOWNLOAD=true npm install --save m3api m3api-rest
```

Expected: exits 0; `package.json` gains `"m3api": "^1.1.0"` and `"m3api-rest": "^0.2.0"`
(current published versions as of 2026-08-02; exact minors may drift — both must
resolve). npm may print `allow-scripts` warnings about puppeteer's postinstall —
that is pre-existing and fine.

**Step 2: Verify the ESM boundary works from CJS**

```bash
node -e "import('m3api/node.js').then(m => { console.log(typeof m.default, typeof m.ApiErrors) })"
node -e "import('m3api-rest').then(m => { console.log(typeof m.getJson, typeof m.path) })"
```

Expected output: `function function` twice (m3api's Session is `m.default`).

**Step 3: Verify the suite still passes (no source changed)**

```bash
npm test 2>&1 | tail -3
```

Expected: `572 passing, 1 pending` with the test DB container up (that 1 pending is a
pre-existing baseline pending, not a failure; more pend if the DB container is down).

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: add m3api and m3api-rest for the shared Wikimedia client (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `wmFetch` retry semantics

**Files:**
- Create: `test/mw-api.test.js`
- Create: `lib/mw-api.js`

**Step 1: Write the failing tests**

Create `test/mw-api.test.js`:

```js
const { assert } = require('chai')
const nock = require('nock')
const { wmFetch, wmFetchJson } = require('../lib/mw-api')

const HOST = 'https://wm.test'

describe('mw-api', function() {
  afterEach(function() {
    nock.cleanAll()
  })

  describe('wmFetch retry semantics', function() {
    // Ported from place-bot-platform-design test/reassess-api.test.js —
    // these four cases are the contract for 429/Retry-After behavior.

    it('waits out a 429 rather than burning a retry attempt', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').times(6).reply(429)
      nock(HOST).get('/thing').reply(200, 'ok')

      const res = await wmFetch(`${HOST}/thing`, {
        tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'ok')
    })

    it('honours a Retry-After header when present', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').reply(429, '', { 'retry-after': '1' })
      nock(HOST).get('/thing').reply(200, 'ok')

      const started = Date.now()
      const res = await wmFetch(`${HOST}/thing`, {
        tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
      assert.isAtLeast(Date.now() - started, 900)
    })

    it('still gives up on a 5xx after `tries` attempts', async function() {
      // count actual requests: nock.pendingMocks() counts interceptors, not
      // remaining .times() uses, so a reply function does the counting
      let requests = 0
      nock(HOST).get('/thing').times(5).reply(500, function() { requests++; return '' })

      try {
        await wmFetch(`${HOST}/thing`, { tries: 2, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 500')
      }
      assert.equal(requests, 2)
    })

    it('eventually gives up if the rate limit never clears', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').times(20).reply(429)

      try {
        await wmFetch(`${HOST}/thing`, {
          tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 3
        })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 429')
      }
    })

    it('does not retry a permanent 4xx', async function() {
      // Etiquette rule: never retry a permanent 4xx. 404 throws immediately.
      let requests = 0
      nock(HOST).get('/thing').times(3).reply(404, function() { requests++; return '' })

      try {
        await wmFetch(`${HOST}/thing`, { tries: 4, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 404')
      }
      assert.equal(requests, 1)
    })
  })
})
```

**Step 2: Run to verify failure**

```bash
npx mocha test/mw-api.test.js
```

Expected: fails with `Cannot find module '../lib/mw-api'`.

**Step 3: Implement `lib/mw-api.js`**

Create `lib/mw-api.js`:

```js
// Shared Wikimedia API client (LUI-94).
//
// Transport facade only: owns User-Agent, gzip, maxlag, 429/Retry-After and
// timeout behavior for every Wikimedia-facing request in the repo. Domain
// logic stays in consumers. Action API traffic rides m3api, /w/rest.php rides
// m3api-rest (both ESM-only — the import() boundary is contained here), and
// endpoints no library covers (pageviews, RESTBase summaries, thumbnails,
// WDQS) go through wmFetch below.
//
// Never issues parallel requests at Wikimedia hosts; m3api's request
// combining merges concurrent compatible calls into one HTTP request.

const { userAgent } = require('./user-agent')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Retry semantics ported from the tested apiGet in place-bot-platform-design
// scripts/reassess.js: 429 waits are free (separate maxRateLimitWaits cap,
// Retry-After authoritative); 5xx/network errors get `tries` attempts with
// linear backoff; permanent non-429 4xx never retries.
async function wmFetch(url, {
  component = 'mw-api',
  tries = 4,
  backoffMs = 2000,
  rateLimitWaitMs = 10000,
  maxRateLimitWaits = 60,
  timeoutMs = 30000,
  headers = {},
  ...fetchOpts
} = {}) {
  let limitWaits = 0
  for (let attempt = 1; ; ) {
    let res
    try {
      res = await fetch(url, {
        ...fetchOpts,
        headers: {
          'User-Agent': userAgent(component),
          'Accept-Encoding': 'gzip',
          ...headers
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (attempt >= tries) throw error
      await sleep(backoffMs * attempt)
      attempt++
      continue
    }
    if (res.status === 429) {
      if (limitWaits >= maxRateLimitWaits) throw new Error('HTTP 429')
      limitWaits++
      // Retry-After is authoritative when the server sends it.
      const after = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : rateLimitWaitMs)
      continue
    }
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500
      if (permanent || attempt >= tries) throw new Error(`HTTP ${res.status}`)
      await sleep(backoffMs * attempt)
      attempt++
      continue
    }
    return res
  }
}

async function wmFetchJson(url, opts = {}) {
  const res = await wmFetch(url, opts)
  return res.json()
}

module.exports = { wmFetch, wmFetchJson }
```

**Step 4: Run to verify pass**

```bash
npx mocha test/mw-api.test.js
```

Expected: 5 passing.

**Step 5: Commit**

```bash
git add lib/mw-api.js test/mw-api.test.js
git commit -m "$(cat <<'EOF'
feat: add lib/mw-api.js wmFetch with ported 429/Retry-After semantics (LUI-94)

Retry loop ported from place-bot-platform-design's tested apiGet; permanent
4xx now fails fast per API etiquette instead of retrying.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Header compliance + `wmFetchJson`

**Files:**
- Modify: `test/mw-api.test.js` (add a describe block)

`wmFetchJson` already exists from Task 2; this task proves the compliance headers
and the JSON path with tests (they are the module's whole reason to exist, so they
get explicit coverage, not incidental coverage).

**Step 1: Add failing tests**

Append inside the top-level `describe('mw-api', ...)` block of `test/mw-api.test.js`:

```js
  describe('wmFetch compliance headers', function() {
    it('sends the operator User-Agent from lib/user-agent.js', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', userAgent('test-component'))
        .get('/ua')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/ua`, { component: 'test-component' })
      assert.equal(res.status, 200)
    })

    it('requests gzip', async function() {
      nock(HOST)
        .matchHeader('accept-encoding', 'gzip')
        .get('/gz')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/gz`)
      assert.equal(res.status, 200)
    })

    it('lets callers add headers without losing the compliance ones', async function() {
      nock(HOST)
        .matchHeader('accept', 'application/json')
        .matchHeader('accept-encoding', 'gzip')
        .get('/hdr')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/hdr`, { headers: { Accept: 'application/json' } })
      assert.equal(res.status, 200)
    })
  })

  describe('wmFetchJson', function() {
    it('parses a JSON body', async function() {
      nock(HOST).get('/json').reply(200, { items: [1, 2] })

      const data = await wmFetchJson(`${HOST}/json`)
      assert.deepEqual(data, { items: [1, 2] })
    })

    it('throws HTTP <status> on error responses', async function() {
      nock(HOST).get('/json').reply(403, { error: 'nope' })

      try {
        await wmFetchJson(`${HOST}/json`, { tries: 2, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 403')
      }
    })
  })
```

**Step 2: Run**

```bash
npx mocha test/mw-api.test.js
```

Expected: 10 passing. (These should pass immediately — the Task 2 implementation
already sends the headers. If any fail, fix `lib/mw-api.js`, not the test.)

**Step 3: Commit**

```bash
git add test/mw-api.test.js
git commit -m "$(cat <<'EOF'
test: prove wmFetch UA/gzip compliance headers and wmFetchJson paths (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `actionSession` — cached m3api sessions

**Files:**
- Modify: `lib/mw-api.js`
- Modify: `test/mw-api.test.js`

**Step 1: Add failing tests**

Append inside the top-level `describe('mw-api', ...)` block. Note the require line
at the top of the test file must now also pull `actionSession` and `_resetSessions`:

```js
const { wmFetch, wmFetchJson, actionSession, restGetJson, _resetSessions } = require('../lib/mw-api')
```

(`restGetJson` is Task 5; requiring it now is harmless — it will be `undefined`
until then, and no Task 4 test calls it. If you prefer, add it in Task 5.)

```js
  describe('actionSession', function() {
    afterEach(function() {
      _resetSessions()
    })

    it('sends the Action API defaults and the operator User-Agent', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', value => value.includes(userAgent('test-session')))
        .get('/w/api.php')
        .query(q => q.formatversion === '2' && q.maxlag === '5' && q.errorformat === 'plaintext')
        .reply(200, { batchcomplete: true })

      const session = await actionSession('wm.test', 'test-session')
      const response = await session.request({ action: 'query' })
      assert.isTrue(response.batchcomplete)
      assert.isTrue(nock.isDone())
    })

    it('caches one session per host (first caller wins)', async function() {
      const a = await actionSession('wm.test', 'first-component')
      const b = await actionSession('wm.test', 'second-component')
      assert.strictEqual(a, b)
    })

    it('keeps sessions for different hosts distinct', async function() {
      const a = await actionSession('wm.test', 'c')
      const b = await actionSession('other.test', 'c')
      assert.notStrictEqual(a, b)
    })

  })
```

Note on gzip for the m3api path: m3api itself sets only `user-agent`, and undici
(Node's fetch) adds `accept-encoding: gzip, deflate, br` at dispatch — BELOW
nock's interception layer, so no nock test can observe it (verified
empirically). gzip on Action API requests is therefore proven by Phase 5
Task 3's live `content-encoding` check, not by a unit test; the implementation
carries a code comment saying so (Step 3 below). `wmFetch`'s explicit gzip
header IS nock-visible and is tested in Task 3.

Notes for the implementor:
- The UA assertion uses `.includes()` — m3api appends its own `m3api/<ver>` token
  after the caller-supplied string; the operator UA must simply be present.
- `q.maxlag === '5'`: nock exposes query values as strings.
- If the first test fails on the query matcher, debug by replacing the matcher
  with `.query(true)` and logging `req.path` — but the final committed test must
  assert formatversion/maxlag/errorformat, because those defaults are contract.

**Step 2: Run to verify failure**

```bash
npx mocha test/mw-api.test.js
```

Expected: the three new tests fail (`actionSession` is not a function).

**Step 3: Implement**

In `lib/mw-api.js`, after the `wmFetchJson` definition, add:

```js
// --- Action API via m3api (ESM; contained behind one lazy import) ---

let m3apiModule = null
const sessions = new Map()

async function loadM3api() {
  if (!m3apiModule) m3apiModule = await import('m3api/node.js')
  return m3apiModule
}

// One cached Session per wiki host. The first caller's component names the
// session's User-Agent; later callers share it (transport identity is
// per-operator, not per-module). There is deliberately NO constructor options
// param — a cache hit would silently discard it. Per-call knobs (e.g.
// maxRetriesSeconds for bulk callers) go on the request:
// session.request(params, { maxRetriesSeconds: 600 }).
// Accept-Encoding on this path comes from undici's dispatcher (gzip/deflate/br
// by default) — invisible to nock, verified live in Phase 5.
async function actionSession(host, component) {
  if (sessions.has(host)) return sessions.get(host)
  // Session is m3api's DEFAULT export.
  const promise = loadM3api().then(({ default: Session }) => new Session(host, {
    formatversion: 2,
    errorformat: 'plaintext',
    maxlag: 5
  }, {
    userAgent: userAgent(component)
  }))
  sessions.set(host, promise)
  return promise
}

// Test hook: sessions are process-wide state.
function _resetSessions() {
  sessions.clear()
}
```

Update the exports line:

```js
module.exports = { wmFetch, wmFetchJson, actionSession, _resetSessions }
```

**Step 4: Run to verify pass**

```bash
npx mocha test/mw-api.test.js
```

Expected: 13 passing.

**Step 5: Commit**

```bash
git add lib/mw-api.js test/mw-api.test.js
git commit -m "$(cat <<'EOF'
feat: actionSession — cached per-host m3api sessions with compliance defaults (LUI-94)

formatversion=2, errorformat=plaintext, maxlag=5, operator UA from
lib/user-agent.js; ESM boundary contained behind one lazy import().

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `restGetJson` — m3api-rest passthrough

**Files:**
- Modify: `lib/mw-api.js`
- Modify: `test/mw-api.test.js`

**Step 1: Add failing tests**

Append inside the top-level describe (ensure `restGetJson` is in the require line):

```js
  describe('restGetJson', function() {
    afterEach(function() {
      _resetSessions()
    })

    it('GETs a REST path and returns parsed JSON', async function() {
      // caller passes the path relative to rest.php; m3api-rest turns the
      // session's /w/api.php into /w/rest.php and appends it
      nock(HOST)
        .get('/w/rest.php/v1/revision/100/compare/200')
        .reply(200, { diff: [{ type: 0, text: 'unchanged' }] })

      const data = await restGetJson('wm.test', '/v1/revision/100/compare/200', {
        component: 'test-rest'
      })
      assert.deepEqual(data.diff, [{ type: 0, text: 'unchanged' }])
    })

    it('carries the operator User-Agent', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', value => value.includes(userAgent('test-rest')))
        .get('/w/rest.php/v1/page/Foo')
        .reply(200, { title: 'Foo' })

      const data = await restGetJson('wm.test', '/v1/page/Foo', {
        component: 'test-rest'
      })
      assert.equal(data.title, 'Foo')
    })
  })
```

**Step 2: Run to verify failure**

```bash
npx mocha test/mw-api.test.js
```

Expected: the two new tests fail (`restGetJson is not a function`).

**Step 3: Implement**

In `lib/mw-api.js` add below `actionSession`:

```js
// --- MediaWiki REST API (/w/rest.php) via m3api-rest ---

let m3apiRestModule = null

async function loadM3apiRest() {
  if (!m3apiRestModule) m3apiRestModule = await import('m3api-rest')
  return m3apiRestModule
}

// GET a MediaWiki REST path on a cached session. `path` is RELATIVE to
// rest.php (e.g. '/v1/revision/A/compare/B') — m3api-rest derives the rest.php
// base from the session's api.php URL and appends this path. Pre-encode any
// path segments.
async function restGetJson(host, path, { component = 'mw-api', ...options } = {}) {
  const [session, { getJson }] = await Promise.all([
    actionSession(host, component),
    loadM3apiRest()
  ])
  return getJson(session, path, options)
}
```

(The `Promise.all` here awaits a cached session promise and a cached module
load — it is not a request fan-out; only `getJson` performs HTTP, serially.)

Update exports:

```js
module.exports = { wmFetch, wmFetchJson, actionSession, restGetJson, _resetSessions }
```

**Step 4: Run to verify pass**

```bash
npx mocha test/mw-api.test.js
```

Expected: 15 passing.

**Step 5: Commit**

```bash
git add lib/mw-api.js test/mw-api.test.js
git commit -m "$(cat <<'EOF'
feat: restGetJson — m3api-rest passthrough on cached sessions (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only)

**Step 1: Start the test DB and run everything**

```bash
npm run test:db:start
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: `587 passing` (572 baseline + 15 new), 0 failing. If the DB suites
pend, the container isn't up — `SFEDITS_REQUIRE_DB=1` turns that into a hard
failure by design; fix the container, don't drop the env var.

**Step 2: Compliance greps**

```bash
grep -rn "USER_AGENT = '" lib/ scripts/
grep -n "Promise.all" lib/mw-api.js
```

Expected: first grep empty; second shows only the session+module-load await in
`restGetJson` (no request fan-out).

**Step 3: No consumer changed**

```bash
git diff --stat integration...HEAD -- lib/ public/ scripts/ | grep -v mw-api
```

Expected: no consumer files listed (only `lib/mw-api.js` under `lib/`).

---

## CHECKPOINT — STOP before Phase 2

**Do not begin Phase 2.** Per the design plan, pause here and reconcile with Louie:

`.worktrees/delivery-merge` (branch `delivery-merge`) holds in-flight work that
**touches the same files Phases 2–3 modify** — verified 2026-08-02:

- `lib/compare-diff.js` (−134 lines in delivery-merge; Phase 2's biggest migration)
- `lib/subscription-delivery.js` (−85 lines)
- `public/server.js` (Phase 3 UA cleanup target)

Merge order is a decision, not an accident. Present the overlap to Louie and get
an explicit answer on whether delivery-merge lands first (then rebase this work)
or this work proceeds on current `integration` (then delivery-merge rebases).
Record the decision in this file before executing Phase 2.
