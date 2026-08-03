# Shared Wikimedia API Client Module — Phase 2: Bot-runtime consumers

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** The deployed bot's live path runs on `lib/mw-api.js`. Each consumer keeps
its domain logic and fail-soft behavior; only transport changes.

**Architecture:** Swap hand-rolled `fetch`/`https.get` calls for `actionSession`
(Action API via m3api), `restGetJson` (REST compare), and `wmFetch`/`wmFetchJson`
(RESTBase, thumbnails, raw HTML). `lib/edit-stream.js` is deliberately untouched.

**Tech Stack:** as Phase 1.

**Scope:** phase 2 of 5.

**Codebase verified:** 2026-08-02 (call-site excerpts quoted by codebase-investigator)

---

## PRECONDITION — checkpoint resolved

Phase 1's checkpoint (delivery-merge overlap) must have an explicit decision from
Louie recorded at the bottom of `phase_01.md` before any task here starts. If it
does not, STOP and get it.

## Context for the implementor

- Every migrated module already builds its UA via `userAgent('<component>')` — the
  migration REMOVES those per-file `USER_AGENT` constants and lets `lib/mw-api.js`
  apply identity. Keep each module's existing component name.
- Sessions default to `formatversion: 2`. Most consumers already parse v2 shapes
  (they passed `formatversion=2` in their URLs). The ONE exception is
  `fetchParentRevision` in `lib/compare-diff.js` (currently implicit v1: `pages` as
  an object keyed by pageid). Its parsing changes to the v2 array shape in Task 1 —
  deliberately, with a new test.
- m3api throws `ApiErrors` instead of `Error('HTTP <status>')` for API-level
  failures. Every migrated call site is either wrapped in a broad try/catch
  (fail-soft) or lets errors propagate to a caller that catches broadly — check
  this holds when you touch each function.
- Existing nock intercepts in these modules' suites all use function query matchers
  or `.query(true)` (verified 2026-08-02), so the new default params
  (`errorformat=plaintext`, `maxlag=5`, `format=json`) will not break matching.
  If a test fails on an intercept, understand WHY the request changed before
  touching the intercept (design rule: intercepts are updated only deliberately).
- Serial discipline: replace all existing `Promise.all` fan-outs at Wikimedia hosts
  with sequential awaits. Plan initially noted one (compare-diff BLP claims);
  Phase 2 Task 1 review found and serialized two additional fan-outs in lib/diff-image.js
  (fetchPageSummary ∥ fetchBlpStatus, and fetchCompareDiff ∥ fetchArticleMeta).
- Run `npm test` after every task; `SFEDITS_REQUIRE_DB=1` with the DB container up
  for the final task.

---

## Task 1: Migrate `lib/compare-diff.js`

**Files:**
- Modify: `lib/compare-diff.js` (lines 11-12 requires; 59-66 fetchJson; 71-82
  fetchParentRevision; 88-101 fetchCompareDiff; 332-343 fetchPageSummary; 384-420
  fetchBlpStatus; 429-444 fetchImageAsDataUri)
- Modify: `test/compare-diff.test.js` (add nock coverage for fetchParentRevision)

**Step 1: Write the failing test**

`test/compare-diff.test.js` currently tests pure functions only. Add nock coverage
for the one function whose response parsing changes (v1 object → v2 array). At the
top of the file add `const nock = require('nock')` and, in a new describe block:

```js
describe('fetchParentRevision', function() {
  afterEach(function() {
    nock.cleanAll()
  })

  it('reads the parent id from a formatversion 2 pages array', async function() {
    nock('https://en.wikipedia.org')
      .get('/w/api.php')
      .query(q => q.action === 'query' && q.prop === 'revisions' && q.formatversion === '2')
      .reply(200, {
        query: { pages: [{ pageid: 42, revisions: [{ revid: 200, parentid: 100 }] }] }
      })

    const { fetchParentRevision } = require('../lib/compare-diff')
    assert.equal(await fetchParentRevision('en.wikipedia.org', 200), 100)
  })

  it('returns null when the revision has no parent', async function() {
    nock('https://en.wikipedia.org')
      .get('/w/api.php')
      .query(true)
      .reply(200, {
        query: { pages: [{ pageid: 42, revisions: [{ revid: 200, parentid: 0 }] }] }
      })

    const { fetchParentRevision } = require('../lib/compare-diff')
    assert.isNull(await fetchParentRevision('en.wikipedia.org', 200))
  })
})
```

