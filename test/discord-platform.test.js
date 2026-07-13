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
})
