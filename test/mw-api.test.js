const { assert } = require('chai')
const nock = require('nock')
const { wmFetch, wmFetchJson, actionSession, restGetJson, _resetSessions } = require('../lib/mw-api')

const HOST = 'https://wm.test'

// undici wraps dispatcher errors as `TypeError: fetch failed` with the real
// code on the cause chain — walk it to find a headers-timeout anywhere.
const isHeadersTimeout = (error) => {
  for (let e = error; e; e = e.cause) {
    if (e.code === 'UND_ERR_HEADERS_TIMEOUT') return true
  }
  return false
}

// undici wraps dispatcher errors as `TypeError: fetch failed` with the real
// code on the cause chain — walk it to find a body-timeout anywhere.
const isBodyTimeout = (error) => {
  for (let e = error; e; e = e.cause) {
    if (e.code === 'UND_ERR_BODY_TIMEOUT') return true
  }
  return false
}

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
        component: 'test',
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
        component: 'test',
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
        await wmFetch(`${HOST}/thing`, { component: 'test', tries: 2, backoffMs: 1 })
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
          component: 'test',
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
        await wmFetch(`${HOST}/thing`, { component: 'test', tries: 4, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 404')
      }
      assert.equal(requests, 1)
    })

    it('honours Retry-After on 503 (per WMF load-shedding)', async function() {
      this.timeout(5000)
      nock(HOST).get('/thing').reply(503, '', { 'retry-after': '1' })
      nock(HOST).get('/thing').reply(200, 'ok')

      const started = Date.now()
      const res = await wmFetch(`${HOST}/thing`, {
        component: 'test',
        tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
      assert.isAtLeast(Date.now() - started, 900)
    })

    it('clamps hostile Retry-After waits to maxRetryAfterMs', async function() {
      this.timeout(2000)
      // Server sends Retry-After: 86400 (24 hours), but we clamp to 100ms
      nock(HOST).get('/thing').reply(503, '', { 'retry-after': '86400' })
      nock(HOST).get('/thing').reply(200, 'ok')

      const started = Date.now()
      const res = await wmFetch(`${HOST}/thing`, {
        component: 'test',
        tries: 2, backoffMs: 1, maxRateLimitWaits: 60, maxRetryAfterMs: 100
      })
      assert.equal(res.status, 200)
      // Should complete in ~100ms, not 24 hours
      assert.isBelow(Date.now() - started, 1000)
    })

    it('retries on network error with original error on final failure', async function() {
      this.timeout(2000)
      nock(HOST).get('/thing').replyWithError(new Error('ECONNREFUSED'))
      nock(HOST).get('/thing').replyWithError(new Error('ECONNREFUSED'))

      try {
        await wmFetch(`${HOST}/thing`, { component: 'test', tries: 2, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'ECONNREFUSED')
      }
    })

    it('retries transient network error then succeeds', async function() {
      this.timeout(2000)
      nock(HOST).get('/thing').replyWithError(new Error('ECONNREFUSED'))
      nock(HOST).get('/thing').reply(200, 'ok')

      const res = await wmFetch(`${HOST}/thing`, { component: 'test', tries: 2, backoffMs: 1 })
      assert.equal(res.status, 200)
    })

    it('clamps Retry-After on 429 to maxRetryAfterMs', async function() {
      this.timeout(2000)
      // Server sends Retry-After: 86400 (24 hours), but we clamp to 50ms
      nock(HOST).get('/thing').reply(429, '', { 'retry-after': '86400' })
      nock(HOST).get('/thing').reply(200, 'ok')

      const started = Date.now()
      const res = await wmFetch(`${HOST}/thing`, {
        component: 'test',
        tries: 2, backoffMs: 1, maxRateLimitWaits: 60, maxRetryAfterMs: 50
      })
      assert.equal(res.status, 200)
      // Should complete in ~50ms, not 24 hours
      assert.isBelow(Date.now() - started, 1000)
    })

    it('throws HTTP 503 when 503+Retry-After exhausts maxRateLimitWaits', async function() {
      this.timeout(5000)
      // Sustained 503 with Retry-After
      nock(HOST).get('/thing').times(20).reply(503, '', { 'retry-after': '1' })

      try {
        await wmFetch(`${HOST}/thing`, {
          component: 'test',
          tries: 2, backoffMs: 1, rateLimitWaitMs: 5, maxRateLimitWaits: 3, maxRetryAfterMs: 100
        })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 503')
      }
    })

    it('throws HTTP 429 when total wait time exceeds maxTotalWaitMs', async function() {
      this.timeout(2000)
      // Two 429s that each wait 100ms, total 200ms > maxTotalWaitMs 150ms
      nock(HOST).get('/thing').reply(429)
      nock(HOST).get('/thing').reply(429)
      nock(HOST).get('/thing').reply(200, 'ok')

      try {
        await wmFetch(`${HOST}/thing`, {
          component: 'test',
          tries: 4,
          backoffMs: 1,
          rateLimitWaitMs: 100,
          maxRateLimitWaits: 60,
          maxRetryAfterMs: 100,
          maxTotalWaitMs: 150 // First wait ~100ms, second would exceed this
        })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 429')
      }
    })

    it('regression: per-attempt timeout does not span waits between retries', async function() {
      this.timeout(5000)
      // Three 429s with retry-after:0.2 (0.2 seconds each) = ~600ms total
      // With timeoutMs: 150 (150ms per attempt), we'd fail if timeout spanned waits
      // Each attempt's fetch is served by nock in single-digit ms, well under 150ms.
      // The 200ms waits happen between attempts, outside any fetch, and each new
      // attempt composes a fresh AbortSignal.timeout — so the expired signal from
      // the previous attempt is discarded rather than aborting the next fetch.
      nock(HOST).get('/thing').times(3).reply(429, '', { 'retry-after': '0.2' })
      nock(HOST).get('/thing').reply(200, 'ok')

      const res = await wmFetch(`${HOST}/thing`, {
        component: 'test',
        tries: 2,
        backoffMs: 1,
        rateLimitWaitMs: 10,
        maxRateLimitWaits: 60,
        maxRetryAfterMs: 5 * 60 * 1000,
        maxTotalWaitMs: 10 * 60 * 1000,
        timeoutMs: 150 // Short timeout per attempt
      })
      assert.equal(res.status, 200)
    })

    it('respects caller-supplied AbortSignal and rejects immediately', async function() {
      this.timeout(2000)
      // When signal is pre-aborted, the abort is honored immediately without fetching.
      let requests = 0
      nock(HOST).get('/thing').times(5).reply(200, function() { requests++; return 'ok' })

      // Pre-abort the caller's signal
      const controller = new AbortController()
      controller.abort()

      try {
        await wmFetch(`${HOST}/thing`, { component: 'test', signal: controller.signal, tries: 4, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        // abort errors have name AbortError
        assert.equal(error.name, 'AbortError',
          `Expected AbortError, got: ${error.name} - ${error.message}`)
      }
      // Most important: NO requests were made (not even retried attempts)
      assert.equal(requests, 0, 'abort should be honored immediately without any fetch attempts')
    })

    it('throws when component is not provided', async function() {
      try {
        // Calling wmFetch without component should throw
        await wmFetch(`${HOST}/thing`)
        assert.fail('should have thrown')
      } catch (error) {
        assert.include(error.message, 'component', 'should mention component requirement')
      }
    })

    it('returns a non-ok response when throwOnHttpError is false', async function() {
      nock(HOST).get('/soft').reply(500, 'wdqs stack trace')

      const res = await wmFetch(`${HOST}/soft`, {
        component: 'test',
        tries: 1, throwOnHttpError: false
      })
      assert.equal(res.status, 500)
      assert.equal(await res.text(), 'wdqs stack trace')
    })

    it('still waits out 429s when throwOnHttpError is false', async function() {
      nock(HOST).get('/soft').times(3).reply(429)
      nock(HOST).get('/soft').reply(200, 'ok')

      const res = await wmFetch(`${HOST}/soft`, {
        component: 'test',
        tries: 1, throwOnHttpError: false, rateLimitWaitMs: 5, maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
    })
  })

  describe('wmFetch compliance headers', function() {
    it('cleans up abort listeners from sleep waits', async function() {
      this.timeout(2000)
      // Multiple 429s force multiple sleep() calls with the signal
      nock(HOST).get('/thing').times(3).reply(429)
      nock(HOST).get('/thing').reply(200, 'ok')

      const { getEventListeners } = require('events')
      const controller = new AbortController()
      const res = await wmFetch(`${HOST}/thing`, {
        component: 'test',
        signal: controller.signal,
        tries: 2,
        backoffMs: 1,
        rateLimitWaitMs: 5,
        maxRateLimitWaits: 60
      })
      assert.equal(res.status, 200)
      // Verify no abort listeners remain on the signal
      const listeners = getEventListeners(controller.signal, 'abort')
      assert.equal(listeners.length, 0, 'all abort listeners should be cleaned up')
    })

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

      const res = await wmFetch(`${HOST}/gz`, { component: 'test' })
      assert.equal(res.status, 200)
    })

    it('lets callers add headers without losing the compliance ones', async function() {
      nock(HOST)
        .matchHeader('accept', 'application/json')
        .matchHeader('accept-encoding', 'gzip')
        .get('/hdr')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/hdr`, { headers: { Accept: 'application/json' }, component: 'test' })
      assert.equal(res.status, 200)
    })

    it('protects User-Agent from uppercase caller override', async function() {
      const { userAgent } = require('../lib/user-agent')
      const expectedUA = userAgent('test-component')
      nock(HOST)
        .matchHeader('user-agent', ua => {
          // UA should NOT be the caller's malicious override
          assert.notEqual(ua, 'Mozilla/5.0')
          // UA should be the operator's
          assert.include(ua, 'sfedits-test-component')
          return true
        })
        .get('/ua-protected')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/ua-protected`, {
        component: 'test-component',
        headers: { 'User-Agent': 'Mozilla/5.0 (attacker)' }
      })
      assert.equal(res.status, 200)
    })

    it('protects User-Agent from lowercase caller override (exactly one header)', async function() {
      const { userAgent } = require('../lib/user-agent')
      const expectedUA = userAgent('test-component')
      nock(HOST)
        .matchHeader('user-agent', ua => {
          // UA must be exactly the operator's, not concatenated with the caller's malicious override
          // (Duplication via Headers.append manifests as comma-joined value)
          assert.equal(ua, expectedUA, `UA should be exactly "${expectedUA}", not concatenated with attacker value`)
          assert.notInclude(ua, ',', 'User-Agent should not contain comma from concatenation')
          return true
        })
        .get('/ua-lowercase')
        .reply(200, 'ok')

      const res = await wmFetch(`${HOST}/ua-lowercase`, {
        component: 'test-component',
        headers: { 'user-agent': 'Mozilla/5.0 (attacker)' }
      })
      assert.equal(res.status, 200)
    })
  })

  describe('wmFetchJson', function() {
    it('parses a JSON body', async function() {
      nock(HOST).get('/json').reply(200, { items: [1, 2] })

      const data = await wmFetchJson(`${HOST}/json`, { component: 'test' })
      assert.deepEqual(data, { items: [1, 2] })
    })

    it('throws HTTP <status> on error responses', async function() {
      nock(HOST).get('/json').reply(403, { error: 'nope' })

      try {
        await wmFetchJson(`${HOST}/json`, { component: 'test', tries: 2, backoffMs: 1 })
        assert.fail('should have thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 403')
      }
    })
  })

  describe('actionSession', function() {
    afterEach(function() {
      _resetSessions()
    })

    it('socket timeout fires against stalling real server (actionSession)', async function() {
      this.timeout(5000)

      // Real server test: create a server that accepts connections but never sends
      // a response. The socket timeout should fire and reject with UND_ERR_HEADERS_TIMEOUT.
      const http = require('http')
      const server = http.createServer(() => {
        // Accept connection but never send headers (triggers headersTimeout)
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        // Disable nock for 127.0.0.1 so real requests go through
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        // Use a very short timeout (100ms) that will fire before the server
        // could possibly respond (it won't respond at all).
        const session = await actionSession(baseUrl, 'test-real-timeout', { timeoutMs: 100 })

        let threw = false
        let error
        try {
          await session.request({ action: 'query' })
        } catch (e) {
          threw = true
          error = e
        }
        assert.isTrue(threw, 'should have rejected with timeout')
        // Expect either UND_ERR_HEADERS_TIMEOUT or a cause chain containing it
        assert.isTrue(
          isHeadersTimeout(error),
          `Expected headers-timeout on the cause chain, got: ${error.name} - ${error.message}`
        )
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('distinguishes between different timeoutMs values (undici ~1s granularity)', async function() {
      this.timeout(8000)
      // undici FastTimers have ~1s granularity: 100ms and 500ms both fire ~1s, but
      // 2500ms fires ~2.5s. Verify the CONFIGURED timeout matters by checking elapsed time.
      // This proves our configuration is actually being enforced, not just a fixed delay.

      const http = require('http')

      // Test case 1: short timeout (100ms) should fire around 1s due to granularity
      const server1 = http.createServer(() => {
        // Accept connection but never send headers (triggers headersTimeout)
      })
      await new Promise(resolve => server1.listen(0, '127.0.0.1', resolve))
      const { port: port1 } = server1.address()
      const baseUrl1 = `http://127.0.0.1:${port1}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        const session1 = await actionSession(baseUrl1, 'test-timeout-100', { timeoutMs: 100 })

        const start1 = Date.now()
        let threw1 = false
        try {
          await session1.request({ action: 'query' })
        } catch (e) {
          threw1 = true
        }
        const elapsed1 = Date.now() - start1

        assert.isTrue(threw1, 'timeoutMs:100 should reject')
        // Granularity is ~1s, so expect ~1000ms; verify it's less than 1500ms to prove
        // it's not the 2500ms timeout
        assert.isBelow(elapsed1, 1500, `timeoutMs:100 elapsed ${elapsed1}ms should be < 1500ms`)
      } finally {
        server1.close()
      }

      // Test case 2: longer timeout (2500ms) should fire around 2.5s
      const server2 = http.createServer(() => {
        // Accept connection but never send headers (triggers headersTimeout)
      })
      await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve))
      const { port: port2 } = server2.address()
      const baseUrl2 = `http://127.0.0.1:${port2}`

      try {
        _resetSessions()
        const session2 = await actionSession(baseUrl2, 'test-timeout-2500', { timeoutMs: 2500 })

        const start2 = Date.now()
        let threw2 = false
        try {
          await session2.request({ action: 'query' })
        } catch (e) {
          threw2 = true
        }
        const elapsed2 = Date.now() - start2

        assert.isTrue(threw2, 'timeoutMs:2500 should reject')
        // With ~1s granularity, 2500ms should fire around 2.5s; verify it's >= 2000ms
        // to distinguish from the 100ms case
        assert.isAtLeast(elapsed2, 2000, `timeoutMs:2500 elapsed ${elapsed2}ms should be >= 2000ms`)
      } finally {
        server2.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('socket timeout does not interrupt m3api Retry-After waits (real server)', async function() {
      this.timeout(5000)

      // Real server test: verify that socket timeouts (headersTimeout on the
      // dispatcher) do not interrupt m3api's Retry-After waits that happen
      // between attempts. The key design property: each attempt gets its own
      // AbortSignal.timeout(), but m3api's wait between attempts is outside
      // any timeout, so the expired signal from one attempt doesn't abort the next.
      const http = require('http')
      let hitCount = 0
      const server = http.createServer((req, res) => {
        hitCount++
        if (hitCount === 1) {
          // First hit: return 503 with Retry-After: 1 (1 second)
          res.writeHead(503, {
            'content-type': 'application/json',
            'retry-after': '1'
          })
          res.end(JSON.stringify({ error: { code: 'maxlag', info: 'Maxlag exceeded' } }))
        } else if (hitCount === 2) {
          // Second hit: return 200 OK
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ batchcomplete: true }))
        } else {
          res.writeHead(500)
          res.end('Unexpected hit')
        }
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        // Socket timeout: 200ms (smaller than the 1000ms Retry-After wait).
        // This proves the timeout doesn't cap the wait between attempts.
        const session = await actionSession(baseUrl, 'test-retry-real', { timeoutMs: 200 })

        const started = Date.now()
        const response = await session.request(
          { action: 'query' },
          { maxRetriesSeconds: 10 } // high budget, proves the timeout doesn't cap it
        )
        const elapsed = Date.now() - started

        assert.isTrue(response.batchcomplete, 'request should succeed after Retry-After wait')
        assert.equal(hitCount, 2, 'should have made exactly 2 requests')
        assert.isAtLeast(elapsed, 900, 'should have waited ~1000ms for Retry-After')
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('sends the Action API defaults and the operator User-Agent', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', value => value.includes(userAgent('test-session')))
        .get('/w/api.php')
        .query(q => q.formatversion === '2' && q.maxlag === '5' && q.errorformat === 'plaintext')
        .reply(200, { batchcomplete: true })

      const session = await actionSession('wm.test', 'test-session')
      const response = await session.request({ action: 'query' })
      assert.isTrue(response.batchcomplete)
      assert.isTrue(nock.isDone())
    })

    it('caches one session per host (first caller wins)', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', value => value.includes(userAgent('first-component')))
        .get('/w/api.php')
        .query(true)
        .reply(200, { batchcomplete: true })

      const a = await actionSession('wm.test', 'first-component')
      const b = await actionSession('wm.test', 'second-component')
      assert.strictEqual(a, b)

      // Verify the wire request carried the first caller's UA
      const response = await a.request({ action: 'query' })
      assert.isTrue(response.batchcomplete)
    })

    it('caches sessions per host + options (different timeouts are distinct)', async function() {
      // Same host + same options → same cached session
      const a1 = await actionSession('wm.test', 'comp-a', { timeoutMs: 30000 })
      const a2 = await actionSession('wm.test', 'comp-b', { timeoutMs: 30000 })
      assert.strictEqual(a1, a2, 'same host + same options should reuse cached session')

      // Same host + different options → distinct cached sessions
      const b = await actionSession('wm.test', 'comp-c', { timeoutMs: 15000 })
      assert.notStrictEqual(a1, b, 'same host + different timeoutMs should be distinct sessions')
    })

    it('normalizes host: bare host and full URL share the same session', async function() {
      // Per m3api's rule: 'wm.test' becomes 'https://wm.test/w/api.php'
      // So both forms should resolve to the same cached session
      const a = await actionSession('wm.test', 'comp-a')
      const b = await actionSession('https://wm.test/w/api.php', 'comp-b')
      assert.strictEqual(a, b, 'bare host and full URL should share the same session')
    })

    it('keeps sessions for different hosts distinct', async function() {
      const a = await actionSession('wm.test', 'c')
      const b = await actionSession('other.test', 'c')
      assert.notStrictEqual(a, b)
    })

    it('throws when component is not provided', async function() {
      try {
        await actionSession('wm.test')
        assert.fail('should have thrown')
      } catch (error) {
        assert.include(error.message, 'component', 'should mention component requirement')
      }
    })

    it('deletes the cache entry when session construction rejects', async function () {
      let failNext = true
      const real = require('../lib/user-agent')
      const proxyquire = require('proxyquire')
      const mod = proxyquire('../lib/mw-api', {
        './user-agent': { userAgent: (c) => {
          if (failNext) { failNext = false; throw new Error('boom') }
          return real.userAgent(c)
        } }
      })
      await mod.actionSession('wm.test', 'test').then(
        () => assert.fail('should reject'), (e) => assert.match(e.message, /boom/))
      assert.isOk(await mod.actionSession('wm.test', 'test'), 'second call must construct a fresh session')
    })

    it('retries bare 429 (no Retry-After) after a wait', async function() {
      this.timeout(5000)
      // Bare 429 (no Retry-After header), then success
      nock(HOST)
        .get('/w/api.php')
        .query(true)
        .reply(429, '')
      nock(HOST)
        .get('/w/api.php')
        .query(true)
        .reply(200, { batchcomplete: true })

      _resetSessions()
      const session = await actionSession('wm.test', 'test-bare-429', { bare429WaitMs: 50 })
      const started = Date.now()
      const response = await session.request(
        { action: 'query' },
        { maxRetriesSeconds: 10 }
      )
      const elapsed = Date.now() - started

      assert.isTrue(response.batchcomplete, 'request should succeed after bare 429 wait')
      assert.isAtLeast(elapsed, 40, 'should have waited before retrying')
    })

  })

  describe('restGetJson', function() {
    afterEach(function() {
      _resetSessions()
    })

    it('GETs a REST path and returns parsed JSON', async function() {
      // caller passes the path relative to rest.php; m3api-rest turns the
      // session's /w/api.php into /w/rest.php and appends it
      nock(HOST)
        .get('/w/rest.php/v1/revision/100/compare/200')
        .reply(200, { diff: [{ type: 0, text: 'unchanged' }] })

      const data = await restGetJson('wm.test', '/v1/revision/100/compare/200', {
        component: 'test-rest'
      })
      assert.deepEqual(data.diff, [{ type: 0, text: 'unchanged' }])
    })

    it('carries the operator User-Agent', async function() {
      const { userAgent } = require('../lib/user-agent')
      nock(HOST)
        .matchHeader('user-agent', value => value.includes(userAgent('test-rest')))
        .get('/w/rest.php/v1/page/Foo')
        .reply(200, { title: 'Foo' })

      const data = await restGetJson('wm.test', '/v1/page/Foo', {
        component: 'test-rest'
      })
      assert.equal(data.title, 'Foo')
    })

    it('socket timeout fires on REST requests against stalling server', async function() {
      this.timeout(5000)

      // Real server test: REST requests (which use session.fetch, not session.request)
      // should also respect socket-level timeouts.
      const http = require('http')
      const server = http.createServer(() => {
        // Accept connection but never send headers (triggers headersTimeout)
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        // Use a very short timeout (100ms)
        const session = await actionSession(baseUrl, 'test-rest-real-timeout', { timeoutMs: 100 })

        // m3api-rest calls session.fetch, which should respect the dispatcher timeout
        const { getJson } = await import('m3api-rest')
        let threw = false
        let error
        try {
          await getJson(session, '/v1/revision/100/compare/200')
        } catch (e) {
          threw = true
          error = e
        }
        assert.isTrue(threw, 'should have rejected with timeout')
        assert.isTrue(
          isHeadersTimeout(error),
          `Expected headers-timeout on the cause chain, got: ${error.name} - ${error.message}`
        )
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('body timeout fires when server sends headers but never ends body', async function() {
      this.timeout(10000)

      // Real server test: server sends response headers but never sends body.
      // The socket bodyTimeout should fire and reject with UND_ERR_BODY_TIMEOUT.
      // We use session.fetch() which uses the agent with our configured timeouts.
      const http = require('http')
      const server = http.createServer((req, res) => {
        // Send status and headers immediately
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': '1000'  // Claim body size but never send it
        })
        // Flush headers to the client (res.writeHead alone doesn't flush in Node).
        // This leaves the body owed, so client will timeout waiting for body data.
        res.write('x')
        // Don't call res.end() — body never fully arrives.
        // This will trigger bodyTimeout when client waits for more body data.
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        // Create a session with a medium timeout that allows headers to arrive
        // but fires on body read. With ~1s granularity, 1000ms allows headers but
        // should trigger timeout when body doesn't arrive.
        const session = await actionSession(baseUrl, 'test-body-timeout', { timeoutMs: 1000 })

        let threw = false
        let error
        try {
          // Use session.fetch() which respects the dispatcher timeouts
          const res = await session.fetch(`${baseUrl}/test`)
          // Try to read the body, which should timeout during body reads
          await res.text()
        } catch (e) {
          threw = true
          error = e
        }
        assert.isTrue(threw, 'should have rejected with timeout')
        // With headers flushed, client should timeout on body read, not headers.
        assert.isTrue(
          isBodyTimeout(error),
          `Expected body timeout, got: ${error.name} - ${error.message}`
        )
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('deadline rejects stalled request against real server', async function() {
      this.timeout(3000)
      // Real server test: verify that if a request stalls (tries to connect but
      // the server never responds), the deadline fires and rejects with AbortError,
      // not leaving the request hanging forever.

      const http = require('http')
      // Create a server that accepts connections but never responds
      const server = http.createServer(() => {
        // Accept connection but never send anything
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        // Create session with a very short deadline (100ms) so it fires before
        // network timeout or socket timeout can
        const session = await actionSession(baseUrl, 'test-deadline-real', { requestDeadlineMs: 100 })

        let threw = false
        let error
        try {
          await session.request({ action: 'query' })
        } catch (e) {
          threw = true
          error = e
        }
        assert.isTrue(threw, 'should have rejected')
        // Deadline produces AbortError
        assert.equal(error.name, 'AbortError', `Expected AbortError, got ${error.name}: ${error.message}`)
        assert.include(error.message, 'deadline', 'error should mention deadline')
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('request with long deadline completes before deadline', async function() {
      this.timeout(2000)
      // Verify that a request completing before the deadline succeeds normally
      // and the deadline doesn't interfere. Also verifies the timer doesn't hold
      // the event loop (test completes promptly, not stuck waiting on a timer).
      nock(HOST)
        .get('/w/api.php')
        .query(q => q.formatversion === '2' && q.maxlag === '5' && q.errorformat === 'plaintext')
        .reply(200, { batchcomplete: true })

      _resetSessions()
      try {
        const session = await actionSession('wm.test', 'test-deadline-success', { requestDeadlineMs: 10000 })
        const response = await session.request({ action: 'query' })
        assert.isTrue(response.batchcomplete)
        assert.isTrue(nock.isDone())
        // If the timer held the event loop, this test would timeout, but it completes promptly
      } finally {
        _resetSessions()
      }
    })

    it('real dispatcher: responsive server returns parsed Action API response', async function() {
      this.timeout(5000)
      // Transport test: real HTTP server (no nock interception) responding with
      // a valid Action API JSON body. Verifies the dispatcher correctly handles
      // the response and m3api parses it.
      const http = require('http')
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ batchcomplete: true, query: { pages: [] } }))
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        const session = await actionSession(baseUrl, 'test-real-dispatcher')

        const response = await session.request({ action: 'query', meta: 'siteinfo' })
        assert.isTrue(response.batchcomplete)
        assert.deepEqual(response.query.pages, [])
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('real dispatcher: session.fetch returns valid REST JSON', async function() {
      this.timeout(5000)
      // Transport test: real HTTP server returning valid REST JSON.
      // Verifies session.fetch (used by m3api-rest) correctly handles responses.
      const http = require('http')
      const server = http.createServer((req, res) => {
        if (req.url === '/w/rest.php/v1/page/Test') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ title: 'Test', id: 123 }))
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        const session = await actionSession(baseUrl, 'test-rest-fetch')

        // Simulate what m3api-rest does: call session.fetch directly
        const res = await session.fetch(`${baseUrl}/w/rest.php/v1/page/Test`)
        const data = await res.json()
        assert.equal(data.title, 'Test')
        assert.equal(data.id, 123)
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })

    it('request deadline fires against stalling real server', async function() {
      this.timeout(5000)
      // Real server test: verify that if a request stalls (socket times out is
      // bypassed somehow), the request deadline fires and rejects with AbortError.
      // This tests the out-of-band deadline guard works independently of socket timeouts.

      const http = require('http')
      // Create a server that accepts connections but never responds, forcing
      // the deadline to fire.
      const server = http.createServer(() => {
        // Accept connection but never respond
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        nock.cleanAll()
        nock.enableNetConnect(/127\.0\.0\.1/)

        _resetSessions()
        // Create session with a very short deadline (300ms) and longer socket timeout.
        // The deadline should fire first.
        const session = await actionSession(baseUrl, 'test-deadline-real', {
          timeoutMs: 2000,      // socket timeout is longer
          requestDeadlineMs: 300 // deadline fires first
        })

        let threw = false
        let error
        try {
          await session.request({ action: 'query' })
        } catch (e) {
          threw = true
          error = e
        }
        assert.isTrue(threw, 'should have rejected')
        // Deadline produces AbortError
        assert.equal(error.name, 'AbortError', `Expected AbortError, got ${error.name}`)
        assert.include(error.message, 'deadline', 'error should mention deadline')
      } finally {
        server.close()
        nock.cleanAll()
        nock.enableNetConnect()
        _resetSessions()
      }
    })
  })
})
