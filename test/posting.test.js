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
      // Clean up fake screenshot file if it wasn't deleted by sendStatus
      if (fs.existsSync(fakeScreenshotPath)) {
        fs.unlinkSync(fakeScreenshotPath)
      }

      nock.cleanAll()
    })

    it('(CRITICAL 2+3) sendStatus with all deliveries failing returns null and doesn\'t record', async function() {
      this.timeout(10000)

      let recordPostCalled = false

      const pageWatch = proxyquire('../page-watch', {
        './lib/diff-image': {
          captureDiffImage: async () => ({ screenshot: fakeScreenshotPath, altText: 'Diff' })
        },
        './lib/geolocation': {
          enrichIPsInText: async (text) => text,
          initializeReader: async () => null
        },
        './lib/post-log': {
          recordPost: () => { recordPostCalled = true; return null }
        }
      })

      // Mock Wikipedia diff page
      nock('https://en.wikipedia.org')
        .get('/w/index.php')
        .query({ diff: '123', oldid: '456' })
        .reply(200, '<script>RLCONF={"wgPageName":"Test_Article"};</script>')

      // All platform calls will fail or be rejected
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(500)

      nock('https://mastodon.example.com')
        .post('/api/v1/media')
        .reply(500)

      const fakeAccount = {
        bluesky: { identifier: 'test.bsky.social', password: 'pass' },
        mastodon: { access_token: 'token', instance: 'https://mastodon.example.com' },
        discord: { webhook_url: 'http://example.com/webhook' },  // Invalid: not https
        deliveries: [
          { type: 'bluesky' },
          { type: 'mastodon' },
          { type: 'discord' }
        ],
        template: '{{page}}'
      }

      const fakeEdit = {
        page: 'Test',
        user: 'User',
        url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
      }

      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      const result = await pageWatch.sendStatus(fakeAccount, statusData, fakeEdit)

      // Total failure must return null
      assert.isNull(result, 'sendStatus should return null when all deliveries fail')

      // recordPost should NOT have been called
      assert.isFalse(recordPostCalled, 'recordPost should not be called on total failure')
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
  })
})
