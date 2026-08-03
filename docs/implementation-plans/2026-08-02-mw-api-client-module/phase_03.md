# Shared Wikimedia API Client Module — Phase 3: Remaining call sites + UA cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** No Wikimedia call on this branch bypasses the module; no UA literals
anywhere in `lib/`, `scripts/`, or `public/`.

**Architecture:** `lib/sparql.js` keeps its WDQS-specific retryability
classification but moves transport onto `wmFetch` (a new `throwOnHttpError: false`
knob lets it keep classifying non-ok responses itself). `searchPlaces`, the three
`find-*` scripts, and `lib/mw-oauth.js` get operator identity via the module or
`userAgent()`.

**Tech Stack:** as Phase 1.

**Scope:** phase 3 of 5.

**Codebase verified:** 2026-08-02 (full-file excerpts by codebase-investigator)

---

## Context for the implementor

- `lib/sparql.js` (154 lines) is the repo's existing transport-module precedent.
  Its `sparqlRaw` (lines 33-49) POSTs to WDQS with UA + Content-Type + Accept
  headers and a 60s timeout, attaches `.status` and `.body` to thrown errors, and
  `isRetryable` (lines 82-87) classifies TimeoutError/AbortError/429/5xx/body
  patterns for the OUTER retry loops in `sparqlChunked`. That outer classification
  must survive: `wmFetch` is told `tries: 1` (no inner non-429 retries) and
  `throwOnHttpError: false` (return non-ok responses so sparql can attach
  status+body itself). What sparql GAINS from wmFetch: gzip, 429/Retry-After
  waits, and the timeout via AbortSignal.
- `lib/region.js` and `lib/wikidata-claim-watch.js` are the only requirers of
  sparql exports — their code does not change.
- `test/sparql.test.js` uses loose `.post('/sparql')` matchers and `.times()`
  counts; `test/public-server.test.js` mocks SPARQL with `.times(9)`. Keeping
  `tries: 1` inside wmFetch preserves request counts. If a count assertion fails,
  the transport is retrying where it didn't before — fix the transport call, not
  the test.
- `scripts/find-*` have NO tests. Verification is `node --check` plus the suite
  staying green. Their UA literals carry the UPSTREAM author's contact — the exact
  bug class CLAUDE.md flags; removing them is the point of this phase.
- `lib/mw-oauth.js` keeps plain `fetch` (an OAuth token POST must not be blindly
  retried) — it only gains the operator UA header. nock only asserts headers
  listed in `.reqheaders`, so adding a request header does not break the existing
  intercepts; the new test proves the header is sent.
- `lib/osm-boundary.js` (Overpass/OSM hosts) is DELIBERATELY out of scope: the
  design covers Wikimedia hosts only. OSM is the same compliance family
  (operator-identifying UA) and already uses `userAgent()`; migrating its
  transport is a candidate follow-up, not part of LUI-94.

---

## Task 1: Add `throwOnHttpError` knob to `wmFetch`

**Files:**
- Modify: `lib/mw-api.js`
- Modify: `test/mw-api.test.js`

**Step 1: Write the failing tests**

Append to the `wmFetch retry semantics` describe block in `test/mw-api.test.js`:

```js
    it('returns a non-ok response when throwOnHttpError is false', async function() {
      nock(HOST).get('/soft').reply(500, 'wdqs stack trace')

      const res = await wmFetch(`${HOST}/soft`, {
        tries: 1, throwOnHttpError: false
      })
      assert.equal(res.status, 500)
      assert.equal(await res.text(), 'wdqs stack trace')
    })

    it('still waits out 429s when throwOnHttpError is false', async function() {
      nock(HOST).get('/soft').times(3).reply(429)
      nock(HOST).get('/soft').reply(200, 'ok')

      const res = await wmFetch(`${HOST}/soft`, {
        tries: 1, throwOnHttpError: false, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
    })
```

**Step 2: Run to verify failure**

```bash
npx mocha test/mw-api.test.js
```

Expected: first new test fails (throws `HTTP 500`).

**Step 3: Implement**

In `lib/mw-api.js` `wmFetch`, add `throwOnHttpError = true` to the destructured
options, and change the non-ok branch:

```js
    if (!res.ok) {
      if (!throwOnHttpError) return res
      const permanent = res.status >= 400 && res.status < 500
      if (permanent || attempt >= tries) throw new Error(`HTTP ${res.status}`)
      await sleep(backoffMs * attempt)
      attempt++
      continue
    }
```

(429 handling stays ABOVE this branch and applies in both modes.)

**Step 4: Run to verify pass**

```bash
npx mocha test/mw-api.test.js
```

