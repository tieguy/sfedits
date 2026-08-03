const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { sparqlSelect, sparqlRows, sparqlChunked, isRetryable } = require('../lib/sparql')

const WDQS = 'https://query.wikidata.org'

function bindings(rows) {
  return {
    results: {
      bindings: rows
    }
  }
}

describe('sparql', function() {
  this.timeout(15000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('sparqlSelect', function() {
    it('returns bare QIDs from the first column', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { p: { value: 'http://www.wikidata.org/entity/Q62' } },
        { p: { value: 'http://www.wikidata.org/entity/Q100' } }
      ]))

      const result = await sparqlSelect('SELECT ?p WHERE { }')
      assert.deepEqual(result, ['Q62', 'Q100'])
    })
  })

  describe('sparqlRows', function() {
    it('returns every column, stripping entity prefixes', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: { value: 'http://www.wikidata.org/entity/Q1' },
          article: { value: 'https://en.wikipedia.org/wiki/Balmy_Alley' },
          cls: { value: 'http://www.wikidata.org/entity/Q1500350' }
        }
      ]))

      const rows = await sparqlRows('SELECT ?item ?article ?cls WHERE { }')
      assert.deepEqual(rows, [{
        item: 'Q1',
        article: 'https://en.wikipedia.org/wiki/Balmy_Alley',
        cls: 'Q1500350'
      }])
    })

    it('omits unbound optional columns', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { item: { value: 'http://www.wikidata.org/entity/Q1' } }
      ]))

      const rows = await sparqlRows('SELECT ?item ?article WHERE { }')
      assert.deepEqual(rows, [{ item: 'Q1' }])
    })
  })

  describe('sparqlChunked', function() {
    it('runs one query per chunk and concatenates the rows', async function() {
      const seen = []
      nock(WDQS).post('/sparql', body => {
        seen.push(body.query)
        return true
      }).times(3).reply(200, bindings([
        { item: { value: 'http://www.wikidata.org/entity/Q1' } }
      ]))

      const rows = await sparqlChunked(
        ['Q62', 'Q107146', 'Q108058'],
        qid => `SELECT ?item WHERE { ?item wdt:P131* wd:${qid} }`
      )

      assert.equal(rows.length, 3)
      assert.equal(seen.length, 3)
      assert.isTrue(seen.some(q => q.includes('wd:Q107146')))
    })

    it('retries a chunk that times out, then succeeds', async function() {
      nock(WDQS).post('/sparql').reply(500, 'Query timeout limit reached')
      nock(WDQS).post('/sparql').reply(200, bindings([
        { item: { value: 'http://www.wikidata.org/entity/Q9' } }
      ]))

      const rows = await sparqlChunked(['Q62'], qid => `SELECT ?item WHERE { wd:${qid} }`,
        { retries: 1, retryDelayMs: 0 })

      assert.deepEqual(rows, [{ item: 'Q9' }])
    })

    it('reports which chunks failed after exhausting retries', async function() {
      nock(WDQS).post('/sparql').times(2).reply(500, 'Query timeout limit reached')

      const failed = []
      const rows = await sparqlChunked(['Q62'], qid => `SELECT ?item WHERE { wd:${qid} }`,
        { retries: 1, retryDelayMs: 0, onChunkError: (chunk) => failed.push(chunk) })

      assert.deepEqual(rows, [])
      assert.deepEqual(failed, ['Q62'])
      assert.isTrue(nock.isDone())
    })

    it('does not retry on non-retryable errors (400)', async function() {
      nock(WDQS).post('/sparql').times(1).reply(400, 'Bad Request')

      const failed = []
      const rows = await sparqlChunked(['Q62'], qid => `SELECT ?item WHERE { wd:${qid} }`,
        { retries: 2, retryDelayMs: 0, onChunkError: (chunk) => failed.push(chunk) })

      assert.deepEqual(rows, [])
      assert.deepEqual(failed, ['Q62'])
      assert.isTrue(nock.isDone())
    })

    it('uses default console.error reporter when onChunkError is absent', async function() {
      let errorLogged = false
      const originalError = console.error
      console.error = function(msg) {
        errorLogged = errorLogged || msg.includes('SPARQL chunk Q62 failed')
      }

      try {
        nock(WDQS).post('/sparql').reply(500, 'Internal Server Error')

        await sparqlChunked(['Q62'], qid => `SELECT ?item WHERE { wd:${qid} }`,
          { retries: 0, retryDelayMs: 0 })

        assert.isTrue(errorLogged)
      } finally {
        console.error = originalError
      }
    })
  })

  describe('sparqlRaw rate-limit error handling', function() {
    it('exhausts maxRateLimitWaits on 429, restores status, and throws', async function() {
      // Four 429s (exceeds maxRateLimitWaits: 3 in sparqlRaw options).
      // Retry-After: 1 = 1 second; small but > 0 so wmFetch uses it.
      nock(WDQS).post('/sparql').times(4).reply(429, '', { 'retry-after': '1' })

      try {
        await sparqlRows('SELECT ?p WHERE { }')
        assert.fail('Expected error to be thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 429')
        assert.equal(error.status, 429, 'catch restore must attach .status for 429')
        assert.equal(error.body, '', 'catch restore must attach empty .body')
        assert.isTrue(isRetryable(error), 'restored error must classify as retryable')
      }
    })

    it('exhausts maxRateLimitWaits on 503+Retry-After, restores status, and throws', async function() {
      // Four 503s with Retry-After (exceeds maxRateLimitWaits: 3).
      // Retry-After: 1 = 1 second; small but > 0 so wmFetch uses it.
      nock(WDQS).post('/sparql').times(4).reply(503, '', { 'retry-after': '1' })

      try {
        await sparqlRows('SELECT ?p WHERE { }')
        assert.fail('Expected error to be thrown')
      } catch (error) {
        assert.equal(error.message, 'HTTP 503')
        assert.equal(error.status, 503, 'catch restore must attach .status for 503')
        assert.equal(error.body, '', 'catch restore must attach empty .body')
        assert.isTrue(isRetryable(error), 'restored 503 error must classify as retryable')
      }
    })
  })

  describe('isRetryable', function() {
    it('returns true for 429 with empty body', function() {
      const error = new Error('Too Many Requests')
      error.status = 429
      error.body = ''
      assert.isTrue(isRetryable(error))
    })

    it('returns true for 429 with unhelpful body', function() {
      const error = new Error('Too Many Requests')
      error.status = 429
      error.body = '<html>Error</html>'
      assert.isTrue(isRetryable(error))
    })

    it('returns false for 400 (malformed query)', function() {
      const error = new Error('Bad Request')
      error.status = 400
      error.body = 'Malformed query'
      assert.isFalse(isRetryable(error))
    })

    it('returns true for 500', function() {
      const error = new Error('Internal Server Error')
      error.status = 500
      error.body = ''
      assert.isTrue(isRetryable(error))
    })

    it('returns true for body containing "Query timeout limit reached"', function() {
      const error = new Error('Query timed out')
      error.status = 200
      error.body = 'Query timeout limit reached on this server'
      assert.isTrue(isRetryable(error))
    })

    it('returns true for TimeoutError', function() {
      const error = new Error('Timeout')
      error.name = 'TimeoutError'
      assert.isTrue(isRetryable(error))
    })

    it('returns true for AbortError', function() {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      assert.isTrue(isRetryable(error))
    })

    it('returns false for non-retryable error', function() {
      const error = new Error('Unknown error')
      error.status = 403
      error.body = 'Forbidden'
      assert.isFalse(isRetryable(error))
    })
  })
})
