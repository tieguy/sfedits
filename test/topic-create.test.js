const { assert } = require('chai')
const { describe, it, before, beforeEach, after } = require('mocha')

const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const { createTopicStore } = require('../lib/topic-store')
const {
  createBot, checkInvite, normalizeQid, normalizeLanguages, CreateError
} = require('../lib/topic-create')

describe('topic-create (validation)', function() {
  const config = { invite_codes: ['good-code'] }

  function thrown(fn) {
    try {
      fn()
      return null
    } catch (error) {
      return error
    }
  }

  describe('checkInvite', function() {
    it('accepts a configured code', function() {
      assert.isTrue(checkInvite(config, 'good-code'))
    })

    it('rejects a wrong code', function() {
      const error = thrown(() => checkInvite(config, 'nope'))
      assert.instanceOf(error, CreateError)
      assert.equal(error.field, 'invite_code')
    })

    it('rejects a missing code', function() {
      assert.instanceOf(thrown(() => checkInvite(config, undefined)), CreateError)
      assert.instanceOf(thrown(() => checkInvite(config, '')), CreateError)
    })

    it('closes creation entirely when no codes are configured', function() {
      const error = thrown(() => checkInvite({}, 'anything'))
      assert.instanceOf(error, CreateError)
      assert.equal(error.status, 503,
        'an unconfigured deployment must not be wide open')
    })
  })

  describe('normalizeQid', function() {
    it('accepts and upcases a QID', function() {
      assert.equal(normalizeQid(' q62 '), 'Q62')
    })

    it('rejects anything that is not a QID', function() {
      for (const bad of ['62', 'Q', 'Q0', 'P31', 'Q62; DROP TABLE topics', '']) {
        assert.instanceOf(thrown(() => normalizeQid(bad)), CreateError, `${bad} should be refused`)
      }
    })
  })

  describe('normalizeLanguages', function() {
    it('defaults to English', function() {
      assert.deepEqual(normalizeLanguages(''), ['en'])
      assert.deepEqual(normalizeLanguages([]), ['en'])
    })

    it('splits a typed list and drops duplicates', function() {
      assert.deepEqual(normalizeLanguages('en, es en'), ['en', 'es'])
    })

    it('rejects a code that is not a wiki code', function() {
      assert.instanceOf(thrown(() => normalizeLanguages('en, ../etc')), CreateError)
    })

    it('keeps the long codes that are real wikis', function() {
      assert.deepEqual(normalizeLanguages('simple, zh-classical'), ['simple', 'zh-classical'])
    })
  })
})

describeWithDb('topic-create (database)', function() {
  this.timeout(30000)

  let pool
  let store

  const config = { invite_codes: ['good-code'], max_articles: 100 }

  const params = overrides => ({
    invite_code: 'good-code',
    region_qid: 'Q62',
    languages: 'en',
    owner_user: 'Tester',
    webhook_url: 'https://discord.com/api/webhooks/1/abc',
    ...overrides
  })

  const resolverFor = articles => async () => ({
    region: { qid: 'Q62', label: 'San Francisco', strategy: 'admin' },
    articles
  })

  const twoArticles = [
    { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
    { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
  ]

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

  async function attempt(overrides, resolver = resolverFor(twoArticles)) {
    return createBot({ store, config, params: params(overrides), resolver })
      .then(result => ({ result }), error => ({ error }))
  }

  it('creates a topic, a subscription, and a populated watchlist', async function() {
    const { result, error } = await attempt({})

    assert.isUndefined(error)
    assert.isTrue(result.created)
    assert.equal(result.articleCount, 2)

    const index = await store.getWatchIndex({ requireSubscription: true })
    assert.deepEqual(Array.from(index.byWiki.get('en').get('Alpha')), [result.topicId])
  })

  it('gives two people asking for the same place one topic and two subscriptions',
    async function() {
      const first = await attempt({ owner_user: 'A' })
      const second = await attempt({
        owner_user: 'B', webhook_url: 'https://discord.com/api/webhooks/2/def'
      })

      assert.equal(first.result.topicId, second.result.topicId)
      assert.isTrue(first.result.created)
      assert.isFalse(second.result.created, 'the second person joins rather than creating')

      const topics = await pool.query('SELECT COUNT(*) AS n FROM topics')
      assert.equal(Number(topics[0].n), 1)

      const subs = await store.subscriptionsForTopic(first.result.topicId)
      assert.equal(subs.length, 2)
    })

  it('refuses a region over the article ceiling, writing nothing', async function() {
    const huge = Array.from({ length: 101 }, (_, i) => ({
      qid: `Q${i + 1000}`, wikipedia: 'en', title: `Article ${i}`, source: 'admin'
    }))

    const { error } = await attempt({}, resolverFor(huge))

    assert.instanceOf(error, CreateError)
    assert.include(error.message, '101')

    const topics = await pool.query('SELECT COUNT(*) AS n FROM topics')
    assert.equal(Number(topics[0].n), 0,
      'a refused creation must not leave a half-built bot behind')
  })

  it('refuses a webhook that is not a Discord https url', async function() {
    const { error } = await attempt({ webhook_url: 'http://127.0.0.1/api/webhooks/1/x' })

    assert.instanceOf(error, CreateError)
    assert.equal(error.field, 'webhook_url')

    const subs = await pool.query('SELECT COUNT(*) AS n FROM subscriptions')
    assert.equal(Number(subs[0].n), 0)
  })

  it('refuses a bad invite code before touching the database', async function() {
    const { error } = await attempt({ invite_code: 'wrong' })

    assert.instanceOf(error, CreateError)
    assert.equal(error.field, 'invite_code')

    const topics = await pool.query('SELECT COUNT(*) AS n FROM topics')
    assert.equal(Number(topics[0].n), 0)
  })

  it('surfaces the suggested container instead of silently watching a whole city',
    async function() {
      const { error } = await attempt({ region_qid: 'Q7469' }, async () => ({
        region: { qid: 'Q7469', strategy: 'geo' },
        suggestion: { qid: 'Q62', label: 'San Francisco', via: 'p131' },
        needsConfirmation: true
      }))

      assert.instanceOf(error, CreateError)
      assert.include(error.message, 'San Francisco')

      const topics = await pool.query('SELECT COUNT(*) AS n FROM topics')
      assert.equal(Number(topics[0].n), 0)
    })

  it('reports a resolver failure as a form error rather than a crash', async function() {
    const { error } = await attempt({}, async () => { throw new Error('WDQS timed out') })

    assert.instanceOf(error, CreateError)
    assert.include(error.message, 'WDQS timed out')
  })
})