Expected: all passing (Phase 1's 15 + 2).

**Step 5: Commit**

```bash
git add lib/mw-api.js test/mw-api.test.js
git commit -m "$(cat <<'EOF'
feat: wmFetch throwOnHttpError=false for callers with their own classification (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `lib/sparql.js` transport onto `wmFetch`

**Files:**
- Modify: `lib/sparql.js` (lines 14-16 constants; 33-49 sparqlRaw)

**Step 1: Migrate**

Replace the `userAgent` require and `USER_AGENT` constant (line 16) with a require
of the module, and rewrite `sparqlRaw`'s fetch. The function currently looks like
(lines 33-49): plain `fetch(SPARQL_URL, { method: 'POST', headers: { 'User-Agent',
'Content-Type', 'Accept' }, body, signal: AbortSignal.timeout(60000) })` followed
by error construction attaching `.status`/`.body`. It becomes:

```js
const { wmFetch } = require('./mw-api')
```

```js
  let res
  try {
    res = await wmFetch(SPARQL_URL, {
      method: 'POST',
      component: 'sparql',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json'
      },
      body: new URLSearchParams({ format: 'json', query }),
      timeoutMs: 60000,
      tries: 1,               // sparqlChunked's isRetryable classification owns retries
      throwOnHttpError: false, // non-ok responses classified below, with status+body
      // WDQS 429s/503s: honor Retry-After in-band, but briefly — after 3 waits of
      // ≤30s each, ≤90s total. Then wmFetch throws and the outer
      // isRetryable/onChunkError path takes over. This caps the wait per sparqlRaw
      // call; the outer classifier owns longer-running region queries.
      maxRateLimitWaits: 3,
      maxRetryAfterMs: 30000,
      maxTotalWaitMs: 90000
    })
  } catch (error) {
    // wmFetch's capped-429/503 throws carry no .status; restore it so
    // isRetryable classifies them correctly as retryable.
    const m = /^HTTP (\d+)$/.exec(error.message)
    if (m) { error.status = Number(m[1]); error.body = '' }
    throw error
  }
```

Keep the existing non-ok error construction below it EXACTLY as-is (it reads
`res.status` and `res.text()` and attaches both to the thrown error — that is the
contract `isRetryable` depends on). Keep `isRetryable`, `sparqlSelect`,
`sparqlRows`, `sparqlChunked` and all exports unchanged, except: if `USER_AGENT`
was exported (line 16 / exports at 146-153), remove it from the exports and
confirm nothing requires it (`grep -rn "USER_AGENT" lib/ test/ scripts/ public/ | grep sparql`).

What changed for callers: nothing in signature; requests now also carry
`Accept-Encoding: gzip`, and a WDQS 429 waits out `Retry-After` (up to 3 waits)
inside wmFetch before surfacing to the outer classifier as before.

**Step 2: Verify**

```bash
npx mocha test/sparql.test.js test/public-server.test.js test/region.test.js test/wikidata-claim-watch.test.js && npm test 2>&1 | tail -3
```

Expected: green. The `.times()` count assertions hold because `tries: 1` keeps
one HTTP request per logical attempt.

**Step 3: Commit**

```bash
git add lib/sparql.js
git commit -m "$(cat <<'EOF'
refactor: sparql transport onto wmFetch — gzip + Retry-After, classification kept (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `public/server.js` `searchPlaces` drops its UA literal

**Files:**
- Modify: `public/server.js` (lines 544-568)

**Step 1: Migrate**

In `searchPlaces`, replace the `fetch` call + ok-check + `.json()` (lines 556-562)
with:

```js
  const data = await wmFetchJson(`https://www.wikidata.org/w/api.php?${params}`, {
    component: 'web', timeoutMs: 10000, tries: 1
  })
