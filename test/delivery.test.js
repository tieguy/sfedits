/**
 * Tests for lib/delivery.js - unified delivery layer
 *
 * Tests dispatch to platform modules, return value normalization,
 * replyTo pass-through, and config resolution.
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const proxyquire = require('proxyquire')

describe('lib/delivery', function() {
  this.timeout(5000)

  let delivery
  let mockBluesky
  let mockMastodon
  let mockDiscord
  let mockSubscriptionDelivery

  beforeEach(function() {
    // Mock platform modules
    mockBluesky = {
      post: async (opts) => ({
        uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
        cid: 'bafkreiabc123'
      })
    }

    mockMastodon = {
      post: async (opts) => ({
        id: '109383210193324631',
        uri: 'https://mastodon.social/@bot/109383210193324631'
      })
    }

    mockDiscord = {
      post: async (opts) => ({
        id: 'message-id-123',
        channel_id: 'channel-123'
      })
    }

    mockSubscriptionDelivery = {
      validateWebhookUrl: (url) => {
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:') {
            return { valid: false, reason: `protocol ${parsed.protocol} is not https` }
          }
          return { valid: true }
        } catch {
          return { valid: false, reason: 'not a valid URL' }
        }
      }
    }

    // Load delivery module with mocked dependencies
    delivery = proxyquire('../lib/delivery', {
      './bluesky-platform': mockBluesky,
      './mastodon-platform': mockMastodon,
      './discord-platform': mockDiscord,
      './subscription-delivery': mockSubscriptionDelivery
    })
  })

  describe('post()', function() {
    it('dispatches to bluesky platform and returns {type, postId, ref}', async function() {
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
          screenshot: '/tmp/test.png',
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
        cid: 'bafkreiabc123'
      })
    })

    it('passes replyTo through untouched to bluesky platform', async function() {
      let capturedReplyTo = null

      mockBluesky.post = async (opts) => {
        capturedReplyTo = opts.replyTo
        return {
          uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
          cid: 'bafkreiabc123'
        }
      }

      const replyTo = {
        root: { uri: 'at://did:plc:root/app.bsky.feed.post/root', cid: 'root-cid' },
        parent: { uri: 'at://did:plc:parent/app.bsky.feed.post/parent', cid: 'parent-cid' }
      }

      // Reload to get the new mock
      delivery = proxyquire('../lib/delivery', {
        './bluesky-platform': mockBluesky,
        './mastodon-platform': mockMastodon,
        './discord-platform': mockDiscord,
        './subscription-delivery': mockSubscriptionDelivery
      })

      await delivery.post(
        {
          type: 'bluesky',
          credentials: { identifier: 'test.bsky.social', password: 'pass' }
        },
        {
          text: 'Reply',
          screenshot: '/tmp/test.png',
          metadata: { page: 'Test', name: 'User', pageUrl: 'url', userUrl: 'url' },
          replyTo
        }
      )

      assert.deepEqual(capturedReplyTo, replyTo)
    })

    it('dispatches to mastodon platform and returns normalized postId', async function() {
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
          screenshot: '/tmp/test.png',
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

    it('dispatches to discord platform and returns normalized postId', async function() {
      const result = await delivery.post(
        {
          type: 'discord',
          credentials: {
            webhook_url: 'https://discord.com/api/webhooks/123/token'
          }
        },
        {
          text: 'Test edit',
          screenshot: '/tmp/test.png',
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

    it('returns null on handled failure (discord webhook validation)', async function() {
      const result = await delivery.post(
        {
          type: 'discord',
          credentials: {
            webhook_url: 'http://example.com/webhook'  // Invalid: not https
          }
        },
        {
          text: 'Test',
          screenshot: '/tmp/test.png',
          metadata: {}
        }
      )

      assert.isNull(result)
    })
  })

  describe('resolveConfigDeliveries()', function() {
    it('maps delivery entries with default credential_ref', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.social' },
        discord: { webhook_url: 'https://discord.com/api/webhooks/123/token' }
      }

      const deliveries = [
        { type: 'bluesky' },
        { type: 'mastodon' },
        { type: 'discord' }
      ]

      const resolved = deliveries.map(d => delivery.resolveConfigDeliveries(account, d))

      // Each should have the credentials resolved
      assert.deepEqual(resolved[0].credentials, account.bluesky)
      assert.deepEqual(resolved[1].credentials, account.mastodon)
      assert.deepEqual(resolved[2].credentials, account.discord)
    })

    it('maps delivery entries with explicit credential_ref', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' },
        bluesky_alt: { identifier: 'alt.bsky.social', password: 'pass2' }
      }

      const delivery1 = { type: 'bluesky', credential_ref: 'bluesky' }
      const delivery2 = { type: 'bluesky', credential_ref: 'bluesky_alt' }

      const resolved1 = delivery.resolveConfigDeliveries(account, delivery1)
      const resolved2 = delivery.resolveConfigDeliveries(account, delivery2)

      assert.deepEqual(resolved1.credentials, account.bluesky)
      assert.deepEqual(resolved2.credentials, account.bluesky_alt)
    })

    it('throws when credentials stanza is missing', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' }
      }

      const deliveryEntry = { type: 'mastodon' }  // mastodon credentials missing

      try {
        delivery.resolveConfigDeliveries(account, deliveryEntry)
        assert.fail('Should have thrown')
      } catch (error) {
        assert.match(error.message, /missing|not found|undefined/i)
      }
    })

    it('throws when credential_ref points to missing stanza', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' }
      }

      const deliveryEntry = { type: 'bluesky', credential_ref: 'nonexistent' }

      try {
        delivery.resolveConfigDeliveries(account, deliveryEntry)
        assert.fail('Should have thrown')
      } catch (error) {
        assert.match(error.message, /missing|not found|undefined|nonexistent/i)
      }
    })

    it('preserves template and edit_filters in resolved delivery', function() {
      const account = {
        bluesky: { identifier: 'bot.bsky.social', password: 'pass' }
      }

      const deliveryEntry = {
        type: 'bluesky',
        template: 'Custom {{template}}',
        edit_filters: { minorEdit: true }
      }

      const resolved = delivery.resolveConfigDeliveries(account, deliveryEntry)

      assert.equal(resolved.template, 'Custom {{template}}')
      assert.deepEqual(resolved.edit_filters, { minorEdit: true })
    })
  })
})
