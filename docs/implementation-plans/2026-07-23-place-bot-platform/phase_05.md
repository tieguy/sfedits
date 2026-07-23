# Place-Bot Platform Implementation Plan — Phase 5: Per-Subscription Discord Delivery

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Make delivery to a third party's webhook safe — rate-capped, failure-tolerant, and self-quarantining when a webhook dies.

**Architecture:** The `RateCap` class already proven in the Wikidata claim watcher moves to `lib/delivery-limits.js` and gains per-subscription instances. `lib/subscription-delivery.js` grows cap enforcement, a "+N more" summary, and consecutive-failure tracking that marks a subscription `broken` in the store rather than retrying a dead webhook forever.

**Tech Stack:** Node 20+, mocha/chai/nock/sinon, MariaDB.

**Scope:** Phase 5 of 5 (Plan A). This is the last phase before the go/no-go on Plan B.

**Codebase verified:** 2026-07-23 04:27 PDT, branch `place-bot-platform`.

---

## Context the executing engineer needs

**Verified code:**

- `lib/wikidata-claim-watch.js:119-153` defines `class RateCap` — a sliding-window cap with `tryTake()` and `drainSuppressed()`. It is **already exported** (`:404-414`), already tested (`test/wikidata-claim-watch.test.js`, the "respects the rate cap" case), and has **no dependencies on the rest of that module**. Moving it is a pure relocation.
- `lib/wikidata-claim-watch.js:346-356` turns `drainSuppressed()` into a "…and N more" webhook post. That is the pattern to generalize.
- `lib/discord-platform.js:250-294` exports `post({ account, text, screenshot, metadata })`, reading the webhook from `account.webhook_url`. Phase 4's `lib/subscription-delivery.js` already calls it with a synthesized `{ webhook_url }`, so no change is needed there.
- `lib/topic-store.js` (Phase 2) exports `setSubscriptionStatus(subscriptionId, status)`, and `subscriptionsForTopic` already filters to `status = 'active'`. The quarantine mechanism exists; this phase wires it up.

**Why a cap is not optional here.** Until now every post came from a watchlist the maintainer curated. From Phase 5 on, a stranger picks the region — and the design's scale table says a state-sized region is 10⁵ articles, which is an unusable firehose aimed at someone's Discord channel. The cap is what stops a mis-sized region from being a denial-of-service against its own subscriber, and it is what makes the region-size cap in Phase 9 a refinement rather than the only defense.

---

## Task 1: Extract the rate cap

**Files:**
- Create: `lib/delivery-limits.js`
- Modify: `lib/wikidata-claim-watch.js:119-153` (delete `RateCap`, import it) and `:404-414` (keep re-exporting it)
- Create: `test/delivery-limits.test.js`

**Step 1: Write the failing test**

Create `test/delivery-limits.test.js`:

```javascript
const { assert } = require('chai')
const { describe, it } = require('mocha')

const { RateCap, SubscriptionLimiter } = require('../lib/delivery-limits')

describe('delivery-limits', function() {
  this.timeout(5000)

  describe('RateCap', function() {
    it('allows up to max within the window', function() {
      let now = 1000
      const cap = new RateCap({ max: 2, windowMs: 60000, now: () => now })

      assert.isTrue(cap.tryTake())
      assert.isTrue(cap.tryTake())
      assert.isFalse(cap.tryTake())
    })

    it('allows again once the window rolls over', function() {
      let now = 1000
      const cap = new RateCap({ max: 1, windowMs: 60000, now: () => now })

      assert.isTrue(cap.tryTake())
      assert.isFalse(cap.tryTake())

      now += 60001
      assert.isTrue(cap.tryTake())
    })

    it('reports suppressed count only after the window rolls over', function() {
      let now = 1000
      const cap = new RateCap({ max: 1, windowMs: 60000, now: () => now })

      cap.tryTake()
      cap.tryTake()
      cap.tryTake()

      assert.equal(cap.drainSuppressed(), 0, 'window still open')

      now += 60001
      assert.equal(cap.drainSuppressed(), 2)
      assert.equal(cap.drainSuppressed(), 0, 'draining resets the counter')
    })
  })

  describe('SubscriptionLimiter', function() {
    it('caps each subscription independently', function() {
      let now = 1000
      const limiter = new SubscriptionLimiter({
        max: 1, windowMs: 60000, now: () => now
      })

      assert.isTrue(limiter.tryTake(1))
      assert.isFalse(limiter.tryTake(1))
      assert.isTrue(limiter.tryTake(2), 'a busy subscription must not cap a quiet one')
    })

    it('drains each subscription separately', function() {
      let now = 1000
      const limiter = new SubscriptionLimiter({ max: 1, windowMs: 60000, now: () => now })

      limiter.tryTake(1)
      limiter.tryTake(1)
      limiter.tryTake(1)
      limiter.tryTake(2)

      now += 60001

      assert.equal(limiter.drainSuppressed(1), 2)
      assert.equal(limiter.drainSuppressed(2), 0)
    })

    it('forgets subscriptions that have gone quiet', function() {
      let now = 1000
      const limiter = new SubscriptionLimiter({ max: 5, windowMs: 60000, now: () => now })

      limiter.tryTake(1)
      assert.equal(limiter.size(), 1)

      now += 60001 * 3
      limiter.prune()

      assert.equal(limiter.size(), 0,
        'a limiter that never forgets is a memory leak once bots come and go')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/delivery-limits.test.js
```
Expected: FAIL — `Cannot find module '../lib/delivery-limits'`

