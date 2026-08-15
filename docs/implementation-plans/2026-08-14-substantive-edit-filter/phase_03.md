# Substantive-Edit Filter Implementation Plan — Phase 3: Pipeline Integration (Log-Only Capable)

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Wire the classifier into the bot's per-delivery filter pipeline behind a three-state `substantive_only` option (`false` | `'log'` | `true`), with a conservative-pass fetch helper and a unit-tested stage module. Nothing changes for deliveries that don't set the flag.

**Architecture:** `lib/edit-filters.js` gains the normalized option plus pure decision helpers; `lib/revision-pair.js` fetches both revisions' wikitext + tags in one batched request via `lib/mw-api.js`; `lib/significance-stage.js` holds the stage logic with the fetch and classify functions injected (so the conservative-pass invariant is unit-tested); `page-watch.js` calls the stage **after the metadata filters and before the `--noop` early return and the diff-HTML fetch** — so a local no-post run shows verdicts, and dropped edits skip the diff/image work.

**Design deviation, documented:** the design originally said "fetch helper beside the `page-watch.js` call site"; both the helper and the stage live in `lib/` modules instead, precisely so they are testable with nock/stubs. The design doc has been amended to match (commit on this branch).

**Tech Stack:** Node 22, `actionSession` from `lib/mw-api.js`, `parseDiffParams` from `lib/compare-diff.js`, nock v14, sinon spies.

**Scope:** 5 phases from `docs/design-plans/2026-08-14-substantive-edit-filter.md` (this file: phase 3).

**Codebase verified:** 2026-08-14, re-verified by an executing reviewer. Key facts:
- `normalizeEditFilters()` (lib/edit-filters.js:17-27) **drops unknown keys**; new keys go in `DEFAULTS` (line 12) and the return shape.
- Four existing tests (`test/edit-filters.test.js:9,10,11,16`) `assert.deepEqual` the normalized shape against the exact 4-key object — they MUST be updated when the shape grows.
- In `page-watch.js` `sendStatus()`: metadata stage ends around :255; `if (argv.noop) { …; return null }` sits at :252-258 **before** the diff fetch (:267) and content stage (:277-299); `consumersAfterContent` is read at **four** places after the content stage — the `filter-pass:` log (:292), the empty-set early return (:297), the config delivery loop (:332), and the subscription fan-out (:393). Line numbers drift as phases land — anchor on code content.
- `parseDiffParams(diffUrl)` (lib/compare-diff.js:41, exported :770) returns `{host, torev, fromrev|null}` where `host` is `new URL(diffUrl).host` (bare hostname — exactly what `actionSession` normalizes).

---

### Task 1: Three-state `substantive_only` in edit-filters

**Files:**
- Modify: `lib/edit-filters.js` (DEFAULTS; `normalizeEditFilters()`; new helpers; `module.exports`; header comment)
- Modify: `test/edit-filters.test.js` (four existing deepEqual expectations + new cases)

**Step 1: Update the four existing shape assertions.** `test/edit-filters.test.js` lines 9, 10, 11 and 16 each `assert.deepEqual(normalizeEditFilters(…), { bots: …, minor: …, min_delta: …, cosmetic_only: … })`. Extend each expected object with the two new keys:

```javascript
, substantive_only: false, substantive_channels: null
```

(and for the line-16 case, whatever `bots`/`minor` values it already asserts stay as they are — only append the two new keys to the expected object).

**Step 2: Write the new failing tests** — append inside the existing top-level `describe`:

