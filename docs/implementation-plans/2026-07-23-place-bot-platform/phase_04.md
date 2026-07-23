# Place-Bot Platform Implementation Plan — Phase 4: Bot Wiring and Fan-out

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** The running bot matches edits against the topic store and fans one edit out to many subscriptions, rendering the diff exactly once — without disturbing the existing SFBA account.

**Architecture:** A new `lib/topic-index.js` holds the in-RAM index, refreshing it when the store's generation changes. `page-watch.js`'s `inspect()` gains a topic-matching branch alongside the existing `isWatched()` branch, and `sendStatus()` grows a `deliveries` list that it posts to after its single render.

**Tech Stack:** Node 20+, mocha/chai/nock/proxyquire, MariaDB.

**Scope:** Phase 4 of 5 (Plan A).

**Codebase verified:** 2026-07-23 04:27 PDT, branch `place-bot-platform`.

---

## Context the executing engineer needs

**This phase edits the live posting path. The governing constraint is Definition of Done #10 from the design plan: the existing SFBA bot must keep working with no loss of behavior.** Rich Discord embeds, the revdel sweeper, and the Wikidata claim watch are fork-only features with no upstream equivalent, and they are the regression test for whether generalization broke something. `test/posting.test.js` and `test/watchlist-sync.test.js` staying green is not a formality here.

**Verified code, with exact anchors:**

