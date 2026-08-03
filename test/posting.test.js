const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')
const { getStatus, buildFacets, getArticleUrl, getUserContributionsUrl } = require('../page-watch')

describe('posting flow', function() {
  beforeEach(function() {
    nock.cleanAll()
  })

  afterEach(function() {
    nock.cleanAll()
  })

  describe('getStatus', function() {
    it('generates status with correct text from template', function() {
      const edit = {
        page: 'Test Article',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }
      const name = 'TestUser'
      const template = '{{page}} edited by {{name}} {{&url}}'

      const result = getStatus(edit, name, template)

      assert.equal(result.text, 'Test Article edited by TestUser https://en.wikipedia.org/w/index.php?diff=123&oldid=456')
      assert.equal(result.page, 'Test Article')
      assert.equal(result.name, 'TestUser')
    })

    it('generates correct Wikipedia article URL', function() {
      const edit = {
        page: 'San Francisco',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }
      const name = 'TestUser'
      const template = '{{page}} edited by {{name}}'

      const result = getStatus(edit, name, template)

      assert.equal(result.pageUrl, 'https://en.wikipedia.org/wiki/San%20Francisco')
    })

    it('generates correct user contributions URL', function() {
      const edit = {
        page: 'Test Article',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }
      const name = 'TestUser'
      const template = '{{page}} edited by {{name}}'

      const result = getStatus(edit, name, template)

      assert.equal(result.userUrl, 'https://en.wikipedia.org/wiki/Special:Contributions/TestUser')
    })

    it('handles IP addresses as usernames', function() {
      const edit = {
        page: 'Test Article',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }
      const name = '192.168.1.1'
      const template = '{{page}} edited by {{name}}'

      const result = getStatus(edit, name, template)

      assert.equal(result.text, 'Test Article edited by 192.168.1.1')
      assert.equal(result.userUrl, 'https://en.wikipedia.org/wiki/Special:Contributions/192.168.1.1')
    })
  })

  describe('buildFacets', function() {
    it('creates facets for page name, username, and URLs in text', function() {
      const text = 'Article edited by User https://wiki.org/diff'
      const page = 'Article'
      const name = 'User'
      const pageUrl = 'https://en.wikipedia.org/wiki/Article'
      const userUrl = 'https://en.wikipedia.org/wiki/Special:Contributions/User'

      const facets = buildFacets(text, page, name, pageUrl, userUrl)

      // Should have 3 facets: page, user, and the diff URL in text
      assert.equal(facets.length, 3)

      // First facet should be for "Article"
      assert.equal(facets[0].features[0].$type, 'app.bsky.richtext.facet#link')
      assert.equal(facets[0].features[0].uri, pageUrl)

      // Second facet should be for "User"
      assert.equal(facets[1].features[0].$type, 'app.bsky.richtext.facet#link')
      assert.equal(facets[1].features[0].uri, userUrl)

      // Third facet should be for the URL in the text
      assert.equal(facets[2].features[0].$type, 'app.bsky.richtext.facet#link')
      assert.equal(facets[2].features[0].uri, 'https://wiki.org/diff')
    })

    it('handles UTF-8 characters correctly in byte offsets', function() {
      const text = 'Café edited by User'
      const page = 'Café'
      const name = 'User'
      const pageUrl = 'https://en.wikipedia.org/wiki/Café'
      const userUrl = 'https://en.wikipedia.org/wiki/Special:Contributions/User'

      const facets = buildFacets(text, page, name, pageUrl, userUrl)

      // Should still create facets correctly despite UTF-8
      assert.equal(facets.length, 2)

      // Verify byte offsets are correct (é is 2 bytes in UTF-8)
      const pageByteStart = facets[0].index.byteStart
      const pageByteEnd = facets[0].index.byteEnd

      // "Café" should be 5 bytes (C=1, a=1, f=1, é=2)
      assert.equal(pageByteEnd - pageByteStart, 5)
    })

    it('handles emojis correctly in byte offsets', function() {
      const text = 'Article 🇺🇸 edited by User'
      const page = 'Article'
      const name = 'User'
      const pageUrl = 'https://en.wikipedia.org/wiki/Article'
      const userUrl = 'https://en.wikipedia.org/wiki/Special:Contributions/User'

      const facets = buildFacets(text, page, name, pageUrl, userUrl)

      // Should handle emoji correctly (flag is 8 bytes)
      assert.equal(facets.length, 2)
      assert.equal(facets[0].features[0].uri, pageUrl)
      assert.equal(facets[1].features[0].uri, userUrl)
    })

    it('returns empty array when no URLs provided', function() {
      const text = 'Article edited by User'
      const page = 'Article'
      const name = 'User'
      const pageUrl = null
      const userUrl = null

      const facets = buildFacets(text, page, name, pageUrl, userUrl)

      assert.equal(facets.length, 0)
    })
  })

  describe('URL helpers', function() {
    describe('getArticleUrl', function() {
      it('builds correct article URL from edit URL', function() {
        const editUrl = 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
        const pageName = 'San Francisco'

        const result = getArticleUrl(editUrl, pageName)

        assert.equal(result, 'https://en.wikipedia.org/wiki/San%20Francisco')
      })

      it('handles special characters in page names', function() {
        const editUrl = 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
        const pageName = 'San Francisco (disambiguation)'

        const result = getArticleUrl(editUrl, pageName)

        assert.equal(result, 'https://en.wikipedia.org/wiki/San%20Francisco%20(disambiguation)')
      })

      it('handles different Wikipedia languages', function() {
        const editUrl = 'https://fr.wikipedia.org/w/index.php?diff=123&oldid=456'
        const pageName = 'Paris'

        const result = getArticleUrl(editUrl, pageName)

        assert.equal(result, 'https://fr.wikipedia.org/wiki/Paris')
      })

      it('returns null for malformed URLs', function() {
        const editUrl = 'not-a-valid-url'
        const pageName = 'Article'

        const result = getArticleUrl(editUrl, pageName)

        assert.isNull(result)
      })
    })

    describe('getUserContributionsUrl', function() {
      it('builds correct contributions URL', function() {
        const editUrl = 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
        const username = 'TestUser'

        const result = getUserContributionsUrl(editUrl, username)

        assert.equal(result, 'https://en.wikipedia.org/wiki/Special:Contributions/TestUser')
      })

      it('handles IP addresses as usernames', function() {
        const editUrl = 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
        const username = '192.168.1.1'

        const result = getUserContributionsUrl(editUrl, username)

        assert.equal(result, 'https://en.wikipedia.org/wiki/Special:Contributions/192.168.1.1')
      })

      it('handles usernames with special characters', function() {
        const editUrl = 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
        const username = 'User:Test/Sandbox'

        const result = getUserContributionsUrl(editUrl, username)

        assert.equal(result, 'https://en.wikipedia.org/wiki/Special:Contributions/User%3ATest%2FSandbox')
      })

      it('returns null for malformed URLs', function() {
        const editUrl = 'not-a-valid-url'
        const username = 'TestUser'

        const result = getUserContributionsUrl(editUrl, username)

        assert.isNull(result)
      })
    })
  })

  describe('sendStatus() integration test', function() {
    let fakeScreenshotPath

    beforeEach(function() {
      // Create a fake screenshot file for the test
      fakeScreenshotPath = path.join(__dirname, 'fake-screenshot.png')
      fs.writeFileSync(fakeScreenshotPath, 'fake image data')
    })

    afterEach(function() {
      // Clean up fake screenshot files if they weren't deleted by sendStatus
      if (fs.existsSync(fakeScreenshotPath)) {
        fs.unlinkSync(fakeScreenshotPath)
      }
      // Also clean up any fakeScreenshotPath2 files from test 3t
      const fakeScreenshotPath2 = path.join(__dirname, 'fake-screenshot2.png')
      if (fs.existsSync(fakeScreenshotPath2)) {
        fs.unlinkSync(fakeScreenshotPath2)
      }

      nock.cleanAll()
    })

    it('sends over-limit text to delivery module (fitting is tested in delivery.test.js)', async function() {
      this.timeout(10000)

      // Long enough that template + name + URL blows past 300 graphemes
      const longTitle = 'A'.repeat(280)

      let capturedDeliveryPayload = null
      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({
            screenshot: fakeScreenshotPath,
            altText: 'alt', summary: null, article: null
          })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': { recordPost: () => null, entryDeliveries: require('../lib/post-log').entryDeliveries },
        './lib/delivery': {
          post: async (delivery, payload) => {
            // Capture what page-watch sends to delivery (before fitting)
            if (delivery.type === 'bluesky') {
              capturedDeliveryPayload = { delivery, payload }
            }
            return { type: 'bluesky', postId: 'at://did:plc:fake/app.bsky.feed.post/1', ref: { uri: 'at://did:plc:fake/app.bsky.feed.post/1', cid: 'fakecid' } }
          },
          resolveConfigDeliveries: require('../lib/delivery').resolveConfigDeliveries
        }
      })

      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, `<script>RLCONF={"wgPageName":"${longTitle}"};</script>`)

      const fakeAccount = {
        bluesky: { identifier: 'top500.thebay.wiki', password: 'fake' },
        deliveries: [{ type: 'bluesky' }],
        template: '{{page}} Wikipedia article edited by {{name}} {{&url}}',
        pii_blocking: { enabled: false }
      }
      const fakeEdit = {
        page: longTitle,
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      await pageWatch.sendStatus(fakeAccount, pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template), fakeEdit)

      // Verify page-watch wiring: delivery receives the un-fitted text and full metadata
      assert.exists(capturedDeliveryPayload, 'Bluesky delivery should have been called')
      assert.equal(capturedDeliveryPayload.delivery.type, 'bluesky')
      assert.equal(capturedDeliveryPayload.payload.metadata.page, longTitle, 'metadata.page should be the full original title')
      assert.isTrue(capturedDeliveryPayload.payload.text.includes(longTitle), 'text should contain the full original title (fitting happens inside delivery)')
      // The fitting itself is tested in lib/delivery's test, not here
    })

    it('(CRITICAL 1) all account deliveries fail returns null and doesn\'t record', async function() {
      this.timeout(10000)

      let recordPostCalled = false
      let heartbeatWritten = false

      // Track fs.writeFileSync calls for heartbeat
      const fsStub = {
        writeFileSync: function(path, data) {
          if (path.includes('heartbeat-post')) {
            heartbeatWritten = true
          }
          // Don't actually write the heartbeat in test
        },
        existsSync: require('fs').existsSync,
        unlinkSync: require('fs').unlinkSync
      }

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/delivery': {
          post: async () => {
            throw new Error('Delivery failed')
          },
          resolveConfigDeliveries: require('../lib/delivery').resolveConfigDeliveries
        },
        './lib/post-log': {
          recordPost: () => { recordPostCalled = true; return null },
          entryDeliveries: require('../lib/post-log').entryDeliveries
        },
        fs: fsStub
      })

      // Mock Wikipedia diff page
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      const fakeAccount = {
        bluesky: { identifier: 'test.bsky.social', password: 'pass' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        discord: { webhook_url: 'https://discord.com/api/webhooks/account-hook' },
        deliveries: [
          { type: 'bluesky' },
          { type: 'mastodon' },
          { type: 'discord' }
        ],
        template: '{{page}}'
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'User',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456',
        wikipedia: 'en'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)

      // Call with empty topicIds (default)
      // With all account deliveries failing, allDeliveries will be empty
      const result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      // Total failure must return null
      assert.isNull(result, 'sendStatus should return null when all deliveries fail')

      // recordPost should NOT have been called
      assert.isFalse(recordPostCalled, 'recordPost should not be called when all deliveries fail')

      // Heartbeat should NOT have been written
      assert.isFalse(heartbeatWritten, 'heartbeat-post should not be written when all deliveries fail')
    })

    it('posts to Bluesky and Mastodon without errors', async function() {
      this.timeout(10000)

      // Track if screenshot was called
      let screenshotCalled = false

      // Use proxyquire to inject mocked dependencies
      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => {
            screenshotCalled = true
            return { screenshot: fakeScreenshotPath, altText: 'Diff of Wikipedia article "Test Article": 1 line added.' }
          }
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text, // Pass through without enrichment
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      // Mock the Wikipedia diff page fetch (used for page verification)
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      // Mock Bluesky API
      const blueskyScope = nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-jwt-token',
          refreshJwt: 'fake-refresh-token',
          did: 'did:plc:fake123',
          handle: 'testuser.bsky.social'
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

      // Mock Mastodon API
      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'fake-media-id-123' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, {
          id: 'fake-status-id-456',
          url: 'https://mastodon.example.com/@testuser/fake-status-id-456'
        })

      // Create test data
      const fakeAccount = {
        bluesky: {
          identifier: 'testuser.bsky.social',
          password: 'fake-password',
          service: 'https://bsky.social'
        },
        mastodon: {
          access_token: 'fake-mastodon-token',
          instance: 'https://mastodon.example.com'
        },
        template: '{{page}} edited by {{name}} {{&url}}'
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)

      // Call sendStatus - this should complete without throwing
      await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      // Verify all HTTP mocks were called
      assert.isTrue(blueskyScope.isDone(), 'All Bluesky API calls should have been made')
      assert.isTrue(mastodonScope.isDone(), 'All Mastodon API calls should have been made')

      // Verify screenshot was taken
      assert.isTrue(screenshotCalled, 'Screenshot should have been taken')

      // Verify screenshot file was cleaned up
      assert.isFalse(fs.existsSync(fakeScreenshotPath), 'Screenshot file should have been deleted')
    })

    it('blocks the post when the diff belongs to a different page', async function() {
      this.timeout(10000)

      let screenshotCalled = false

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => {
            screenshotCalled = true
            return { screenshot: fakeScreenshotPath, altText: null }
          }
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      // The diff URL resolves to a DIFFERENT page than edit.page claims -
      // the wikichanges splice bug. Verification must catch it.
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '1331882607', oldid: '1082626579' })
        .reply(200, '<script>RLCONF={"wgPageName":"Wikipedia:Articles_for_deletion\\/Roza_Gough"};</script>')

      // Posting endpoints should never be hit. If they are, nock throws.
      const blueskyScope = nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, { accessJwt: 'x', refreshJwt: 'y', did: 'did:plc:x', handle: 'x.bsky.social' })

      const fakeAccount = {
        bluesky: { identifier: 'testuser.bsky.social', password: 'p', service: 'https://bsky.social' },
        mastodon: { access_token: 't', instance: 'https://mastodon.example.com' },
        template: '{{page}} edited by {{name}} {{&url}}'
      }

      const fakeEdit = {
        page: 'Scott Wiener',
        user: 'MatrixBot',
        url: 'https://en.wikipedia.org/w/index.php?diff=1331882607&oldid=1082626579'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      assert.isFalse(screenshotCalled, 'Screenshot should NOT be taken for a mismatched diff')
      assert.isFalse(blueskyScope.isDone(), 'Bluesky should NOT be called for a mismatched diff')
    })

    it('(Task 3a) posts to all three platforms and returns refs for threading', async function() {
      this.timeout(10000)

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      const blueskyScope = nock('https://bsky.social')
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

      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: '109383210193324631', url: 'https://mastodon.example.com/@test/109383210193324631' })

      const discordScope = nock('https://discord.com')
        .post('/api/webhooks/account-hook')
        .query({ wait: 'true' })
        .reply(200, { id: 'discord-msg-123' })

      const fakeAccount = {
        bluesky: { identifier: 'test.bsky.social', password: 'pass', service: 'https://bsky.social' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        discord: { webhook_url: 'https://discord.com/api/webhooks/account-hook' },
        deliveries: [
          { type: 'bluesky' },
          { type: 'mastodon' },
          { type: 'discord' }
        ],
        template: '{{page}} edited'
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      const result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      assert.isTrue(blueskyScope.isDone(), 'All Bluesky calls should be made')
      assert.isTrue(mastodonScope.isDone(), 'All Mastodon calls should be made')
      assert.isTrue(discordScope.isDone(), 'All Discord calls should be made')

      // Verify refs object for threading
      assert.ok(result, 'sendStatus should return result')
      assert.ok(result.bluesky, 'Should have bluesky ref')
      assert.equal(result.bluesky.uri, 'at://did:plc:test/app.bsky.feed.post/abc123')
      assert.equal(result.bluesky.cid, 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
      assert.ok(result.mastodon, 'Should have mastodon ref')
      assert.equal(result.mastodon, '109383210193324631')
    })

    it('(Task 3b) Bluesky 500 doesn\'t stop Mastodon and Discord', async function() {
      this.timeout(10000)

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      // Bluesky will fail
      const blueskyScope = nock('https://bsky.social')
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
        .reply(500, { error: 'Server error' })

      // But Mastodon should succeed
      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: '109383210193324631' })

      // And Discord should succeed
      const discordScope = nock('https://discord.com')
        .post('/api/webhooks/account-hook')
        .query({ wait: 'true' })
        .reply(200, { id: 'discord-msg-456' })

      const fakeAccount = {
        bluesky: { identifier: 'test.bsky.social', password: 'pass', service: 'https://bsky.social' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        discord: { webhook_url: 'https://discord.com/api/webhooks/account-hook' },
        deliveries: [
          { type: 'bluesky' },
          { type: 'mastodon' },
          { type: 'discord' }
        ],
        template: '{{page}} edited'
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      const result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      // All platform scopes should be consumed despite Bluesky failure
      assert.isTrue(blueskyScope.isDone(), 'Bluesky calls should be made (even if they fail)')
      assert.isTrue(mastodonScope.isDone(), 'Mastodon calls should be made despite Bluesky failure')
      assert.isTrue(discordScope.isDone(), 'Discord calls should be made despite Bluesky failure')

      // Bluesky ref should be null
      assert.isNull(result.bluesky, 'Bluesky ref should be null on failure')
      // But Mastodon should be set
      assert.ok(result.mastodon, 'Mastodon ref should be set')
      assert.equal(result.mastodon, '109383210193324631')
    })

    it('(Task 3c) Threading argument passed to Bluesky reply', async function() {
      this.timeout(10000)

      let capturedBody = null

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '789', oldid: '788' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      const blueskyScope = nock('https://bsky.social')
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
        .post('/xrpc/com.atproto.repo.createRecord', (body) => {
          capturedBody = body
          return true
        })
        .reply(200, {
          uri: 'at://did:plc:test/app.bsky.feed.post/reply789',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
        })

      const fakeAccount = {
        bluesky: { identifier: 'test.bsky.social', password: 'pass', service: 'https://bsky.social' },
        deliveries: [{ type: 'bluesky' }],
        template: '{{page}} edited'
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=789&oldid=788'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)

      // Pass threading context
      const threadingContext = {
        root: { bluesky: { uri: 'at://did:plc:root/app.bsky.feed.post/root', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' } },
        parent: { bluesky: { uri: 'at://did:plc:parent/app.bsky.feed.post/parent', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' } }
      }

      await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit, [], threadingContext)

      assert.isTrue(blueskyScope.isDone(), 'Bluesky calls should be made')
      assert.ok(capturedBody, 'Should capture request body')
      assert.ok(capturedBody.record.reply, 'Should have reply field')
      assert.equal(capturedBody.record.reply.root.uri, 'at://did:plc:root/app.bsky.feed.post/root')
      assert.equal(capturedBody.record.reply.parent.cid, 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
    })

    it('(Task 3f1) allowlist rejection logs and other deliveries post', async function() {
      this.timeout(10000)

      let warnCalls = []
      const originalWarn = console.warn
      console.warn = function(...args) {
        warnCalls.push(args.join(' '))
      }

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      // Mock Wikipedia diff page verification
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      // Mastodon should post
      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: '109383210193324631' })

      const fakeAccount = {
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        discord: { webhook_url: 'https://evil.example/api/webhooks/1/t' }, // fails allowlist
        deliveries: [
          { type: 'mastodon' },
          { type: 'discord' }
        ],
        template: '{{page}} edited'
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      const result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      console.warn = originalWarn

      assert.isTrue(mastodonScope.isDone(), 'Mastodon should post despite Discord rejection')
      assert.ok(result.mastodon, 'Should have Mastodon ref')
      assert.ok(warnCalls.some(w => w.includes('discord')), 'Should warn about discord rejection')
    })

    it('(Task 3d) recordPost per collapsedUrls: account + subscription deliveries each call', async function() {
      this.timeout(10000)

      let recordPostCalls = []

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: (params) => {
            recordPostCalls.push(params)
            return { host: 'en.wikipedia.org', revId: 123 }
          }
        },
        './lib/subscription-delivery': {
          deliver: async () => ({ ok: true, type: 'discord', postId: 'discord-sub-123', subscriptionId: 999, capped: false }),
          deliverAll: async () => [{ ok: true, type: 'discord', postId: 'discord-sub-123', subscriptionId: 999, capped: false }],
          validateWebhookUrl: require('../lib/delivery').validateWebhookUrl,
          isPermanentFailure: () => false,
          ALLOWED_WEBHOOK_HOSTS: new Set(['discord.com']),
          FAILURES_BEFORE_BROKEN: 5
        }
      })

      // Mock Wikipedia diff page verification
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '111', oldid: '110' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')
        .get('/w/index.php')
        .query({ diff: '112', oldid: '111' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      // Mock Mastodon for account delivery
      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: '109383210193324631' })

      // Set up topic store with a subscription
      const mockTopicStore = {
        subscriptionsForTopic: async () => [{
          id: 999,
          deliveryType: 'discord',
          deliveryConfig: { webhook_url: 'https://discord.com/api/webhooks/sub' }
        }]
      }
      pageWatch._setTopicStateForTest(mockTopicStore, {
        topicsForEdit: () => [42]
      })

      const fakeAccount = {
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        deliveries: [{ type: 'mastodon' }],
        template: '{{page}} edited'
      }

      // Edit with TWO collapsed URLs
      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        collapsedUrls: [
          'https://en.wikipedia.org/w/index.php?diff=111&oldid=110',
          'https://en.wikipedia.org/w/index.php?diff=112&oldid=111'
        ],
        url: 'https://en.wikipedia.org/w/index.php?diff=111&oldid=110'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit, [42])

      assert.isTrue(mastodonScope.isDone(), 'Mastodon endpoint should be called')

      // recordPost should be called exactly twice (once per collapsedUrl)
      assert.lengthOf(recordPostCalls, 2, 'recordPost should be called exactly twice for 2 collapsedUrls')

      // Each call should have deliveries array with account + subscription results
      recordPostCalls.forEach((call, idx) => {
        assert.ok(call.deliveries, `recordPost call ${idx} should have deliveries array`)
        assert.lengthOf(call.deliveries, 2, `recordPost call ${idx} should have 2 deliveries (account + subscription)`)

        // First delivery should be the account mastodon delivery
        assert.equal(call.deliveries[0].type, 'mastodon', `call ${idx} delivery 0 should be mastodon`)
        assert.ok(call.deliveries[0].postId, `call ${idx} delivery 0 should have postId`)
        assert.isUndefined(call.deliveries[0].subscriptionId, `call ${idx} delivery 0 should not have subscriptionId`)

        // Second delivery should be the subscription discord delivery with subscriptionId
        assert.equal(call.deliveries[1].type, 'discord', `call ${idx} delivery 1 should be discord`)
        assert.ok(call.deliveries[1].postId, `call ${idx} delivery 1 should have postId`)
        assert.equal(call.deliveries[1].subscriptionId, 999, `call ${idx} delivery 1 should have subscriptionId`)
      })
    })

    it('(Task 3f2) empty deliveries falls back to legacy stanzas', async function() {
      this.timeout(10000)

      let warnCalls = []
      const originalWarn = console.warn
      console.warn = function(...args) {
        warnCalls.push(args.join(' '))
      }

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      // Mock Wikipedia diff page verification
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'media-id-789' })
        .post(/\/api\/v1\/statuses.*/)
        .reply(200, { id: '109383210193324631' })

      // Account has legacy stanzas but no deliveries array
      const fakeAccount = {
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        template: '{{page}} edited'
        // NOTE: no deliveries key
      }

      const fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      const result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      console.warn = originalWarn

      assert.isTrue(mastodonScope.isDone(), 'Should post via legacy stanza')
      assert.ok(result.mastodon, 'Should have Mastodon ref')
      assert.ok(warnCalls.some(w => w.includes('legacy')), 'Should warn about fallback to legacy behavior')
    })

    it('(Task 3t) template override: non-collapsed applies override, collapsed skips it', async function() {
      this.timeout(10000)

      // Create second screenshot file for the second test case
      const fakeScreenshotPath2 = path.join(__dirname, 'fake-screenshot2.png')
      fs.writeFileSync(fakeScreenshotPath2, 'fake image data 2')

      let screenshotIndex = 0
      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => {
            // Return different screenshot path for each call to avoid file deletion issues
            screenshotIndex++
            return {
              screenshot: screenshotIndex === 1 ? fakeScreenshotPath : fakeScreenshotPath2,
              altText: 'Diff'
            }
          }
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => null
        }
      })

      // Mock Wikipedia diff page verification (will be called twice)
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      // Capture the wire bodies so we can assert on the posted TEXT, per platform,
      // per case — scope.isDone() alone cannot prove the override was applied.
      const blueskyBodies = []
      const mastodonBodies = []

      // Set up Bluesky scope with TWO session/upload/post chains (for two test cases)
      const blueskyScope = nock('https://bsky.social')
        // First chain (non-collapsed)
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, { accessJwt: 'token1', refreshJwt: 'refresh1', did: 'did:plc:test', handle: 'test.bsky.social' })
        .post('/xrpc/com.atproto.repo.uploadBlob')
        .reply(200, { blob: { $type: 'blob', ref: { $link: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4' }, mimeType: 'image/png', size: 1234 } })
        .post('/xrpc/com.atproto.repo.createRecord', (body) => { blueskyBodies.push(body); return true })
        .reply(200, { uri: 'at://did:plc:test/app.bsky.feed.post/abc', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' })
        // Second chain (collapsed)
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, { accessJwt: 'token2', refreshJwt: 'refresh2', did: 'did:plc:test', handle: 'test.bsky.social' })
        .post('/xrpc/com.atproto.repo.uploadBlob')
        .reply(200, { blob: { $type: 'blob', ref: { $link: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4' }, mimeType: 'image/png', size: 1234 } })
        .post('/xrpc/com.atproto.repo.createRecord', (body) => { blueskyBodies.push(body); return true })
        .reply(200, { uri: 'at://did:plc:test/app.bsky.feed.post/xyz', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' })

      // Mastodon scope with TWO chains
      const mastodonScope = nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(200, { id: 'media-1' })
        .post(/\/api\/v1\/statuses.*/, (body) => { mastodonBodies.push(body); return true })
        .reply(200, { id: '109383210193324631' })
        .post('/api/v1/media')
        .reply(200, { id: 'media-2' })
        .post(/\/api\/v1\/statuses.*/, (body) => { mastodonBodies.push(body); return true })
        .reply(200, { id: '109383210193324632' })

      const fakeAccount = {
        bluesky: { identifier: 'test.bsky.social', password: 'pass', service: 'https://bsky.social' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        deliveries: [
          { type: 'bluesky', template: 'OVERRIDE: {{page}}' },
          { type: 'mastodon' }
        ],
        template: 'DEFAULT: {{page}}'
      }

      // Case 1: Non-collapsed edit
      let fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      let statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      let result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)
      assert.ok(result, 'Non-collapsed: Should return result when posts succeed')

      // Non-collapsed: the bluesky delivery's override template must reach the
      // wire, while the mastodon delivery (no override) keeps the default text.
      assert.equal(blueskyBodies.length, 1, 'Non-collapsed: one Bluesky post so far')
      assert.include(blueskyBodies[0].record.text, 'OVERRIDE: Test Article',
        'Non-collapsed: Bluesky wire text must come from the delivery override template')
      assert.equal(mastodonBodies.length, 1, 'Non-collapsed: one Mastodon post so far')
      assert.include(decodeURIComponent(JSON.stringify(mastodonBodies[0])), 'DEFAULT: Test Article',
        'Non-collapsed: Mastodon wire text must keep the account default template')
      assert.notInclude(decodeURIComponent(JSON.stringify(mastodonBodies[0])), 'OVERRIDE:',
        'Non-collapsed: the override must apply per-delivery, not globally')

      // Case 2: Collapsed burst (collapsedCount > 1)
      fakeEdit = {
        page: 'Test Article',
        user: 'TestUser',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456',
        collapsedCount: 3  // Collapsed burst
      }

      statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)
      assert.ok(result, 'Collapsed: Should return result when posts succeed')

      // Collapsed burst: the override is skipped (it would lose {{count}}), so
      // the bluesky wire text must be the default, not the override.
      assert.equal(blueskyBodies.length, 2, 'Collapsed: second Bluesky post captured')
      assert.include(blueskyBodies[1].record.text, 'DEFAULT: Test Article',
        'Collapsed: Bluesky wire text must fall back to the default template')
      assert.notInclude(blueskyBodies[1].record.text, 'OVERRIDE:',
        'Collapsed: the single-edit override template must not be applied to a burst')

      // Both chains should be consumed
      assert.isTrue(blueskyScope.isDone(), 'All Bluesky calls should be made')
      assert.isTrue(mastodonScope.isDone(), 'All Mastodon calls should be made')
    })
  })
})