**Step 3: Write the implementation**

Create `lib/delivery-limits.js`:

```javascript
/**
 * Post-rate limiting.
 *
 * RateCap is moved here verbatim from lib/wikidata-claim-watch.js, where it
 * was written to stop a QuickStatements bulk import from firing a hundred
 * Discord posts in a minute. The same shape solves the self-serve problem:
 * a subscriber who picks a region far bigger than they meant to should get a
 * notice, not a firehose.
 *
 * SubscriptionLimiter is the per-subscription fleet of caps. Each subscription
 * gets its own window, so one oversized bot cannot silence a well-sized one
 * that happens to share the process.
 */

/**
 * Sliding-window rate cap. Posts beyond `max` per window are suppressed and
 * counted; drainSuppressed() returns and resets the count once the window
 * has rolled over (the caller turns it into a "+N more" summary post).
 */
class RateCap {
  constructor({ max, windowMs, now = Date.now } = {}) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
    this.stamps = []
    this.suppressed = 0
  }

  _prune() {
    const cutoff = this.now() - this.windowMs
    this.stamps = this.stamps.filter(t => t > cutoff)
  }

  tryTake() {
    this._prune()
    if (this.stamps.length >= this.max) {
      this.suppressed++
      return false
    }
    this.stamps.push(this.now())
    return true
  }

  /** Suppressed count if the window has rolled over, resetting it; else 0 */
  drainSuppressed() {
    this._prune()
    if (this.stamps.length === 0 && this.suppressed > 0) {
      const n = this.suppressed
      this.suppressed = 0
      return n
    }
    return 0
  }

  /** True when this cap holds no state worth keeping. */
  isIdle() {
    this._prune()
    return this.stamps.length === 0 && this.suppressed === 0
  }
}

const DEFAULT_MAX = 20
const DEFAULT_WINDOW_MS = 60 * 60 * 1000

/**
 * One RateCap per subscription id.
 *
 * Caps are created lazily and pruned when idle - subscriptions come and go on
 * a self-serve platform, and a map that only ever grows is a slow leak in a
 * process meant to run for months.
 */
class SubscriptionLimiter {
  constructor({ max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
    this.caps = new Map()
  }

  _capFor(subscriptionId) {
    let cap = this.caps.get(subscriptionId)
    if (!cap) {
      cap = new RateCap({ max: this.max, windowMs: this.windowMs, now: this.now })
      this.caps.set(subscriptionId, cap)
    }
    return cap
  }

  tryTake(subscriptionId) {
    return this._capFor(subscriptionId).tryTake()
  }

  drainSuppressed(subscriptionId) {
    const cap = this.caps.get(subscriptionId)
    return cap ? cap.drainSuppressed() : 0
  }

  /** Drop caps holding no state. */
  prune() {
    for (const [id, cap] of this.caps) {
      if (cap.isIdle()) this.caps.delete(id)
    }
  }

  size() {
    return this.caps.size
  }
}

module.exports = {
  RateCap,
  SubscriptionLimiter,
  DEFAULT_MAX,
  DEFAULT_WINDOW_MS
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/delivery-limits.test.js
```
Expected: PASS — 7 passing

**Step 5: Rewire the claim watcher**

In `lib/wikidata-claim-watch.js`, delete the `RateCap` class definition at lines 119-153 and add to the requires near the top of the file:

```javascript
const { RateCap } = require('./delivery-limits')
```

**Keep `RateCap` in that module's `module.exports`** (line 404-414, unchanged). `test/wikidata-claim-watch.test.js` imports it from there, and re-exporting costs nothing.

**Step 6: Verify the move changed nothing**

