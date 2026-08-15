const { assert } = require('chai')
const { it, before, beforeEach, after } = require('mocha')

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

  /** An edit shaped the way lib/edit-stream.js shapes enwiki edits. */
  function enEdit(page) {
    return {
      wikipedia: 'English Wikipedia',
      wikipediaUrl: 'https://en.wikipedia.org',
      page
    }
  }

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
      index.topicsForEdit(enEdit('Alpha')), [topic.id])
  })

  it('matches an edit shaped the way the stream shapes it', async function() {
    // The store keys articles by language code ('es'); the live stream labels
    // edits with a display name ('Spanish Wikipedia'). Matching must not
    // depend on the label - only wikipediaUrl is common ground.
    const topic = await store.upsertTopic('Q717', { languages: ['es'] })
    await store.addSubscription(topic.id, {
      ownerUser: 'Tester',
      deliveryType: 'discord',
      deliveryConfig: { webhook_url: 'https://discord.test/hook' }
    })
    await store.setTopicArticles(topic.id, [
      { qid: 'Q1533', wikipedia: 'es', title: 'Caracas', source: 'admin' }
    ])

    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(
      index.topicsForEdit({
        wikipedia: 'Spanish Wikipedia',
        wikipediaUrl: 'https://es.wikipedia.org',
        page: 'Caracas'
      }),
      [topic.id])
  })

  it('returns an empty array for an unwatched title', async function() {
    await seedTopic(['Alpha'])
    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(index.topicsForEdit(enEdit('Unwatched')), [])
    assert.deepEqual(index.topicsForEdit({
      wikipedia: 'Spanish Wikipedia',
      wikipediaUrl: 'https://es.wikipedia.org',
      page: 'Alpha'
    }), [])
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
      index.topicsForEdit(enEdit('Shared')).sort(),
      [a.id, b.id].sort())
  })

  it('matches before any refresh has happened without throwing', function() {
    const index = createTopicIndex(store)
    assert.deepEqual(index.topicsForEdit(enEdit('Alpha')), [])
  })

  it('picks up new articles on refresh', async function() {
    const topic = await seedTopic(['Alpha'])
    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(index.topicsForEdit(enEdit('Gamma')), [])

    await store.setTopicArticles(topic.id, [
      { qid: 'Q100', wikipedia: 'en', title: 'Alpha', source: 'admin' },
      { qid: 'Q200', wikipedia: 'en', title: 'Gamma', source: 'admin' }
    ])
    await index.refresh()

    assert.deepEqual(index.topicsForEdit(enEdit('Gamma')), [topic.id])
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
      broken.topicsForEdit(enEdit('Alpha')), [topic.id],
      'a database blip must not silently empty the watchlist')
  })

  it('excludes topics that have no active subscription', async function() {
    const topic = await store.upsertTopic('Q62', { languages: ['en'] })
    await store.setTopicArticles(topic.id, [
      { qid: 'Q10', wikipedia: 'en', title: 'Orphan', source: 'admin' }
    ])

    const index = createTopicIndex(store)
    await index.refresh()

    assert.deepEqual(index.topicsForEdit(enEdit('Orphan')), [],
      'nobody is subscribed, so there is nothing to deliver')
  })
})
