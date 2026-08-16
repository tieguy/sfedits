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

  it('never delivers a topic-only edit to the account\'s own platforms', async function() {
    // The incident this pins: on 2026-08-15 the SF account posted a Venezuela
    // topic edit to its public Discord/Mastodon/Bluesky feeds, because config
    // deliveries were attached to every edit that reached sendStatus. Account
    // channels belong to the account's watchlist; topic matches belong to
    // subscriptions. An edit only a topic matched must reach only subscribers.
    const subHook = nock('https://discord.com')
      .post('/api/webhooks/5/sub').query(true).reply(200, { id: '1' })
    const accountHook = nock('https://discord.com')
      .post('/api/webhooks/9/account').query(true).reply(200, { id: '2' })

    const pageWatch = loadPageWatch()

    nock('https://es.wikipedia.org')
      .get('/w/index.php')
      .query(true)
      .reply(200, '<script>RLCONF={"wgPageName":"Planetario_Humboldt"};</script>')

    pageWatch._setTopicStateForTest({
      subscriptionsForTopic: async () => [subscription(5, '/api/webhooks/5/sub')]
    }, null)

    // The account watches enwiki pages; this edit is not on any of its lists.
    const account = {
      discord: { webhook_url: 'https://discord.com/api/webhooks/9/account' },
      deliveries: [{ type: 'discord' }],
      watchlist: { 'English Wikipedia': { 'Alpha': true } }
    }
    const edit = {
      wikipedia: 'Spanish Wikipedia',
      page: 'Planetario Humboldt',
      user: 'Editor',
      url: 'https://es.wikipedia.org/w/index.php?diff=123&oldid=456'
    }

    await pageWatch.sendStatus(
      account, pageWatch.getStatus(edit, edit.user, '{{page}} edited'), edit, [1])

    assert.isTrue(subHook.isDone(), 'the subscription must receive the post')
    assert.isFalse(accountHook.isDone(),
      'the account\'s own channel must NOT receive a topic-only edit')
    nock.cleanAll()
  })

  it('still delivers a watched edit to the account\'s platforms', async function() {
    // Companion regression pin for the gate above: watched edits keep flowing
    // to the account's channels exactly as before.
    const accountHook = nock('https://discord.com')
      .post('/api/webhooks/9/account').query(true).reply(200, { id: '2' })

    const pageWatch = loadPageWatch()

    nock('https://en.wikipedia.org')
      .get('/w/index.php')
      .query(true)
      .reply(200, '<script>RLCONF={"wgPageName":"Alpha"};</script>')

    pageWatch._setTopicStateForTest({ subscriptionsForTopic: async () => [] }, null)

    const account = {
      discord: { webhook_url: 'https://discord.com/api/webhooks/9/account' },
      deliveries: [{ type: 'discord' }],
      watchlist: { 'English Wikipedia': { 'Alpha': true } }
    }
    const edit = {
      wikipedia: 'English Wikipedia',
      page: 'Alpha',
      user: 'Editor',
      url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
    }

    await pageWatch.sendStatus(
      account, pageWatch.getStatus(edit, edit.user, '{{page}} edited'), edit, [])

    assert.isTrue(accountHook.isDone(), 'watched edits still post to the account')
  })

  it('skips rendering when no topic matched and no account platform is set',
    async function() {
      const pageWatch = loadPageWatch()
      pageWatch._setTopicStateForTest({ subscriptionsForTopic: async () => [] }, null)

      // No nock setup needed - the page verification fetch won't happen since rendering is skipped

      const edit = {
        wikipedia: 'en', page: 'Alpha', user: 'Editor',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
      }
      const account = {}
      await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'),
        edit, [])

      assert.equal(renderCount, 0,
        'with no consumers (no topics matched and no account deliveries), ' +
        'rendering is skipped - this is the phase 6 optimization')
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

  it('a delivery failure log names the page and the image size', async function() {
    // Three "400 attachments" failures on 2026-08-15 could not be attributed
    // to an edit because the failure line carried neither page nor payload
    // detail. The log line is the only evidence trail for intermittent
    // delivery rejections, so it must say what was being delivered.
    nock('https://discord.com').post('/api/webhooks/9/dead').query(true)
      .reply(400, '{"attachments": ["0"]}')

    const pageWatch = loadPageWatch()
    const errors = []
    const original = console.error
    console.error = (...args) => { errors.push(args.join(' ')) }
    try {
      await pageWatch.deliverToTopics(
        [subscription(1, '/api/webhooks/9/dead')],
        { text: 'x', screenshot: screenshotPath, metadata: { page: 'Municipio Roscio' } })
    } finally {
      console.error = original
    }

    const line = errors.find(e => e.includes('delivery failed'))
    assert.exists(line, 'the failure must be logged')
    assert.include(line, 'Municipio Roscio', 'the failing page must be named')
    assert.match(line, /\d+ bytes/, 'the attachment size must be recorded')
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

  it('treats a bodyless 200 as transient, not permanent', async function() {
    // Discord returns 200 but with no message id - this is a transient failure
    // (the server accepted it but something went wrong internally)
    nock('https://discord.com')
      .post('/api/webhooks/77/silent', () => true)
      .query(true)
      .reply(200, {})

    const { deliver } = require('../lib/subscription-delivery')

    const sub = subscription(77, '/api/webhooks/77/silent')
    const result = await deliver(
      sub,
      { text: 'test', screenshot: screenshotPath, metadata: { page: 'Test' } }
    )

    assert.isFalse(result.ok, 'delivery should fail')
    assert.isFalse(result.permanent, 'a successful post with no id must not count toward quarantine')
    assert.include(result.error, 'no message id',
      'error should indicate the missing message id')
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

  describe('edit filtering', function() {
    it('skips consumers that fail metadata checks (bot filter)', async function() {
      const paths = ['/api/webhooks/1/bots-true', '/api/webhooks/2/bots-false']
      const scope1 = nock('https://discord.com').post(paths[0]).query(true).reply(200, { id: '1' })
      const scope2 = nock('https://discord.com').post(paths[1]).query(true).reply(200, { id: '1' })

      const pageWatch = loadPageWatch()

      nock('https://en.wikipedia.org')
        .get('/w/index.php').query(true)
        .reply(200, '<script>RLCONF={"wgPageName":"BotEdit"};</script>')

      const stubStore = {
        subscriptionsForTopic: async (topicId) => [
          { ...subscription(1, paths[0]), editFilters: { bots: true } },
          { ...subscription(2, paths[1]), editFilters: { bots: false } }
        ]
      }
      pageWatch._setTopicStateForTest(stubStore, null)

      const edit = {
        wikipedia: 'en',
        page: 'BotEdit',
        user: 'SomeBot',
        robot: true,
        minor: false,
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const account = {}
      await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'), edit, [1])

      // Bot edits: only bots: true consumer receives it
      assert.isTrue(scope1.isDone(), 'bots:true consumer should receive bot edit')
      assert.isFalse(scope2.isDone(), 'bots:false consumer should filter out bot edit')
    })

    it('performs zero renders when all consumers are filtered by metadata (C4)', async function() {
      const pageWatch = loadPageWatch()

      // Set up the diff-fetch scope but do NOT set up the page-verification scope
      // since we should return early before fetching anything
      const diffScope = nock('https://en.wikipedia.org')
        .get('/w/index.php').query(true)
        .reply(200, '<script>RLCONF={"wgPageName":"Alpha"};</script>')

      const stubStore = {
        subscriptionsForTopic: async (topicId) => [
          { ...subscription(1, '/api/webhooks/1/x'), editFilters: { bots: false } },
          { ...subscription(2, '/api/webhooks/2/y'), editFilters: { minor: false } }
        ]
      }
      pageWatch._setTopicStateForTest(stubStore, null)

      const edit = {
        wikipedia: 'en',
        page: 'Alpha',
        user: 'BotUser',
        robot: true,
        minor: true,
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
      }

      const account = {}
      await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'), edit, [1])

      assert.equal(renderCount, 0,
        'when all consumers filter out an edit at metadata stage, no render should occur')

      // CRITICAL: the diff fetch must NOT have been consumed - the metadata-stage
      // early return prevents the HTTP fetch, not just the render
      assert.isFalse(diffScope.isDone(), 'metadata-stage early return must prevent the diff fetch')
      const pending = nock.pendingMocks()
      assert.isAbove(pending.length, 0, 'the diff scope should still be pending (not consumed)')
    })

    it('filters cosmetic-only edits from consumers with cosmetic_only: true (I3a)', async function() {
      const fs = require('fs')
      const path = require('path')

      // Load the template-only fixture (cosmetic edit)
      const templateOnlyHtml = fs.readFileSync(
        path.join(__dirname, 'fixtures/diff-html/template-only.html'), 'utf-8')

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => {
            renderCount++
            return { screenshot: screenshotPath, altText: 'alt', summary: null, article: null }
          }
        },
        './lib/geolocation': {
          initializeReader: async () => null,
          enrichIPsInText: async (text) => text
        },
        './lib/diff-page': {
          fetchDiffHtml: async () => templateOnlyHtml,
          verifyDiffPage: (html, page) => ({ match: true, actualPage: page })
        },
        './lib/post-log': { recordPost: () => null }
      })

      const paths = ['/api/webhooks/1/filter-less', '/api/webhooks/2/cosmetic-only']
      const scope1 = nock('https://discord.com').post(paths[0]).query(true).reply(200, { id: '1' })
      const scope2 = nock('https://discord.com').post(paths[1]).query(true).reply(200, { id: '2' })

      const stubStore = {
        subscriptionsForTopic: async (topicId) => [
          { ...subscription(1, paths[0]), editFilters: null },
          { ...subscription(2, paths[1]), editFilters: { cosmetic_only: true } }
        ]
      }
      pageWatch._setTopicStateForTest(stubStore, null)

      const edit = {
        wikipedia: 'en',
        page: 'TestPage',
        user: 'Editor',
        robot: false,
        minor: false,
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
      }

      const account = {}
      await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'), edit, [1])

      assert.isTrue(scope1.isDone(), 'filter-less consumer should receive template-only edit')
      assert.isFalse(scope2.isDone(), 'cosmetic_only consumer should NOT receive template-only edit')
    })

    it('passes prose edits through content stage for all consumers (I3b)', async function() {
      const fs = require('fs')
      const path = require('path')

      // Load the prose fixture (non-cosmetic edit)
      const proseHtml = fs.readFileSync(
        path.join(__dirname, 'fixtures/diff-html/prose.html'), 'utf-8')

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => {
            renderCount++
            return { screenshot: screenshotPath, altText: 'alt', summary: null, article: null }
          }
        },
        './lib/geolocation': {
          initializeReader: async () => null,
          enrichIPsInText: async (text) => text
        },
        './lib/diff-page': {
          fetchDiffHtml: async () => proseHtml,
          verifyDiffPage: (html, page) => ({ match: true, actualPage: page })
        },
        './lib/post-log': { recordPost: () => null }
      })

      const paths = ['/api/webhooks/1/filter-less', '/api/webhooks/2/cosmetic-only']
      const scope1 = nock('https://discord.com').post(paths[0]).query(true).reply(200, { id: '1' })
      const scope2 = nock('https://discord.com').post(paths[1]).query(true).reply(200, { id: '2' })

      const stubStore = {
        subscriptionsForTopic: async (topicId) => [
          { ...subscription(1, paths[0]), editFilters: null },
          { ...subscription(2, paths[1]), editFilters: { cosmetic_only: true } }
        ]
      }
      pageWatch._setTopicStateForTest(stubStore, null)

      const edit = {
        wikipedia: 'en',
        page: 'TestPage',
        user: 'Editor',
        robot: false,
        minor: false,
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
      }

      const account = {}
      await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'), edit, [1])

      assert.isTrue(scope1.isDone(), 'filter-less consumer should receive prose edit')
      assert.isTrue(scope2.isDone(), 'cosmetic_only consumer should receive prose edit (prose is not cosmetic)')
    })

    it('noop mode still logs filter decisions (C1)', async function() {
      // Set argv BEFORE proxyquire so page-watch loads with --noop
      const originalArgv = process.argv
      process.argv = ['node', 'page-watch.js', '--noop']

      const logMessages = []
      const originalLog = console.log
      const mockLog = function() {
        logMessages.push(Array.from(arguments).join(' '))
        originalLog.apply(console, arguments)
      }

      try {
        // Stub console.log to capture messages
        console.log = mockLog

        const pageWatch = proxyquire('../page-watch', {
          './lib/diff-image': {
            captureDiffImage: async () => {
              renderCount++
              return { screenshot: screenshotPath, altText: 'alt', summary: null, article: null }
            }
          },
          './lib/geolocation': {
            initializeReader: async () => null,
            enrichIPsInText: async (text) => text
          },
          './lib/post-log': { recordPost: () => null }
        })

        nock('https://en.wikipedia.org')
          .get('/w/index.php').query(true)
          .reply(200, '<script>RLCONF={"wgPageName":"Alpha"};</script>')

        const stubStore = {
          subscriptionsForTopic: async (topicId) => [
            { ...subscription(1, '/api/webhooks/1/passes'), editFilters: null },
            { ...subscription(2, '/api/webhooks/2/bots-false'), editFilters: { bots: false } }
          ]
        }
        pageWatch._setTopicStateForTest(stubStore, null)

        const edit = {
          wikipedia: 'en',
          page: 'Alpha',
          user: 'SomeBot',
          robot: true,
          minor: false,
          url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
        }

        const account = {}
        await pageWatch.sendStatus(account, pageWatch.getStatus(edit, edit.user, '{{page}}'), edit, [1])

        // In noop mode: should still log filter decisions but NOT render
        assert.equal(renderCount, 0, 'noop mode must not render')

        // Should have logged a "filtered:" line for the bot-blocked subscription
        const filteredLine = logMessages.find(msg => msg.includes('filtered: Alpha for sub:2 (bot)'))
        assert.isOk(filteredLine, 'should log filtered: line for bot-blocked subscription')

        // Should have logged a "filter-pass:" line for the filter-less subscription
        const filterPassLine = logMessages.find(msg => msg.includes('filter-pass: Alpha for sub:1'))
        assert.isOk(filterPassLine, 'should log filter-pass: line for filter-less subscription')
      } finally {
        console.log = originalLog
        process.argv = originalArgv
      }
    })
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