Run:
```bash
npx mocha --colors --reporter spec --exit test/wikidata-claim-watch.test.js
```
Expected: PASS, unchanged count. Specifically "respects the rate cap" must still pass — it exercises the moved class through `handleWikidataEdit`.

Run:
```bash
npm test
```
Expected: the Phase 4 total plus the new delivery-limits tests, 0 failing

**Step 7: Commit**

```bash
git add lib/delivery-limits.js lib/wikidata-claim-watch.js test/delivery-limits.test.js
git commit -m "refactor: extract RateCap into lib/delivery-limits

Moved verbatim from the claim watcher, which still re-exports it. Adds
SubscriptionLimiter, a per-subscription fleet of caps that prunes idle
entries rather than growing forever."
```

---

## Task 2: Cap enforcement and the over-cap notice

**Files:**
- Modify: `lib/subscription-delivery.js` (add limiter support and the summary post)
- Modify: `test/fan-out.test.js` (append a describe block)

**Step 1: Write the failing test**

Append to `test/fan-out.test.js`, at the end of the file:

```javascript
describe('subscription rate caps', function() {
  this.timeout(5000)

  let screenshotPath

  beforeEach(function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'))
    screenshotPath = path.join(dir, 'diff.png')
    fs.writeFileSync(screenshotPath, 'fake png bytes')
  })

  afterEach(function() {
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath)
    nock.cleanAll()
  })

  function sub(id) {
    return {
      id,
      topicId: 1,
      ownerUser: `user${id}`,
      deliveryType: 'discord',
      deliveryConfig: { webhook_url: 'https://capped.test/api/webhooks/1/token' },
      status: 'active'
    }
  }

  const payload = () => ({
    text: 'x', screenshot: screenshotPath, metadata: { page: 'Alpha', wiki: 'en' }
  })

  it('suppresses posts beyond the cap', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')
    const { SubscriptionLimiter } = require('../lib/delivery-limits')

    let now = 1000
    const limiter = new SubscriptionLimiter({ max: 2, windowMs: 60000, now: () => now })

    const scope = nock('https://capped.test')
      .post(/.*/).query(true).times(2).reply(200, { id: '1' })

    for (let i = 0; i < 5; i++) {
      await deliverAll([sub(1)], payload(), { limiter })
    }

    assert.isTrue(scope.isDone(), 'exactly two posts should have gone out')
    assert.isTrue(nock.isDone(), 'no third post should have been attempted')
  })

  it('refuses a non-Discord host', async function() {
    const { validateWebhookUrl } = require('../lib/subscription-delivery')

    // The SSRF cases. Each of these is a URL a stranger could type into the
    // Phase 7 create form, aimed at something only reachable from inside
    // Wikimedia Cloud.
    for (const url of [
      'http://127.0.0.1:8080/api/webhooks/1/t',
      'https://169.254.169.254/api/webhooks/1/t',
      'https://tools.db.svc.wikimedia.cloud/api/webhooks/1/t',
      'https://evil.test/api/webhooks/1/t',
      'https://discord.com.evil.test/api/webhooks/1/t'
    ]) {
      assert.isFalse(validateWebhookUrl(url).valid, `${url} should be refused`)
    }
  })

  it('refuses plain http even to a Discord host', async function() {
    const { validateWebhookUrl } = require('../lib/subscription-delivery')
    assert.isFalse(validateWebhookUrl('http://discord.com/api/webhooks/1/t').valid)
  })

  it('accepts a real Discord webhook url', async function() {
    const { validateWebhookUrl } = require('../lib/subscription-delivery')
    assert.isTrue(
      validateWebhookUrl('https://discord.com/api/webhooks/123/abcDEF').valid)
  })

  it('refuses to deliver to a rejected url without making a request',
    async function() {
      const { deliver } = require('../lib/subscription-delivery')

      const result = await deliver(
        {
          id: 9, deliveryType: 'discord',
          deliveryConfig: { webhook_url: 'http://127.0.0.1:9999/api/webhooks/1/t' }
        },
        { text: 'x', screenshot: screenshotPath, metadata: {} })

      assert.isFalse(result.ok)
      assert.isTrue(result.permanent)
      assert.include(result.error, 'refusing webhook')
      // nock intercepts all HTTP; nothing was registered, so any request would
      // have thrown a "no match" error rather than silently succeeding.
    })

  it('reports a capped result rather than a failure', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')
    const { SubscriptionLimiter } = require('../lib/delivery-limits')

    let now = 1000
    const limiter = new SubscriptionLimiter({ max: 1, windowMs: 60000, now: () => now })
    nock('https://capped.test').post(/.*/).query(true).reply(200, { id: '1' })

    await deliverAll([sub(1)], payload(), { limiter })
    const results = await deliverAll([sub(1)], payload(), { limiter })

    assert.isTrue(results[0].capped)
    assert.isFalse(results[0].ok)
    assert.notOk(results[0].error, 'being capped is not an error condition')
  })

  it('posts a "+N more" summary when the window rolls over', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')
    const { SubscriptionLimiter } = require('../lib/delivery-limits')

    let now = 1000
    const limiter = new SubscriptionLimiter({ max: 1, windowMs: 60000, now: () => now })

    nock('https://capped.test').post(/.*/).query(true).reply(200, { id: '1' })
    await deliverAll([sub(1)], payload(), { limiter })

    await deliverAll([sub(1)], payload(), { limiter })
    await deliverAll([sub(1)], payload(), { limiter })

    now += 60001

    let summaryBody = null
    nock('https://capped.test').post(/.*/, body => {
      summaryBody = String(JSON.stringify(body))
      return true
    }).query(true).reply(200, { id: '2' })
    nock('https://capped.test').post(/.*/).query(true).reply(200, { id: '3' })

    await deliverAll([sub(1)], payload(), { limiter })

    assert.isNotNull(summaryBody)
    assert.include(summaryBody, '2 more')
  })

  it('caps each subscription separately', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')
    const { SubscriptionLimiter } = require('../lib/delivery-limits')

    let now = 1000
    const limiter = new SubscriptionLimiter({ max: 1, windowMs: 60000, now: () => now })

    const scope = nock('https://capped.test')
      .post(/.*/).query(true).times(2).reply(200, { id: '1' })

    const results = await deliverAll([sub(1), sub(2)], payload(), { limiter })

    assert.isTrue(results[0].ok)
    assert.isTrue(results[1].ok)
    assert.isTrue(scope.isDone())
  })

  it('delivers without a cap when no limiter is supplied', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')

    const scope = nock('https://capped.test')
      .post(/.*/).query(true).times(3).reply(200, { id: '1' })

    for (let i = 0; i < 3; i++) {
      await deliverAll([sub(1)], payload())
    }

    assert.isTrue(scope.isDone())
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/fan-out.test.js
```
Expected: FAIL — the cap is not enforced, so more posts go out than nock expects.

