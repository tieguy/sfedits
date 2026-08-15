const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const {
  resolveRegion, articlesByAdmin, parsePoint, ADMIN_CLASSES, assertQid, assertLang,
  memberPattern, IS_HERE_PROPERTIES
} = require('../lib/region')

const WDQS = 'https://query.wikidata.org'

function bindings(rows) {
  return { results: { bindings: rows } }
}

function entity(qid) {
  return { value: `http://www.wikidata.org/entity/${qid}` }
}

describe('region', function() {
  this.timeout(5000)

  beforeEach(function() {
    nock.disableNetConnect()
  })

  afterEach(function() {
    nock.cleanAll()
    nock.enableNetConnect()
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
      let err = null
      try {
        assertQid('Q62 ')
      } catch (e) {
        err = e
      }
      assert.isNotNull(err, 'expected assertQid to throw')
      assert.include(err.message, 'must look like "Q62"')
    })

    it('rejects a QID with leading zeros in the numeric part', function() {
      let err1
      try {
        assertQid('Q0123')
      } catch (e) {
        err1 = e
      }
      assert.isNotNull(err1, 'expected assertQid to throw')
      assert.include(err1.message, 'must look like "Q62"')

      let err2
      try {
        assertQid('Q0')
      } catch (e) {
        err2 = e
      }
      assert.isNotNull(err2, 'expected assertQid to throw')
      assert.include(err2.message, 'must look like "Q62"')
    })

    it('rejects a bare number', function() {
      let err = null
      try {
        assertQid('62')
      } catch (e) {
        err = e
      }
      assert.isNotNull(err, 'expected assertQid to throw')
      assert.include(err.message, 'must look like "Q62"')
    })

    it('rejects lowercase q', function() {
      let err = null
      try {
        assertQid('q62')
      } catch (e) {
        err = e
      }
      assert.isNotNull(err, 'expected assertQid to throw')
      assert.include(err.message, 'must look like "Q62"')
    })

    it('rejects non-string input', function() {
      let err = null
      try {
        assertQid(123)
      } catch (e) {
        err = e
      }
      assert.isNotNull(err, 'expected assertQid to throw')
      assert.include(err.message, 'must look like "Q62"')
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
      let err = null
      try {
        assertLang('en" } UNION { ?item ?p ?o')
      } catch (e) {
        err = e
      }
      assert.isNotNull(err, 'expected assertLang to throw')
      assert.include(err.message, 'Wiki language code')
    })

    it('rejects language codes containing a space, leading or internal', function() {
      for (const bad of ['en ', 'e n', ' en']) {
        let err = null
        try {
          assertLang(bad)
        } catch (e) {
          err = e
        }
        assert.isNotNull(err, `expected assertLang to throw for ${JSON.stringify(bad)}`)
        assert.include(err.message, 'Wiki language code')
      }
    })

    it('rejects non-string input', function() {
      let err = null
      try {
        assertLang(123)
      } catch (e) {
        err = e
      }
      assert.isNotNull(err, 'expected assertLang to throw')
      assert.include(err.message, 'Wiki language code')
    })
  })

  describe('resolveRegion', function() {
    it('rejects an invalid input QID before querying SPARQL', async function() {
      // This test proves assertQid is called; if removed, this test fails
      // No SPARQL mock is set up, so if assertQid is skipped, the test would hang/error differently
      const err = await resolveRegion('62').then(() => null, e => e)
      assert.isNotNull(err, 'expected resolveRegion to reject')
      assert.include(err.message, 'must look like "Q62"')
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

    it('classifies a subclass of an admin class as the admin strategy', async function() {
      // San Mateo County's real P31 is Q131427665, "charter county of
      // California" - a subclass of county, not county itself. Matching P31
      // against a flat set missed it, the region fell through to the geo
      // strategy, and its 5km centroid seed returned 13 articles for a whole
      // county without erroring. The subclass walk is what catches this.
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q131427665'),
          adminCls: entity('Q28575'),     // ...which is a county
          label: { value: 'San Mateo County' },
          coord: { value: 'Point(-122.35 37.43)' }
        }
      ]))

      const region = await resolveRegion('Q108101')

      assert.equal(region.strategy, 'admin')
    })

    it('does not treat the generic admin root as an admin classification',
      async function() {
        // Q56061 (administrative territorial entity) is the root nearly every
        // place class descends from, INCLUDING neighborhoods. Walking to it
        // would flip the Mission District to the admin strategy and undo the
        // whole boundary-resolution design. Only specific classes count.
        nock(WDQS).post('/sparql').reply(200, bindings([
          {
            cls: entity('Q748198'),        // neighborhood of San Francisco
            adminCls: entity('Q56061'),    // ...only reaches the generic root
            label: { value: 'Mission District' },
            coord: { value: 'Point(-122.4148 37.7599)' }
          }
        ]))

        const region = await resolveRegion('Q7469')

        assert.equal(region.strategy, 'geo',
          'a neighborhood must keep the geo strategy')
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

      const err = await resolveRegion('Q42').then(() => null, e => e)
      assert.isNotNull(err, 'expected resolveRegion to reject')
      assert.include(err.message, 'Q42')
      assert.include(err.message, 'not a usable place')
    })

    it('throws when a geo region has no coordinate to seed from', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q123705'), label: { value: 'Nowhere' } }
      ]))

      const err = await resolveRegion('Q999').then(() => null, e => e)
      assert.isNotNull(err, 'expected resolveRegion to reject')
      assert.include(err.message, 'no coordinate')
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

  describe('memberPattern', function() {
    it('builds the located-in closure pattern for P131', function() {
      const pattern = memberPattern('P131', 'Q717')
      assert.match(pattern, /\?item wdt:P131\* wd:Q717/)
    })

    it('builds the pointer-property pattern for a property like P159', function() {
      const pattern = memberPattern('P159', 'Q717')
      assert.match(pattern, /\?item wdt:P159 \?place/)
      assert.match(pattern, /\?place wdt:P131\* wd:Q717/)
    })

    it('builds the office-jurisdiction union for P39', function() {
      const pattern = memberPattern('P39', 'Q717')
      assert.match(pattern, /\?item wdt:P39 \?pos/)
      assert.match(pattern, /\?pos wdt:P1001 wd:Q717/)
      assert.match(pattern, /UNION/)
      assert.match(pattern, /\?j wdt:P131\+ wd:Q717 . \?pos wdt:P1001 \?j/)
    })

    it('validates the anchor QID', function() {
      assert.throws(() => memberPattern('P131', 'Q0abc'), /QID/)
    })

    it('rejects a malformed property id', function() {
      assert.throws(() => memberPattern('P131 } UNION { ?x ?y ?z', 'Q717'), /[Pp]roperty/)
    })

    it('exports the vetted is-here property set', function() {
      assert.deepEqual(IS_HERE_PROPERTIES, ['P131', 'P159', 'P276', 'P39'])
    })
  })

  describe('articlesByAdmin', function() {
    it('defaults to one anchored query per is-here property, deduplicated', async function() {
      // The membership rule is the reassess universe rule: located in the
      // region (P131*), headquartered (P159) or located (P276) there, or
      // holding an office whose jurisdiction is there (P39). One serial query
      // per property - Wikimedia etiquette forbids fan-out, and anchored
      // single-property queries are the shape WDQS handles without timeouts.
      const sent = []
      const capture = body => { sent.push(body.query); return true }
      nock(WDQS)
        .post('/sparql', capture).reply(200, bindings([
          {
            item: entity('Q10'), cls: entity('Q515'),
            article: { value: 'https://es.wikipedia.org/wiki/Caracas' },
            lang: { value: 'es' }
          }
        ]))
        .post('/sparql', capture).reply(200, bindings([
          {
            item: entity('Q20'), cls: entity('Q4830453'),
            article: { value: 'https://es.wikipedia.org/wiki/PDVSA' },
            lang: { value: 'es' }
          }
        ]))
        .post('/sparql', capture).reply(200, bindings([
          // P276 returns an article P131 already found: dedup keeps one row.
          {
            item: entity('Q10'), cls: entity('Q515'),
            article: { value: 'https://es.wikipedia.org/wiki/Caracas' },
            lang: { value: 'es' }
          }
        ]))
        .post('/sparql', capture).reply(200, bindings([
          {
            item: entity('Q30'), cls: entity('Q5'),
            article: { value: 'https://es.wikipedia.org/wiki/Presidenta' },
            lang: { value: 'es' }
          }
        ]))

      const articles = await articlesByAdmin(
        { qid: 'Q717', label: 'Venezuela', strategy: 'admin' },
        { languages: ['es'] })

      assert.equal(sent.length, 4, 'one query per is-here property')
      assert.include(sent[0], 'wdt:P131* wd:Q717')
      assert.include(sent[1], 'wdt:P159 ?place')
      assert.include(sent[2], 'wdt:P276 ?place')
      assert.include(sent[3], 'wdt:P39 ?pos')
      for (const query of sent) {
        assert.include(query, 'wd:Q717', 'every query is anchored at the region')
      }

      assert.equal(articles.length, 3, 'Caracas found twice is returned once')
      const bySource = Object.fromEntries(articles.map(a => [a.title, a.source]))
      assert.equal(bySource.Caracas, 'admin', 'P131 membership keeps the admin source tag')
      assert.equal(bySource.PDVSA, 'P159')
      assert.equal(bySource.Presidenta, 'P39')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('queries only the requested properties when the option is given', async function() {
      const sent = []
      nock(WDQS).post('/sparql', body => { sent.push(body.query); return true })
        .reply(200, bindings([]))

      const articles = await articlesByAdmin(
        { qid: 'Q717', strategy: 'admin' },
        { languages: ['es'], properties: ['P131'] })

      assert.equal(sent.length, 1, 'a pinned property list overrides the default')
      assert.deepEqual(articles, [])
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('returns article rows from a single unchunked query anchored at the region', async function() {
      const sent = []
      nock(WDQS).post('/sparql', body => { sent.push(body.query); return true }).reply(200, bindings([
        {
          item: entity('Q10'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        },
        {
          item: entity('Q20'),
          cls: entity('Q5'),
          article: { value: 'https://es.wikipedia.org/wiki/Beta' },
          lang: { value: 'es' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q664', label: 'New Zealand', strategy: 'admin' },
        { languages: ['en', 'es'], properties: ['P131'] })

      assert.equal(sent.length, 1, 'exactly one query - no per-sub-entity chunking')
      assert.include(sent[0], 'wd:Q664', 'the closure is anchored at the region itself')
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
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q30'),
          cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Caf%C3%A9_du_Nord' },
          lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'], properties: ['P131'] })

      assert.equal(articles[0].title, 'Café du Nord')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('deduplicates an item that appears more than once in the result set', async function() {
      const dupe = {
        item: entity('Q10'),
        cls: entity('Q515'),
        article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
        lang: { value: 'en' }
      }
      nock(WDQS).post('/sparql').reply(200, bindings([dupe, dupe]))

      const articles = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' }, { languages: ['en'], properties: ['P131'] })

      assert.equal(articles.length, 1)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('queries without language filter when languages is omitted', async function() {
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
        { qid: 'Q1917571', strategy: 'admin' }, { properties: ['P131'] })

      assert.equal(articles.length, 1)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('skips articles with malformed percent-encoding in the sitelink', async function() {
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
        { qid: 'Q1917571', strategy: 'admin' }, { languages: ['en'], properties: ['P131'] })

      // Only the good sitelink should be returned; the malformed one should be skipped
      assert.equal(articles.length, 1)
      assert.equal(articles[0].title, 'Good')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('throws a clear out-of-scope error when the query times out', async function() {
      // WDQS signals a query timeout with a 500 whose body names the timeout. A region
      // whose P131* closure cannot be resolved in one query (e.g. a whole large country
      // like the USA) is out of scope, and the failure must say so rather than surface a
      // bare 500 - see place-bot-region-scale-scope.
      nock(WDQS).post('/sparql').reply(500,
        'java.util.concurrent.TimeoutException: Query timed out')

      const err = await articlesByAdmin(
        { qid: 'Q30', label: 'United States of America', strategy: 'admin' },
        { languages: ['en'] }).then(() => null, e => e)

      assert.isNotNull(err, 'expected a WDQS timeout to reject')
      assert.include(err.message, 'Q30')
      assert.include(err.message, 'too large')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('validates the region QID before querying', async function() {
      // region.qid is interpolated straight into the closure query, so it must be
      // validated here - there is no longer a subEntities() call to do it first.
      const err = await articlesByAdmin(
        { qid: 'Q0abc', strategy: 'admin' }, { languages: ['en'] }).then(() => null, e => e)
      assert.isNotNull(err, 'expected an invalid QID to reject')
      assert.include(err.message, 'QID')
    })

    it('rejects an invalid language code before querying SPARQL', async function() {
      const err = await articlesByAdmin(
        { qid: 'Q62', strategy: 'admin' },
        { languages: ['en" } UNION { ?item ?p ?o'] }).then(() => null, e => e)
      assert.isNotNull(err, 'expected articlesByAdmin to reject')
      assert.include(err.message, 'Wiki language code')
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

      await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      // The seed is sized from the boundary, not from a flat default. SQUARE's
      // farthest corner is ~2.8km from this centre, so with the margin and the
      // ceiling the radius is 4km. A flat 5km happened to cover this fixture;
      // it did NOT cover a county, which is the bug this sizing prevents.
      assert.equal(sent.length, 1)
      assert.include(sent[0], 'wikibase:radius "4"')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('sizes the seed to a large boundary instead of the 5km default',
      async function() {
        // A county-sized square: ~0.5 degrees, far beyond a 5km seed. Before
        // this, the seed stayed at 5km, the polygon filter had nothing to trim,
        // and a whole county came back as a dozen articles without any error.
        const county = {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [-122.6, 37.2], [-122.6, 37.7], [-122.1, 37.7],
              [-122.1, 37.2], [-122.6, 37.2]
            ]]
          }
        }

        const sent = []
        nock(WDQS).post('/sparql', body => {
          sent.push(body.query)
          return true
        }).reply(200, bindings([]))

        await articlesByGeo(
          { qid: 'Q108101', strategy: 'geo', centroid: { lon: -122.35, lat: 37.45 } },
          { boundary: county, languages: ['en'] })

        const radius = Number(/wikibase:radius "(\d+)"/.exec(sent[0])[1])
        assert.isAbove(radius, 30, 'a county-sized boundary needs a county-sized seed')
      })

    it('falls back to the default radius when the boundary has no usable geometry',
      async function() {
        const sent = []
        nock(WDQS).post('/sparql', body => {
          sent.push(body.query)
          return true
        }).reply(200, bindings([]))

        await articlesByGeo(
          { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
          {
            boundary: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
            languages: ['en']
          })

        assert.include(sent[0], 'wikibase:radius "5"')
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

    it('returns the whole radius seed unfiltered when no boundary is given', async function() {
      // Approximate mode (resolveBoundary's radius tier): no polygon to trim against,
      // so every candidate in the radius seed is kept - even one far from the centroid.
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'https://en.wikipedia.org/wiki/Near' }, lang: { value: 'en' }
        },
        {
          item: entity('Q20'), cls: entity('Q515'),
          coord: { value: 'Point(-122.99 37.99)' },
          article: { value: 'https://en.wikipedia.org/wiki/Far' }, lang: { value: 'en' }
        }
      ]))

      const articles = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { languages: ['en'] })  // no boundary

      assert.equal(articles.length, 2, 'no polygon filter - the radius seed is the answer')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('throws when region has no centroid', async function() {
      const err = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo' },
        { boundary: SQUARE }).then(() => null, e => e)
      assert.isNotNull(err, 'expected articlesByGeo to reject')
      assert.include(err.message, 'centroid')
    })

    it('validates radiusKm is a finite positive number', async function() {
      const err1 = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, radiusKm: -5 }).then(() => null, e => e)
      assert.isNotNull(err1, 'expected articlesByGeo to reject for negative radius')
      assert.include(err1.message, 'radius')

      const err2 = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, radiusKm: Infinity }).then(() => null, e => e)
      assert.isNotNull(err2, 'expected articlesByGeo to reject for infinite radius')
      assert.include(err2.message, 'radius')
    })

    it('validates the region QID before querying', async function() {
      // No SPARQL mock needed - validation must happen first
      const err = await articlesByGeo(
        { qid: '123', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE }).then(() => null, e => e)
      assert.isNotNull(err, 'expected articlesByGeo to reject')
      assert.include(err.message, 'must look like "Q62"')
      // Verify nock.isDone() - no SPARQL request should have been made
      assert.isTrue(nock.isDone(), 'no SPARQL request should be made for invalid QID')
    })

    it('validates centroid coordinates are finite before querying SPARQL', async function() {
      // Centroid with Infinity should throw before SPARQL query
      const err = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: Infinity, lat: 37.76 } },
        { boundary: SQUARE }).then(() => null, e => e)
      assert.isNotNull(err, 'expected articlesByGeo to reject')
      assert.include(err.message, 'centroid coordinates must be finite')
      assert.isTrue(nock.isDone(), 'no SPARQL request should be made for invalid centroid')
    })

    it('validates centroid coordinates are finite (NaN)', async function() {
      const err = await articlesByGeo(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: NaN, lat: 37.76 } },
        { boundary: SQUARE }).then(() => null, e => e)
      assert.isNotNull(err, 'expected articlesByGeo to reject')
      assert.include(err.message, 'centroid coordinates must be finite')
      assert.isTrue(nock.isDone(), 'no SPARQL request should be made for NaN centroid')
    })
  })

  describe('articlesForRegion', function() {
    const { articlesForRegion } = require('../lib/region')

    it('takes the admin path for an administrative region', async function() {
      // resolveRegion
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q62049'), label: { value: 'San Francisco' } }
      ]))
      // membership: one query per is-here property (P131 finds Alpha, the
      // pointer and office queries come back empty here)
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
          lang: { value: 'en' }
        }
      ]))
      nock(WDQS).post('/sparql').times(3).reply(200, bindings([]))

      const result = await articlesForRegion('Q62', { languages: ['en'] })

      assert.equal(result.region.strategy, 'admin')
      assert.equal(result.articles.length, 1)
      assert.equal(result.articles[0].source, 'admin')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('fetches a boundary and takes the geo path for a neighborhood', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'), label: { value: 'Mission District' },
          osm: { value: '2222222' },
          coord: { value: 'Point(-122.41 37.76)' }
        }
      ]))
      nock('https://overpass-api.de').post('/api/interpreter').reply(200, {
        elements: [{
          type: 'relation',
          members: [{
            type: 'way', role: 'outer',
            geometry: [
              { lat: 37.74, lon: -122.43 }, { lat: 37.78, lon: -122.43 },
              { lat: 37.78, lon: -122.39 }, { lat: 37.74, lon: -122.39 }
            ]
          }]
        }]
      })
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'https://en.wikipedia.org/wiki/Inside' },
          lang: { value: 'en' }
        }
      ]))

      const result = await articlesForRegion('Q1917571', { languages: ['en'] })

      assert.equal(result.region.strategy, 'geo')
      assert.equal(result.articles.length, 1)
      assert.equal(result.articles[0].source, 'geo')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('surfaces a container suggestion when a boundaryless region has a boundaried parent', async function() {
      // resolveRegion: neighborhood (geo), has a coord, no P402
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'), label: { value: 'Vague Place' },
          coord: { value: 'Point(-122.41 37.76)' }
        }
      ]))
      // resolveBoundary tier 2: P131 parent Q62 carries a boundary
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q999')).reply(200, bindings([
        { parent: entity('Q62'), parentLabel: { value: 'San Francisco' },
          osm: { value: '111968' }, cls: entity('Q515') }
      ]))

      const result = await articlesForRegion('Q999', { languages: ['en'] })

      assert.isTrue(result.needsConfirmation, 'container substitution must be surfaced, not silent')
      assert.equal(result.suggestion.qid, 'Q62')
      assert.isUndefined(result.articles, 'no articles fetched before confirmation')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('returns an approximate result when there is no boundary and no boundaried ancestor', async function() {
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          cls: entity('Q123705'), label: { value: 'Vague Place' },
          coord: { value: 'Point(-122.41 37.76)' }
        }
      ]))
      // resolveBoundary tier 2: parent has no boundary...
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q999')).reply(200, bindings([
        { parent: entity('Q100'), parentLabel: { value: 'Unbounded' }, cls: entity('Q1') }
      ]))
      // ...and neither does anything above it
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q100')).reply(200, bindings([]))
      // tier 3 radius: articlesByGeo seeds a disc and returns it unfiltered
      nock(WDQS).post('/sparql').reply(200, bindings([
        {
          item: entity('Q10'), cls: entity('Q515'),
          coord: { value: 'Point(-122.41 37.76)' },
          article: { value: 'https://en.wikipedia.org/wiki/X' }, lang: { value: 'en' }
        }
      ]))

      const result = await articlesForRegion('Q999', { languages: ['en'] })

      assert.isTrue(result.approximate, 'radius fallback stays on the region but flags imprecision')
      assert.equal(result.articles.length, 1)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })
  })

  describe('resolveBoundary', function() {
    const { resolveBoundary } = require('../lib/region')

    const OVERPASS = 'https://overpass-api.de'
    function overpassSquare() {
      // fetchBoundary stitches an outer ring from Overpass way geometry
      return {
        elements: [{
          type: 'relation',
          members: [{
            type: 'way', role: 'outer',
            geometry: [
              { lat: 37.74, lon: -122.43 }, { lat: 37.78, lon: -122.43 },
              { lat: 37.78, lon: -122.39 }, { lat: 37.74, lon: -122.39 }
            ]
          }]
        }]
      }
    }

    it('tier 1 (self): returns the place own boundary when it has P402', async function() {
      nock(OVERPASS).post('/api/interpreter').reply(200, overpassSquare())

      const result = await resolveBoundary({
        qid: 'Q62', label: 'San Francisco', osmRelationId: '111968',
        centroid: { lon: -122.42, lat: 37.77 }
      })

      assert.equal(result.source, 'self')
      assert.isTrue(result.exact)
      assert.equal(result.boundary.type, 'Feature')
      assert.isTrue(nock.isDone(), 'all mocked requests were consumed')
    })

    it('tier 2 (container): falls back to the boundaried P131 container', async function() {
      // Q7469 (Mission) has no P402; its P131 parent Q62 (SF) does.
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q7469')).reply(200, bindings([
        { parent: entity('Q62'), parentLabel: { value: 'San Francisco' },
          osm: { value: '111968' }, cls: entity('Q515') }
      ]))

      const result = await resolveBoundary({
        qid: 'Q7469', label: 'Mission District', osmRelationId: null,
        centroid: { lon: -122.42, lat: 37.76 }
      })

      assert.equal(result.source, 'container')
      assert.isFalse(result.exact)
      assert.deepEqual(result.suggestion,
        { qid: 'Q62', label: 'San Francisco', class: 'Q515', via: 'p131' })
      assert.isTrue(nock.isDone(), 'all mocked requests were consumed')
    })

    it('tier 2: skips an unbounded parent and climbs to the next level', async function() {
      // Level 1 parent Q100 has no P402; level 2 parent Q200 does.
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q50')).reply(200, bindings([
        { parent: entity('Q100'), parentLabel: { value: 'Unbounded District' }, cls: entity('Q1') }
      ]))
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q100')).reply(200, bindings([
        { parent: entity('Q200'), parentLabel: { value: 'Bounded City' },
          osm: { value: '999' }, cls: entity('Q515') }
      ]))

      const result = await resolveBoundary({
        qid: 'Q50', label: 'Deep Place', osmRelationId: null,
        centroid: { lon: 0, lat: 0 }
      })

      assert.equal(result.source, 'container')
      assert.equal(result.suggestion.qid, 'Q200')
      assert.equal(result.suggestion.via, 'p131')
      assert.isTrue(nock.isDone(), 'all mocked requests were consumed')
    })

    it('tier 2: picks the smallest-by-area container when a level has several', async function() {
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q7469')).reply(200, bindings([
        { parent: entity('Q10'), parentLabel: { value: 'Big County' },
          osm: { value: '10' }, cls: entity('Q28575'), area: { value: '1200' } },
        { parent: entity('Q20'), parentLabel: { value: 'Small City' },
          osm: { value: '20' }, cls: entity('Q515'), area: { value: '120' } }
      ]))

      const result = await resolveBoundary({
        qid: 'Q7469', label: 'Mission District', osmRelationId: null,
        centroid: { lon: -122.42, lat: 37.76 }
      })

      assert.equal(result.suggestion.qid, 'Q20', 'smaller area wins')
      assert.isTrue(nock.isDone(), 'all mocked requests were consumed')
    })

    it('tier 3 (radius): no boundaried ancestor falls back to a radius on the centroid', async function() {
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q50')).reply(200, bindings([
        { parent: entity('Q100'), parentLabel: { value: 'Unbounded' }, cls: entity('Q1') }
      ]))
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q100')).reply(200, bindings([]))

      const result = await resolveBoundary({
        qid: 'Q50', label: 'Orphan Place', osmRelationId: null,
        centroid: { lon: -1.2, lat: 51.7 }
      })

      assert.equal(result.source, 'radius')
      assert.isFalse(result.exact)
      assert.deepEqual(result.centroid, { lon: -1.2, lat: 51.7 })
      assert.isTrue(nock.isDone(), 'all mocked requests were consumed')
    })

    it('tier 3: terminates on a P131 cycle and falls back to radius', async function() {
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q50')).reply(200, bindings([
        { parent: entity('Q60'), parentLabel: { value: 'A' }, cls: entity('Q1') }
      ]))
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q60')).reply(200, bindings([
        { parent: entity('Q50'), parentLabel: { value: 'B' }, cls: entity('Q1') } // back to Q50
      ]))

      const result = await resolveBoundary({
        qid: 'Q50', label: 'Cyclic', osmRelationId: null, centroid: { lon: 0, lat: 0 }
      })

      assert.equal(result.source, 'radius', 'cycle must not loop forever')
      assert.isTrue(nock.isDone(), 'all mocked requests were consumed')
    })

    it('tier 3: throws when there is no boundary and no centroid to approximate from', async function() {
      nock(WDQS).post('/sparql', body => body.query.includes('wd:Q50')).reply(200, bindings([]))

      const err = await resolveBoundary({
        qid: 'Q50', label: 'Nowhere', osmRelationId: null, centroid: null
      }).then(() => null, e => e)

      assert.isNotNull(err, 'expected resolveBoundary to reject')
      assert.include(err.message, 'no coordinate')
    })
  })

  describe('regionHistogram', function() {
    const { regionHistogram, countFromHistogram } = require('../lib/region')

    it('returns class x language cells, not articles', async function() {
      const sent = []
      nock(WDQS).post('/sparql', body => { sent.push(body.query); return true }).reply(200, bindings([
        { cls: entity('Q515'), lang: { value: 'en' }, count: { value: '120' } },
        { cls: entity('Q5'), lang: { value: 'en' }, count: { value: '80' } },
        { cls: entity('Q515'), lang: { value: 'es' }, count: { value: '30' } }
      ]))

      const histogram = await regionHistogram(
        { qid: 'Q62', strategy: 'admin' }, { properties: ['P131'] })

      assert.equal(sent.length, 1, 'exactly one query - no per-sub-entity chunking')
      assert.include(sent[0], 'wd:Q62', 'the histogram is anchored at the region itself')
      assert.equal(histogram.cells.length, 3)
      assert.deepEqual(histogram.cells[0], { cls: 'Q515', lang: 'en', count: 120 })
      assert.equal(histogram.total, 230)
      assert.isFalse(histogram.partial)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('sums a (class, language) cell that appears more than once in the result', async function() {
      // A GROUP BY normally returns each (cls, lang) once, but the merge step is kept
      // defensively so a duplicated row cannot overwrite or double-list a cell. Feed one
      // response with a repeated (Q515, en) to prove the counts are summed, not replaced.
      nock(WDQS).post('/sparql').reply(200, bindings([
        { cls: entity('Q515'), lang: { value: 'en' }, count: { value: '120' } },
        { cls: entity('Q515'), lang: { value: 'en' }, count: { value: '30' } },
        { cls: entity('Q5'), lang: { value: 'en' }, count: { value: '7' } }
      ]))

      const histogram = await regionHistogram(
        { qid: 'Q62', strategy: 'admin' }, { properties: ['P131'] })

      assert.equal(histogram.cells.length, 2, 'Q515/en must appear as ONE merged cell')
      const q515 = histogram.cells.find(c => c.cls === 'Q515' && c.lang === 'en')
      assert.equal(q515.count, 150, '120 + 30 summed, not overwritten')
      assert.equal(histogram.total, 157)
      assert.isFalse(histogram.partial)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('aggregates every is-here property and merges the cells', async function() {
      // The estimate must widen with membership: if articlesByAdmin includes
      // office holders and headquartered orgs, the create-form count has to
      // count them too, or the max_articles gate undercounts. Overlap between
      // properties makes this an over-estimate; the dry run stays the truth.
      const sent = []
      const capture = body => { sent.push(body.query); return true }
      nock(WDQS)
        .post('/sparql', capture).reply(200, bindings([
          { cls: entity('Q515'), lang: { value: 'es' }, count: { value: '100' } }
        ]))
        .post('/sparql', capture).reply(200, bindings([
          { cls: entity('Q4830453'), lang: { value: 'es' }, count: { value: '20' } }
        ]))
        .post('/sparql', capture).reply(200, bindings([
          { cls: entity('Q515'), lang: { value: 'es' }, count: { value: '5' } }
        ]))
        .post('/sparql', capture).reply(200, bindings([
          { cls: entity('Q5'), lang: { value: 'es' }, count: { value: '40' } }
        ]))

      const histogram = await regionHistogram({ qid: 'Q717', strategy: 'admin' })

      assert.equal(sent.length, 4, 'one aggregation per is-here property')
      const q515 = histogram.cells.find(c => c.cls === 'Q515' && c.lang === 'es')
      assert.equal(q515.count, 105, 'cells for the same (cls, lang) merge across properties')
      assert.equal(histogram.total, 165)
      assert.isFalse(histogram.partial)
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('sums matching cells client-side with no further queries', function() {
      const histogram = {
        cells: [
          { cls: 'Q515', lang: 'en', count: 120 },
          { cls: 'Q5', lang: 'en', count: 80 },
          { cls: 'Q515', lang: 'es', count: 30 }
        ],
        total: 230
      }

      assert.equal(
        countFromHistogram(histogram, { classes: ['Q515'], languages: ['en'] }), 120)
      assert.equal(
        countFromHistogram(histogram, { classes: ['Q515'], languages: ['en', 'es'] }), 150)
      assert.equal(
        countFromHistogram(histogram, { classes: ['Q515', 'Q5'], languages: ['en'] }), 200)
      assert.equal(countFromHistogram(histogram, {}), 230)
    })

    it('buckets the polygon-filtered list for a geo region', async function() {
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

      const histogram = await regionHistogram(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } },
        { boundary: SQUARE, languages: ['en'] })

      assert.equal(histogram.total, 1,
        'the count must respect the polygon, not the radius seed')
      assert.deepEqual(histogram.cells, [{ cls: 'Q515', lang: 'en', count: 1 }])
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })

    it('refuses a geo histogram with no boundary', async function() {
      const err = await regionHistogram(
        { qid: 'Q1917571', strategy: 'geo', centroid: { lon: -122.41, lat: 37.76 } }, {})
        .then(() => null, e => e)
      assert.isNotNull(err, 'expected regionHistogram to reject')
      assert.include(err.message, 'boundary')
    })

    it('throws a clear out-of-scope error when the histogram query times out', async function() {
      nock(WDQS).post('/sparql').reply(500, 'Query timeout limit reached')

      const err = await regionHistogram(
        { qid: 'Q30', label: 'United States of America', strategy: 'admin' })
        .then(() => null, e => e)

      assert.isNotNull(err, 'expected a WDQS timeout to reject')
      assert.include(err.message, 'Q30')
      assert.include(err.message, 'too large')
      assert.isTrue(nock.isDone(), 'all mocked SPARQL requests were consumed')
    })
  })
})