```

Add to the require block at the top of `public/server.js`:

```js
const { wmFetchJson } = require('../lib/mw-api')
```

Delete the hardcoded `'sfedits-web/1.0 (https://github.com/tieguy/sfedits)'`
literal (it lacked the operator contact — the exact bug class this phase kills).
`tries: 1` keeps this interactive endpoint snappy and preserves the test's
one-request-per-search expectation; a thrown `HTTP <status>` reaches the same
route-level error handling the old `Wikidata search returned <status>` did.

**Step 2: Verify**

```bash
npx mocha test/create-server.test.js test/public-server.test.js && npm test 2>&1 | tail -3
```

Expected: green (`.query(true)` intercepts; the 500-failure test still sees one
request and an error response from the route).

**Step 3: Commit**

```bash
git add public/server.js
git commit -m "$(cat <<'EOF'
refactor: searchPlaces onto wmFetchJson, dropping its contactless UA literal (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `scripts/find-*` drop the upstream author's UA

**Files:**
- Modify: `scripts/find-articles-in-categories.js` (helper at lines 6-39, literal line 13)
- Modify: `scripts/find-categories.js` (helper at lines 11-46, literal line 18)
- Modify: `scripts/find-translations.js` (helper at lines 11-49, literal line 18)

These are untested CLI utilities, all with the same shape: a promise-wrapped
`https.get` helper carrying `mrfinnsmith`'s contact — the operator-identity bug.

**Step 1: Migrate each script**

For each of the three, in its request helper:
- Drop the `https` require if it becomes unused; add
  `const { wmFetchJson } = require('../lib/mw-api')`.
- Replace the `options`-object + `https.get` + chunk-accumulation + `JSON.parse`
  body of the helper with a single call, keeping the function's signature, its URL
  construction, and all result-processing code unchanged:

```js
  const data = await wmFetchJson(url, { component: '<component>', timeoutMs: 30000 })
```

  Components: `find-articles`, `find-categories`, `find-translations`.
- If the helper was `new Promise((resolve, reject) => ...)`-wrapped, make it a
  plain `async function` returning `data` — the call sites already `await`/`.then`
  it either way; adjust the call sites only if one used explicit callbacks.
- Delete the UA literal line entirely.

**Step 2: Verify**

```bash
node --check scripts/find-articles-in-categories.js
node --check scripts/find-categories.js
node --check scripts/find-translations.js
grep -n "mrfinnsmith" scripts/find-articles-in-categories.js scripts/find-categories.js scripts/find-translations.js
npm test 2>&1 | tail -3
```

Expected: three clean parses, empty grep, suite green. (Live execution of these
scripts hits real Wikipedia — that belongs to Phase 5's judgment, not here.)

**Step 3: Commit**

```bash
git add scripts/find-articles-in-categories.js scripts/find-categories.js scripts/find-translations.js
git commit -m "$(cat <<'EOF'
fix: find-* scripts onto wmFetchJson — upstream author's User-Agent removed (LUI-94)

The UA now identifies the operator via lib/user-agent.js (SFEDITS_CONTACT
override), per the Wikimedia User-Agent policy.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `lib/mw-oauth.js` gains its missing User-Agent

**Files:**
- Modify: `lib/mw-oauth.js` (fetches at lines 42 and 69)
- Modify: `test/mw-oauth.test.js`

**Step 1: Write the failing test**

In `test/mw-oauth.test.js`, extend the success-path intercepts to require the UA
header. For `fetchProfile` (intercept at line 58), change its `.reqheaders` to:

```js
      reqheaders: {
        authorization: 'Bearer tok',
        'user-agent': require('../lib/user-agent').userAgent('mw-oauth')
      }
```

For `exchangeCode` (intercept at lines 31-32), add a matching
`.matchHeader('user-agent', require('../lib/user-agent').userAgent('mw-oauth'))`
to the interceptor chain.

**Step 2: Run to verify failure**

```bash
npx mocha test/mw-oauth.test.js
```

Expected: both success tests fail (no UA sent yet).

**Step 3: Implement**

In `lib/mw-oauth.js` add at the top:

```js
const { userAgent } = require('./user-agent')
const USER_AGENT_HEADER = userAgent('mw-oauth')
```

Add `'User-Agent': USER_AGENT_HEADER` to the headers of BOTH fetches:
`exchangeCode` (line 42, alongside `Content-Type`) and `fetchProfile` (line 69,
alongside `Authorization`). Transport stays plain `fetch` — an OAuth code
exchange must not be re-POSTed by a generic retry loop.

**Step 4: Run to verify pass**

```bash
npx mocha test/mw-oauth.test.js && npm test 2>&1 | tail -3
```

Expected: green.

**Step 5: Commit**

```bash
git add lib/mw-oauth.js test/mw-oauth.test.js
git commit -m "$(cat <<'EOF'
fix: mw-oauth sends the operator User-Agent on both OAuth endpoints (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Phase gate — UA-literal grep + full suite

**Files:** none (verification only)

**Step 1:**

```bash
grep -rn "USER_AGENT = '" lib/ scripts/ public/
grep -rni "user-agent" lib/ scripts/ public/ --include='*.js' | grep -v "user-agent.js" | grep -vi "userAgent(" | grep -vi "USER_AGENT_HEADER" | grep -v mw-api.js
grep -rnE "= *'[A-Za-z0-9._-]+/[0-9]" scripts/ lib/ public/
```

Expected: first grep empty (the CLAUDE.md invariant); second grep's known
acceptable hits are comments, `'User-Agent': USER_AGENT` header keys deriving
from `userAgent()`, references to reassess.js's `UA` literal
(`scripts/reassess.js:86,468`, `scripts/reassess-untagged.js:61`,
`scripts/matrix-untagged.js:104` — all one literal, deleted by Phase 4 Task 3),
and `scripts/record-deploy.js:99` / `scripts/toolforge-api.js:83` (GitHub API
and Toolforge jobs API, not Wikimedia — out-of-scope-acceptable); third grep
(broader sweep) hits only `scripts/reassess.js:41`'s `const UA =` (EXPECTED —
Phase 4 Task 3 deletes it). Anything outside these sets is the bug.

**Step 2:**

```bash
npm run test:db:start
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: 0 failing.