**Step 3: Write the implementation**

Replace the whole of `lib/subscription-delivery.js` with:

```javascript
/**
 * Deliver one already-rendered post to one subscription.
 *
 * The render happens once per edit, upstream of this. That is the entire
 * operational payoff of deduplicating on topic: 500 people subscribed to the
 * Mission means one diff render and 500 cheap posts, not 500 renders.
 *
 * Two protections live here, both because delivery targets now belong to
 * strangers rather than to the maintainer:
 *
 *  - a per-subscription rate cap, so a region far bigger than the subscriber
 *    meant to pick becomes a notice rather than a firehose aimed at their
 *    Discord channel
 *  - consecutive-failure quarantine, so a webhook that has been deleted stops
 *    being retried on every matching edit forever
 */

const discord = require('./discord-platform')

/** Consecutive hard failures before a subscription is quarantined. */
const FAILURES_BEFORE_BROKEN = 5

/**
 * Discord webhook hosts. Anything else is refused.
 *
 * From Phase 5 on, the delivery URL is a string a stranger typed. Fetching an
 * arbitrary URL from a Toolforge-resident process is a server-side request
 * forgery primitive: http://127.0.0.1:..., link-local metadata endpoints, and
 * anything else reachable from inside Wikimedia Cloud but not from outside.
 *
 * An allowlist rather than a denylist, because denylists for this never hold -
 * DNS rebinding, IPv6 forms, decimal IP literals, and redirects all defeat
 * them. Plan A only supports Discord, so the allowlist costs nothing today,
 * and Phase 8 extends it deliberately when other platforms arrive.
 */
const ALLOWED_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com'
])

/**
 * @param {string} url
 * @returns {{valid: boolean, reason?: string}}
 */
function validateWebhookUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, reason: 'not a valid URL' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: `protocol ${parsed.protocol} is not https` }
  }
  if (!ALLOWED_WEBHOOK_HOSTS.has(parsed.hostname)) {
    return { valid: false, reason: `host ${parsed.hostname} is not a Discord webhook host` }
  }
  if (!parsed.pathname.startsWith('/api/webhooks/')) {
    return { valid: false, reason: 'path is not a Discord webhook path' }
  }
  return { valid: true }
}

/** Discord's own grey, matching the claim watcher's summary embeds. */
const NOTICE_COLOR = 0x95a5a6

/**
 * A 4xx means the webhook is gone or malformed and will never succeed; a 5xx
 * or a transport error is Discord having a bad minute. Only the former should
 * count toward quarantine.
 */
function isPermanentFailure(error) {
  const match = /\b(4\d\d)\b/.exec(error.message || '')
  if (!match) return false
  const status = Number(match[1])
  return status !== 429
}

async function postSummary(webhookUrl, missed) {
  const body = {
    embeds: [{
      description:
        `…and ${missed} more edit${missed === 1 ? '' : 's'} not shown (rate cap). ` +
        'If this keeps happening, the region this bot watches is probably too big.',
      color: NOTICE_COLOR
    }],
    // Matches lib/discord-platform.js:255. The text is static today so nothing
    // could ping - but Phase 9's auto-naming will make these messages carry
    // user-supplied region names, and a guard added only after that is a guard
    // added too late.
    allowed_mentions: { parse: [] }
  }

  await fetch(`${webhookUrl}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
}

