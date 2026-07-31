const { assert } = require('chai')
const nock = require('nock')
const { apiGet } = require('../scripts/reassess')

describe('reassess apiGet', function() {
  this.timeout(10000)
  afterEach(() => nock.cleanAll())

  it('waits out a 429 rather than burning a retry attempt', async function() {
    // more 429s than `tries` would allow if each consumed an attempt
    nock('https://api.test').get(/.*/).times(6).reply(429, '', { 'retry-after': '0' })
    nock('https://api.test').get(/.*/).reply(200, { ok: true })
    const out = await apiGet('https://api.test/w/api.php', { action: 'query' },
      { tries: 2, rateLimitWaitMs: 1 })
    assert.deepEqual(out, { ok: true })
  })

  it('honours a Retry-After header when present', async function() {
    nock('https://api.test').get(/.*/).reply(429, '', { 'retry-after': '1' })
    nock('https://api.test').get(/.*/).reply(200, { ok: true })
    const started = Date.now()
    await apiGet('https://api.test/w/api.php', { action: 'query' },
      { tries: 2, rateLimitWaitMs: 50 })
    assert.isAtLeast(Date.now() - started, 900, 'should have waited the full second')
  })

  it('still gives up on a non-429 error after `tries` attempts', async function() {
    nock('https://api.test').get(/.*/).times(5).reply(500)
    let threw = null
    try {
      await apiGet('https://api.test/w/api.php', { action: 'query' },
        { tries: 2, backoffMs: 1 })
    } catch (error) { threw = error }
    assert.isNotNull(threw, 'should have thrown')
    assert.match(threw.message, /HTTP 500/)
  })

  it('eventually gives up if the rate limit never clears', async function() {
    nock('https://api.test').get(/.*/).times(20).reply(429, '', { 'retry-after': '0' })
    let threw = null
    try {
      await apiGet('https://api.test/w/api.php', { action: 'query' },
        { tries: 2, rateLimitWaitMs: 1, maxRateLimitWaits: 3 })
    } catch (error) { threw = error }
    assert.isNotNull(threw, 'should not retry a rate limit forever')
    assert.match(threw.message, /HTTP 429/)
  })
})
