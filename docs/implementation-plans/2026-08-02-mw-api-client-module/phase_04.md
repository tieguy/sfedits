# Shared Wikimedia API Client Module — Phase 4: Port reassess.js from the design branch

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** The current (941-line) `scripts/reassess.js` lives on this branch,
running on `lib/mw-api.js` instead of its own `apiGet` + hardcoded UA.

**Architecture:** Copy the script and its companions from
`place-bot-platform-design` via `git show`, then delete `apiGet`/`UA` and route
everything through a thin `api()` shim over `actionSession` (with
`formatversion: 1` pinned — the script's 10 call sites all parse v1 shapes, and
this port deliberately does NOT rewrite their parsing) plus `wmFetchJson` for
pageviews. `test/reassess-api.test.js` is retired: its four cases were ported
verbatim into `test/mw-api.test.js` in Phase 1.

**Tech Stack:** as Phase 1, plus `wtf_wikipedia` (needed by `wikitextLinks()` in
reassess.js). `seek-bzip` and `lib/dump-reader.js` stay on the design branch —
they belong to `rank.js`, which is explicitly out of scope.

**Scope:** phase 4 of 5.

**Codebase verified:** 2026-08-02 (design-branch excerpts by codebase-investigator)

---

## Context for the implementor

- Source of truth for the port is the git branch `place-bot-platform-design`
  (checked out at `.worktrees/place-bot-platform-design`; read files with
  `git show place-bot-platform-design:<path>` from this worktree — do not edit
  that worktree).
- On the design branch, `scripts/reassess.js` exports (lines 936-940):
  `percentileRanks, median, leadScore, scoreCohort, pickCandidates, wikitextLinks,
  canonicalInlinks, redirectTargets, buildUniverse, assignTiers, IS_HERE_PROPERTIES,
  fetchPageviews, BAY_AREA_RE, apiGet, batches, EN_API, WD_API, UA, PROJECT`.
  After the port, `apiGet` and `UA` leave the export list; `api` (the shim) joins
  it (reassess-untagged.js and matrix-untagged.js consume it).
- `apiGet` call sites (10): lines 243, 267, 304, 348, 388, 489, 526, 568, 599, 774
  — all `apiGet(EN_API|WD_API, params)` with default options, all parsing
  formatversion 1 shapes, several with `data.continue` loops that must keep
  working (the shim passes `...cont` params through untouched).
- Old retry budget was `maxRateLimitWaits: 60` × `rateLimitWaitMs: 10000` ≈ 600s
  of waiting out sustained 429/maxlag. m3api's equivalent knob is
  `maxRetriesSeconds` (default 65s — too low for bulk); the shim passes 600.
- `data/reassess/*.json` checkpoint/resume must survive: it is pure fs logic in
  the script (`loadCache`, progress files, `nextBatch`) and the port does not
  touch it.
- `rank.js` is NOT ported. `test/reassess.test.js` (pure-function tests) IS.

---

## Task 1: Add `wtf_wikipedia` dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

**Step 1: Install**

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install --save wtf_wikipedia
```

Expected: `"wtf_wikipedia": "^10.x"` added. Do NOT add `seek-bzip`.

**Step 2: Verify**

```bash
node -e "const wtf = require('wtf_wikipedia'); console.log(wtf('[[A]] and [[B]]').links().length)"
```

Expected output: `2`.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: add wtf_wikipedia for reassess prose-link parsing (LUI-94)

seek-bzip/dump-reader stay on place-bot-platform-design with rank.js.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Copy reassess.js + its pure-function tests from the design branch

**Files:**
- **Overwrite**: `scripts/reassess.js` (this branch carries an OLDER 586-line
  version; the design branch's 941-line version replaces it — that replacement
  IS the design intent, per the design's Definition of Done)
- **Overwrite**: `test/reassess.test.js` (older 134-line version → incoming
  445-line version; the suite's passing count will change accordingly — judge
  the gates below by "0 failing", not by arithmetic on the old count)

**Step 1: See what you're replacing, then copy verbatim**

```bash
git diff --stat HEAD -- scripts/reassess.js test/reassess.test.js  # baseline (no output)
git show place-bot-platform-design:scripts/reassess.js > scripts/reassess.js
git show place-bot-platform-design:test/reassess.test.js > test/reassess.test.js
git diff --stat -- scripts/reassess.js test/reassess.test.js       # shows the replacement size
```

**Step 2: Verify the copy runs as-is**

```bash
npx mocha test/reassess.test.js
node scripts/reassess.js 2>&1 | head -2
```

Expected: pure-function tests pass unmodified (they exercise percentileRanks,
scoring, link canonicalization — no HTTP); the bare invocation prints the
`usage: node scripts/reassess.js <cohort|...|all>` line and exits 1.

**Step 3: Commit the verbatim copy** (so the next task's diff shows exactly what
the migration changed — reviewability is the point of splitting these commits):

```bash
git add scripts/reassess.js test/reassess.test.js
git commit -m "$(cat <<'EOF'
feat: port reassess.js verbatim from place-bot-platform-design (LUI-94)