/**
 * @param {Object} subscription - from store.subscriptionsForTopic()
 * @param {Object} payload - {text, screenshot, metadata}
 * @param {Object} [options]
 * @param {Object} [options.limiter] - a SubscriptionLimiter
 * @returns {Promise<{ok, capped, subscriptionId, messageId?, error?, permanent?}>}
 */
async function deliver(subscription, payload, options = {}) {
  const { limiter = null } = options

  if (subscription.deliveryType !== 'discord') {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: `unsupported delivery type "${subscription.deliveryType}"`,
      permanent: true
    }
  }

  const webhookUrl = subscription.deliveryConfig?.webhook_url
  if (!webhookUrl) {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: 'subscription has no webhook_url',
      permanent: true
    }
  }

  // Re-validate at delivery, not only at insert. A row can be written by a
  // future code path, by a migration, or by hand; the process that actually
  // makes the request is the only place the check cannot be bypassed.
  const validation = validateWebhookUrl(webhookUrl)
  if (!validation.valid) {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: `refusing webhook: ${validation.reason}`,
      permanent: true
    }
  }

  if (limiter) {
    // Drain first: if the window just rolled over, the subscriber should learn
    // what they missed before the next post lands on top of it.
    const missed = limiter.drainSuppressed(subscription.id)
    if (missed > 0) {
      try {
        await postSummary(webhookUrl, missed)
      } catch (error) {
        console.error(
          `Rate-cap summary failed for subscription ${subscription.id}:`, error.message)
      }
    }

    if (!limiter.tryTake(subscription.id)) {
      // Capped is not an error. The subscriber asked for too much; they get a
      // summary when the window rolls over.
      return { ok: false, capped: true, subscriptionId: subscription.id }
    }
  }

  try {
    const result = await discord.post({
      account: { webhook_url: webhookUrl },
      text: payload.text,
      screenshot: payload.screenshot,
      metadata: payload.metadata
    })
    return {
      ok: true,
      capped: false,
      subscriptionId: subscription.id,
      messageId: result?.id || null
    }
  } catch (error) {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: error.message,
      permanent: isPermanentFailure(error)
    }
  }
}

/**
 * Deliver to every subscription. One failure never blocks the others - a dead
 * webhook belonging to one subscriber must not silence everyone else's bot.
 *
 * @returns {Promise<Array>} one result per subscription
 */
async function deliverAll(subscriptions, payload, options = {}) {
  const results = []
  for (const subscription of subscriptions) {
    results.push(await deliver(subscription, payload, options))
  }
  return results
}

