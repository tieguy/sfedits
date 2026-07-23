const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { sparqlSelect, sparqlRows, sparqlChunked } = require('../lib/sparql')

const WDQS = 'https://query.wikidata.org'

function bindings(rows) {
  return {
    results: {
      bindings: rows
    }
  }
}

describe('sparql', function() {
  this.timeout(5000)

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
      let callCount = 0
      nock(WDQS).post('/sparql').times(3).reply(function() {
        callCount++
        return [200, bindings([
          { item: { value: 'http://www.wikidata.org/entity/Q1' } }
        ])]
      })

      const rows = await sparqlChunked(
        ['Q62', 'Q107146', 'Q108058'],
        qid => `SELECT ?item WHERE { ?item wdt:P131* wd:${qid} }`
      )

      assert.equal(rows.length, 3)
      assert.equal(callCount, 3)
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
    })
  })
})