Because module-level session caching is process-wide, also add to this describe:

```js
  afterEach(function() {
    require('../lib/mw-api')._resetSessions()
  })
```

(One `afterEach` doing both `nock.cleanAll()` and `_resetSessions()` is fine.)

**Step 2: Run to verify failure**

```bash
npx mocha test/compare-diff.test.js
```

Expected: fails — `fetchParentRevision` is not currently exported (and still
parses v1).

**Step 3: Migrate the module**

In `lib/compare-diff.js`:

(a) Replace the UA/require block (lines 11-12) — delete
`const USER_AGENT = userAgent('compare-diff')` and the `userAgent` require; add:

```js
const { actionSession, restGetJson, wmFetch, wmFetchJson } = require('./mw-api')
```

(b) Delete the `fetchJson` helper (lines 59-66) entirely.

(c) Replace `fetchParentRevision` (lines 71-82) — note the v2 array parsing:

```js
async function fetchParentRevision(host, revid) {
  const session = await actionSession(host, 'compare-diff')
  const data = await session.request({
    action: 'query', prop: 'revisions', revids: revid, rvprop: 'ids'
  })
  for (const page of data?.query?.pages || []) {
    const rev = page?.revisions?.[0]
    if (rev && Number.isInteger(rev.parentid) && rev.parentid > 0) {
      return rev.parentid
    }
  }
  return null
}
```

(d) In `fetchCompareDiff` (lines 88-101), replace the two lines building `url` and
calling `fetchJson` with:

```js
  const data = await restGetJson(host, `/v1/revision/${fromrev}/compare/${torev}`, {
    component: 'compare-diff'
  })
```

(Path is relative to rest.php — m3api-rest prepends `https://<host>/w/rest.php`
itself; passing `/w/rest.php/...` here would double the prefix.)

(the surrounding parseDiffParams / parent-revision fallback / `Array.isArray(data?.diff)`
logic stays exactly as-is).

(e) Replace `fetchPageSummary` (lines 332-343) body's fetch with `wmFetchJson`
(fail-soft catch stays). Deliberate behavior change: the old code made exactly
one attempt; `tries: 2, backoffMs: 1000` here (and in (g)) adds ONE bounded
retry on the posting path — worst case ~1s extra before the existing null
fallback, in exchange for surviving transient RESTBase/thumb hiccups:

```js
async function fetchPageSummary(host, page) {
  try {
    const url = `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(page.replace(/ /g, '_'))}`
    const data = await wmFetchJson(url, {
      component: 'compare-diff', timeoutMs: FETCH_TIMEOUT_MS, tries: 2, backoffMs: 1000
    })
    return {
      description: data?.description || null,
      thumbnailUrl: data?.thumbnail?.source || null
    }
  } catch (e) {
    return { description: null, thumbnailUrl: null }
  }
}
```

(f) In `fetchBlpStatus` (lines 384-420):
- pageprops call: replace the `ppUrl` construction + `fetchJson(ppUrl)` with

```js
    const session = await actionSession(host, 'compare-diff')
    const ppData = await session.request({
      action: 'query', titles: page, prop: 'pageprops', ppprop: 'wikibase_item'
    })
```

  (parsing `ppData?.query?.pages?.[0]` already assumes v2 — unchanged).
- claims calls: replace the `claimsUrl` helper and the `Promise.all` with two
  SEQUENTIAL requests on a Wikidata session (this removes an existing parallel
  fan-out at a Wikimedia host — serial discipline):

