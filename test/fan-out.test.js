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

    // pii_blocking must be present and disabled - matching this fork's real
    // config. With no stanza at all, screenForPII cannot extract diff text from
    // the fixture and blocks the post, returning BEFORE captureDiffImage. The
    // render would never happen and the assertion below would fail for the
    // wrong reason.
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