module.exports = {
  deliver,
  deliverAll,
  validateWebhookUrl,
  isPermanentFailure,
  ALLOWED_WEBHOOK_HOSTS,
  FAILURES_BEFORE_BROKEN
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npx mocha --colors --reporter spec --exit test/fan-out.test.js
```
Expected: PASS — 10 passing

**Step 5: Commit**

```bash
git add lib/subscription-delivery.js test/fan-out.test.js
git commit -m "feat: per-subscription rate caps with a rolled-over summary

Being capped is reported as capped, not as an error - the subscriber asked
for too much, nothing failed. The summary names the likely cause, since an
oversized region is what usually produces it."
```

---

## Task 3: Quarantine broken subscriptions

**Files:**
- Create: `lib/subscription-health.js`
- Modify: `page-watch.js` (`deliverToTopics` — track failures and quarantine)
- Modify: `test/fan-out.test.js` (append a describe block)

**Step 1: Write the failing test**

Append to `test/fan-out.test.js`:

```javascript
describe('subscription health', function() {
  this.timeout(5000)

  it('quarantines after consecutive permanent failures', function() {
    const { createHealthTracker } = require('../lib/subscription-health')
    const tracker = createHealthTracker({ threshold: 3 })

    assert.isFalse(tracker.record(1, { ok: false, permanent: true }))
    assert.isFalse(tracker.record(1, { ok: false, permanent: true }))
    assert.isTrue(tracker.record(1, { ok: false, permanent: true }),
      'third consecutive permanent failure quarantines')
  })

  it('does not count transient failures toward quarantine', function() {
    const { createHealthTracker } = require('../lib/subscription-health')
    const tracker = createHealthTracker({ threshold: 2 })

    assert.isFalse(tracker.record(1, { ok: false, permanent: false }))
    assert.isFalse(tracker.record(1, { ok: false, permanent: false }))
    assert.isFalse(tracker.record(1, { ok: false, permanent: false }),
      'Discord having a bad hour must not disable a working bot')
  })

  it('resets the streak on a success', function() {
    const { createHealthTracker } = require('../lib/subscription-health')
    const tracker = createHealthTracker({ threshold: 2 })

    tracker.record(1, { ok: false, permanent: true })
    tracker.record(1, { ok: true })

    assert.isFalse(tracker.record(1, { ok: false, permanent: true }),
      'streak restarted after the success')
  })

  it('ignores capped results entirely', function() {
    const { createHealthTracker } = require('../lib/subscription-health')
    const tracker = createHealthTracker({ threshold: 2 })

    tracker.record(1, { ok: false, capped: true })
    tracker.record(1, { ok: false, capped: true })
    tracker.record(1, { ok: false, capped: true })

    assert.isFalse(tracker.record(1, { ok: false, permanent: true }),
      'being rate capped is not a health signal')
  })

  it('tracks each subscription separately', function() {
    const { createHealthTracker } = require('../lib/subscription-health')
    const tracker = createHealthTracker({ threshold: 2 })

    tracker.record(1, { ok: false, permanent: true })
    assert.isFalse(tracker.record(2, { ok: false, permanent: true }))
  })
})

Then create a **separate** file `test/subscription-quarantine.test.js` for the
database-backed half. Keeping it out of `test/fan-out.test.js` matters: that file
is the fast nock-only feedback loop this phase leans on, and appending a
`describeWithDb` block to it would make `npx mocha test/fan-out.test.js` depend on
a running container.

```javascript
const { assert } = require('chai')
const { describe, it, before, beforeEach, after } = require('mocha')

const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const { createTopicStore } = require('../lib/topic-store')
const { createHealthTracker } = require('../lib/subscription-health')

describeWithDb('subscription quarantine', function() {
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

  it('stops delivering to a subscription once it is marked broken',
    async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const dead = await store.addSubscription(topic.id, {
        ownerUser: 'Gone', deliveryType: 'discord',
        deliveryConfig: { webhook_url: 'https://discord.com/api/webhooks/1/dead' }
      })
      const live = await store.addSubscription(topic.id, {
        ownerUser: 'Here', deliveryType: 'discord',
        deliveryConfig: { webhook_url: 'https://discord.com/api/webhooks/2/live' }
      })

      await store.setSubscriptionStatus(dead.id, 'broken')

      const active = await store.subscriptionsForTopic(topic.id)
      assert.equal(active.length, 1)
      assert.equal(active[0].id, live.id)

      const all = await store.subscriptionsForTopic(topic.id, { includeInactive: true })
      assert.equal(all.length, 2)
      assert.equal(all.find(s => s.id === dead.id).status, 'broken')
    })

  // The integration test: failures counted through the real tracker must
  // actually flip the database row. Unit-testing the tracker and the store
  // separately leaves the wiring between them - which is the part that breaks -
  // unverified.
  it('flips the row after enough permanent failures through the tracker',
    async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const sub = await store.addSubscription(topic.id, {
        ownerUser: 'Doomed', deliveryType: 'discord',
        deliveryConfig: { webhook_url: 'https://discord.com/api/webhooks/3/x' }
      })

      const tracker = createHealthTracker({ threshold: 5 })
      let quarantined = false

      for (let i = 0; i < 5; i++) {
        if (tracker.record(sub.id, { ok: false, permanent: true })) {
          await store.setSubscriptionStatus(sub.id, 'broken')
          quarantined = true
        }
      }

      assert.isTrue(quarantined, 'five permanent failures should quarantine')

      const active = await store.subscriptionsForTopic(topic.id)
      assert.equal(active.length, 0, 'a quarantined subscription stops receiving posts')
    })

  it('survives a restart, because quarantine lives in the database',
    async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const sub = await store.addSubscription(topic.id, {
        ownerUser: 'Doomed', deliveryType: 'discord',
        deliveryConfig: { webhook_url: 'https://discord.com/api/webhooks/4/x' }
      })
      await store.setSubscriptionStatus(sub.id, 'broken')

      // A second store handle stands in for a restarted process.
      const restarted = createTopicStore({ pool })
      const active = await restarted.subscriptionsForTopic(topic.id)

      assert.equal(active.length, 0)
    })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npx mocha --colors --reporter spec --exit test/fan-out.test.js
```
Expected: FAIL — `Cannot find module '../lib/subscription-health'`

**Step 3: Write the implementation**

Create `lib/subscription-health.js`:

```javascript
/**
 * Consecutive-failure tracking for subscription delivery.
 *
 * A webhook a subscriber deleted will fail on every single matching edit,
 * forever, and each failure costs a network round trip and a log line. After
 * enough consecutive permanent failures the subscription is quarantined so the
 * bot stops asking.
 *
 * Only PERMANENT failures count. Discord returning 500 for an hour is not the
 * subscriber's fault and must not disable a working bot; neither is being rate
 * capped, which is a deliberate outcome rather than a fault at all.
 *
 * Telling the subscriber their bot went quiet is deliberately NOT handled here
 * - see "Credential death" in the design plan's deferred section. Quarantine
 * stops the waste; notification needs its own thinking, because a bot that
 * edits user talk pages is itself subject to bot-editing norms.
 */

const { FAILURES_BEFORE_BROKEN } = require('./subscription-delivery')

function createHealthTracker({ threshold = FAILURES_BEFORE_BROKEN } = {}) {
  const streaks = new Map()

  /**
   * Record a delivery result.
   * @returns {boolean} true when this result crosses the quarantine threshold
   */
  function record(subscriptionId, result) {
    if (result.capped) return false

    if (result.ok) {
      streaks.delete(subscriptionId)
      return false
    }

    if (!result.permanent) return false

    const streak = (streaks.get(subscriptionId) || 0) + 1
    streaks.set(subscriptionId, streak)

    if (streak >= threshold) {
      streaks.delete(subscriptionId)
      return true
    }
    return false
  }

  function reset(subscriptionId) {
    streaks.delete(subscriptionId)
  }

  return { record, reset, size: () => streaks.size }
}

module.exports = { createHealthTracker }
```

**Step 4: Wire it into the fan-out**

In `page-watch.js`, add to the requires added in Phase 4:

```javascript
const { createHealthTracker } = require('./lib/subscription-health')
const { SubscriptionLimiter } = require('./lib/delivery-limits')
```

Add to the module-level state added in Phase 4 Step 4b:

```javascript
let subscriptionLimiter = null
const subscriptionHealth = createHealthTracker()
```

Replace the `deliverToTopics` function added in Phase 4 Step 4c with:

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

    const delivered = await deliverAll(subscriptions, payload,
      { limiter: subscriptionLimiter })

    for (const result of delivered) {
      if (result.capped) {
        console.log(`Subscription ${result.subscriptionId}: rate capped`)
        continue
      }
      if (result.ok) {
        subscriptionHealth.record(result.subscriptionId, result)
        continue
      }

      console.error(
        `Subscription ${result.subscriptionId} delivery failed: ${result.error}`)

      if (subscriptionHealth.record(result.subscriptionId, result)) {
        try {
          await store.setSubscriptionStatus(result.subscriptionId, 'broken')
          console.error(
            `Subscription ${result.subscriptionId} quarantined after repeated ` +
            'permanent failures; it will stop receiving posts')
        } catch (error) {
          console.error(
            `Could not quarantine subscription ${result.subscriptionId}:`, error.message)
        }
      }
    }
    results.push(...delivered)
  }
  return results
}
```

Finally, initialize the limiter in `main()`. In the `if (config.topic_store) { ... }` block added in Phase 4 Step 4g, add immediately after `topicIndex = createTopicIndex(topicStore)`:

```javascript
    subscriptionLimiter = new SubscriptionLimiter({
      max: config.topic_store.max_posts_per_hour || undefined,
      windowMs: config.topic_store.rate_window_ms || undefined
    })
    // Idle caps accumulate as subscriptions come and go; sweep hourly.
    const pruneTimer = setInterval(() => subscriptionLimiter.prune(), 60 * 60 * 1000)
    pruneTimer.unref()