- `page-watch.js:338-438` — `sendStatus(account, statusData, edit)`. Structure (anchors re-derived by grep; trust the quoted text over the numbers if they ever disagree):
  - `:344` `fetchDiffHtml(edit.url)` — fetches the diff HTML once
  - `:348` `verifyDiffPage(diffHtml, edit.page)`
  - `:355` `screenForPII(...)` (disabled in this fork's config, but the call stays)
  - `:363` `enrichIPsInText(statusData.text)`
  - `:366` `captureDiffImage(edit.url, edit.page)` — **the single render**
  - `:375` `const metadata = {`
  - `:389` `if (account.bluesky)`, `:401` `if (account.mastodon)`, `:413` `if (account.discord)` — all keyed on `account.*`
  - `:425` `recordPost(...)` for the revdel sweeper, `:427` `writeHeartbeat('post')`
  - `:428` the `finally` that always unlinks the screenshot
- `page-watch.js:440-461` — `inspect(account, edit)`. `:442-449` diverts Wikidata edits to the claim watcher; `:452` calls `isWatched(account, edit)`; `:453` builds status; `:455` calls `sendStatus`.
- `page-watch.js:499-501` — the per-edit loop already iterates **all** accounts. Fan-out sits inside one account's inspect, so this loop is unchanged.
- `page-watch.js:478` — `await startWatchlistSync(config, { dataDir: HEARTBEAT_DIR })` in `main()`. The topic index starts here too.
- `lib/watchlist-sync.js:209-215` — `isWatched(account, edit)` returns a boolean from `account.watchlist` (static) or `account.dynamicWatchlist` (PageAssessments). **This stays exactly as it is.** Per the design plan, PageAssessments is retained for continuity because the SFBA bot depends on it; the topic path runs alongside, not instead.

**Deliberate divergence from the design plan.** The design names `lib/watchlist-sync.js` as the home of `topicsForEdit(edit) → topicId[]`. This plan puts it in a new `lib/topic-index.js` instead, because `watchlist-sync.js` is the PageAssessments path the SFBA bot runs on, and Definition of Done #10 says that path must not change. Keeping the two in separate modules means the legacy file is untouched by this phase, so a regression there can only come from `page-watch.js` — a much smaller surface to audit. The design's contract is otherwise honored exactly: same function name, same signature, same return shape.

**Design decision for this phase:** the topic path is **additive**. `inspect()` checks the legacy watchlist and the topic index independently, and an edit matching both renders once and delivers to both. That keeps the SFBA account bit-identical while the new path is exercised, which is what makes this phase safe to deploy before Phase 5 is finished.

---

## Task 1: The refreshing topic index

**Files:**
- Create: `lib/topic-index.js`
- Create: `test/topic-index.test.js`

**Step 1: Write the failing test**

Create `test/topic-index.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, before, beforeEach, after } = require('mocha')

const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const { createTopicStore } = require('../lib/topic-store')
const { createTopicIndex } = require('../lib/topic-index')

describeWithDb('topic-index', function() {
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

  async function seedTopic(titles) {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })
    await store.addSubscription(topic.id, {
      ownerUser: 'Tester',
      deliveryType: 'discord',
      deliveryConfig: { webhook_url: 'https://discord.test/hook' }
    })
    await store.setTopicArticles(topic.id, titles.map((title, i) => ({
      qid: `Q${100 + i}`, wikipedia: 'en', title, source: 'admin'
    })))
    return topic
  }

  it('matches a watched title to its topic', async function() {
    const topic = await seedTopic(['Alpha', 'Beta'])
    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(
      index.topicsForEdit({ wikipedia: 'en', page: 'Alpha' }), [topic.id])
  })

  it('returns an empty array for an unwatched title', async function() {
    await seedTopic(['Alpha'])
    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(index.topicsForEdit({ wikipedia: 'en', page: 'Unwatched' }), [])
    assert.deepEqual(index.topicsForEdit({ wikipedia: 'es', page: 'Alpha' }), [])
  })

  it('returns every topic watching a shared title', async function() {
    const a = await store.upsertTopic('Q62', { languages: ['en'] })
    const b = await store.upsertTopic('Q62', { languages: ['en', 'es'] })
    for (const topic of [a, b]) {
      await store.addSubscription(topic.id, {
        ownerUser: 'T', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://x' }
      })
      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Shared', source: 'admin' }
      ])
    }

    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(
      index.topicsForEdit({ wikipedia: 'en', page: 'Shared' }).sort(),
      [a.id, b.id].sort())
  })

  it('matches before any refresh has happened without throwing', function() {
    const index = createTopicIndex(store)
    assert.deepEqual(index.topicsForEdit({ wikipedia: 'en', page: 'Alpha' }), [])
  })

  it('picks up new articles on refresh', async function() {
    const topic = await seedTopic(['Alpha'])
    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(index.topicsForEdit({ wikipedia: 'en', page: 'Gamma' }), [])

    await store.setTopicArticles(topic.id, [
      { qid: 'Q100', wikipedia: 'en', title: 'Alpha', source: 'admin' },
      { qid: 'Q200', wikipedia: 'en', title: 'Gamma', source: 'admin' }
    ])
    await index.refresh()

    assert.deepEqual(index.topicsForEdit({ wikipedia: 'en', page: 'Gamma' }), [topic.id])
  })

  it('skips the rebuild when the generation has not moved', async function() {
    await seedTopic(['Alpha'])
    const index = createTopicIndex(store)

    await index.refresh()
    const first = index.stats()

    const result = await index.refresh()

    assert.isFalse(result.rebuilt, 'nothing changed, so no rebuild')
    assert.equal(index.stats().refreshedAt, first.refreshedAt)
  })

  it('keeps serving the old index when a refresh fails', async function() {
    const topic = await seedTopic(['Alpha'])
    const index = createTopicIndex(store)
    await index.refresh()

    const broken = createTopicIndex({
      getWatchIndex: async () => { throw new Error('database down') }
    })
    // seed the broken index from a working one, then fail a refresh
    broken._setIndexForTest(index._indexForTest())

    const result = await broken.refresh()

    assert.isFalse(result.ok)
    assert.deepEqual(
      broken.topicsForEdit({ wikipedia: 'en', page: 'Alpha' }), [topic.id],
      'a database blip must not silently empty the watchlist')
  })

  it('excludes topics that have no active subscription', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })
    await store.setTopicArticles(topic.id, [
      { qid: 'Q10', wikipedia: 'en', title: 'Orphan', source: 'admin' }
    ])

    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(index.topicsForEdit({ wikipedia: 'en', page: 'Orphan' }), [],
      'nobody is subscribed, so there is nothing to deliver')
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm run test:db:start
npx mocha --colors --reporter spec --exit test/topic-index.test.js
```
Expected: FAIL — `Cannot find module '../lib/topic-index'`

**Step 3: Write the implementation**

Create `lib/topic-index.js`:

```javascript
/**
 * The in-RAM index the bot's hot path matches against.
 *
 * The store is the source of truth, but no edit ever queries it: at ~10 edits
 * a second across the feed, a per-edit round trip would be both slow and
 * rude to ToolsDB. Instead the index is loaded once and reloaded when the
 * store's generation moves, so matching stays the same two hash lookups the
 * bot has always done against a static watchlist.
 *
 * A failed refresh keeps the previous index. A database blip should degrade to
 * "slightly stale" rather than to "silently watching nothing" - the same
 * reasoning behind the disk-cache fallback in lib/watchlist-sync.js.
 */

const DEFAULT_REFRESH_SECONDS = 60

function createTopicIndex(store, options = {}) {
  const { refreshSeconds = DEFAULT_REFRESH_SECONDS } = options

  let index = { byWiki: new Map(), generation: null, topicCount: 0, titleCount: 0 }
  let refreshedAt = null

  /**
   * Reload if the store's generation has moved.
   * @returns {Promise<{ok: boolean, rebuilt: boolean, error?: string}>}
   */
  async function refresh() {
    try {
      const next = await store.getWatchIndex({ requireSubscription: true })

      if (index.generation !== null && next.generation === index.generation) {
        return { ok: true, rebuilt: false }
      }

      index = next
      refreshedAt = Date.now()
      return { ok: true, rebuilt: true }
    } catch (error) {
      console.error('Topic index refresh failed (keeping previous index):', error.message)
      return { ok: false, rebuilt: false, error: error.message }
    }
  }

  /**
   * Which topics watch this edit's page.
   *
   * @param {Object} edit - needs .wikipedia and .page
   * @returns {number[]} topic ids, empty when unwatched
   */
  function topicsForEdit(edit) {
    const titles = index.byWiki.get(edit.wikipedia)
    if (!titles) return []
    const topicIds = titles.get(edit.page)
    return topicIds ? Array.from(topicIds) : []
  }

  function stats() {
    return {
      generation: index.generation,
      topicCount: index.topicCount,
      titleCount: index.titleCount,
      refreshedAt
    }
  }

  /** Start periodic refreshes. Returns the timer so callers can clear it. */
  function start() {
    const timer = setInterval(() => {
      refresh().catch(error =>
        console.error('Topic index refresh error:', error.message))
    }, refreshSeconds * 1000)
    timer.unref()
    return timer
  }

  return {
    refresh,
    topicsForEdit,
    stats,
    start,
    // Test seams: let a test install a known index without a database.
    _indexForTest: () => index,
    _setIndexForTest: (value) => { index = value }
  }
}

module.exports = { createTopicIndex, DEFAULT_REFRESH_SECONDS }
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/topic-index.test.js
```
Expected: PASS, 0 failing — every test in this file green

**Step 5: Commit**

```bash
git add lib/topic-index.js test/topic-index.test.js
git commit -m "feat: in-RAM topic index with generation-gated refresh

Hot-path matching stays two hash lookups. A failed refresh keeps the
previous index rather than degrading to watching nothing."
```

---

## Task 2: Fan-out in the posting path

**Files:**
- Modify: `page-watch.js:338-438` (`sendStatus` — accept and deliver to a `deliveries` list)
- Modify: `page-watch.js:440-461` (`inspect` — match topics and assemble deliveries)
- Modify: `page-watch.js` requires block and `main()`
- Create: `lib/subscription-delivery.js`
- Create: `test/fan-out.test.js`

**Step 1: Write the delivery dispatcher**

Create `lib/subscription-delivery.js`. In this phase it handles Discord only; Phase 5 hardens it with rate caps and broken-subscription marking, and Phase 8 adds the other platforms.

```javascript
/**
 * Deliver one already-rendered post to one subscription.
 *
 * The render happens once per edit, upstream of this. That is the entire
 * operational payoff of deduplicating on topic: 500 people subscribed to the
 * Mission means one diff render and 500 cheap posts, not 500 renders.
 *
 * Phase 4 supports Discord webhooks only, which need no OAuth plumbing - just
 * a POST to a URL the subscriber pasted in.
 */

const discord = require('./discord-platform')

/**
 * @param {Object} subscription - from store.subscriptionsForTopic()
 * @param {Object} payload
 * @param {string} payload.text
 * @param {string} payload.screenshot - path to the rendered PNG
 * @param {Object} payload.metadata
 * @returns {Promise<{ok: boolean, subscriptionId: number, messageId?: string, error?: string}>}
 */
async function deliver(subscription, payload) {
  if (subscription.deliveryType !== 'discord') {
    return {
      ok: false,
      subscriptionId: subscription.id,
      error: `unsupported delivery type "${subscription.deliveryType}"`
    }
  }

  const webhookUrl = subscription.deliveryConfig?.webhook_url
  if (!webhookUrl) {
    return {
      ok: false,
      subscriptionId: subscription.id,
      error: 'subscription has no webhook_url'
    }
  }

  try {
    const result = await discord.post({
      account: { webhook_url: webhookUrl },
      text: payload.text,
      screenshot: payload.screenshot,
      metadata: payload.metadata
    })
    return { ok: true, subscriptionId: subscription.id, messageId: result?.id || null }
  } catch (error) {
    return { ok: false, subscriptionId: subscription.id, error: error.message }
  }
}

/**
 * Deliver to every subscription. One failure never blocks the others - a dead
 * webhook belonging to one subscriber must not silence everyone else's bot.
 *
 * @returns {Promise<Array>} one result per subscription
 */
async function deliverAll(subscriptions, payload) {
  const results = []
  for (const subscription of subscriptions) {
    results.push(await deliver(subscription, payload))
  }
  return results
}

module.exports = { deliver, deliverAll }
```

**Step 2: Write the failing test**

Create `test/fan-out.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const fs = require('fs')
const os = require('os')
const path = require('path')
const nock = require('nock')
const proxyquire = require('proxyquire')

describe('fan-out', function() {
  this.timeout(5000)

  let screenshotPath
  let renderCount

  beforeEach(function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-test-'))
    screenshotPath = path.join(dir, 'diff.png')
    fs.writeFileSync(screenshotPath, 'fake png bytes')
    renderCount = 0
  })

  afterEach(function() {
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath)
    nock.cleanAll()
  })

  /**
   * page-watch with its heavy dependencies stubbed out, following the
   * proxyquire pattern already used in test/posting.test.js:253-267.
   */
  function loadPageWatch() {
    return proxyquire('../page-watch', {
      './lib/diff-image': {
        captureDiffImage: async () => {
          renderCount++
          // summary must be an object or null, never a string: the embed
          // builder does summary.sentence.charAt(0) at
          // lib/discord-platform.js:187, and a truthy string sends every
          // delivery through that path with sentence undefined.
          return { screenshot: screenshotPath, altText: 'alt', summary: null, article: null }
        }
      },
      './lib/geolocation': {
        initializeReader: async () => null,
        enrichIPsInText: async (text) => text
      },
      './lib/post-log': { recordPost: () => null }
    })
  }

  function subscription(id, path) {
    return {
      id,
      topicId: 1,
      ownerUser: `user${id}`,
      deliveryType: 'discord',
      deliveryConfig: { webhook_url: `https://discord.com${path}` },
      status: 'active'
    }
  }

  it('renders once and delivers to every subscription', async function() {
    // THE test for this phase. It must drive sendStatus end to end - calling
    // deliverToTopics directly would never invoke the renderer, so the
    // "one render" half of the assertion would be vacuously true.
    // Real Discord hosts, distinguished by path. Phase 5 adds a host allowlist
    // to lib/subscription-delivery.js; fixtures on invented hosts would start
    // failing there, in a file this phase owns.
    const paths = ['/api/webhooks/1/aaa', '/api/webhooks/2/bbb', '/api/webhooks/3/ccc']
    const scopes = paths.map(p =>
      nock('https://discord.com').post(p).query(true).reply(200, { id: '1' }))

    const pageWatch = loadPageWatch()

    // Page-verification fetch that sendStatus does before rendering.
    nock('https://en.wikipedia.org')
      .get('/w/index.php')
      .query(true)
      .reply(200, '<script>RLCONF={"wgPageName":"Alpha"};</script>')

    const stubStore = {
      subscriptionsForTopic: async (topicId) => ({
        1: [subscription(1, paths[0]), subscription(2, paths[1])],
        2: [subscription(3, paths[2])]
      })[topicId] || []
    }
    pageWatch._setTopicStateForTest(stubStore, null)

    const edit = {
      wikipedia: 'en',
      page: 'Alpha',
      user: 'Editor',
      url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
    }
    const statusData = pageWatch.getStatus(edit, edit.user, '{{page}} edited')

    // pii_blocking must be present and disabled - matching this fork's real
    // config. With no stanza at all, screenForPII cannot extract diff text from
    // the fixture and blocks the post at page-watch.js:355, returning BEFORE
    // captureDiffImage at :366. The render would never happen and the
    // assertion below would fail for the wrong reason.
    const account = { pii_blocking: { enabled: false } }

    await pageWatch.sendStatus(account, statusData, edit, [1, 2])

    assert.equal(renderCount, 1,
      'the diff must be rendered exactly once no matter how many subscribers')
    scopes.forEach((scope, i) =>
      assert.isTrue(scope.isDone(), `webhook ${i} did not receive the post`))
  })

  it('renders nothing when no topic matched and no account platform is set',
    async function() {
      const pageWatch = loadPageWatch()
      pageWatch._setTopicStateForTest({ subscriptionsForTopic: async () => [] }, null)

      nock('https://en.wikipedia.org')
        .get('/w/index.php').query(true)
        .reply(200, '<script>RLCONF={"wgPageName":"Alpha"};</script>')

      const edit = {
        wikipedia: 'en', page: 'Alpha', user: 'Editor',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
      }
      const account = { pii_blocking: { enabled: false } }
      await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'),
        edit, [])

      assert.equal(renderCount, 1,
        'sendStatus renders before it knows about deliveries; that cost is why ' +
        'inspect() must not call it when nothing matched')
    })

  it('keeps delivering after one subscription fails', async function() {
    nock('https://discord.com').post('/api/webhooks/9/dead').query(true).reply(500, 'gone')
    const live = nock('https://discord.com')
      .post('/api/webhooks/9/live').query(true).reply(200, { id: '2' })

    const { deliverAll } = require('../lib/subscription-delivery')

    const results = await deliverAll(
      [subscription(1, '/api/webhooks/9/dead'), subscription(2, '/api/webhooks/9/live')],
      { text: 'x', screenshot: screenshotPath, metadata: { page: 'Alpha' } })

    assert.isFalse(results[0].ok)
    assert.isTrue(results[1].ok)
    assert.isTrue(live.isDone(), 'a dead webhook must not silence the next subscriber')
  })

  it('rejects a subscription with no webhook url without throwing', async function() {
    const { deliver } = require('../lib/subscription-delivery')

    const result = await deliver(
      { id: 9, deliveryType: 'discord', deliveryConfig: {} },
      { text: 'x', screenshot: screenshotPath, metadata: {} })

    assert.isFalse(result.ok)
    assert.include(result.error, 'webhook_url')
  })

  it('rejects an unsupported delivery type without throwing', async function() {
    const { deliver } = require('../lib/subscription-delivery')

    const result = await deliver(
      { id: 9, deliveryType: 'carrier-pigeon', deliveryConfig: {} },
      { text: 'x', screenshot: screenshotPath, metadata: {} })

    assert.isFalse(result.ok)
    assert.include(result.error, 'carrier-pigeon')
  })
})
```

**Step 3: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/fan-out.test.js
```
Expected: FAIL — `pageWatch._setTopicStateForTest is not a function` (the seam is added in Step 4h)

