const { assert } = require('chai')
const { describe, it, before, beforeEach, after } = require('mocha')

const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const {
  normalizeFilters, filtersHash, connectionOptions, parseJsonColumn, createTopicStore
} = require('../lib/topic-store')

describe('topic-store', function() {
  describe('normalizeFilters', function() {
    it('sorts and lowercases languages', function() {
      const normalized = normalizeFilters({ languages: ['ES', 'en', 'de'] })
      assert.deepEqual(normalized.languages, ['de', 'en', 'es'])
    })

    it('sorts entity filters', function() {
      const normalized = normalizeFilters({ entityFilters: ['Q5', 'Q515', 'Q43229'] })
      assert.deepEqual(normalized.entityFilters, ['Q43229', 'Q5', 'Q515'])
    })

    it('drops duplicates', function() {
      const normalized = normalizeFilters({
        languages: ['en', 'en', 'es'],
        entityFilters: ['Q5', 'Q5']
      })
      assert.deepEqual(normalized.languages, ['en', 'es'])
      assert.deepEqual(normalized.entityFilters, ['Q5'])
    })

    it('represents "no filter" as null, not an empty array', function() {
      const normalized = normalizeFilters({})
      assert.isNull(normalized.languages)
      assert.isNull(normalized.entityFilters)
    })

    it('treats an empty array as no filter', function() {
      const normalized = normalizeFilters({ languages: [], entityFilters: [] })
      assert.isNull(normalized.languages)
      assert.isNull(normalized.entityFilters)
    })

    it('defaults strategy to auto', function() {
      assert.equal(normalizeFilters({}).strategy, 'auto')
      assert.equal(normalizeFilters({ strategy: 'admin' }).strategy, 'admin')
    })
  })

  describe('filtersHash', function() {
    it('collides for the same selection in a different order', function() {
      const a = filtersHash({ languages: ['en', 'es'], entityFilters: ['Q5', 'Q515'] })
      const b = filtersHash({ languages: ['es', 'en'], entityFilters: ['Q515', 'Q5'] })
      assert.equal(a, b)
    })

    it('differs when the selection differs', function() {
      const a = filtersHash({ languages: ['en'] })
      const b = filtersHash({ languages: ['en', 'es'] })
      assert.notEqual(a, b)
    })

    it('differs when the strategy differs', function() {
      assert.notEqual(
        filtersHash({ languages: ['en'], strategy: 'admin' }),
        filtersHash({ languages: ['en'], strategy: 'geo' }))
    })

    it('is a 64-character hex digest', function() {
      assert.match(filtersHash({ languages: ['en'] }), /^[0-9a-f]{64}$/)
    })
  })

  describe('connectionOptions', function() {
    it('falls back to the Toolforge build-service env vars', function() {
      const options = connectionOptions(
        { database: 's51234__sfedits' },
        { TOOL_TOOLSDB_USER: 's51234', TOOL_TOOLSDB_PASSWORD: 'secret' })

      assert.equal(options.user, 's51234')
      assert.equal(options.password, 'secret')
      assert.equal(options.host, 'tools.db.svc.wikimedia.cloud')
    })

    it('prefers explicit config over the environment', function() {
      const options = connectionOptions(
        { database: 'local', user: 'root', password: 'local-pw', host: '127.0.0.1' },
        { TOOL_TOOLSDB_USER: 'ignored', TOOL_TOOLSDB_PASSWORD: 'ignored' })

      assert.equal(options.user, 'root')
      assert.equal(options.host, '127.0.0.1')
    })

    it('throws a directive error when credentials are absent everywhere', function() {
      let error = null
      try {
        connectionOptions({ database: 'x' }, {})
      } catch (thrown) {
        error = thrown
      }

      assert.isNotNull(error, 'missing credentials must not pass silently')
      assert.include(error.message, 'TOOL_TOOLSDB_USER')
    })

    it('defaults the pool to the documented Toolforge budget', function() {
      const options = connectionOptions(
        { database: 'x' }, { TOOL_TOOLSDB_USER: 'u', TOOL_TOOLSDB_PASSWORD: 'p' })
      assert.equal(options.connectionLimit, 5)
    })
  })

  describe('parseJsonColumn', function() {
    it('passes an already-parsed value through', function() {
      assert.deepEqual(parseJsonColumn(['en', 'es']), ['en', 'es'])
    })

    it('parses a raw JSON string', function() {
      assert.deepEqual(parseJsonColumn('["en","es"]'), ['en', 'es'])
    })

    it('returns null rather than throwing on garbage', function() {
      assert.isNull(parseJsonColumn('not json'))
      assert.isNull(parseJsonColumn(null))
    })
  })
})