```

**Step 5: Run tests**

Run:
```bash
npm run test:db:start
npx mocha --colors --reporter spec --exit test/fan-out.test.js
```
Expected: PASS — 16 passing

Run the full suite:
```bash
npm test
```
Expected: the Phase 4 total plus every test written in this phase, 0 failing

Run the regression surface one more time explicitly:
```bash
npx mocha --colors --reporter spec --exit \
  test/posting.test.js test/watchlist-sync.test.js \
  test/discord-platform.test.js test/wikidata-claim-watch.test.js
```
Expected: PASS with counts unchanged from the Phase 1 baseline.

**Step 6: Commit**

```bash
git add lib/subscription-health.js page-watch.js test/fan-out.test.js \
  test/subscription-quarantine.test.js
git commit -m "feat: quarantine subscriptions whose webhook is permanently dead

Only 4xx-except-429 counts toward the threshold - Discord having a bad hour
must not disable a working bot, and being rate capped is not a fault at all.
Notifying the subscriber stays deferred; see the design plan."
```

---

## Task 4: Document the operational surface

**Files:**
- Modify: `docs/config-topic-store.md` (append a section)

**Step 1: Append to the doc**

Add to the end of `docs/config-topic-store.md`:

```markdown
## Delivery limits

```json
{
  "topic_store": {
    "max_posts_per_hour": 20,
    "rate_window_ms": 3600000
  }
}
```