**Step 4: Modify `page-watch.js`**

**4a — add requires.** `page-watch.js:17` currently reads:

```javascript
const { startWatchlistSync, isWatched } = require('./lib/watchlist-sync')
```

Add immediately after it:

```javascript
const { createTopicStore } = require('./lib/topic-store')
const { createTopicIndex } = require('./lib/topic-index')
const { deliverAll } = require('./lib/subscription-delivery')
```

**4b — add module-level handles.** Below the requires block, alongside the other module-level state, add:

```javascript
// Topic store and index are null until main() starts them; the bot runs
// without a topic_store stanza exactly as it did before this phase.
let topicStore = null
let topicIndex = null
```

**4c — add the fan-out helper.** Insert this immediately **before** `async function sendStatus(...)` at `page-watch.js:338`:

```javascript
/**
 * Deliver an already-rendered post to every subscription of every matched
 * topic. The render happened once, upstream; this is the cheap part.
 *
 * Exported for testing.
 */
async function deliverToTopics({ topicStore: store, topicIds }, payload) {
  if (!store || topicIds.length === 0) return []

  const results = []
  for (const topicId of topicIds) {
    let subscriptions
    try {
      subscriptions = await store.subscriptionsForTopic(topicId)
    } catch (error) {
      console.error(`Could not load subscriptions for topic ${topicId}:`, error.message)
      continue
    }

    const delivered = await deliverAll(subscriptions, payload)
    for (const result of delivered) {
      if (!result.ok) {
        console.error(
          `Subscription ${result.subscriptionId} delivery failed: ${result.error}`)
      }
    }
    results.push(...delivered)
  }
  return results
}
```

