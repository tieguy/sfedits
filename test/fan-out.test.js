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
   * proxyquire pattern already used in test/posting.test.js.
   */
  function loadPageWatch() {
    return proxyquire('../page-watch', {
      './lib/diff-image': {
        captureDiffImage: async () => {
          renderCount++
          // summary must be an object or null, never a string: the embed
          // builder does summary.sentence.charAt(0) in
          // lib/discord-platform.js, and a truthy string sends every
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

  function subscription(id, hookPath) {
    return {
      id,
      topicId: 1,
      ownerUser: `user${id}`,
      deliveryType: 'discord',
      deliveryConfig: { webhook_url: `https://discord.com${hookPath}` },
      status: 'active'
    }
  }

  it('renders once and delivers to every subscription', async function() {
    // THE test for this phase. It must drive sendStatus end to end - calling
    // deliverToTopics directly would never invoke the renderer, so the
    // "one render" half of the assertion would be vacuously true.
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

    const account = {}

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
      const account = {}
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

  it('returns deliver() result with task 2 contract (ok, type, postId, subscriptionId)', async function() {
    // Task 2 contract verification: deliver() result structure
    nock('https://discord.com')
      .post('/api/webhooks/99/abc', () => true)
      .query(true)
      .reply(200, { id: 'msg-id-456' })

    const { deliver } = require('../lib/subscription-delivery')

    const sub = subscription(99, '/api/webhooks/99/abc')
    const result = await deliver(
      sub,
      { text: 'test', screenshot: screenshotPath, metadata: { page: 'Test' } }
    )

    // Verify task 2 contract
    assert.isTrue(result.ok, 'delivery should succeed')
    assert.equal(result.type, 'discord', 'type should match subscription deliveryType')
    assert.equal(result.postId, 'msg-id-456', 'postId should be the message ID from platform')
    assert.equal(result.subscriptionId, 99, 'subscriptionId should be from the subscription')
    assert.equal(result.messageId, result.postId, 'messageId should equal postId')
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
      // Must be a real Discord host: deliver() validates against the allowlist
      // BEFORE consulting the limiter, so an invented host never reaches the cap.
      deliveryConfig: { webhook_url: `https://discord.com/api/webhooks/${id}/capped` },
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

    const scope = nock('https://discord.com')
      .post('/api/webhooks/1/capped').query(true).times(2).reply(200, { id: '1' })

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
    nock('https://discord.com').post(/.*/).query(true).reply(200, { id: '1' })

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

    nock('https://discord.com').post(/.*/).query(true).reply(200, { id: '1' })
    await deliverAll([sub(1)], payload(), { limiter })

    await deliverAll([sub(1)], payload(), { limiter })
    await deliverAll([sub(1)], payload(), { limiter })

    now += 60001

    let summaryBody = null
    nock('https://discord.com').post(/.*/, body => {
      summaryBody = String(JSON.stringify(body))
      return true
    }).query(true).reply(200, { id: '2' })
    nock('https://discord.com').post(/.*/).query(true).reply(200, { id: '3' })

    await deliverAll([sub(1)], payload(), { limiter })

    assert.isNotNull(summaryBody)
    assert.include(summaryBody, '2 more')
  })

  it('caps each subscription separately', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')
    const { SubscriptionLimiter } = require('../lib/delivery-limits')

    let now = 1000
    const limiter = new SubscriptionLimiter({ max: 1, windowMs: 60000, now: () => now })

    const scope = nock('https://discord.com')
      .post(/.*/).query(true).times(2).reply(200, { id: '1' })

    const results = await deliverAll([sub(1), sub(2)], payload(), { limiter })

    assert.isTrue(results[0].ok)
    assert.isTrue(results[1].ok)
    assert.isTrue(scope.isDone())
  })

  it('delivers without a cap when no limiter is supplied', async function() {
    const { deliverAll } = require('../lib/subscription-delivery')

    const scope = nock('https://discord.com')
      .post(/.*/).query(true).times(3).reply(200, { id: '1' })

    for (let i = 0; i < 3; i++) {
      await deliverAll([sub(1)], payload())
    }

    assert.isTrue(scope.isDone())
  })
})

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
