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

  it('loads config from an explicit file path', function() {
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify({ nick: 'testbot', accounts: [] }))
    const config = loadConfig({ path: file, env: {} })
    assert.equal(config.nick, 'testbot')
  })

  it('loads config from the SFEDITS_CONFIG environment variable', function() {
    const config = loadConfig({
      env: { SFEDITS_CONFIG: JSON.stringify({ nick: 'envbot', accounts: [{ template: 't' }] }) }
    })
    assert.equal(config.nick, 'envbot')
    assert.lengthOf(config.accounts, 1)
  })

  it('prefers an explicit path over the environment variable', function() {
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify({ nick: 'filebot' }))
    const config = loadConfig({
      path: file,
      env: { SFEDITS_CONFIG: JSON.stringify({ nick: 'envbot' }) }
    })
    assert.equal(config.nick, 'filebot')
  })

  it('throws a clear error for invalid env JSON', function() {
    assert.throws(
      () => loadConfig({ env: { SFEDITS_CONFIG: 'not json{' } }),
      /SFEDITS_CONFIG is not valid JSON/
    )
  })

  it('resolves account ranges file references relative to the config file', function() {
    fs.writeFileSync(path.join(dir, 'ranges.json'), JSON.stringify({ 'Some Org': ['192.0.2.0/24'] }))
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify({ accounts: [{ ranges: './ranges.json' }] }))
    const config = loadConfig({ path: file, env: {} })
    assert.deepEqual(config.accounts[0].ranges, { 'Some Org': ['192.0.2.0/24'] })
  })

  it('falls back to CONFIG_PATH when no explicit path or env config is set', function() {
    const file = path.join(dir, 'other.json')
    fs.writeFileSync(file, JSON.stringify({ nick: 'pathbot' }))
    const config = loadConfig({ env: { CONFIG_PATH: file } })
    assert.equal(config.nick, 'pathbot')
  })

  it('passes a topic_store stanza through untouched', function() {
    const config = loadConfig({
      env: {
        SFEDITS_CONFIG: JSON.stringify({
          accounts: [],
          topic_store: {
            host: 'tools.db.svc.wikimedia.cloud',
            database: 's51234__sfedits'
          }
        })
      }
    })

    assert.equal(config.topic_store.database, 's51234__sfedits')
  })

  it('loads a config with no topic_store stanza', function() {
    const config = loadConfig({
      env: { SFEDITS_CONFIG: JSON.stringify({ accounts: [] }) }
    })

    assert.isUndefined(config.topic_store)
  })
})