**4d — give `sendStatus` a topic list.** Change its signature at `page-watch.js:338` from:

```javascript
async function sendStatus(account, statusData, edit) {
```

to:

```javascript
async function sendStatus(account, statusData, edit, topicIds = []) {
```

**4e — fan out after the existing platform posts.** The Discord block opens at `page-watch.js:413` (`if (account.discord) {`) and the `recordPost(...)` call is at `:425`. Insert the fan-out **between** them.

Anchor on the text, not the line number: find the closing brace of the `if (account.discord) { ... }` block, and insert immediately before the `// Record what was posted so the revdel sweeper can delete these` comment.

```javascript
        // Fan out to topic subscriptions, reusing the single render above.
        // Delivery failures are logged per subscription and never abort the
        // account-level posts that already succeeded.
        await deliverToTopics({ topicStore, topicIds }, {
          text: enrichedText,
          screenshot,
          metadata
        })
```

This placement matters: it is inside the `try` whose `finally` at `:428-432` unlinks the screenshot, so the file still exists while subscriptions are being delivered to, and is still cleaned up afterwards.

**4f — match topics in `inspect`.** Replace the body of the `if (edit.url)` block at `page-watch.js:451-459`:

```javascript
  if (edit.url) {
    if (isWatched(account, edit)) {
      const statusData = getStatus(edit, edit.user, account.template)
      try {
        await sendStatus(account, statusData, edit)
      } catch (error) {
        console.error('Failed to process edit:', edit.page, error.message)
      }
    }
  }
```