Both are optional; the defaults are 20 posts per hour per subscription.

The cap is per **subscription**, not per topic or per bot. Two people
subscribed to the same busy topic each get their own budget, so one
oversized bot cannot consume another's.

When a subscription exceeds its cap, posts are suppressed and counted. Once
the window rolls over, the subscriber gets a single summary embed —
"…and N more edits not shown (rate cap)" — which names the likely cause,
since an oversized region is what usually produces it.

## Broken subscriptions

A subscription whose webhook returns a 4xx (other than 429) five times in a
row is marked `status = 'broken'` and stops receiving posts. `subscriptionsForTopic()`
filters to active subscriptions, so quarantine takes effect immediately and
survives a restart.

Transient failures — 5xx, timeouts, 429 — never count toward this. Discord
having a bad hour must not disable a working bot.

**The subscriber is not currently told their bot went quiet.** This is a known
gap, deferred deliberately: see "Credential death" in
`docs/design-plans/2026-07-23-place-bot-platform.md`. The likely answer is a
low-frequency notice to the creator's user talk page, but a bot that edits
talk pages is itself subject to bot-editing norms and needs its own design.

To re-enable a repaired subscription:

```sql
UPDATE subscriptions SET status = 'active' WHERE id = ?;
```
```

**Step 2: Commit**

```bash
git add docs/config-topic-store.md
git commit -m "docs: delivery limits and broken-subscription handling"
```

---

## Phase 5 Done When

- `npm test` is green with no pre-existing test failing, and the SFBA regression surface reports its Phase 1 baseline counts.
- Two subscriptions on one topic deliver to two different webhooks from one render.
- The cap suppresses excess posts and emits exactly one summary notice per rolled-over window.
- A webhook returning 404 five times marks its subscription `broken`; a webhook returning 500 fifty times does not.
- `npm test` with the container stopped remains green, with database suites pending.
- A webhook URL pointing at localhost, a link-local address, or any non-Discord host is refused before any request is made.

**Manual verification against live data — this is the Plan A exit check:**

Seed two subscriptions on one topic pointing at two different Discord webhooks, watching a page that gets edited regularly. Run the bot for real (not `--noop`) and confirm on a live edit:

1. Both channels receive the post.
2. The rich embed survives intact in both — title, BLP flag, added/removed excerpts, action links with escaped parens.
3. The bot logs exactly one render for that edit.

Then delete one of the two webhooks in Discord and wait for five more edits. Confirm the subscription flips to `broken`, the surviving channel keeps receiving posts, and the log says so.

---

## Plan A Complete — Go/No-Go for Plan B

Plan A ends here with a deployable bot whose watchlist comes from the topic
store and which fans out to multiple third-party webhooks. Before writing Plan
B (Phases 6–9: Wikimedia OAuth, create/discovery web flow, BYO-auth delivery,
guardrails), answer the question this plan exists to settle:

**Does the region resolver hold up at county scale?**

Run the Phase 1 manual check against a county QID (San Mateo is `Q108101`) and
a state (California is `Q99`), and record:

- wall-clock time for `articlesForRegion`
- whether `regionHistogram` returns `partial: true`
- the article count, against the design's estimate of ~10⁴ for a county and
  10⁵+ for a state

If county scale returns partial results or takes long enough to blow a
Toolforge job slot, Plan B is premature — the fix belongs in the resolver, and
the design's scale table needs revisiting before a web form lets strangers ask
for a state. Report the numbers rather than proceeding on assumption.