```js
    const wd = await actionSession('www.wikidata.org', 'compare-diff')
    const p31 = await wd.request({
      action: 'wbgetclaims', entity: qid, property: P_INSTANCE_OF
    })
    const p570 = await wd.request({
      action: 'wbgetclaims', entity: qid, property: P_DATE_OF_DEATH
    })
```

  (the `instanceOfIds` / `deathTime` extraction below stays exactly as-is; the
  enclosing try/catch keeps the fail-soft `{ isBlp: null, ... }` return.)

(g) Replace `fetchImageAsDataUri` (lines 429-444):

```js
async function fetchImageAsDataUri(url) {
  try {
    const res = await wmFetch(url, {
      component: 'compare-diff', timeoutMs: FETCH_TIMEOUT_MS, tries: 2, backoffMs: 1000
    })
    const type = res.headers.get('content-type') || ''
    if (!/^image\/(jpeg|png|gif|webp)/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_THUMBNAIL_BYTES) return null
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
  } catch (e) {
    return null
  }
}
```

(h) Add `fetchParentRevision` to the module's `module.exports` (it is a test hook;
keep the existing exports untouched otherwise).

**Step 4: Run to verify pass**

```bash
npx mocha test/compare-diff.test.js && npm test 2>&1 | tail -3
```

Expected: new tests pass; full suite count unchanged +2 (574 passing, 1 pending).

**Step 5: Commit**