Verbatim copy; the switch to lib/mw-api lands in the next commit.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: reassess.js onto the module

**Files:**
- Modify: `scripts/reassess.js`

**Step 1: Replace apiGet/UA with the shim**

(a) Delete the `UA` constant (line 55) and the whole `apiGet` function
(lines 90-129).

(b) Where `apiGet` was defined, add the shim (requires at top of file):

```js
const { actionSession, wmFetchJson } = require('../lib/mw-api')
```

```js
// Transport shim over lib/mw-api. formatversion 1 is pinned deliberately:
// every stage in this script parses v1 shapes, and this port changes
// transport, not parsing. maxRetriesSeconds 600 matches the old budget of
// waiting out sustained 429/maxlag (60 waits x 10s) — m3api owns those
// waits now, Retry-After included.
async function api(base, params) {
  const session = await actionSession(base, 'reassess')
  return session.request(
    { formatversion: 1, ...params },
    { maxRetriesSeconds: 600 }
  )
}
```

(c) Replace all 10 `apiGet(` call sites (lines 243, 267, 304, 348, 388, 489, 526,
568, 599, 774) with `api(` — arguments unchanged except: none of them pass an
options object (verified), so the third argument never appears. `sed` is safe
here, but do it with an editor and read each site:

```bash
grep -n "apiGet(" scripts/reassess.js
```

must return zero hits afterwards.

(d) `fetchPageviews` (lines 787-800): replace its raw
`fetch(url, { headers: { 'User-Agent': UA } })` + ok-check with `wmFetch` in
non-throwing mode, PRESERVING the existing distinction between "no data" (non-ok
response → `null`) and transport failure (throws, so the stage's checkpoint
machinery can rerun it):

```js
    const res = await wmFetch(url, {
      component: 'reassess', tries: 2, backoffMs: 1000, throwOnHttpError: false
    })
    if (!res.ok) return null  // article genuinely has no pageview data
    const data = await res.json()
```

**and DELETE the function's enclosing `try { … } catch { return null }`**
(design-branch lines 795-800) — otherwise transport failures still collapse
into `null` and the split above is dead code. After this change: non-ok
response → `null` ("no data"), transport failure → throws, so the stage's
checkpoint machinery reruns instead of recording gaps. Keep the aggregation
logic itself unchanged, and switch the require to
`const { actionSession, wmFetch } = require('../lib/mw-api')` — `wmFetchJson`
is not needed here.

(e) Update `module.exports` (lines 936-940): remove `apiGet` and `UA`; add `api`.

**Step 2: Verify**

```bash
node --check scripts/reassess.js
npx mocha test/reassess.test.js
node scripts/reassess.js 2>&1 | head -2
grep -n "User-Agent\|apiGet\|sfba-reassess" scripts/reassess.js
```

Expected: clean parse; tests pass; usage line prints; grep returns nothing
(no UA literal, no apiGet remnant).

**Step 3: Commit**

