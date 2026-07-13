/**
 * Discord platform module tests
 *
 * Tests webhook posting and Discord markdown text formatting.
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const path = require('path')

const discordPlatform = require('../lib/discord-platform')
const { buildDiscordEmbed } = discordPlatform
const { buildDiscordText } = discordPlatform

describe('discord-platform', function() {
  this.timeout(5000)

  let testScreenshot

  beforeEach(function() {
    testScreenshot = path.join(__dirname, 'test-discord-screenshot.png')
    fs.writeFileSync(testScreenshot, 'fake image data')
  })

  afterEach(function() {
    if (fs.existsSync(testScreenshot)) {
      fs.unlinkSync(testScreenshot)
    }
    nock.cleanAll()
  })

  describe('buildDiscordText', function() {
    it('converts article name and editor to masked links', function() {
      const result = buildDiscordText(
        'Cat edited by SomeUser https://en.wikipedia.org/diff/123',
        'Cat',
        'SomeUser',
        'https://en.wikipedia.org/wiki/Cat',
        'https://en.wikipedia.org/wiki/Special:Contributions/SomeUser'
      )
      assert.include(result, '[Cat](<https://en.wikipedia.org/wiki/Cat>)')
      assert.include(result, '[SomeUser](<https://en.wikipedia.org/wiki/Special:Contributions/SomeUser>)')
    })

    it('wraps bare URLs in <> to suppress embeds', function() {
      const result = buildDiscordText(
        'Cat edited by SomeUser https://en.wikipedia.org/diff/123',
        'Cat',
        'SomeUser',
        'https://en.wikipedia.org/wiki/Cat',
        'https://en.wikipedia.org/wiki/Special:Contributions/SomeUser'
      )
      assert.include(result, '<https://en.wikipedia.org/diff/123>')
    })

    it('does not link the editor name inside the article link', function() {
      // Editor name appears within article title - must link the later occurrence
      const result = buildDiscordText(
        'London Breed article edited by London https://example.com/diff',
        'London Breed',
        'London',
        'https://en.wikipedia.org/wiki/London_Breed',
        'https://en.wikipedia.org/wiki/Special:Contributions/London'
      )
      assert.include(result, '[London Breed](<https://en.wikipedia.org/wiki/London_Breed>)')
      assert.include(result, '[London](<https://en.wikipedia.org/wiki/Special:Contributions/London>)')
    })

    it('returns empty string for missing text', function() {
      assert.equal(buildDiscordText(null, 'A', 'B', 'u', 'u'), '')
      assert.equal(buildDiscordText(undefined, 'A', 'B', 'u', 'u'), '')
    })

    it('leaves text unchanged when names are absent from it', function() {
      const result = buildDiscordText('Plain text no links', 'Missing', 'AlsoMissing',
        'https://example.com/a', 'https://example.com/b')
      assert.equal(result, 'Plain text no links')
    })
  })

  describe('post', function() {
    it('posts to webhook with screenshot attachment', async function() {
      let capturedBody = null
      nock('https://discord.com')
        .post('/api/webhooks/123/token', function(body) {
          capturedBody = body
          return true
        })
        .query({ wait: 'true' })
        .reply(200, { id: 'fake-message-id', channel_id: 'fake-channel' })

      const result = await discordPlatform.post({
        account: { webhook_url: 'https://discord.com/api/webhooks/123/token' },
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
      assert.equal(result.id, 'fake-message-id')
      // Multipart body should include the markdown content and the file
      const bodyText = String(capturedBody)
      assert.include(bodyText, '[Test article]')
      assert.include(bodyText, 'payload_json')
      assert.include(bodyText, 'files[0]')
    })

    it('disables mentions in the payload', async function() {
      let capturedBody = null
      nock('https://discord.com')
        .post('/api/webhooks/123/token', function(body) {
          capturedBody = body
          return true
        })
        .query({ wait: 'true' })
        .reply(200, { id: 'fake-message-id' })

      await discordPlatform.post({
        account: { webhook_url: 'https://discord.com/api/webhooks/123/token' },
        text: 'Test edited by @everyone https://example.com/diff',
        screenshot: testScreenshot,
        metadata: {
          page: 'Test',
          name: '@everyone',
          pageUrl: 'https://example.com/page',
          userUrl: 'https://example.com/user'
        }
      })

      assert.include(String(capturedBody), '"allowed_mentions":{"parse":[]}')
    })

    it('throws when the webhook returns an error', async function() {
      nock('https://discord.com')
        .post('/api/webhooks/123/token')
        .query({ wait: 'true' })
        .reply(401, { message: 'Invalid Webhook Token' })

      try {
        await discordPlatform.post({
          account: { webhook_url: 'https://discord.com/api/webhooks/123/token' },
          text: 'Test',
          screenshot: testScreenshot,
          metadata: { page: 'Test', name: 'User', pageUrl: 'http://example.com', userUrl: 'http://example.com' }
        })
        assert.fail('Should have thrown error')
      } catch (error) {
        assert.include(error.message, '401')
      }
    })
  })

  describe('buildDiscordEmbed', function() {
    const metadata = {
      page: 'London Breed',
      name: 'AadamentAardvark',
      pageUrl: 'https://en.wikipedia.org/wiki/London_Breed',
      userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/AadamentAardvark',
      diffUrl: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=0',
      wiki: 'English Wikipedia',
      altText: 'Diff of Wikipedia article "London Breed": 1 line changed.',
      summary: {
        counts: { added: 0, removed: 0, changed: 1, whitespace: 0 },
        sentence: '1 line changed',
        added: ['passport'],
        removed: ['mandate']
      },
      article: {
        description: 'Mayor of San Francisco from 2018 to 2025',
        thumbnailUrl: 'https://upload.wikimedia.org/breed.jpg'
      }
    }

    it('builds a rich embed with description, excerpts, and thumbnail', function() {
      const embed = buildDiscordEmbed(metadata, 'diff.png')
      assert.equal(embed.title, 'London Breed')
      assert.equal(embed.url, metadata.pageUrl)
      assert.include(embed.description, '*Mayor of San Francisco from 2018 to 2025*')
      assert.include(embed.description, '1 line changed')
      assert.include(embed.description, metadata.diffUrl)
      assert.equal(embed.author.name, 'Edited by AadamentAardvark')
      assert.equal(embed.thumbnail.url, metadata.article.thumbnailUrl)
      assert.equal(embed.image.url, 'attachment://diff.png')
      assert.equal(embed.footer.text, 'English Wikipedia')
      const added = embed.fields.find(f => f.name === 'Added')
      const removed = embed.fields.find(f => f.name === 'Removed')
      assert.equal(added.value, '> passport')
      assert.equal(removed.value, '> mandate')
    })

    it('colors pure additions green and pure removals red', function() {
      const add = buildDiscordEmbed({ ...metadata, summary: { ...metadata.summary, counts: { added: 2, removed: 0, changed: 0, whitespace: 0 } } }, 'x.png')
      const rem = buildDiscordEmbed({ ...metadata, summary: { ...metadata.summary, counts: { added: 0, removed: 1, changed: 0, whitespace: 0 } } }, 'x.png')
      const mix = buildDiscordEmbed(metadata, 'x.png')
      assert.equal(add.color, 0x14866d)
      assert.equal(rem.color, 0xd73333)
      assert.equal(mix.color, 0x3366cc)
    })

    it('caps long excerpt fields at Discord limits', function() {
      const long = 'x'.repeat(3000)
      const embed = buildDiscordEmbed({ ...metadata, summary: { ...metadata.summary, added: [long] } }, 'x.png')
      const added = embed.fields.find(f => f.name === 'Added')
      assert.isAtMost(added.value.length, 1024)
    })

    it('omits thumbnail and description when article meta is missing', function() {
      const embed = buildDiscordEmbed({ ...metadata, article: null }, 'x.png')
      assert.isUndefined(embed.thumbnail)
      assert.notInclude(embed.description, '*Mayor')
    })
  })

  describe('post with rich metadata', function() {
    it('sends an embed payload and alt text on the attachment', async function() {
      let captured
      nock('https://discord.com')
        .post('/api/webhooks/123/token', body => { captured = body; return true })
        .query({ wait: 'true' })
        .reply(200, { id: 'msg-1' })

      const result = await discordPlatform.post({
        account: { webhook_url: 'https://discord.com/api/webhooks/123/token' },
        text: 'plain text',
        screenshot: testScreenshot,
        metadata: {
          page: 'Cat', name: 'User',
          pageUrl: 'https://en.wikipedia.org/wiki/Cat',
          userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/User',
          diffUrl: 'https://en.wikipedia.org/w/index.php?diff=5',
          wiki: 'English Wikipedia',
          altText: 'descriptive alt text',
          summary: { counts: { added: 1, removed: 0, changed: 0, whitespace: 0 }, sentence: '1 line added', added: ['hi'], removed: [] },
          article: { description: 'a cat', thumbnailUrl: null }
        }
      })

      assert.equal(result.id, 'msg-1')
      const bodyText = String(captured)
      assert.include(bodyText, '"embeds"')
      assert.include(bodyText, 'descriptive alt text')
      assert.notInclude(bodyText, '"content"')
    })
  })
})