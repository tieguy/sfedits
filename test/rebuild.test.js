const { assert } = require('chai')
const { it, before, beforeEach, after } = require('mocha')

const { connect, migrate, truncateAll, testDsn, describeWithDb } =
  require('./helpers/db-helper')
const { createTopicStore } = require('../lib/topic-store')
const { rebuildTopic, rebuildAll } = require('../lib/rebuild')

describeWithDb('rebuild', function() {
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

  /** Stub resolver standing in for lib/region.js, which Phase 1 tests cover. */
  function resolverReturning(articles) {
    return async () => ({
      region: { qid: 'Q62', label: 'San Francisco', strategy: 'admin' },
      articles
    })
  }

  it('populates an empty topic and reports every article as new', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    const result = await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ])
    })

    assert.deepEqual(result.added.sort(), ['Q10', 'Q20'])
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.newArticles.sort(), ['Q10', 'Q20'])
  })

  it('reports only genuinely new QIDs on a later rebuild', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])
    })

    const result = await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
        { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
      ])
    })

    assert.deepEqual(result.added, ['Q20'])
    assert.deepEqual(result.newArticles, ['Q20'],
      'a QID seen before is not a new article, even if it left and came back')
  })

  it('does not report a returning article as new', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })
    const alpha = [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]

    await rebuildTopic(store, topic.id, { resolver: resolverReturning(alpha) })
    await rebuildTopic(store, topic.id, { resolver: resolverReturning([]) })
    const result = await rebuildTopic(store, topic.id, { resolver: resolverReturning(alpha) })

    assert.deepEqual(result.added, ['Q10'])
    assert.deepEqual(result.newArticles, [])
  })

  it('follows a rename without losing membership', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Old Name', source: 'admin' }
      ])
    })

    const result = await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'New Name', source: 'admin' }
      ])
    })

    assert.deepEqual(result.added, [], 'a rename is not an addition')
    assert.deepEqual(result.removed, [], 'a rename is not a removal')
    assert.deepEqual(result.renamed, [{ qid: 'Q10', from: 'Old Name', to: 'New Name' }])

    const index = await store.getWatchIndex()
    assert.isTrue(index.byWiki.get('en').has('New Name'))
    assert.isFalse(index.byWiki.get('en').has('Old Name'))
  })

  it('leaves the topic untouched when the resolver fails', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })

    await rebuildTopic(store, topic.id, {
      resolver: resolverReturning([
        { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }
      ])
    })
    const before = await store.getTopic(topic.id)

    const result = await rebuildTopic(store, topic.id, {
      resolver: async () => { throw new Error('WDQS exploded') }
    })

    assert.isFalse(result.ok)
    assert.include(result.error, 'WDQS exploded')

    const after = await store.getTopic(topic.id)
    assert.equal(after.generation, before.generation,
      'a failed rebuild must not empty a working watchlist')

    const index = await store.getWatchIndex()
    assert.isTrue(index.byWiki.get('en').has('Alpha'))
  })

  it('refuses a partial result rather than deleting the missing articles',
    async function() {
      const topic = await store.upsertTopic('Q62', { languages: ['en'] })

      await rebuildTopic(store, topic.id, {
        resolver: resolverReturning([
          { qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' },
          { qid: 'Q20', wikipedia: 'en', title: 'Beta', source: 'admin' }
        ])
      })

      const result = await rebuildTopic(store, topic.id, {
        resolver: async () => ({
          region: { qid: 'Q62', strategy: 'admin' },
          articles: [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }],
          partial: true
        })
      })

      assert.isFalse(result.ok)
      assert.include(result.error, 'partial')

      const index = await store.getWatchIndex()
      assert.isTrue(index.byWiki.get('en').has('Beta'), 'Beta survives a partial rebuild')
    })

  it('refuses a region that only resolved to a containing region', async function() {
    const topic = await store.upsertTopic('Q7469', { languages: ['en'] })

    const result = await rebuildTopic(store, topic.id, {
      resolver: async () => ({
        region: { qid: 'Q7469', strategy: 'geo' },
        suggestion: { qid: 'Q62', label: 'San Francisco', via: 'p131' },
        needsConfirmation: true
      })
    })

    assert.isFalse(result.ok)
    assert.include(result.error, 'Q62',
      'the operator needs to know which container was suggested')
  })

  it('rebuilds every topic and keeps going after one fails', async function() {
    const good = await store.upsertTopic('Q62', { languages: ['en'] })
    const bad = await store.upsertTopic('Q99', { languages: ['en'] })

    const results = await rebuildAll(store, {
      resolver: async (regionQid) => {
        if (regionQid === 'Q99') throw new Error('nope')
        return {
          region: { qid: regionQid, strategy: 'admin' },
          articles: [{ qid: 'Q10', wikipedia: 'en', title: 'Alpha', source: 'admin' }]
        }
      }
    })

    assert.equal(results.length, 2)
    assert.isTrue(results.find(r => r.topicId === good.id).ok)
    assert.isFalse(results.find(r => r.topicId === bad.id).ok)
  })
})
