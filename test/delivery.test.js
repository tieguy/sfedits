/**
 * Tests for lib/delivery.js - unified delivery layer
 *
 * Tests dispatch to platform modules, return value normalization,
 * replyTo pass-through, and config resolution.
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const nock = require('nock')

describe('lib/delivery', function() {
  this.timeout(5000)

  let delivery
  let screenshotPath

  beforeEach(function() {
    // Create a fake screenshot file for tests
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'))
    screenshotPath = path.join(dir, 'diff.png')
    fs.writeFileSync(screenshotPath, 'fake png bytes')

    // Load the real delivery module (no mocking)
    delivery = require('../lib/delivery')
  })

  afterEach(function() {
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath)
    nock.cleanAll()
  })

  describe('post()', function() {
    it('dispatches to bluesky platform and returns {type, postId, ref}', async function() {
      // Mock Bluesky authentication and post creation
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-access-token',
          refreshJwt: 'fake-refresh-token',
          did: 'did:plc:test',
          handle: 'test.bsky.social'
        })
        .post('/xrpc/com.atproto.repo.uploadBlob')
        .reply(200, {
          blob: {
            $type: 'blob',
            ref: { $link: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4' },
            mimeType: 'image/png',
            size: 1234
          }
        })
        .post('/xrpc/com.atproto.repo.createRecord')
        .reply(200, {
          uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      const result = await delivery.post(
        {
          type: 'bluesky',
          credentials: {
            identifier: 'test.bsky.social',
            password: 'fake-password'
          }
        },
        {
          text: 'Test edit',
          screenshot: screenshotPath,
          metadata: {
            page: 'Test',
            name: 'User',
            pageUrl: 'https://example.com/wiki/Test',
            userUrl: 'https://example.com/user'
          }
        }
      )

      assert.equal(result.type, 'bluesky')
      assert.equal(result.postId, 'at://did:plc:test/app.bsky.feed.post/abc123')
      assert.deepEqual(result.ref, {
        uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
        cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      })
    })

    it('passes replyTo through to bluesky platform', async function() {
      const replyTo = {
        root: { uri: 'at://did:plc:root/app.bsky.feed.post/root', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' },
        parent: { uri: 'at://did:plc:parent/app.bsky.feed.post/parent', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }
      }

      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'token',
          refreshJwt: 'refresh',
          did: 'did:plc:test',
          handle: 'test.bsky.social'
        })
        .post('/xrpc/com.atproto.repo.uploadBlob')
        .reply(200, {
          blob: {
            $type: 'blob',
            ref: { $link: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4' },
            mimeType: 'image/png',
            size: 1234
          }
        })
        .post('/xrpc/com.atproto.repo.createRecord', body => {
          // Verify replyTo was passed through to the platform
          assert.ok(body.record.reply, 'reply field should be present')
          assert.equal(body.record.reply.root.uri, replyTo.root.uri, 'root uri should match')
          assert.equal(body.record.reply.parent.cid, replyTo.parent.cid, 'parent cid should match')
          return true
        })
        .reply(200, {
          uri: 'at://did:plc:test/app.bsky.feed.post/reply123',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      const result = await delivery.post(
        {
          type: 'bluesky',
          credentials: { identifier: 'test.bsky.social', password: 'pass' }
        },
        {
          text: 'Reply',
          screenshot: screenshotPath,
          metadata: { page: 'Test', name: 'User', pageUrl: 'url', userUrl: 'url' },
          replyTo
        }
      )

      assert.equal(result.type, 'bluesky')
      assert.equal(result.postId, 'at://did:plc:test/app.bsky.feed.post/reply123')
    })

    it('dispatches to mastodon platform and returns normalized postId', async function() {
      // Mock Mastodon media upload
      nock('https://mastodon.social')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        // Mock Mastodon status posting
        .post('/api/v1/statuses')
        .reply(200, {
          id: '109383210193324631',
          uri: 'https://mastodon.social/@bot/109383210193324631'
        })

      const result = await delivery.post(
        {
          type: 'mastodon',
          credentials: {
            access_token: 'fake-token',
            instance: 'https://mastodon.social'
          }
        },
        {
          text: 'Test edit',
          screenshot: screenshotPath,
          metadata: {
            page: 'Test',
            name: 'User',
            pageUrl: 'https://example.com/wiki/Test',
            userUrl: 'https://example.com/user'
          }
        }
      )

      assert.equal(result.type, 'mastodon')
      assert.equal(result.postId, '109383210193324631')
      assert.equal(result.ref, '109383210193324631')
    })

    it('passes replyTo through to mastodon platform', async function() {
      nock('https://mastodon.social')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        .post('/api/v1/statuses')
        .reply(200, function(uri, requestBody) {
          // Verify in_reply_to_id appears in the form body
          if (requestBody && typeof requestBody === 'string') {
            assert.include(requestBody, 'in_reply_to_id=12345', 'form body should include in_reply_to_id')
          }
          return {
            id: '109383210193324631',
            uri: 'https://mastodon.social/@bot/109383210193324631'
          }
        })

      const result = await delivery.post(
        {
          type: 'mastodon',
          credentials: {
            access_token: 'fake-token',
            instance: 'https://mastodon.social'
          }
        },
        {
          text: 'Reply',
          screenshot: screenshotPath,
          metadata: {
            page: 'Test',
            name: 'User',
            pageUrl: 'https://example.com/wiki/Test',
            userUrl: 'https://example.com/user'
          },
          replyTo: '12345'
        }
      )

      assert.equal(result.type, 'mastodon')
      assert.equal(result.postId, '109383210193324631')
    })

    it('dispatches to discord platform and returns normalized postId', async function() {
      // Mock Discord webhook POST with ?wait=true query parameter
      nock('https://discord.com')
        .post('/api/webhooks/123/token', () => true)
        .query(true)
        .reply(200, { id: 'message-id-123', channel_id: 'channel-123' })

      const result = await delivery.post(
        {
          type: 'discord',
          credentials: {
            webhook_url: 'https://discord.com/api/webhooks/123/token'
          }
        },
        {
          text: 'Test edit',
          screenshot: screenshotPath,
          metadata: {
            page: 'Test',
            name: 'User',
            pageUrl: 'https://example.com/wiki/Test',
            userUrl: 'https://example.com/user'
          }
        }
      )

      assert.equal(result.type, 'discord')
      assert.equal(result.postId, 'message-id-123')
      assert.equal(result.ref, 'message-id-123')
    })

    it('throws error for unknown delivery type', async function() {
      try {
        await delivery.post(
          {
            type: 'unknown-platform',
            credentials: {}
          },
          {
            text: 'Test',
            screenshot: '/tmp/test.png',
            metadata: {}
          }
        )
        assert.fail('Should have thrown')
      } catch (error) {
        assert.match(error.message, /unknown|unsupported/i)
      }
    })

    it('returns null on webhook validation failure (not https)', async function() {
      const result = await delivery.post(
        {
          type: 'discord',
          credentials: {
            webhook_url: 'http://example.com/webhook'  // Invalid: not https
          }
        },
        {
          text: 'Test',
          screenshot: screenshotPath,
          metadata: {}
        }
      )

      assert.isNull(result)
    })

    it('returns null when webhook host is not in allowlist', async function() {
      // SSRF guard: only Discord webhook hosts are allowed
      const result = await delivery.post(
        {
          type: 'discord',
          credentials: {
            webhook_url: 'https://evil.example/api/webhooks/1/token'  // Wrong host
          }
        },
        {
          text: 'Test',
          screenshot: screenshotPath,
          metadata: {}
        }
      )

      assert.isNull(result)
    })

    it('returns null when webhook path is not a Discord webhook path', async function() {
      // Path validation guard
      const result = await delivery.post(
        {
          type: 'discord',
          credentials: {
            webhook_url: 'https://discord.com/api/users/123'  // Wrong path
          }
        },
        {
          text: 'Test',
          screenshot: screenshotPath,
          metadata: {}
        }
      )

      assert.isNull(result)
    })
  })

  describe('resolveConfigDeliveries()', function() {
    it('returns empty array when account has no deliveries', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' }
      }

      const resolved = delivery.resolveConfigDeliveries(account)

      assert.isArray(resolved)
      assert.equal(resolved.length, 0)
    })

    it('maps delivery entries with default credential_ref', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.social' },
        discord: { webhook_url: 'https://discord.com/api/webhooks/123/token' },
        deliveries: [
          { type: 'bluesky' },
          { type: 'mastodon' },
          { type: 'discord' }
        ]
      }

      const resolved = delivery.resolveConfigDeliveries(account)

      // Should return an array of three resolved deliveries
      assert.equal(resolved.length, 3)
      assert.deepEqual(resolved[0].credentials, account.bluesky)
      assert.deepEqual(resolved[1].credentials, account.mastodon)
      assert.deepEqual(resolved[2].credentials, account.discord)
    })

    it('maps delivery entries with explicit credential_ref', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        bluesky_alt: { identifier: 'alt.bsky.social', password: 'pass2' },
        deliveries: [
          { type: 'bluesky', credential_ref: 'bluesky' },
          { type: 'bluesky', credential_ref: 'bluesky_alt' }
        ]
      }

      const resolved = delivery.resolveConfigDeliveries(account)

      assert.equal(resolved.length, 2)
      assert.deepEqual(resolved[0].credentials, account.bluesky)
      assert.deepEqual(resolved[1].credentials, account.bluesky_alt)
    })

    it('throws when credentials stanza is missing', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        deliveries: [
          { type: 'mastodon' }  // mastodon credentials missing
        ]
      }

      try {
        delivery.resolveConfigDeliveries(account)
        assert.fail('Should have thrown')
      } catch (error) {
        assert.match(error.message, /missing|not found|undefined/i)
      }
    })

    it('throws when credential_ref points to missing stanza', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        deliveries: [
          { type: 'bluesky', credential_ref: 'nonexistent' }
        ]
      }

      try {
        delivery.resolveConfigDeliveries(account)
        assert.fail('Should have thrown')
      } catch (error) {
        assert.match(error.message, /missing|not found|undefined|nonexistent/i)
      }
    })

    it('preserves template and edit_filters in resolved delivery', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        deliveries: [
          {
            type: 'bluesky',
            template: 'Custom {{template}}',
            edit_filters: { minorEdit: true }
          }
        ]
      }

      const resolved = delivery.resolveConfigDeliveries(account)

      assert.equal(resolved.length, 1)
      assert.equal(resolved[0].template, 'Custom {{template}}')
      assert.deepEqual(resolved[0].edit_filters, { minorEdit: true })
    })
  })
})
