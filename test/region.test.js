const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { resolveRegion } = require('../lib/region')

const WDQS = 'https://query.wikidata.org'

function bindings(rows) {
  return { results: { bindings: rows } }
}

function entity(qid) {
  return { value: `http://www.wikidata.org/entity/${qid}` }
}

describe('region', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('resolveRegion', function() {
    it('classifies an administrative entity as the admin strategy', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q62049'),          // consolidated city-county
          label: { value: 'San Francisco' },
          osm: { value: '111968' },
          coord: { value: 'Point(-122.4194 37.7749)' }
        }
      ]))

      const region = await resolveRegion('Q62')

      assert.equal(region.qid, 'Q62')
      assert.equal(region.strategy, 'admin')
      assert.equal(region.label, 'San Francisco')
      assert.equal(region.osmRelationId, '111968')
      assert.deepEqual(region.centroid, { lon: -122.4194, lat: 37.7749 })
    })

    it('classifies an informal neighborhood as the geo strategy', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'),         // neighborhood
          label: { value: 'Mission District' },
          osm: { value: '2222222' },
          coord: { value: 'Point(-122.4148 37.7599)' }
        }
      ]))

      const region = await resolveRegion('Q1917571')

      assert.equal(region.strategy, 'geo')
      assert.equal(region.label, 'Mission District')
    })

    it('honors an explicit strategy override', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'),
          label: { value: 'Mission District' },
          coord: { value: 'Point(-122.4148 37.7599)' }
        }
      ]))

      const region = await resolveRegion('Q1917571', { strategy: 'admin' })

      assert.equal(region.strategy, 'admin')
    })

    it('throws a descriptive error when the QID is not a place', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))

      try {
        await resolveRegion('Q42')
        assert.fail('expected resolveRegion to throw')
      } catch (error) {
        assert.include(error.message, 'Q42')
        assert.include(error.message, 'not a usable place')
      }
    })

    it('falls back to geo when an informal region has no coordinate', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q123705'), label: { value: 'Nowhere' } }
      ]))

      try {
        await resolveRegion('Q999')
        assert.fail('expected resolveRegion to throw')
      } catch (error) {
        assert.include(error.message, 'no coordinate')
      }
    })
  })

  describe('articlesByAdmin', function() {
    const { articlesByAdmin } = require('../lib/region')

    it('returns one article row per sitelink, chunked by sub-entity', async function() {
      // chunk discovery query
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))
      // one closure query per chunk
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q20'),
          cls: entity('Q5'),
          article: { value: 'https://es.wikipedia.org/wiki/Beta' },
          lang: { value: 'es' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', label: 'San Francisco', strategy: 'admin' },
        { languages: ['en', 'es'] })

      assert.equal(articles.length, 2)
      assert.deepEqual(articles[0], {
        qid: 'Q10',
        cls: 'Q515',
        lang: 'en',
        wikipedia: 'en',
        title: 'Alpha',
        source: 'admin'
      })
      assert.equal(articles[1].title, 'Beta')
      assert.equal(articles[1].wikipedia, 'es')
    })

    it('decodes percent-encoded and underscored titles', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q30'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Caf%C3%A9_du_Nord' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(articles[0].title, 'Café du Nord')
    })

    it('deduplicates an item reachable through two sub-entities', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))
      const dupe = {
        item: entity('Q10'),
        cls: entity('Q515'),
        article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
        lang: { value: 'en' }
      }
      nock(WDQS).post('/sparql').reply(200, bindings([dupe]))
      nock(WDQS).post('/sparql').reply(200, bindings([dupe]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(articles.length, 1)
    })

    it('queries the region directly when it has no sub-entities', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      nock(WDQS).post('/sparql', body =>
        body.query.includes('wd:Q1917571')
      ).reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q1917571', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(articles.length, 1)
    })
  })
})
