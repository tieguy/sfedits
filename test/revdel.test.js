const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')

const nock = require('nock')
const { extractRevisionInfo, recordPost, loadActive, updateEntries, entryDeliveries } = require('../lib/post-log')
const { classifyRevisions, decideActions, deletePosts } = require('../lib/revdel-check')

describe('post-log', function() {
  let logFile

  beforeEach(function() {
    logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'postlog-')), 'posted-log.jsonl')
  })

  afterEach(function() {
    fs.rmSync(path.dirname(logFile), { recursive: true, force: true })
  })

  describe('extractRevisionInfo', function() {
    it('extracts host and revision id from a diff URL', function() {
      assert.deepEqual(
        extractRevisionInfo('https://en.wikipedia.org/w/index.php?diff=123&oldid=456'),
        { host: 'en.wikipedia.org', revId: 123 }
      )
    })

    it('returns null for URLs without a numeric diff', function() {
      assert.isNull(extractRevisionInfo('https://en.wikipedia.org/w/index.php?diff=prev&oldid=456'))
      assert.isNull(extractRevisionInfo('not a url'))
    })
  })

  describe('recordPost / loadActive', function() {
    it('round-trips a posted entry', function() {
      recordPost({
        diffUrl: 'https://en.wikipedia.org/w/index.php?diff=111&oldid=110',
        page: 'Cat',
        blueskyUri: 'at://did:plc:x/app.bsky.feed.post/abc',
        mastodonId: '42'
      }, logFile)

      const active = loadActive(30, logFile)
      assert.lengthOf(active, 1)
      assert.equal(active[0].revId, 111)
      assert.equal(active[0].host, 'en.wikipedia.org')
      assert.equal(active[0].blueskyUri, 'at://did:plc:x/app.bsky.feed.post/abc')
      assert.equal(active[0].mastodonId, '42')
      assert.equal(active[0].status, 'active')
      assert.equal(active[0].missingCount, 0)
    })

    it('(Task 3e) entryDeliveries: new format passthrough', function() {
      const entry = {
        host: 'en.wikipedia.org',
        revId: 123,
        page: 'Test',
        status: 'active',
        deliveries: [
          { type: 'bluesky', postId: 'at://uri', deleted: false },
          { type: 'mastodon', postId: '999', deleted: false },
          { type: 'discord', postId: 'msg-123', subscriptionId: 456, deleted: false }
        ]
      }

      const deliveries = entryDeliveries(entry)

      assert.lengthOf(deliveries, 3)
      assert.deepEqual(deliveries[0], { type: 'bluesky', postId: 'at://uri', deleted: false })
      assert.deepEqual(deliveries[2], { type: 'discord', postId: 'msg-123', subscriptionId: 456, deleted: false })
    })

    it('(Task 3e) entryDeliveries: legacy format mapping', function() {
      const entry = {
        host: 'en.wikipedia.org',
        revId: 456,
        page: 'Test',
        status: 'active',
        blueskyUri: 'at://legacy-uri',
        blueskyDeleted: false,
        mastodonId: '888',
        mastodonDeleted: true,
        discordMessageId: 'msg-456',
        discordDeleted: false
      }

      const deliveries = entryDeliveries(entry)

      assert.lengthOf(deliveries, 3)
      assert.deepEqual(deliveries[0], { type: 'bluesky', postId: 'at://legacy-uri', deleted: false })
      assert.deepEqual(deliveries[1], { type: 'mastodon', postId: '888', deleted: true })
      assert.deepEqual(deliveries[2], { type: 'discord', postId: 'msg-456', deleted: false })
    })

    it('returns null and records nothing for an unparseable URL', function() {
      const entry = recordPost({ diffUrl: 'garbage', page: 'Cat' }, logFile)
      assert.isNull(entry)
      assert.lengthOf(loadActive(30, logFile), 0)
    })

    it('excludes deleted entries and entries older than the window', function() {
      recordPost({ diffUrl: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=0', page: 'A' }, logFile)
      recordPost({ diffUrl: 'https://en.wikipedia.org/w/index.php?diff=2&oldid=1', page: 'B' }, logFile)

      const [first] = loadActive(30, logFile)
      updateEntries([{ ...first, status: 'deleted' }], logFile)

      const active = loadActive(30, logFile)
      assert.lengthOf(active, 1)
      assert.equal(active[0].revId, 2)

      // Age out the remaining entry
      updateEntries([{ ...active[0], postedAt: new Date(Date.now() - 40 * 86400000).toISOString() }], logFile)
      assert.lengthOf(loadActive(30, logFile), 0)
    })

    it('updateEntries modifies only matching entries', function() {
      recordPost({ diffUrl: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=0', page: 'A' }, logFile)
      recordPost({ diffUrl: 'https://fr.wikipedia.org/w/index.php?diff=1&oldid=0', page: 'A-fr' }, logFile)

      const entries = loadActive(30, logFile)
      const target = entries.find(e => e.host === 'fr.wikipedia.org')
      updateEntries([{ ...target, missingCount: 1 }], logFile)

      const after = loadActive(30, logFile)
      assert.equal(after.find(e => e.host === 'fr.wikipedia.org').missingCount, 1)
      assert.equal(after.find(e => e.host === 'en.wikipedia.org').missingCount, 0)
    })
  })
})

describe('revdel-check', function() {

  describe('classifyRevisions', function() {
    it('classifies visible, hidden, and missing revisions', function() {
      const response = {
        query: {
          pages: [{
            revisions: [
              { revid: 1, user: 'Alice', sha1: 'abc' },
              { revid: 2, texthidden: true, sha1hidden: true },
              { revid: 3, userhidden: true, user: undefined, sha1: 'def' }
            ]
          }],
          badrevids: { 4: { revid: 4 } }
        }
      }
      const result = classifyRevisions(response, [1, 2, 3, 4])
      assert.equal(result.get(1), 'visible')
      assert.equal(result.get(2), 'hidden')
      assert.equal(result.get(3), 'hidden')
      assert.equal(result.get(4), 'missing')
    })

    it('treats suppressed revisions as hidden', function() {
      const response = {
        query: { pages: [{ revisions: [{ revid: 7, suppressed: true }] }] }
      }
      assert.equal(classifyRevisions(response, [7]).get(7), 'hidden')
    })

    it('treats revisions absent from the response as missing', function() {
      const response = { query: { pages: [] } }
      assert.equal(classifyRevisions(response, [9]).get(9), 'missing')
    })
  })

  describe('decideActions', function() {
    const entry = (revId, missingCount = 0) => ({
      host: 'en.wikipedia.org', revId, page: 'Cat', status: 'active', missingCount
    })

    it('deletes immediately on the affirmative hidden signal', function() {
      const { toDelete, toUpdate } = decideActions(
        [entry(1)],
        new Map([[1, 'hidden']])
      )
      assert.lengthOf(toDelete, 1)
      assert.equal(toDelete[0].reason, 'hidden')
      assert.lengthOf(toUpdate, 0)
    })

    it('waits for a second consecutive missing before deleting', function() {
      const first = decideActions([entry(1)], new Map([[1, 'missing']]))
      assert.lengthOf(first.toDelete, 0)
      assert.equal(first.toUpdate[0].missingCount, 1)

      const second = decideActions([entry(1, 1)], new Map([[1, 'missing']]))
      assert.lengthOf(second.toDelete, 1)
      assert.equal(second.toDelete[0].reason, 'missing')
    })

    it('resets the missing counter when the revision reappears', function() {
      const { toDelete, toUpdate } = decideActions(
        [entry(1, 1)],
        new Map([[1, 'visible']])
      )
      assert.lengthOf(toDelete, 0)
      assert.equal(toUpdate[0].missingCount, 0)
    })

    it('makes no changes for unclassified entries (failed query batch)', function() {
      const { toDelete, toUpdate } = decideActions([entry(1, 1)], new Map())
      assert.lengthOf(toDelete, 0)
      assert.lengthOf(toUpdate, 0)
    })

    it('leaves untouched visible entries out of the update list', function() {
      const { toDelete, toUpdate } = decideActions(
        [entry(1, 0)],
        new Map([[1, 'visible']])
      )
      assert.lengthOf(toDelete, 0)
      assert.lengthOf(toUpdate, 0)
    })
  })
  describe('deletePosts', function() {
    const WEBHOOK = 'https://discord.com/api/webhooks/123/token-abc'

    afterEach(function() {
      nock.cleanAll()
    })

    describe('legacy format (Discord)', function() {
      const baseEntry = {
        host: 'en.wikipedia.org', revId: 1, page: 'Cat', status: 'active',
        reason: 'hidden', discordMessageId: '111222333'
      }

      it('deletes the webhook message and completes the entry', async function() {
        nock('https://discord.com')
          .delete('/api/webhooks/123/token-abc/messages/111222333')
          .reply(204)

        const updated = await deletePosts({ ...baseEntry }, { discord: { webhook_url: WEBHOOK } })
        assert.isTrue(updated.discordDeleted)
        assert.equal(updated.status, 'deleted')
      })

      it('treats 404 (already gone) as success', async function() {
        nock('https://discord.com')
          .delete('/api/webhooks/123/token-abc/messages/111222333')
          .reply(404)

        const updated = await deletePosts({ ...baseEntry }, { discord: { webhook_url: WEBHOOK } })
        assert.isTrue(updated.discordDeleted)
        assert.equal(updated.status, 'deleted')
      })

      it('keeps the entry active on server errors so it retries', async function() {
        nock('https://discord.com')
          .delete('/api/webhooks/123/token-abc/messages/111222333')
          .reply(500)

        const updated = await deletePosts({ ...baseEntry }, { discord: { webhook_url: WEBHOOK } })
        assert.notOk(updated.discordDeleted)
        assert.equal(updated.status, 'active')
      })

      it('completes with a warning when no webhook is configured anymore', async function() {
        const updated = await deletePosts({ ...baseEntry }, {})
        assert.isTrue(updated.discordDeleted)
        assert.equal(updated.status, 'deleted')
      })
    })

    describe('new deliveries format (Task 4)', function() {
      it('(Task 4l) topicStore absent when subscription delivery needs it', async function() {
        const entry = {
          host: 'en.wikipedia.org',
          revId: 127,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          deliveries: [
            { type: 'discord', postId: 'msg-noop', subscriptionId: 777, deleted: false }
          ]
        }

        let loggedWarning = null
        const originalConsoleWarn = console.warn
        console.warn = function(...args) {
          loggedWarning = args.join(' ')
        }

        const account = {}
        // topicStore is null - should NOT mark delivery deleted, just retry later

        const updated = await deletePosts(entry, account, null)

        console.warn = originalConsoleWarn

        // Delivery should stay deleted:false (not marked deleted, will retry)
        assert.isFalse(updated.deliveries[0].deleted, 'Delivery should NOT be marked deleted when topicStore absent')
        // Entry should stay active (nothing was successfully deleted yet)
        assert.equal(updated.status, 'active', 'Entry should stay active when topicStore absent')
        assert.ok(loggedWarning, 'Should log a warning')
        assert.include(loggedWarning.toLowerCase(), 'not available')
      })

      it('(Task 4j) missing subscription marks delivery deleted + logs', async function() {
        const entry = {
          host: 'en.wikipedia.org',
          revId: 125,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          deliveries: [
            { type: 'discord', postId: 'msg-999', subscriptionId: 404, deleted: false }
          ]
        }

        let loggedError = null
        const originalConsoleError = console.error
        console.error = function(...args) {
          loggedError = args.join(' ')
        }

        const account = {}
        const mockTopicStore = {
          subscriptionById: async () => null  // Subscription not found
        }

        const updated = await deletePosts(entry, account, mockTopicStore)

        console.error = originalConsoleError

        // Should mark as deleted without throwing
        assert.isTrue(updated.deliveries[0].deleted)
        assert.ok(loggedError, 'Should log an error about missing subscription')
        assert.include(loggedError, 'not found')
      })

      it('(Task 4k) legacy-shape entry can be processed', async function() {
        const entry = {
          host: 'en.wikipedia.org',
          revId: 126,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          blueskyUri: 'at://legacy-uri',
          blueskyDeleted: false,
          discordMessageId: 'msg-legacy-123',
          discordDeleted: false
        }

        // Simulate successful Discord deletion for legacy entry
        nock('https://discord.com')
          .delete('/api/webhooks/111/token/messages/msg-legacy-123')
          .reply(204)

        const account = {
          discord: { webhook_url: 'https://discord.com/api/webhooks/111/token' }
        }

        const updated = await deletePosts(entry, account)

        // Discord should be marked deleted
        assert.isTrue(updated.discordDeleted)
      })

      it('(CRITICAL 3) zero-delivery entry marked as deleted with oddity log', async function() {
        const entry = {
          host: 'en.wikipedia.org',
          revId: 999,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          deliveries: []  // No deliveries - vacuously complete
        }

        let loggedMessage = null
        const originalConsoleLog = console.log
        console.log = function(...args) {
          const msg = args.join(' ')
          if (msg.includes('zero-delivery')) {
            loggedMessage = msg
          }
        }

        const account = {}

        const updated = await deletePosts(entry, account)

        console.log = originalConsoleLog

        // Entry should be marked deleted (vacuously - nothing to take down)
        assert.equal(updated.status, 'deleted', 'Zero-delivery entry should be marked deleted')
        assert.ok(updated.deletedAt, 'deletedAt timestamp should be set')
        assert.ok(loggedMessage, 'Should log oddity message about zero-delivery entry')
      })

      it('(IMPORTANT 5) legacy entry with blueskyUri but no bluesky stanza stays active', async function() {
        const entry = {
          host: 'en.wikipedia.org',
          revId: 128,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          blueskyUri: 'at://legacy-uri',
          blueskyDeleted: false,
          discordMessageId: 'msg-legacy-456',
          discordDeleted: false
        }

        // Only Discord webhook available (no bluesky stanza)
        nock('https://discord.com')
          .delete('/api/webhooks/222/token/messages/msg-legacy-456')
          .reply(204)

        const account = {
          discord: { webhook_url: 'https://discord.com/api/webhooks/222/token' }
          // NOTE: no bluesky stanza, even though entry has blueskyUri
        }

        const updated = await deletePosts(entry, account)

        // Discord should be deleted (successfully)
        assert.isTrue(updated.discordDeleted, 'Discord should be marked deleted')
        // But entry should stay ACTIVE because bluesky stanza missing - can't delete bluesky post
        // This is the legacy partial-failure contract
        assert.equal(updated.status, 'active', 'Entry should stay active: partial failure (discord deleted, bluesky not)')
      })

      it('(Task 4h) mixed entry: account bluesky + subscription discord both deleted', async function() {
        const mockTopicStore = {
          subscriptionById: async (id) => {
            if (id === 777) {
              return {
                id: 777,
                deliveryConfig: {
                  webhook_url: 'https://discord.com/api/webhooks/sub-hook/token-sub'
                }
              }
            }
            return null
          }
        }

        const entry = {
          host: 'en.wikipedia.org',
          revId: 200,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          deliveries: [
            { type: 'bluesky', postId: 'at://did:plc:test/app.bsky.feed.post/blue200', deleted: false },
            { type: 'discord', postId: 'discord-msg-777', subscriptionId: 777, deleted: false }
          ]
        }

        const blueskyScope = nock('https://bsky.social')
          .post('/xrpc/com.atproto.server.createSession')
          .reply(200, { accessJwt: 'token', refreshJwt: 'refresh', did: 'did:plc:test', handle: 'test.bsky.social' })
          .post('/xrpc/com.atproto.repo.deleteRecord')
          .reply(200, {})

        const discordScope = nock('https://discord.com')
          .delete('/api/webhooks/sub-hook/token-sub/messages/discord-msg-777')
          .reply(204)

        const account = {
          bluesky: { identifier: 'test.bsky.social', password: 'pass', service: 'https://bsky.social' }
        }

        const updated = await deletePosts(entry, account, mockTopicStore)

        assert.isTrue(blueskyScope.isDone(), 'Bluesky delete should be called')
        assert.isTrue(discordScope.isDone(), 'Discord webhook delete should be called')
        assert.isTrue(updated.deliveries[0].deleted, 'Bluesky delivery should be marked deleted')
        assert.isTrue(updated.deliveries[1].deleted, 'Discord subscription delivery should be marked deleted')
        assert.equal(updated.status, 'deleted', 'Entry should be marked deleted when all deliveries deleted')
      })

      it('(Task 4i) partial failure: bluesky 500, discord succeeds, retry only bluesky next sweep', async function() {
        const mockTopicStore = {
          subscriptionById: async (id) => {
            if (id === 888) {
              return {
                id: 888,
                deliveryConfig: { webhook_url: 'https://discord.com/api/webhooks/sub-hook/token-sub' }
              }
            }
            return null
          }
        }

        const entry = {
          host: 'en.wikipedia.org',
          revId: 201,
          page: 'Test',
          status: 'active',
          reason: 'hidden',
          deliveries: [
            { type: 'bluesky', postId: 'at://did:plc:test/app.bsky.feed.post/blue201', deleted: false },
            { type: 'discord', postId: 'discord-msg-888', subscriptionId: 888, deleted: false }
          ]
        }

        // First sweep: Bluesky fails with 500, Discord succeeds
        const blueskyScope1 = nock('https://bsky.social')
          .post('/xrpc/com.atproto.server.createSession')
          .reply(200, { accessJwt: 'token', refreshJwt: 'refresh', did: 'did:plc:test', handle: 'test.bsky.social' })
          .post('/xrpc/com.atproto.repo.deleteRecord')
          .reply(500, { error: 'Server error' })

        const discordScope1 = nock('https://discord.com')
          .delete('/api/webhooks/sub-hook/token-sub/messages/discord-msg-888')
          .reply(204)

        const account = {
          bluesky: { identifier: 'test.bsky.social', password: 'pass', service: 'https://bsky.social' }
        }

        const updated1 = await deletePosts(entry, account, mockTopicStore)

        // After first sweep: Discord should be deleted, Bluesky should NOT
        assert.isTrue(blueskyScope1.isDone(), 'Bluesky delete should be attempted')
        assert.isTrue(discordScope1.isDone(), 'Discord delete should succeed')
        assert.isFalse(updated1.deliveries[0].deleted, 'Bluesky should NOT be marked deleted after 500')
        assert.isTrue(updated1.deliveries[1].deleted, 'Discord should be marked deleted')
        assert.equal(updated1.status, 'active', 'Entry should stay active: partial failure')

        // Second sweep: Only Bluesky (Discord endpoint should NOT be hit)
        const blueskyScope2 = nock('https://bsky.social')
          .post('/xrpc/com.atproto.server.createSession')
          .reply(200, { accessJwt: 'token', refreshJwt: 'refresh', did: 'did:plc:test', handle: 'test.bsky.social' })
          .post('/xrpc/com.atproto.repo.deleteRecord')
          .reply(200, {})

        const discordScope2 = nock('https://discord.com')
          .delete('/api/webhooks/sub-hook/token-sub/messages/discord-msg-888')
          .reply(204)

        // Second delete call should only retry the Bluesky delivery
        const updated2 = await deletePosts(updated1, account, mockTopicStore)

        assert.isTrue(blueskyScope2.isDone(), 'Bluesky delete should succeed on retry')
        // Discord endpoint should NOT have been hit (scope2 should not be done)
        assert.isFalse(discordScope2.isDone(), 'Discord should NOT be called again (already deleted)')
        assert.isTrue(updated2.deliveries[0].deleted, 'Bluesky should be marked deleted on success')
        assert.isTrue(updated2.deliveries[1].deleted, 'Discord should still be marked deleted')
        assert.equal(updated2.status, 'deleted', 'Entry should be marked deleted after retry succeeds')
      })
    })
  })
})
