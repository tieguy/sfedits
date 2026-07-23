const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { resolveRegion, articlesByAdmin, parsePoint, ADMIN_CLASSES, assertQid, assertLang } = require('../lib/region')

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

  describe('parsePoint', function() {
    it('parses a normal WKT point', function() {
      const result = parsePoint('Point(-122.4194 37.7749)')
      assert.deepEqual(result, { lon: -122.4194, lat: 37.7749 })
    })

    it('parses a point with negative coordinates', function() {
      const result = parsePoint('Point(-122.5 -37.5)')
      assert.deepEqual(result, { lon: -122.5, lat: -37.5 })
    })

    it('parses a point with extra whitespace', function() {
      const result = parsePoint('Point(  -122.4  37.7  )')
      assert.deepEqual(result, { lon: -122.4, lat: 37.7 })
    })

    it('parses a globe-prefixed point', function() {
      // Globe prefix is silently dropped; we always treat as Earth
      const result = parsePoint('<http://www.wikidata.org/entity/Q111> Point(12.5 -3.25)')
      assert.deepEqual(result, { lon: 12.5, lat: -3.25 })
    })

    it('returns null for malformed coordinates (tight regex prevents parsing)', function() {
      // "Point(1.2.3 4)" has a malformed longitude with two decimal points.
      // The tight regex /(-?\d+(?:\.\d+)?)/ will not match "1.2.3", so the entire
      // regex fails and we return null. This test kills the mutation of the regex alone.
      const result = parsePoint('Point(1.2.3 4)')
      assert.isNull(result)
    })

    it('returns null for float overflow (Number.isFinite guards absurdly long literals)', function() {
      // An extremely long numeric literal like 999...999 (400 nines) overflows to Infinity.
      // The tight regex matches it successfully (it's still just digits), but Number.isFinite
      // rejects the overflow. This test kills the mutation of Number.isFinite removal alone.
      const result = parsePoint('Point(' + '9'.repeat(400) + ' 4)')
      assert.isNull(result)
    })

    it('returns null for invalid WKT', function() {
      assert.isNull(parsePoint('not a point'))
      assert.isNull(parsePoint(''))
      assert.isNull(parsePoint(null))
    })
  })

  describe('ADMIN_CLASSES', function() {
    it('contains the administrative entity classes', function() {
      assert.instanceOf(ADMIN_CLASSES, Set)
      assert.isTrue(ADMIN_CLASSES.has('Q515'), 'Q515 (city) should be in ADMIN_CLASSES')
      assert.isTrue(ADMIN_CLASSES.has('Q6256'), 'Q6256 (country) should be in ADMIN_CLASSES')
      assert.isFalse(ADMIN_CLASSES.has('Q123705'), 'Q123705 (neighborhood) should not be in ADMIN_CLASSES')
    })
  })

  describe('QID validation', function() {
    it('accepts a valid QID', function() {
      assert.equal(assertQid('Q62'), 'Q62')
      assert.equal(assertQid('Q1'), 'Q1')
      assert.equal(assertQid('Q123456789'), 'Q123456789')
    })

    it('rejects a QID with trailing space', function() {
      try {
        assertQid('Q62 ')
        assert.fail('expected assertQid to throw')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
    })

    it('rejects a QID with leading zeros in the numeric part', function() {
      try {
        assertQid('Q0123')
        assert.fail('expected assertQid to throw')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
      try {
        assertQid('Q0')
        assert.fail('expected assertQid to throw')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
    })

    it('rejects a bare number', function() {
      try {
        assertQid('62')
        assert.fail('expected assertQid to throw')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
    })

    it('rejects lowercase q', function() {
      try {
        assertQid('q62')
        assert.fail('expected assertQid to throw')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
    })


    it('rejects non-string input', function() {
      try {
        assertQid(123)
        assert.fail('expected assertQid to throw')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
    })
  })

  describe('language code validation', function() {
    it('accepts a valid two-letter language code', function() {
      assert.equal(assertLang('en'), 'en')
    })

    it('accepts a language code with subtags', function() {
      assert.equal(assertLang('zh-Hans'), 'zh-Hans')
      assert.equal(assertLang('pt-BR'), 'pt-BR')
    })

    it('accepts Wikipedia language codes like "simple" and "tokipona"', function() {
      assert.equal(assertLang('simple'), 'simple')
      assert.equal(assertLang('tokipona'), 'tokipona')
    })

    it('rejects SPARQL injection attempts in language codes', function() {
      try {
        assertLang('en" } UNION { ?item ?p ?o')
        assert.fail('expected assertLang to throw')
      } catch (error) {
        assert.include(error.message, 'Wiki language code')
      }
    })

    it('rejects language codes with spaces', function() {
      try {
        assertLang('en ')
        assert.fail('expected assertLang to throw')
      } catch (error) {
        assert.include(error.message, 'Wiki language code')
      }
    })

    it('rejects non-string input', function() {
      try {
        assertLang(123)
        assert.fail('expected assertLang to throw')
      } catch (error) {
        assert.include(error.message, 'Wiki language code')
      }
    })
  })

  describe('resolveRegion', function() {
    it('rejects an invalid input QID before querying SPARQL', async function() {
      // This test proves assertQid is called; if removed, this test fails
      // No SPARQL mock is set up, so if assertQid is skipped, the test would hang/error differently
      try {
        await resolveRegion('62')
        assert.fail('expected resolveRegion to throw for invalid QID')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
    })

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

    it('throws when a geo region has no coordinate to seed from', async function() {
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

    it('filters out bnode classes and resolves successfully with valid classes', async function() {
      // Simulate WDQS returning a bnode (from an "unknown value" snak) alongside a valid class
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: { value: 'http://www.wikidata.org/.well-known/genid/t123456' }, // bnode, not a real entity
          label: { value: 'San Francisco' }
        },
        {
          cls: entity('Q62049'),  // consolidated city-county, valid
          label: { value: 'San Francisco' },
          coord: { value: 'Point(-122.4194 37.7749)' }
        }
      ]))

      const region = await resolveRegion('Q62')

      // Should resolve successfully using only the valid Q62049 class
      assert.equal(region.qid, 'Q62')
      assert.equal(region.strategy, 'admin')
      assert.deepEqual(region.classes, ['Q62049'])
    })
  })

  describe('articlesByAdmin', function() {
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
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
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
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
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
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
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
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('queries without language filter when languages is omitted', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      nock(WDQS).post('/sparql', body =>
        !body.query.includes('VALUES ?lang')
      ).reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q1917571', strategy: 'admin' })

      assert.equal(articles.length, 1)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('skips articles with malformed percent-encoding in the sitelink', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([]))
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Good' },
          lang: { value: 'en' }
        },
        {
          item: entity('Q20'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Bad%E0%A4%A' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q1917571', strategy: 'admin' }, { languages: ['en'] })

      // Only the good sitelink should be returned; the malformed one should be skipped
      assert.equal(articles.length, 1)
      assert.equal(articles[0].title, 'Good')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('invokes onChunkError when a chunk query fails', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))
      // First chunk 400s; second chunk succeeds
      nock(WDQS).post('/sparql').reply(400, { error: 'Bad request' })
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q20'),
          cls: entity('Q5'),
          article: { value: 'https://en.wikipedia.org/wiki/Beta' },
          lang: { value: 'en' }
        }
      ]))

      const errors = []
      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' },
        {
          languages: ['en'],
          onChunkError: (chunk, error) => {
            errors.push({ chunk, error })
          }
        })

      // The surviving chunk should still return articles despite the error in the other chunk
      assert.equal(articles.length, 1)
      assert.equal(articles[0].title, 'Beta')
      assert.equal(errors.length, 1)
      assert.include(errors[0].error.message, '400')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('rejects an invalid language code', async function() {
      // This test proves languageFilter validates language codes before querying SPARQL
      // We need to mock subEntities, but the language validation error will occur first
      try {
        await articlesByAdmin(
          { qid: 'Q62', strategy: 'admin' },
          { languages: ['en" } UNION { ?item ?p ?o'] })
        assert.fail('expected articlesByAdmin to throw for invalid language code')
      } catch (error) {
        // The validation error should occur during languageFilter construction
        assert.include(error.message, 'Wiki language code')
      }
    })

    it('filters out unstrippable sub-entities and queries remaining valid anchors', async function() {
      // Simulate subEntities returning a mix of valid QIDs and unstrippable values
      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: { value: 'http://www.wikidata.org/.well-known/genid/abc123' } }, // genid, not a real entity
        { sub: entity('Q1111') },  // valid sub-entity
        { sub: entity('Q2222') }   // valid sub-entity
      ]))
      // Queries for the two valid sub-entities
      nock(WDQS).post('/sparql', body =>
        body.query.includes('wd:Q1111')
      ).reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))
      nock(WDQS).post('/sparql', body =>
        body.query.includes('wd:Q2222')
      ).reply(200, bindings([
        {
          item: entity('Q20'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Beta' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

      // Both valid sub-entities should have been queried and results returned
      assert.equal(articles.length, 2)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })
  })
})
