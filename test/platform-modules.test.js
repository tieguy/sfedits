/**
 * Platform modules tests
 *
 * Tests for Bluesky and Mastodon platform abstraction modules.
 * These modules centralize posting logic and were extracted to eliminate
 * ~100 lines of duplicated code across page-watch.js and admin/server.js.
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')

describe('Platform Modules', function() {
  // Increase timeout for integration tests
  this.timeout(5000)

  let blueskyPlatform
  let mastodonPlatform
  let testScreenshot

  beforeEach(function() {
    // Create a fake screenshot file for testing
    // Per-process temp path: fixed __dirname paths made two concurrent
    // runs in one worktree delete each other's fixtures (LUI-119).
    testScreenshot = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'sfedits-test-')), 'screenshot.png')
    fs.writeFileSync(testScreenshot, 'fake image data')

    // Load modules fresh for each test
    blueskyPlatform = require('../lib/bluesky-platform')
    mastodonPlatform = require('../lib/mastodon-platform')
  })

  afterEach(function() {
    // Clean up test files
    if (fs.existsSync(testScreenshot)) {
      fs.unlinkSync(testScreenshot)
    }

    // Clean up nock
    nock.cleanAll()
  })

  describe('bluesky-platform', function() {
    it('posts to Bluesky with screenshot and facets', async function() {
      // Mock Bluesky API (must include refreshJwt per Bluesky API spec)
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-jwt-token',
          refreshJwt: 'fake-refresh-token',
          did: 'did:plc:fake123',
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
          uri: 'at://did:plc:fake123/app.bsky.feed.post/3kjqrstuqwdz2',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      const result = await blueskyPlatform.post({
        account: {
          identifier: 'test.bsky.social',
          password: 'fake-app-password'
        },
        text: 'Test article edited by User https://en.wikipedia.org/diff/123',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test article',
          name: 'User',
          pageUrl: 'https://en.wikipedia.org/wiki/Test_article',
          userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/User'
        }
      })

      assert.ok(result)
      assert.equal(result.uri, 'at://did:plc:fake123/app.bsky.feed.post/3kjqrstuqwdz2')
    })

    it('builds facets for links in post', async function() {
      // Mock Bluesky API (must include refreshJwt)
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-jwt',
          refreshJwt: 'fake-refresh-jwt',
          did: 'did:plc:fake123',
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
        .post('/xrpc/com.atproto.repo.createRecord', function(body) {
          // Verify facets were included
          assert.ok(body.record.facets)
          assert.isArray(body.record.facets)
          assert.isAtLeast(body.record.facets.length, 1)
          return true
        })
        .reply(200, {
          uri: 'at://did:plc:fake123/app.bsky.feed.post/3kjqrstuqwdz2',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      await blueskyPlatform.post({
        account: {
          identifier: 'test.bsky.social',
          password: 'fake-password'
        },
        text: 'Article edited by User https://example.com',
        screenshot: testScreenshot,
        metadata: {
          page: 'Article',
          name: 'User',
          pageUrl: 'https://en.wikipedia.org/wiki/Article',
          userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/User'
        }
      })
    })

    it('includes screenshot as embedded image', async function() {
      // Mock Bluesky API (must include refreshJwt and handle)
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-jwt',
          refreshJwt: 'fake-refresh',
          did: 'did:plc:fake123',
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
        .post('/xrpc/com.atproto.repo.createRecord', function(body) {
          // Verify embed structure
          assert.ok(body.record.embed)
          assert.equal(body.record.embed.$type, 'app.bsky.embed.images')
          assert.isArray(body.record.embed.images)
          assert.equal(body.record.embed.images.length, 1)
          assert.equal(body.record.embed.images[0].alt, 'Screenshot of edit to Test')
          return true
        })
        .reply(200, {
          uri: 'at://did:plc:fake123/app.bsky.feed.post/3kjqrstuqwdz2',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      await blueskyPlatform.post({
        account: { identifier: 'test', password: 'pass' },
        text: 'Test post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        }
      })
    })

    it('includes reply refs when replyTo is provided', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-jwt',
          refreshJwt: 'fake-refresh',
          did: 'did:plc:fake123',
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
        .post('/xrpc/com.atproto.repo.createRecord', function(body) {
          assert.ok(body.record.reply)
          assert.equal(body.record.reply.root.uri, 'at://did:plc:fake123/app.bsky.feed.post/root1')
          assert.equal(body.record.reply.parent.uri, 'at://did:plc:fake123/app.bsky.feed.post/parent1')
          assert.equal(body.record.reply.parent.cid, 'cid-parent')
          return true
        })
        .reply(200, {
          uri: 'at://did:plc:fake123/app.bsky.feed.post/3kjqrstuqwdz2',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      await blueskyPlatform.post({
        account: { identifier: 'test', password: 'pass' },
        text: 'Follow-up post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        },
        replyTo: {
          root: { uri: 'at://did:plc:fake123/app.bsky.feed.post/root1', cid: 'cid-root' },
          parent: { uri: 'at://did:plc:fake123/app.bsky.feed.post/parent1', cid: 'cid-parent' }
        }
      })
    })

    it('throws error when authentication fails', async function() {
      // Mock failed authentication
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(401, { error: 'AuthenticationRequired', message: 'Invalid credentials' })

      try {
        await blueskyPlatform.post({
          account: { identifier: 'test', password: 'wrong' },
          text: 'Test',
          screenshot: testScreenshot,
          metadata: { page: 'Test', name: 'User', pageUrl: 'http://example.com', userUrl: 'http://example.com' }
        })
        assert.fail('Should have thrown error')
      } catch (error) {
        assert.ok(error)
      }
    })
  })

  describe('mastodon-platform', function() {
    it('posts to Mastodon with screenshot', async function() {
      // Mock Mastodon API - use regex to match query string parameters
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, {
          id: 'fake-status-id',
          url: 'https://mastodon.social/@test/fake-status-id'
        })

      const result = await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social'
        },
        text: 'Test article edited by User https://en.wikipedia.org/diff/123',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test article',
          name: 'User',
          pageUrl: 'https://en.wikipedia.org/wiki/Test_article',
          userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/User'
        }
      })

      assert.ok(result)
      assert.equal(result.data.id, 'fake-status-id')
    })

    it('formats text with URLs in parentheses', async function() {
      // Mock Mastodon API
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, function(uri, requestBody) {
          // Mastodon library sends data as query string
          if (requestBody && typeof requestBody === 'string') {
            const status = decodeURIComponent(requestBody.split('status=')[1]?.split('&')[0] || '')
            // Verify parentheses format is used
            assert.include(status, '(https://')
          }
          return { id: 'fake-status-id' }
        })

      await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social'
        },
        text: 'Article edited by User https://example.com',
        screenshot: testScreenshot,
        metadata: {
          page: 'Article',
          name: 'User',
          pageUrl: 'https://en.wikipedia.org/wiki/Article',
          userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/User'
        }
      })
    })

    it('includes screenshot description', async function() {
      // Mock Mastodon API
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/, function(body) {
          // Verify description is included
          assert.include(body, 'Screenshot of edit to Test Article')
          return true
        })
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: 'fake-status-id' })

      await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social'
        },
        text: 'Test post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test Article',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        }
      })
    })

    it('includes in_reply_to_id when replyTo is provided', async function() {
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, function(uri, requestBody) {
          if (requestBody && typeof requestBody === 'string') {
            assert.include(requestBody, 'in_reply_to_id=12345')
          }
          return { id: 'fake-status-id' }
        })

      await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social'
        },
        text: 'Follow-up post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test Article',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        },
        replyTo: '12345'
      })
    })

    it('omits in_reply_to_id when replyTo is absent', async function() {
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, function(uri, requestBody) {
          if (requestBody && typeof requestBody === 'string') {
            assert.notInclude(requestBody, 'in_reply_to_id')
          }
          return { id: 'fake-status-id' }
        })

      await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social'
        },
        text: 'Standalone post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test Article',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        }
      })
    })

    it('includes visibility when set on the account', async function() {
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, function(uri, requestBody) {
          if (requestBody && typeof requestBody === 'string') {
            assert.include(requestBody, 'visibility=unlisted')
          }
          return { id: 'fake-status-id' }
        })

      await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social',
          visibility: 'unlisted'
        },
        text: 'Bot post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test Article',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        }
      })
    })

    it('omits visibility when not configured, keeping the server default', async function() {
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, function(uri, requestBody) {
          if (requestBody && typeof requestBody === 'string') {
            assert.notInclude(requestBody, 'visibility')
          }
          return { id: 'fake-status-id' }
        })

      await mastodonPlatform.post({
        account: {
          access_token: 'fake-token',
          instance: 'https://mastodon.social'
        },
        text: 'Bot post',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test Article',
          name: 'User',
          pageUrl: 'https://example.com',
          userUrl: 'https://example.com'
        }
      })
    })

    it('throws error when media upload fails', async function() {
      // Mock failed media upload
      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(500, { error: 'Internal server error' })

      try {
        await mastodonPlatform.post({
          account: { access_token: 'fake-token', instance: 'https://mastodon.social' },
          text: 'Test',
          screenshot: testScreenshot,
          metadata: { page: 'Test', name: 'User', pageUrl: 'http://example.com', userUrl: 'http://example.com' }
        })
        assert.fail('Should have thrown error')
      } catch (error) {
        assert.ok(error)
      }
    })
  })

  describe('Integration - both platforms', function() {
    it('can post to both platforms sequentially', async function() {
      // Mock both APIs
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-jwt',
          refreshJwt: 'fake-refresh',
          did: 'did:plc:fake123',
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
          uri: 'at://did:plc:fake123/app.bsky.feed.post/3kjqrstuqwdz2',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      nock('https://mastodon.social')
        .post(/\/api\/v1\/media.*/)
        .reply(200, { id: 'fake-media-id' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: 'fake-status-id' })

      const metadata = {
        page: 'Test',
        name: 'User',
        pageUrl: 'https://example.com/Test',
        userUrl: 'https://example.com/User'
      }

      // Post to Bluesky
      const blueskyResult = await blueskyPlatform.post({
        account: { identifier: 'test', password: 'pass' },
        text: 'Test post https://example.com',
        screenshot: testScreenshot,
        metadata
      })

      // Post to Mastodon
      const mastodonResult = await mastodonPlatform.post({
        account: { access_token: 'token', instance: 'https://mastodon.social' },
        text: 'Test post https://example.com',
        screenshot: testScreenshot,
        metadata
      })

      assert.ok(blueskyResult)
      assert.ok(mastodonResult)
    })
  })
})