with:

```javascript
  if (edit.url) {
    // Two independent membership sources. The legacy PageAssessments
    // watchlist is what the SFBA bot runs on and is deliberately left
    // untouched; the topic index is the new platform path. An edit matching
    // both is rendered once and delivered to both.
    const watched = isWatched(account, edit)
    const topicIds = topicIndex ? topicIndex.topicsForEdit(edit) : []

    if (watched || topicIds.length > 0) {
      const statusData = getStatus(edit, edit.user, account.template)
      try {
        await sendStatus(account, statusData, edit, topicIds)
      } catch (error) {
        console.error('Failed to process edit:', edit.page, error.message)
      }
    }
  }
```

**4g — start the store in `main()`.** `page-watch.js:478` currently reads:

```javascript
  // Fetch dynamic article lists (WikiProject task forces) before listening
  await startWatchlistSync(config, { dataDir: HEARTBEAT_DIR })
```

Insert immediately after it:

```javascript
  // Topic store: optional. Without a topic_store stanza the bot behaves
  // exactly as it did before the platform work, running on the account
  // watchlists alone.
  if (config.topic_store) {
    topicStore = createTopicStore({ config: config.topic_store })
    topicIndex = createTopicIndex(topicStore)
    const loaded = await topicIndex.refresh()
    if (loaded.ok) {
      const stats = topicIndex.stats()
      console.log(
        `Topic index: ${stats.titleCount} titles across ${stats.topicCount} topics`)
      topicIndex.start()
    } else {
      console.error('Topic index unavailable at startup; account watchlists still active')
    }
  }
```