```bash
git add lib/compare-diff.js test/compare-diff.test.js
git commit -m "$(cat <<'EOF'
refactor: compare-diff onto lib/mw-api (LUI-94)

Action API via cached m3api session (fetchParentRevision now parses the
formatversion 2 array shape, with tests), REST compare via restGetJson,
RESTBase summary and thumbnails via wmFetch*. The BLP claims Promise.all
becomes two serial requests — no parallel fan-out at Wikimedia hosts.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migrate `lib/diff-page.js`

**Files:**
- Modify: `lib/diff-page.js` (lines 3-4 requires; 13-22 fetchDiffHtml)

**Step 1: Migrate** (this module's tests are pure-function only; behavior contract
is "resolve HTML string, or '' on any failure" — preserved by the catch):

Replace the `https` + `userAgent` requires and `USER_AGENT` const with:

```js
const { wmFetch } = require('./mw-api')
```

Replace `fetchDiffHtml` (lines 13-22):

```js
async function fetchDiffHtml(diffUrl) {
  try {
    const res = await wmFetch(diffUrl, {
      component: 'diff-page', timeoutMs: 15000, tries: 2, backoffMs: 1000
    })
    return await res.text()
  } catch (e) {
    return ''
  }
}
```

(This also closes the design-noted gap: the old `https.get` had NO timeout.)

**Step 2: Verify**

```bash
npx mocha test/diff-page.test.js && npm test 2>&1 | tail -3
```

Expected: green, counts unchanged.

**Step 3: Commit**

```bash
git add lib/diff-page.js
git commit -m "$(cat <<'EOF'
refactor: diff-page onto wmFetch, gaining a timeout (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Migrate `lib/revdel-check.js`

**Files:**
- Modify: `lib/revdel-check.js` (lines 27-28 requires; 91-100 queryRevisions)

**Step 1: Migrate**

Replace the `userAgent` require + `USER_AGENT` const (lines 27-28) with:

```js
const { actionSession } = require('./mw-api')
```

Replace `queryRevisions` (lines 91-100):

```js
async function queryRevisions(host, revIds) {
  const session = await actionSession(host, 'revdel-check')
  return session.request({
    action: 'query', prop: 'revisions', revids: revIds.join('|'), rvprop: 'ids|user|sha1'
  })
}
```

`classifyRevisions` already parses the formatversion 2 array shape — no change.
The caller's existing skip-batch-on-throw behavior handles m3api's `ApiErrors`
the same as the old `Error('HTTP …')`.

**Step 2: Verify**

```bash
npx mocha test/revdel.test.js && npm test 2>&1 | tail -3
```

Expected: green, counts unchanged (queryRevisions has no direct HTTP test; the
suite proves nothing else broke).

**Step 3: Commit**

```bash
git add lib/revdel-check.js
git commit -m "$(cat <<'EOF'
refactor: revdel-check onto actionSession (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Migrate `lib/watchlist-sync.js` (PageAssessments paging)

**Files:**
- Modify: `lib/watchlist-sync.js` (lines 55-56 requires; 66-123 fetchProjectArticles)

**Step 1: Migrate**

Keep the `userAgent` require — `fetchTitlesList` (lines 141-162) still uses
`USER_AGENT` for its arbitrary, possibly non-Wikimedia `titles_url` fetch, which
deliberately stays plain `fetch` (design decision). Add:

```js
const { actionSession } = require('./mw-api')
```

Replace `fetchProjectArticles` (lines 66-123) with a `requestAndContinue` loop —
this deletes the manual continuation/`data.error` handling, and with it the
maxlag-thrown-as-fatal bug (m3api waits out maxlag internally):

```js
async function fetchProjectArticles(source) {
  const apiUrl = source.api_url || DEFAULT_API_URL
  const importance = source.importance
    ? new Set(source.importance.map(i => i.toLowerCase()))
    : null

  // actionSession accepts a full api.php URL as well as a bare host.
  const session = await actionSession(apiUrl, 'watchlist-sync')

  const params = {
    action: 'query',
    list: 'projectpages',
    wppprojects: source.project,
    wpplimit: PAGE_LIMIT
  }
  if (importance) params.wppassessments = 'true'

  const titles = []
  for await (const data of session.requestAndContinue(params)) {
    const projects = data.query?.projects || {}
    for (const pages of Object.values(projects)) {
      for (const page of pages) {
        if (page.ns !== 0) continue
        if (importance) {
          const pageImportance = (page.assessment?.importance || '').toLowerCase()
          if (!importance.has(pageImportance)) continue
        }
        titles.push(page.title)
      }
    }
  }

  return titles
}
```

**Step 2: Verify**

```bash
npx mocha test/watchlist-sync.test.js && npm test 2>&1 | tail -3
```

Expected: green. The suite's intercepts use function query matchers
(`q => q.list === 'projectpages' && !q.wppcontinue`, `q => q.wppcontinue === 'page-2-token'`),
which tolerate m3api's added default params and match its continuation echo. If
the continuation test fails, inspect what continue params m3api actually resends
(it merges the response's `continue` object verbatim) before changing anything.

**Step 3: Commit**

```bash
git add lib/watchlist-sync.js
git commit -m "$(cat <<'EOF'
refactor: watchlist-sync paging onto requestAndContinue (LUI-94)

m3api owns continuation and waits out maxlag instead of throwing it as
fatal. The arbitrary titles_url fetch deliberately stays plain fetch.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Migrate `lib/wikidata-claim-watch.js`

**Files:**
- Modify: `lib/wikidata-claim-watch.js` (lines 43-44 requires; 186-212 fetchLabels;
  228-238 postToWebhook)

**Step 1: Write the failing assertion (inside the existing test)**

The design requires the Discord webhook to STOP sending a Wikimedia operator UA
(Discord is not a Wikimedia host; the UA there is noise). Rather than duplicate
the arrange block, extend the EXISTING test
`'posts a Discord embed for a matching claim edit'` in
`test/wikidata-claim-watch.test.js` (its Discord intercept is at lines 212-215):

- Declare `let uaSeen` at the top of that test.
- Change its Discord intercept's `.reply(204)` to a function reply that records
  the header before returning:

```js
    nock('https://discord.com')
      .post('/api/webhooks/123/abc', body => { posted = body; return true })
      .query(true)
      .reply(204, function() {
        uaSeen = this.req.headers['user-agent']
        return ''
      })
```

- After the test's existing assertions, add:

```js
    assert.notMatch(String(uaSeen), /sfedits-claim-watch/)
```

(nock lowercases header names in `this.req.headers`; `String()` also covers the
header being absent entirely, which is the desired end state.)

**Step 2: Run to verify failure**

```bash
npx mocha test/wikidata-claim-watch.test.js
```

Expected: the new test fails (UA currently sent).

**Step 3: Migrate**

- Replace the `userAgent` require + `USER_AGENT` const (lines 43-44) with:

```js
const { actionSession } = require('./mw-api')
```

- Replace `fetchLabels` (lines 186-212) — fail-soft fallback preserved:

```js
async function fetchLabels(ids) {
  try {
    const session = await actionSession('www.wikidata.org', 'claim-watch')
    const data = await session.request({
      action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en'
    })
    const labels = {}
    for (const id of ids) {
      labels[id] = data.entities?.[id]?.labels?.en?.value || id
    }
    return labels
  } catch (error) {
    const labels = {}
    for (const id of ids) labels[id] = id
    return labels
  }
}
```

- In `postToWebhook` (lines 228-238), delete the `'User-Agent': USER_AGENT` header
  (keep `Content-Type`). Nothing else changes.

(The module's SPARQL calls already go through `lib/sparql.js` — untouched here;
sparql's transport migrates in Phase 3.)

**Step 4: Run to verify pass**

```bash
npx mocha test/wikidata-claim-watch.test.js && npm test 2>&1 | tail -3
```

Expected: all green (same test count — the assertion lives inside an existing test).

**Step 5: Commit**

```bash
git add lib/wikidata-claim-watch.js test/wikidata-claim-watch.test.js
git commit -m "$(cat <<'EOF'
refactor: claim-watch labels onto actionSession; no Wikimedia UA to Discord (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Migrate `lib/title-resolver.js`

**Files:**
- Modify: `lib/title-resolver.js` (lines 21-22 requires; 77-119 titlesForQidsViaApi)

**Step 1: Migrate**

Replace the `userAgent` require + `USER_AGENT` const (lines 21-22) with:

```js
const { actionSession } = require('./mw-api')
```

In `titlesForQidsViaApi` (lines 77-119), get the session once BEFORE the batch
loop, then replace the `params`/`fetch`/`res.ok` block inside the loop:

```js
  const session = await actionSession('www.wikidata.org', 'title-resolver')

  for (const batch of chunk(qids, API_BATCH_SIZE)) {
    const data = await session.request({
      action: 'wbgetentities', ids: batch.join('|'), props: 'sitelinks'
    })
    // ... existing data.entities parsing unchanged ...
  }
```

The `data.entities` parsing is version-agnostic — unchanged. The batch loop
stays a sequential `for...of` (serial discipline; the existing test asserts
exactly 3 HTTP calls for 120 QIDs and must keep passing).

**Step 2: Verify**

```bash
npx mocha test/title-resolver.test.js && npm test 2>&1 | tail -3
```

Expected: green — the suite's `.query(true)` intercepts and the 3-call batch
assertion all hold. DB-backed portions of this suite need the container.

**Step 3: Commit**

```bash
git add lib/title-resolver.js
git commit -m "$(cat <<'EOF'
refactor: title-resolver onto actionSession (LUI-94)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full-suite + no-fan-out verification

**Files:** none (verification only)

**Step 1:**

```bash
npm run test:db:start
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: 0 failing (net +2 tests over the Phase 1 count — the two new
fetchParentRevision cases; the claim-watch check is an assertion inside an
existing test).

**Step 2:**

```bash
grep -rn "USER_AGENT" lib/compare-diff.js lib/diff-page.js lib/revdel-check.js lib/title-resolver.js lib/wikidata-claim-watch.js
grep -rn "Promise.all" lib/compare-diff.js
```

Expected: first grep empty (watchlist-sync intentionally keeps its constant for
titles_url); second grep empty.

**Step 3: Confirm edit-stream untouched**

```bash
git diff --stat integration...HEAD -- lib/edit-stream.js
```

Expected: no output.
