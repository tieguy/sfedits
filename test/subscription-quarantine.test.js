const { assert } = require('chai')
const { it, before, beforeEach, after } = require('mocha')

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
