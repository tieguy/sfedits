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

    it('returns null for a malformed coordinate', function() {
      // "Point(1.2.3 4)" has a longitude with two decimal points. Note this does NOT
      // isolate the tight regex: Number.isFinite catches this case too, so the test
      // still passes if the regex is loosened back to /([-\d.]+)/. No known input
      // distinguishes the two guards - see the comment on parsePoint.
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

    it('accepts real wiki language codes that BCP 47 length rules would reject', function() {
      // Every one of these is a live wiki. "simple" and "tokipona" exceed the 3-letter
      // primary-subtag rule; "zh-classical" has a 9-character subtag. All were rejected
      // by earlier revisions of this regex, which is why they are pinned here.
      for (const code of [
        'en', 'es', 'simple', 'tokipona', 'zh-classical', 'zh-hans', 'zh-yue',
        'be-tarask', 'nds-nl', 'roa-tara', 'map-bms', 'cbk-zam', 'zh-min-nan',
        'bat-smg', 'fiu-vro', 'crh-latn', 'pt-br', 'sr-el'
      ]) {
        assert.equal(assertLang(code), code, `${code} must be accepted`)
      }
    })

    it('rejects SPARQL injection attempts in language codes', function() {
      try {
        assertLang('en" } UNION { ?item ?p ?o')
        assert.fail('expected assertLang to throw')
      } catch (error) {
        assert.include(error.message, 'Wiki language code')
      }
    })

    it('rejects language codes containing a space, leading or internal', function() {
      for (const bad of ['en ', 'e n', ' en']) {
        try {
          assertLang(bad)
          assert.fail(`expected assertLang to throw for ${JSON.stringify(bad)}`)
        } catch (error) {
          assert.include(error.message, 'Wiki language code')
        }
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

    it('never interpolates an unstrippable sub-entity into a query', async function() {
      // This guards the boundary between WDQS output and raw SPARQL interpolation.
      // Asserting on the returned articles is NOT sufficient: with the filter removed
      // the genid anchor simply produces an extra request that matches no interceptor,
      // sparqlChunked swallows it, and the article count is unchanged. So capture what
      // was actually SENT and assert the genid never reached a query string.
      const sent = []

      nock(WDQS).post('/sparql').reply(200, bindings([
        { sub: { value: 'http://www.wikidata.org/.well-known/genid/abc123' } }, // genid, not an entity
        { sub: entity('Q1111') },
        { sub: entity('Q2222') }
      ]))

      nock(WDQS).post('/sparql', body => {
        sent.push(body.query)
        return true
      }).times(3).reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))

      await articlesByAdmin({ qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

      assert.equal(sent.length, 2, 'exactly two closure queries, one per valid sub-entity')
      assert.isTrue(sent.every(q => !q.includes('genid')),
        'no query may contain the genid URI')
      assert.isTrue(sent.some(q => q.includes('wd:Q1111')))
      assert.isTrue(sent.some(q => q.includes('wd:Q2222')))
    })

    it('warns when every sub-entity was filtered out', async function() {
      // Falling back to one unchunked whole-region query is exactly the timeout the
      // chunking exists to prevent, so it must not happen silently.
      const warnings = []
      const originalWarn = console.warn
      console.warn = msg => warnings.push(msg)

      try {
        nock(WDQS).post('/sparql').reply(200, bindings([
          { sub: { value: 'http://www.wikidata.org/.well-known/genid/abc123' } }
        ]))
        nock(WDQS).post('/sparql').reply(200, bindings([]))

        await articlesByAdmin({ qid: 'Q62', strategy: 'admin' }, { languages: ['en'] })

        assert.equal(warnings.length, 1)
        assert.include(warnings[0], 'all 1 sub-entities were unusable')
      } finally {
        console.warn = originalWarn
      }
    })
  })

  describe('articlesByGeo', function() {
    const { articlesByGeo } = require('../lib/region')

    const SQUARE = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-122.43, 37.74], [-122.43, 37.78], [-122.39, 37.78],
          [-122.39, 37.74], [-122.43, 37.74]
        ]]
      }
    }

    it('keeps candidates inside the polygon and drops those outside', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },      // inside
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        },
        {
          item: entity('Q20'), cls: entity('Q515'),
          coord: { value: 'Point(-122.50 37.90)' },      // outside
          article: { value: 'https://en.wikipedia.org/wiki/Outside' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(articles.length, 1)
      assert.equal(articles[0].title, 'Inside')
      assert.equal(articles[0].source, 'geo')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('drops candidates with an unparseable coordinate', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'not a point' },
          article: { value: 'https://en.wikipedia.org/wiki/Bogus' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(articles.length, 0)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('rejects malformed sitelinks', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'not a valid URL' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(articles.length, 0)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('uses a default seed radius when radiusKm is omitted', async function() {
      const sent = []
      nock(WDQS).post('/sparql', body => {
        sent.push(body.query)
        return true
      }).reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        }
      ]))

      const { DEFAULT_SEED_RADIUS_KM } = require('../lib/region')

      await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      // Default radius should be used (from DEFAULT_SEED_RADIUS_KM)
      assert.equal(sent.length, 1)
      assert.include(sent[0], `wikibase:radius "${DEFAULT_SEED_RADIUS_KM}"`)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('uses an explicit radius when radiusKm is provided', async function() {
      const sent = []
      nock(WDQS).post('/sparql', body => {
        sent.push(body.query)
        return true
      }).reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        }
      ]))

      await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'], radiusKm: 12 })

      assert.equal(sent.length, 1)
      assert.include(sent[0], 'wikibase:radius "12"')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('throws when region has no boundary', async function() {
      try {
        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
          {})
        assert.fail('expected articlesByGeo to throw')
      } catch (error) {
        assert.include(error.message, 'boundary')
      }
    })

    it('throws when region has no centroid', async function() {
      try {
        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo' },
          { boundary: SQUARE })
        assert.fail('expected articlesByGeo to throw')
      } catch (error) {
        assert.include(error.message, 'centroid')
      }
    })

    it('validates radiusKm is a finite positive number', async function() {
      try {
        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
          { boundary: SQUARE, radiusKm: -5 })
        assert.fail('expected articlesByGeo to throw for negative radius')
      } catch (error) {
        assert.include(error.message, 'radius')
      }

      try {
        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
          { boundary: SQUARE, radiusKm: Infinity })
        assert.fail('expected articlesByGeo to throw for infinite radius')
      } catch (error) {
        assert.include(error.message, 'radius')
      }
    })

    it('validates the region QID before querying', async function() {
      // No SPARQL mock needed - validation must happen first
      try {
        await articlesByGeo(
          { qid: '123', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
          { boundary: SQUARE })
        assert.fail('expected articlesByGeo to throw for invalid QID')
      } catch (error) {
        assert.include(error.message, 'must look like "Q62"')
      }
      // Verify nock.isDone() - no SPARQL request should have been made
      assert.isTrue(nock.isDone(), 'no SPARQL request should be made for invalid QID')
    })

    it('validates centroid coordinates are finite before querying SPARQL', async function() {
      // Centroid with Infinity should throw before SPARQL query
      try {
        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: Infinity, lat: 37.76 } },
          { boundary: SQUARE })
        assert.fail('expected articlesByGeo to throw for infinite centroid')
      } catch (error) {
        assert.include(error.message, 'centroid coordinates must be finite')
      }
      assert.isTrue(nock.isDone(), 'no SPARQL request should be made for invalid centroid')
    })

    it('validates centroid coordinates are finite (NaN)', async function() {
      try {
        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: NaN, lat: 37.76 } },
          { boundary: SQUARE })
        assert.fail('expected articlesByGeo to throw for NaN centroid')
      } catch (error) {
        assert.include(error.message, 'centroid coordinates must be finite')
      }
      assert.isTrue(nock.isDone(), 'no SPARQL request should be made for NaN centroid')
    })
  })
})