**4h — export the test seams.** At the end of `page-watch.js`, the module currently exports its helpers for tests. Add `deliverToTopics` and a store accessor to that export block:

```javascript
module.exports.deliverToTopics = deliverToTopics
module.exports._setTopicStateForTest = (store, index) => {
  topicStore = store
  topicIndex = index
}
```

`page-watch.js` already has a `module.exports = { ... }` block at `:524`. Add the three lines above immediately after it, at the end of the file.

**Step 5: Run tests**

Run:
```bash
npx mocha --colors --reporter spec --exit test/fan-out.test.js
```
Expected: PASS, 0 failing — every test in this file green

Then the regression check that matters most:

```bash
npx mocha --colors --reporter spec --exit test/posting.test.js test/watchlist-sync.test.js test/discord-platform.test.js
```
Expected: PASS, unchanged counts. If `test/posting.test.js` fails, the `sendStatus` signature change or the fan-out insertion point broke the existing path — fix it before continuing rather than adjusting the test.

Then:
```bash
npm test
```
Expected: the Phase 3 total plus every test written in this phase, 0 failing

**Step 6: Commit**

```bash
git add page-watch.js lib/subscription-delivery.js test/fan-out.test.js
git commit -m "feat: fan one edit out to topic subscriptions

sendStatus takes a topic list and delivers to each topic's subscriptions
after its single render. The legacy PageAssessments path is untouched and
runs alongside; an edit matching both renders once."
```

---

