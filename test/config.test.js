const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig } = require('../lib/config')

describe('lib/config', function() {
  let dir

  beforeEach(function() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'))
  })

  afterEach(function() {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('loads config.base.json from an explicit baseDir', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({ nick: 'testbot', accounts: [] }))
    const config = loadConfig({ baseDir: dir, env: {} })
    assert.equal(config.nick, 'testbot')
  })

  it('throws a clear error when config.base.json is missing', function() {
    assert.throws(
      () => loadConfig({ baseDir: dir, env: {} }),
      /missing.*config\.base\.json/
    )
  })

  it('local config.json overlay overrides scalar values from base and deep-merges objects', function() {
    const base = {
      nick: 'basebot',
      accounts: [{
        collapse: { window_minutes: 15, enabled: true }
      }]
    }
    const overlay = {
      nick: 'overlaybot',
      accounts: [{
        collapse: { enabled: false }
      }]
    }
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify(base))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overlay))

    const config = loadConfig({ baseDir: dir, env: {} })
    assert.equal(config.nick, 'overlaybot')
    assert.equal(config.accounts[0].collapse.window_minutes, 15)
    assert.equal(config.accounts[0].collapse.enabled, false)
  })

  it('overlay leaves base untouched where the overlay is silent', function() {
    const base = {
      nick: 'basebot',
      web: { max_articles: 5000 }
    }
    const overlay = {
      nick: 'overlaybot'
    }
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify(base))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overlay))

    const config = loadConfig({ baseDir: dir, env: {} })
    assert.equal(config.nick, 'overlaybot')
    assert.equal(config.web.max_articles, 5000)
  })

  it('SFEDITS_BLUESKY_PASSWORD lands at accounts[0].bluesky.password', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      accounts: [{ bluesky: { identifier: 'test.bsky.social' } }]
    }))

    const config = loadConfig({ baseDir: dir, env: { SFEDITS_BLUESKY_PASSWORD: 'secret123' } })
    assert.equal(config.accounts[0].bluesky.password, 'secret123')
    assert.equal(config.accounts[0].bluesky.identifier, 'test.bsky.social')
  })

  it('SFEDITS_MASTODON_ACCESS_TOKEN lands at accounts[0].mastodon.access_token', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      accounts: [{ mastodon: { instance: 'mastodon.social' } }]
    }))

    const config = loadConfig({ baseDir: dir, env: { SFEDITS_MASTODON_ACCESS_TOKEN: 'token456' } })
    assert.equal(config.accounts[0].mastodon.access_token, 'token456')
    assert.equal(config.accounts[0].mastodon.instance, 'mastodon.social')
  })

  it('SFEDITS_DISCORD_WEBHOOK_URL lands at accounts[0].discord.webhook_url', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      accounts: [{ discord: { } }]
    }))

    const config = loadConfig({ baseDir: dir, env: { SFEDITS_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123' } })
    assert.equal(config.accounts[0].discord.webhook_url, 'https://discord.com/api/webhooks/123')
  })

  it('SFEDITS_INVITE_CODES="a,b" lands as [\'a\',\'b\'] at web.invite_codes', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      web: {}
    }))

    const config = loadConfig({ baseDir: dir, env: { SFEDITS_INVITE_CODES: 'a,b' } })
    assert.deepEqual(config.web.invite_codes, ['a', 'b'])
  })

  it('trims whitespace in invite codes and filters empty strings', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      web: {}
    }))

    const config = loadConfig({ baseDir: dir, env: { SFEDITS_INVITE_CODES: ' a , b , ' } })
    assert.deepEqual(config.web.invite_codes, ['a', 'b'])
  })

  it('throws when a secret env var is set but its stanza is absent from the composed config', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      accounts: [{}]
    }))

    assert.throws(
      () => loadConfig({ baseDir: dir, env: { SFEDITS_BLUESKY_PASSWORD: 'secret' } }),
      /SFEDITS_BLUESKY_PASSWORD is set but the config has no stanza for it/
    )
  })

  it('rejects SFEDITS_CONFIG with an error telling the operator it is no longer supported', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({ accounts: [] }))

    assert.throws(
      () => loadConfig({ baseDir: dir, env: { SFEDITS_CONFIG: '{}' } }),
      /SFEDITS_CONFIG is no longer supported/
    )
  })

  it('env secrets override values set by base/local for the same path', function() {
    const base = {
      accounts: [{ discord: { webhook_url: 'base-url' } }]
    }
    const overlay = {
      accounts: [{ discord: { webhook_url: 'overlay-url' } }]
    }
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify(base))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overlay))

    const config = loadConfig({
      baseDir: dir,
      env: { SFEDITS_DISCORD_WEBHOOK_URL: 'env-url' }
    })
    assert.equal(config.accounts[0].discord.webhook_url, 'env-url')
  })

  it('passes a topic_store stanza through untouched', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      accounts: [],
      topic_store: {
        host: 'tools.db.svc.wikimedia.cloud',
        database: 's51234__sfedits'
      }
    }))

    const config = loadConfig({ baseDir: dir, env: {} })
    assert.equal(config.topic_store.host, 'tools.db.svc.wikimedia.cloud')
    assert.equal(config.topic_store.database, 's51234__sfedits')
  })

  it('overlay with shorter array replaces base array completely', function() {
    const base = {
      accounts: [{
        watchlist_source: {
          importance: ['Top', 'High', 'Mid']
        }
      }]
    }
    const overlay = {
      accounts: [{
        watchlist_source: {
          importance: ['Top']
        }
      }]
    }
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify(base))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overlay))

    const config = loadConfig({ baseDir: dir, env: {} })
    assert.deepEqual(config.accounts[0].watchlist_source.importance, ['Top'])
  })

  it('overlay can replace scalar array elements with different types', function() {
    const base = {
      accounts: [{
        wikidata_claims: {
          properties: ['P19', 'P20', 'P39']
        }
      }]
    }
    const overlay = {
      accounts: [{
        wikidata_claims: {
          properties: ['P131']
        }
      }]
    }
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify(base))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overlay))

    const config = loadConfig({ baseDir: dir, env: {} })
    assert.deepEqual(config.accounts[0].wikidata_claims.properties, ['P131'])
  })

  it('resolves account ranges file references relative to the config file', function() {
    fs.writeFileSync(path.join(dir, 'ranges.json'), JSON.stringify({ 'Some Org': ['192.0.2.0/24'] }))
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({
      accounts: [{ ranges: './ranges.json' }]
    }))

    const config = loadConfig({ baseDir: dir, env: {} })
    assert.deepEqual(config.accounts[0].ranges, { 'Some Org': ['192.0.2.0/24'] })
  })

  it('throws a clear error for invalid JSON in config.base.json', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), 'not json{')

    assert.throws(
      () => loadConfig({ baseDir: dir, env: {} }),
      /config\.base\.json is not valid JSON/
    )
  })

  it('throws a clear error for invalid JSON in config.json', function() {
    fs.writeFileSync(path.join(dir, 'config.base.json'), JSON.stringify({ accounts: [] }))
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json{')

    assert.throws(
      () => loadConfig({ baseDir: dir, env: {} }),
      /config\.json is not valid JSON/
    )
  })
})