describeWithDb('topic-store (database)', function() {
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

  describe('upsertTopic', function() {
    it('creates a topic and returns its id', async function() {
      const topic = await store.upsertTopic('Q62', {
        languages: ['en'], entityFilters: ['Q515'], strategy: 'admin'
      })

      assert.isNumber(topic.id)
      assert.equal(topic.regionQid, 'Q62')
      assert.isTrue(topic.created)
    })

    it('returns the existing topic when the selection matches in another order',
      async function() {
        const first = await store.upsertTopic('Q62',
          { languages: ['en', 'es'], entityFilters: ['Q5', 'Q515'] })
        const second = await store.upsertTopic('Q62',
          { languages: ['es', 'en'], entityFilters: ['Q515', 'Q5'] })

        assert.equal(first.id, second.id)
        assert.isTrue(first.created)
        assert.isFalse(second.created)

        const rows = await pool.query('SELECT COUNT(*) AS n FROM topics')
        assert.equal(Number(rows[0].n), 1)
      })

    it('returns languages and filters as arrays, not raw JSON strings',
      async function() {
        const created = await store.upsertTopic('Q62', {
          languages: ['en', 'es'], entityFilters: ['Q515']
        })
        const fetched = await store.getTopic(created.id)

        assert.isArray(fetched.languages,
          'a raw string here would blow up the rebuild with "languages.map is not a function"')
        assert.deepEqual(fetched.languages, ['en', 'es'])
        assert.deepEqual(fetched.entityFilters, ['Q515'])
      })

    it('creates distinct topics for genuinely different selections', async function() {
      const a = await store.upsertTopic('Q62', { languages: ['en'] })
      const b = await store.upsertTopic('Q62', { languages: ['en', 'es'] })
      assert.notEqual(a.id, b.id)
    })
  })

  describe('setTopicArticles', function() {
    it('inserts memberships and shares article rows across topics', async function() {
      const a = await store.upsertTopic('Q62', { languages: ['en'] })
      const b = await store.upsertTopic('Q62', { languages: ['en', 'es'] })

      const articles = [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ]
      await store.setTopicArticles(a.id, articles)
      await store.setTopicArticles(b.id, articles)

      const articleRows = await pool.query('SELECT COUNT(*) AS n FROM articles')
      const membershipRows = await pool.query('SELECT COUNT(*) AS n FROM topic_articles')

      assert.equal(Number(articleRows[0].n), 2, 'article rows are shared, not duplicated')
      assert.equal(Number(membershipRows[0].n), 4)
    })

    it('marks departed articles removed rather than deleting them', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })

      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ])
      const diff = await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q30', wikipedia: 'en', title: 'Gamma', source: 'admin' }
      ])

      assert.deepEqual(diff.added, ['Q30'])
      assert.deepEqual(diff.removed, ['Q20'])

      const live = await pool.query(
        'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ? AND removed_at IS NULL',
        [topic.id])
      assert.equal(Number(live[0].n), 2)

      const gone = await pool.query(
        'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ? AND removed_at IS NOT NULL',
        [topic.id])
      assert.equal(Number(gone[0].n), 1)
    })

    it('revives an article that returns to the topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const alpha = [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]

      await store.setTopicArticles(topic.id, alpha)
      await store.setTopicArticles(topic.id, [])
      const diff = await store.setTopicArticles(topic.id, alpha)

      assert.deepEqual(diff.added, ['Q10'])

      const live = await pool.query(
        'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ? AND removed_at IS NULL',
        [topic.id])
      assert.equal(Number(live[0].n), 1)
    })

    it('bumps the generation for a rename, not only for adds and removes',
      async function() {
        const topic = await store.upsertTopic('Q62', { languages: ['en'] })
        await store.setTopicArticles(topic.id, [
          { qid: 'Q10', wikipedia: 'en', title: 'Old Name', source: 'admin' }
        ])
        const before = await store.getTopic(topic.id)

        const diff = await store.setTopicArticles(topic.id, [
          { qid: 'Q10', wikipedia: 'en', title: 'New Name', source: 'admin' }
        ])

        assert.deepEqual(diff.added, [], 'a rename is not an addition')
        assert.deepEqual(diff.removed, [], 'a rename is not a removal')
        assert.equal(diff.renamed, 1)

        const after = await store.getTopic(topic.id)
        assert.isAbove(Number(after.generation), Number(before.generation),
          'without this bump a running bot keeps matching the dead title')
      })

    it('bumps the generation on every change', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const before = await store.getTopic(topic.id)

      await store.setTopicArticles(topic.id, [
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])

      const after = await store.getTopic(topic.id)
      assert.isAbove(Number(after.generation), Number(before.generation))
    })

    it('leaves the generation alone when nothing changed', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const alpha = [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]

      await store.setTopicArticles(topic.id, alpha)
      const before = await store.getTopic(topic.id)
      await store.setTopicArticles(topic.id, alpha)
      const after = await store.getTopic(topic.id)

      assert.equal(Number(after.generation), Number(before.generation),
        'an unchanged rebuild must not force every bot to reload its index')
    })
  })

  describe('subscriptions', function() {
    it('adds a subscription and lists it by topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const sub = await store.addSubscription(topic.id, {
        ownerUser: 'Tieguy',
        deliveryType: 'discord',
        deliveryConfig: { webhook_url: 'https://discord.test/hook' },
        displayName: 'SF edits'
      })

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 1)
      assert.equal(subs[0].id, sub.id)
      assert.equal(subs[0].deliveryConfig.webhook_url, 'https://discord.test/hook')
    })

    it('lets two owners subscribe to one topic', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })
      await store.addSubscription(topic.id, {
        ownerUser: 'B', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://b' }
      })

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 2)

      const topics = await pool.query('SELECT COUNT(*) AS n FROM topics')
      assert.equal(Number(topics[0].n), 1, 'one shared topic, two subscriptions')
    })

    it('omits non-active subscriptions from delivery lists', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const sub = await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })

      await store.setSubscriptionStatus(sub.id, 'broken')

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 0)

      const all = await store.subscriptionsForTopic(topic.id, { includeInactive: true })
      assert.equal(all.length, 1)
      assert.equal(all[0].status, 'broken')
    })
  })

  describe('topic garbage collection', function() {
    it('deletes a topic when its last subscription goes away', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const first = await store.addSubscription(topic.id, {
        ownerUser: 'A', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })
      const second = await store.addSubscription(topic.id, {
        ownerUser: 'B', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://b' }
      })

      await store.removeSubscription(first.id)
      let remaining = await pool.query('SELECT COUNT(*) AS n FROM topics WHERE id = ?',
        [topic.id])
      assert.equal(Number(remaining[0].n), 1, 'topic survives while another sub references it')

      await store.removeSubscription(second.id)
      const collected = await store.collectOrphanTopics()
      assert.deepEqual(collected, [topic.id])

      remaining = await pool.query('SELECT COUNT(*) AS n FROM topics WHERE id = ?', [topic.id])
      assert.equal(Number(remaining[0].n), 0)
    })

    it('keeps the creator leaving from breaking everyone else', async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })
      const creator = await store.addSubscription(topic.id, {
        ownerUser: 'Creator', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://a' }
      })
      await store.addSubscription(topic.id, {
        ownerUser: 'Follower', deliveryType: 'discord', deliveryConfig: { webhook_url: 'https://b' }
      })

      await store.removeSubscription(creator.id)
      await store.collectOrphanTopics()

      const subs = await store.subscriptionsForTopic(topic.id)
      assert.equal(subs.length, 1)
      assert.equal(subs[0].ownerUser, 'Follower')
    })
  })
})