## Task 3: Config stanza and no-op safety

**Files:**
- Modify: `test/config.test.js` (append cases)
- Create: `docs/config-topic-store.md`

**Step 1: Write the failing test**

Append to `test/config.test.js`, inside its top-level describe:

```javascript
  it('passes a topic_store stanza through untouched', function() {
    const config = loadConfig({
      env: {
        SFEDITS_CONFIG: JSON.stringify({
          accounts: [],
          topic_store: {
            host: 'tools.db.svc.wikimedia.cloud',
            database: 's51234__sfedits'
          }
        })
      }
    })

    assert.equal(config.topic_store.database, 's51234__sfedits')
  })

  it('loads a config with no topic_store stanza', function() {
    const config = loadConfig({
      env: { SFEDITS_CONFIG: JSON.stringify({ accounts: [] }) }
    })

    assert.isUndefined(config.topic_store)
  })
```

**Step 2: Run test**

Run:
```bash
npx mocha --colors --reporter spec --exit test/config.test.js
```
Expected: PASS immediately — `lib/config.js` does no validation, so it already passes unknown stanzas through. These tests exist to **pin** that behavior, so a future validator cannot silently drop the stanza.

**Step 3: Document the stanza**

Create `docs/config-topic-store.md`:

```markdown
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
```

**Step 4: Verify the bot still starts without the stanza**

Run:
```bash
SFEDITS_CONFIG='{"accounts":[{"template":"{{page}} edited"}]}' timeout 10 node page-watch.js --noop --verbose 2>&1 | head -20
```
Expected: the bot starts and streams edits. No topic-store errors, no "Topic index" line. Exits on the timeout, which is the intended way to end this check.

Then with a stanza pointed at the test container (write it to a temp file first if quoting gets awkward):

```bash
npm run test:db:start
SFEDITS_CONFIG='{"accounts":[{"template":"{{page}} edited"}],"topic_store":{"host":"127.0.0.1","port":3307,"database":"sfedits_test","user":"root","password":"sfedits-test"}}' timeout 10 node page-watch.js --noop --verbose 2>&1 | head -20
```
Expected: a `Topic index: N titles across M topics` line (0 and 0 on an empty database is correct), then edits streaming.

**Step 5: Commit**

```bash
git add test/config.test.js docs/config-topic-store.md
git commit -m "docs: topic_store configuration, and pin pass-through in tests

The config loader has no validation layer, so these tests exist to keep a
future one from silently dropping the stanza."
```

---

## Phase 4 Done When

- `npm test` is green with no pre-existing test failing, and `test/posting.test.js`, `test/watchlist-sync.test.js`, and `test/discord-platform.test.js` report exactly the counts they reported at the Phase 1 baseline — the SFBA regression surface.
- One simulated edit matching two topics with three total subscriptions produces **one** render and **three** deliveries, asserted through `sendStatus` rather than by calling `deliverToTopics` directly (which would never invoke the renderer and make the assertion vacuous).
- A dead webhook on one subscription does not prevent delivery to the others, and does not abort the account-level posts.
- The bot starts and runs normally with no `topic_store` stanza.
- With a stanza, the startup log reports the index size, and the index reloads when a rebuild bumps a generation.

**Manual verification against live data before Phase 5:**

Seed one topic pointing at a page that gets edited often, subscribe a throwaway Discord webhook, and run the bot in `--noop`:

```bash
npm run test:db:start
node -e "
const { createTopicStore } = require('./lib/topic-store')
;(async () => {
  const store = createTopicStore({ config: {
    host: '127.0.0.1', port: 3307, database: 'sfedits_test',
    user: 'root', password: 'sfedits-test'
  }})
  const topic = await store.upsertTopic('Q62', { languages: ['en'] })
  await store.addSubscription(topic.id, {
    ownerUser: 'LocalTest', deliveryType: 'discord',
    deliveryConfig: { webhook_url: process.env.TEST_WEBHOOK }
  })
  await store.setTopicArticles(topic.id, [
    { qid: 'Q62', wikipedia: 'en', title: 'San Francisco', source: 'admin' }
  ])
  console.log('seeded topic', topic.id)
  await store.close()
})()
"
```

Then run the bot without `--noop` against that webhook and wait for a real edit to San Francisco. Confirm one Discord post arrives with the rich embed intact. **This is the check that matters** — the unit tests prove the wiring, but only a live edit proves the render, the embed, and the webhook survive the new path together.
