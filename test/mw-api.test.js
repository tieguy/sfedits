const { assert } = require('chai')
const nock = require('nock')
const { wmFetch, wmFetchJson } = require('../lib/mw-api')

const HOST = 'https://wm.test'

describe('mw-api', function() {
  afterEach(function() {
    nock.cleanAll()
  })

  describe('wmFetch retry semantics', function() {
    // Ported from place-bot-platform-design test/reassess-api.test.js —
    // these four cases are the contract for 429/Retry-After behavior.

    it('waits out a 429 rather than burning a retry attempt', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').times(6).reply(429)
      nock(HOST).get('/thing').reply(200, 'ok')

      const res = await wmFetch(`${HOST}/thing`, {
        tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'ok')
    })

    it('honours a Retry-After header when present', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').reply(429, '', { 'retry-after': '1' })
      nock(HOST).get('/thing').reply(200, 'ok')

      const started = Date.now()
      const res = await wmFetch(`${HOST}/thing`, {
        tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
      assert.isAtLeast(Date.now() - started, 900)
    })

    it('still gives up on a 5xx after `tries` attempts', async function() {
      // count actual requests: nock.pendingMocks() counts interceptors, not
      // remaining .times() uses, so a reply function does the counting
      let requests = 0
      nock(HOST).get('/thing').times(5).reply(500, function() { requests++; return '' })

      try {
        await wmFetch(`${HOST}/thing`, { tries: 2, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 500')
      }
      assert.equal(requests, 2)
    })

    it('eventually gives up if the rate limit never clears', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').times(20).reply(429)

      try {
        await wmFetch(`${HOST}/thing`, {
          tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 3
        })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 429')
      }
    })

    it('does not retry a permanent 4xx', async function() {
      // Etiquette rule: never retry a permanent 4xx. 404 throws immediately.
      let requests = 0
      nock(HOST).get('/thing').times(3).reply(404, function() { requests++; return '' })

      try {
        await wmFetch(`${HOST}/thing`, { tries: 4, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 404')
      }
      assert.equal(requests, 1)
    })
  })

  describe('wmFetch compliance headers', function() {
    it('sends the operator User-Agent from lib/user-agent.js', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', userAgent('test-component'))
        .get('/ua')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/ua`, { component: 'test-component' })
      assert.equal(res.status, 200)
    })

    it('requests gzip', async function() {
      nock(HOST)
        .matchHeader('accept-encoding', 'gzip')
        .get('/gz')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/gz`)
      assert.equal(res.status, 200)
    })

    it('lets callers add headers without losing the compliance ones', async function() {
      nock(HOST)
        .matchHeader('accept', 'application/json')
        .matchHeader('accept-encoding', 'gzip')
        .get('/hdr')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/hdr`, { headers: { Accept: 'application/json' } })
      assert.equal(res.status, 200)
    })
  })

  describe('wmFetchJson', function() {
    it('parses a JSON body', async function() {
      nock(HOST).get('/json').reply(200, { items: [1, 2] })

      const data = await wmFetchJson(`${HOST}/json`)
      assert.deepEqual(data, { items: [1, 2] })
    })

    it('throws HTTP <status> on error responses', async function() {
      nock(HOST).get('/json').reply(403, { error: 'nope' })

      try {
        await wmFetchJson(`${HOST}/json`, { tries: 2, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 403')
      }
    })
  })
})