```javascript
describe('substantive_only normalization and decisions', function () {
  it('defaults substantive_only to false and substantive_channels to null', function () {
    const f = normalizeEditFilters({})
    assert.equal(f.substantive_only, false)
    assert.isNull(f.substantive_channels)
  })

  it('normalizes the three states and rejects junk values', function () {
    assert.equal(normalizeEditFilters({ substantive_only: true }).substantive_only, true)
    assert.equal(normalizeEditFilters({ substantive_only: 'log' }).substantive_only, 'log')
    assert.equal(normalizeEditFilters({ substantive_only: 'yes' }).substantive_only, false)
    assert.equal(normalizeEditFilters({ substantive_only: 1 }).substantive_only, false)
  })

  it('passes substantive_channels through as an object, else null', function () {
    const f = normalizeEditFilters({ substantive_channels: { references: 'ignored' } })
    assert.deepEqual(f.substantive_channels, { references: 'ignored' })
    assert.isNull(normalizeEditFilters({ substantive_channels: 'prose' }).substantive_channels)
  })

  it('needsSignificanceCheck is true for log and true, false otherwise', function () {
    assert.isFalse(needsSignificanceCheck(null))
    assert.isFalse(needsSignificanceCheck({ substantive_only: false }))
    assert.isTrue(needsSignificanceCheck({ substantive_only: 'log' }))
    assert.isTrue(needsSignificanceCheck({ substantive_only: true }))
  })

  it('significanceDropReason drops only enforcing consumers on a non-substantive verdict', function () {
    const verdict = { substantive: false, reasons: [], ignored: ['template-bag'] }
    assert.isNull(significanceDropReason(verdict, { substantive_only: false }))
    assert.isNull(significanceDropReason(verdict, { substantive_only: 'log' }))
    assert.equal(significanceDropReason(verdict, { substantive_only: true }),
      'substantive_only: template-bag')
  })

  it('significanceDropReason never drops on substantive, fallback, or missing verdicts', function () {
    assert.isNull(significanceDropReason({ substantive: true, reasons: ['prose'], ignored: [] },
      { substantive_only: true }))
    assert.isNull(significanceDropReason(
      { substantive: true, reasons: [], ignored: [], fallback: 'missing-content' },
      { substantive_only: true }))
    // Defense-in-depth clause, tested non-vacuously: a (contract-violating)
    // fallback verdict with substantive:false must STILL never drop — the
    // fallback check cannot be absorbed by the substantive check.
    assert.isNull(significanceDropReason(
      { substantive: false, reasons: [], ignored: ['template-bag'], fallback: 'parse-error' },
      { substantive_only: true }))
    assert.isNull(significanceDropReason(null, { substantive_only: true }))
  })
})
```

Add `needsSignificanceCheck` and `significanceDropReason` to the test file's require of `../lib/edit-filters`.

**Step 3: Run to verify the expected failures**