```bash
git add scripts/reassess.js
git commit -m "$(cat <<'EOF'
refactor: reassess.js onto lib/mw-api — apiGet and UA literal deleted (LUI-94)

formatversion 1 pinned (parsing untouched); maxRetriesSeconds 600 keeps the
old wait-out-sustained-429s budget; pageviews via wmFetch, with no-data
(null) now distinct from transport failure (throws).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Port reassess-untagged.js and matrix-untagged.js

**Files:**
- **Overwrite**: `scripts/reassess-untagged.js` (older version exists on this
  branch; deliberate replacement, then edit)
- **Overwrite**: `scripts/matrix-untagged.js` (same)

**Step 1: Copy from the design branch**

```bash
git show place-bot-platform-design:scripts/reassess-untagged.js > scripts/reassess-untagged.js
git show place-bot-platform-design:scripts/matrix-untagged.js > scripts/matrix-untagged.js
```

**Step 2: Edit both onto the module**

`scripts/reassess-untagged.js`:
- Its import (lines 29-30) `{ apiGet, batches, EN_API, WD_API, UA, PROJECT, ... }`
  becomes `{ api, batches, EN_API, WD_API, PROJECT, ... }` (drop `UA`, swap
  `apiGet` → `api`); rename its `apiGet(` call sites to `api(` and drop any
  third-argument options object if one appears (read each site).
- Its raw SPARQL POST (lines 55-74, 5 retries/5s backoff with `User-Agent: UA`)
  is replaced with the repo's SPARQL transport:

```js
const { sparqlRows } = require('../lib/sparql')
```

  and the query block becomes a `sparqlRows(<query>)` call. NOTE (corrected at
  review): lib/sparql.js owns WDQS retries only via `sparqlChunked`; `sparqlRows`
  is single-shot (`tries: 1`), so the local 5-attempt retry survives as a small
  `sparqlRowsWithRetry` wrapper gated on the exported `isRetryable`. Keep the
  result-shape mapping — `sparqlRows` returns simplified rows; adjust the
  consuming code to its shape (read `lib/sparql.js` lines 70-79 for the exact
  return contract before writing this).

`scripts/matrix-untagged.js`:
- Import (lines 29-30): drop `UA`, swap `apiGet` → `api`, rename call sites.
- Its direct pageviews fetch (line 104): the ORIGINAL distinguishes "article has
  no pageview data" (non-ok response → the "no data" value) from transport
  trouble (throws after 5 attempts, so the run fails loudly instead of recording
  zeros). PRESERVE that split — this is a measurement tool; a catch-all that
  returns "no data" on network failure silently corrupts measurements:

```js
const { wmFetch } = require('../lib/mw-api')
```

```js
    const res = await wmFetch(url, {
      component: 'reassess', tries: 5, backoffMs: 5000, throwOnHttpError: false
    })
    if (!res.ok) { /* existing "no data" value/continue, unchanged */ }
    const data = await res.json()
```

  (transport errors propagate out of `wmFetch` after 5 attempts, matching the
  old 5-retries/5s-backoff behavior; do NOT wrap this in a catch that returns
  the "no data" value.)

**Step 3: Verify**

```bash
node --check scripts/reassess-untagged.js
node --check scripts/matrix-untagged.js
grep -n "UA\b\|apiGet" scripts/reassess-untagged.js scripts/matrix-untagged.js
npm test 2>&1 | tail -3
```

Expected: clean parses; grep empty; suite green.

**Step 4: Commit**

```bash
git add scripts/reassess-untagged.js scripts/matrix-untagged.js
git commit -m "$(cat <<'EOF'
feat: port reassess-untagged + matrix-untagged onto the shared client (LUI-94)

UA imports gone; SPARQL through lib/sparql.js; pageviews through wmFetch
(no-data vs transport-failure split preserved).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Phase gate

**Files:** none (verification only)

**Step 1: reassess-api.test.js is deliberately NOT ported**

```bash
ls test/reassess-api.test.js 2>&1
```

Expected: `No such file or directory`. Its four retry cases live on as the first
four tests of `test/mw-api.test.js` (Phase 1) — confirm:

```bash
grep -c "waits out a 429\|honours a Retry-After\|gives up on a 5xx\|rate limit never clears" test/mw-api.test.js
```

Expected: `4`.

**Step 2: Full suite**

```bash
npm run test:db:start
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: 0 failing (the replaced reassess.test.js changes the passing count —
judge by failures, not arithmetic).

**Step 3: UA-literal invariant across everything ported**

```bash
grep -rn "USER_AGENT = '" lib/ scripts/
grep -rn "sfba-reassess\|mrfinnsmith" lib/ scripts/
```

Expected: both empty. (Note: public/server.js contains benign attribution links to upstream
and is deliberately excluded.)