```bash
npx mocha --colors --reporter spec 'test/edit-filters.test.js'
```
Expected: the four updated shape assertions FAIL (normalize doesn't emit the new keys yet) and the new describe block FAILS (`needsSignificanceCheck is not a function`). No other failures.

**Step 4: Implement in `lib/edit-filters.js`**

- `DEFAULTS`:
  ```javascript
  const DEFAULTS = { bots: true, minor: true, min_delta: 0, cosmetic_only: false, substantive_only: false, substantive_channels: null }
  ```
- In `normalizeEditFilters()`'s return object add:
  ```javascript
  substantive_only: filters.substantive_only === true || filters.substantive_only === 'log'
    ? filters.substantive_only : false,
  substantive_channels: filters.substantive_channels && typeof filters.substantive_channels === 'object'
    ? filters.substantive_channels : null
  ```
- Add beside `needsContentCheck()`:
  ```javascript
  /**
   * Does this consumer need the two-revision significance check?
   * 'log' and true both need classification; only true enforces.
   */
  function needsSignificanceCheck(filters) {
    return normalizeEditFilters(filters).substantive_only !== false
  }

  /**
   * Drop reason for a significance verdict, or null to keep the edit.
   * Conservative: missing verdict (classification failed upstream),
   * substantive verdicts, and fallback verdicts never drop; 'log' never drops.
   */
  function significanceDropReason(verdict, filters) {
    const f = normalizeEditFilters(filters)
    if (f.substantive_only !== true) return null
    if (!verdict || verdict.substantive || verdict.fallback) return null
    return `substantive_only: ${verdict.ignored.join(',') || 'no-change'}`
  }
  ```
- Extend `module.exports` with both helpers, and update the header comment's filter shape to `{ bots, minor, min_delta, cosmetic_only, substantive_only, substantive_channels }` with the three-state semantics.

**Step 5: Run the file's tests — all pass; then commit**

```bash
npx mocha --colors --reporter spec 'test/edit-filters.test.js'
git add lib/edit-filters.js test/edit-filters.test.js
git commit -m "$(cat <<'EOF'
feat: three-state substantive_only edit filter option

false (off, default) | 'log' (classify + log, never drop) | true (enforce).
Decision helpers are pure so the pipeline stage stays thin; conservative
bias: missing or fallback verdicts never drop.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 2: Revision-pair fetch helper

**Files:**
- Create: `lib/revision-pair.js`
- Create: `test/revision-pair.test.js`

**Step 1: Write the failing tests**

```javascript
const { describe, it, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')

const { fetchRevisionPair } = require('../lib/revision-pair')

const DIFF_URL = 'https://en.wikipedia.org/w/index.php?diff=200&oldid=100'

function apiReply(pages) {
  return { query: { pages } }
}

describe('revision-pair', function () {
  afterEach(function () { nock.cleanAll() })

  it('fetches both revisions in one batched request and returns texts + tags', async function () {
    nock('https://en.wikipedia.org')
      .get('/w/api.php')
      .query(q => q.revids === '100|200' && q.prop === 'revisions')
      .reply(200, apiReply([{
        pageid: 1, title: 'X', revisions: [
          { revid: 200, tags: ['mw-undo'], slots: { main: { content: 'new text' } } },
          { revid: 100, tags: [], slots: { main: { content: 'old text' } } }
        ]
      }]))
    const pair = await fetchRevisionPair(DIFF_URL)
    assert.equal(pair.prev, 'old text')
    assert.equal(pair.curr, 'new text')
    assert.deepEqual(pair.tags, ['mw-undo'])
  })

  it('returns null for an unparseable or prev-less diff URL without fetching', async function () {
    assert.isNull(await fetchRevisionPair('https://en.wikipedia.org/wiki/Whatever'))
    assert.isNull(await fetchRevisionPair('https://en.wikipedia.org/w/index.php?diff=200'))
  })

  it('returns null content for a revision the API withholds (revdeleted)', async function () {
    nock('https://en.wikipedia.org')
      .get('/w/api.php')
      .query(q => q.revids === '100|200')
      .reply(200, apiReply([{
        pageid: 1, title: 'X', revisions: [
          { revid: 200, tags: [], slots: { main: { content: 'new text' } } },
          { revid: 100, texthidden: true, tags: [], slots: { main: {} } }
        ]
      }]))
    const pair = await fetchRevisionPair(DIFF_URL)
    assert.isNull(pair.prev)
    assert.equal(pair.curr, 'new text')
  })
})
```

**Step 2: Run to verify failure** (`Cannot find module '../lib/revision-pair'`)

```bash
npx mocha --colors --reporter spec 'test/revision-pair.test.js'
```

**Step 3: Implement `lib/revision-pair.js`**

```javascript
/**
 * Fetch the wikitext of both sides of a diff URL, plus the new revision's
 * change tags, in one batched Action API request. Feeds
 * lib/edit-significance.js via lib/significance-stage.js; the stage owns
 * the conservative-pass policy (a throw here must not drop the edit).
 */
const { actionSession } = require('./mw-api')
const { parseDiffParams } = require('./compare-diff')

/**
 * @param {string} diffUrl  the edit's diff URL (edit.url)
 * @returns {Promise<{prev: string|null, curr: string|null, tags: string[]}|null>}
 *   null when the URL has no usable revision pair (new pages, odd URLs).
 */
async function fetchRevisionPair(diffUrl) {
  const parsed = parseDiffParams(diffUrl)
  if (!parsed || !parsed.fromrev || !parsed.torev) return null
  const session = await actionSession(parsed.host, 'edit-significance')
  const resp = await session.request({
    action: 'query', prop: 'revisions',
    revids: `${parsed.fromrev}|${parsed.torev}`,
    rvslots: 'main', rvprop: 'ids|content|tags',
    formatversion: 2
  })
  const byId = new Map()
  for (const page of resp.query?.pages || []) {
    for (const r of page.revisions || []) {
      byId.set(r.revid, r)
    }
  }
  const from = byId.get(parsed.fromrev)
  const to = byId.get(parsed.torev)
  return {
    prev: from?.slots?.main?.content ?? null,
    curr: to?.slots?.main?.content ?? null,
    tags: to?.tags || []
  }
}

module.exports = { fetchRevisionPair }
```

**Step 4: Run tests, commit**

```bash
npx mocha --colors --reporter spec 'test/revision-pair.test.js'
git add lib/revision-pair.js test/revision-pair.test.js
git commit -m "$(cat <<'EOF'
feat: batched revision-pair fetcher for the significance filter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 3: Significance stage module (conservative pass under test)

**Files:**
- Create: `lib/significance-stage.js`
- Create: `test/significance-stage.test.js`

**Step 1: Write the failing tests**

```javascript
const { describe, it } = require('mocha')
const { assert } = require('chai')

const { filterBySignificance } = require('../lib/significance-stage')

const EDIT = { page: 'Testville', url: 'https://en.wikipedia.org/w/index.php?diff=200&oldid=100' }
const PAIR = { prev: 'old text here.', curr: 'old text here. And new prose.', tags: [] }
const GNOME_PAIR = { prev: 'text {{a}}', curr: 'text {{b}}', tags: [] }

function consumer(name, filters) {
  // Mirrors the real consumer shape: subType carries the delivery type.
  return { type: 'delivery', subType: name, editFilters: filters }
}

function deps(overrides = {}) {
  const logs = []
  return {
    logs,
    fetchRevisionPair: async () => PAIR,
    log: line => logs.push(line),
    label: c => c.subType,
    ...overrides
  }
}

describe('significance-stage', function () {
  it('skips entirely (no fetch) when no consumer opts in', async function () {
    let fetched = false
    const d = deps({ fetchRevisionPair: async () => { fetched = true; return PAIR } })
    const consumers = [consumer('discord', { bots: false })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.deepEqual(kept, consumers)
    assert.isFalse(fetched)
    assert.lengthOf(d.logs, 0)
  })

  it('keeps everything and logs the verdict in log mode', async function () {
    const d = deps({ fetchRevisionPair: async () => GNOME_PAIR })
    const consumers = [consumer('discord', { substantive_only: 'log' })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.startsWith('substantive-verdict: Testville substantive=false')))
    assert.isFalse(d.logs.some(l => l.startsWith('filtered:')))
  })

  it('drops only enforcing consumers on a non-substantive verdict', async function () {
    const d = deps({ fetchRevisionPair: async () => GNOME_PAIR })
    const consumers = [
      consumer('discord', { substantive_only: true }),
      consumer('mastodon', { substantive_only: 'log' }),
      consumer('bluesky', null)
    ]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.deepEqual(kept.map(c => c.subType), ['mastodon', 'bluesky'])
    assert.isTrue(d.logs.some(l => l === 'filtered: Testville for discord (substantive_only: template-bag)'))
  })

  it('keeps every consumer on a substantive verdict', async function () {
    const d = deps()
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.includes('substantive=true')))
  })

  it('CONSERVATIVE PASS: keeps every consumer when the fetch throws', async function () {
    const d = deps({ fetchRevisionPair: async () => { throw new Error('network down') } })
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.includes('classification failed, passing')))
  })

  it('CONSERVATIVE PASS: keeps every consumer when the pair is unavailable (null)', async function () {
    const d = deps({ fetchRevisionPair: async () => null })
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
  })

  it('CONSERVATIVE PASS: fallback verdicts (revdeleted content) never drop', async function () {
    const d = deps({ fetchRevisionPair: async () => ({ prev: null, curr: 'x', tags: [] }) })
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.includes('fallback=missing-content')))
  })

  it('takes channel overrides only from consumers that opted in', async function () {
    const d = deps({ fetchRevisionPair: async () => GNOME_PAIR })
    const consumers = [
      // not opted in — its channels must NOT apply
      consumer('bluesky', { substantive_channels: { 'template-bag': 'substantive' } }),
      consumer('discord', { substantive_only: true })
    ]
    const kept = await filterBySignificance(EDIT, consumers, d)
    // With default channels the gnome pair is non-substantive → discord drops.
    assert.deepEqual(kept.map(c => c.subType), ['bluesky'])
  })

  it('logs the new revision tags as annotation', async function () {
    const d = deps({ fetchRevisionPair: async () => ({ ...PAIR, tags: ['mw-undo'] }) })
    await filterBySignificance(EDIT, [consumer('discord', { substantive_only: 'log' })], d)
    assert.isTrue(d.logs.some(l => l.includes('tags=[mw-undo]')))
  })
})
```

**Step 2: Run to verify failure** (`Cannot find module '../lib/significance-stage'`)

**Step 3: Implement `lib/significance-stage.js`**

```javascript
/**
 * The significance filter stage: classify "did this edit change what a
 * reader sees?" once per edit, apply the verdict per consumer.
 *
 * Dependencies (fetch, classify, log) are injected so the conservative-pass
 * invariant — ANY failure keeps every consumer — is enforced by unit tests,
 * not by hope. page-watch.js supplies the real ones.
 */
const { needsSignificanceCheck, significanceDropReason, normalizeEditFilters } = require('./edit-filters')
const { classifyEdit } = require('./edit-significance')
const { fetchRevisionPair } = require('./revision-pair')

/**
 * @param {object} edit  the edit object (needs .page and .url)
 * @param {Array} consumers  consumers with .editFilters
 * @param {object} [deps]  injectable for tests:
 *   fetchRevisionPair(diffUrl), classify(prev, curr, opts), log(line), label(consumer)
 * @returns {Promise<Array>} the consumers to keep
 */
async function filterBySignificance(edit, consumers, deps = {}) {
  const fetch = deps.fetchRevisionPair || fetchRevisionPair
  const classify = deps.classify || classifyEdit
  const log = deps.log || console.log
  // Real consumers carry subType ('discord'|'mastodon'|...); page-watch
  // injects its richer consumerLabel, so this is only a fallback.
  const label = deps.label || (c => c.subType || c.type || 'consumer')

  const optedIn = consumers.filter(c => needsSignificanceCheck(c.editFilters))
  if (optedIn.length === 0) return consumers

  let verdict = null
  try {
    const pair = await fetch(edit.url)
    if (pair) {
      // Channel overrides come only from opted-in consumers; the live config
      // gives all deliveries one policy, so first-match is deliberate.
      const channels = optedIn
        .map(c => normalizeEditFilters(c.editFilters).substantive_channels)
        .find(Boolean) || undefined
      verdict = classify(pair.prev, pair.curr, { channels })
      log(`substantive-verdict: ${edit.page} substantive=${verdict.substantive}` +
        ` reasons=[${verdict.reasons.join(',')}] ignored=[${verdict.ignored.join(',')}]` +
        (verdict.fallback ? ` fallback=${verdict.fallback}` : '') +
        (pair.tags && pair.tags.length ? ` tags=[${pair.tags.join(',')}]` : ''))
    }
  } catch (err) {
    log(`substantive-verdict: ${edit.page} classification failed, passing (${err.message})`)
    verdict = null
  }

  const kept = []
  for (const consumer of consumers) {
    const reason = significanceDropReason(verdict, consumer.editFilters)
    if (reason) {
      log(`filtered: ${edit.page} for ${label(consumer)} (${reason})`)
    } else {
      kept.push(consumer)
    }
  }
  return kept
}

module.exports = { filterBySignificance }
```

**Step 4: Run the new tests, then the full suite; commit**

```bash
npx mocha --colors --reporter spec 'test/significance-stage.test.js'
SFEDITS_REQUIRE_DB=1 npm test
git add lib/significance-stage.js test/significance-stage.test.js
git commit -m "$(cat <<'EOF'
feat: significance stage module with tested conservative-pass

Fetch/classify/log are injected so unit tests enforce the invariant that
any classification failure keeps every consumer.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 4: Wire the stage into page-watch.js

**Files:**
- Modify: `page-watch.js` (inside `sendStatus()`)

**Step 1: Add the require** — merge into the existing top-of-file requires:

```javascript
const { filterBySignificance } = require('./lib/significance-stage')
```

**Step 2: Insert the stage after the metadata filter block and BEFORE the `--noop` early return.** Anchor: the metadata stage that builds `metadataFiltered` (logs `filtered: … (${metadataDropReason(…)})`), followed by `if (argv.noop) { …; return null }`. Between them insert:

```javascript
  // SIGNIFICANCE STAGE: classify "did this edit change what a reader sees?"
  // once per edit if any consumer opted in ('log' or true). Runs before the
  // --noop return (verdicts observable in no-post runs) and before the diff
  // fetch (dropped edits skip diff/image work). Conservative pass on any
  // failure — see lib/significance-stage.js tests.
  const consumersAfterSignificance = await filterBySignificance(edit, metadataFiltered, {
    label: consumerLabel
  })
```

**Step 3: Repoint every downstream reader of `metadataFiltered`.** After the insertion the chain reads metadata → significance → (noop return) → content; `metadataFiltered` must be consumed by the significance stage ONLY. Three repoints:

- **The `--noop` block** (currently loops `metadataFiltered` to print `filter-pass:` lines and return): iterate `consumersAfterSignificance` instead, and rewrite its comment ("Noop stops before the diff fetch, so metadata survivors are final here") to describe the new reality — significance-filtered survivors are final in noop mode. Without this, a noop run with an enforcing consumer logs both `filtered:` and `filter-pass:` for the same consumer, breaking the documented one-`filter-pass`-per-delivered-consumer invariant.
- The `anyNeedsContentCheck` computation and the content-stage loop over consumers: `metadataFiltered` → `consumersAfterSignificance`.
- Any early return on an empty consumer set between the two stages must consider `consumersAfterSignificance`.

The four downstream reads of `consumersAfterContent` (the `filter-pass:` log, the empty-set early return, the config delivery loop at ~:332, the subscription fan-out at ~:393) **stay untouched** — `consumersAfterContent` now derives from the significance-filtered set, so both delivery paths and the logging invariant (each delivered consumer logs `filter-pass:` exactly once) inherit the filter automatically. Verify with:

```bash
grep -n "metadataFiltered\|consumersAfterContent\|consumersAfterSignificance" page-watch.js
```
Expected: `metadataFiltered` is consumed only by the significance stage; the content stage consumes `consumersAfterSignificance`; all four downstream reads still reference `consumersAfterContent`.

**Step 4: Verify against the live stream without posting.** Set up the local `config.json` overlay (CLAUDE.md "Commands": `topic_store` at the :3307 test container, `test:db:start` up, `scripts/migrate.js` run) and add `"substantive_only": "log"` to a `deliveries` overlay mirroring `config.base.json`'s. Then:

```bash
node page-watch.js --noop --verbose
```
Let it run over live edits until a watchlist article is edited. Expected: `substantive-verdict:` lines appear (the stage now runs before the noop return); no `filtered: … (substantive_only…)` lines (log mode never drops); no crash. Ctrl-C and revert the overlay change.

**Step 5: Full suite, then commit**

```bash
SFEDITS_REQUIRE_DB=1 npm test
git add page-watch.js
git commit -m "$(cat <<'EOF'
feat: significance filter stage in the delivery pipeline

Runs after metadata filters and before the noop return and diff fetch, so
no-post runs show verdicts and dropped edits skip image work. Both the
config-delivery and topic-subscription paths inherit the filtered set.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

**Phase 3 done when:** full suite green (`SFEDITS_REQUIRE_DB=1 npm test`); the `--noop` live-stream run shows `substantive-verdict:` lines; the grep in Task 4 Step 3 shows the expected consumer-list chain; all four commits exist. **Do not merge to `integration` or push anything yet** — that is Phase 4's gated step.
