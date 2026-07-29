const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { titlesForQidsViaApi, normalizeTitle } = require('../lib/title-resolver')

describe('title-resolver', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('normalizeTitle', function() {
    it('converts underscores to spaces', function() {
      assert.equal(normalizeTitle('Cafe_du_Nord'), 'Cafe du Nord')
    })

    it('decodes a Buffer from the replicas', function() {
      assert.equal(normalizeTitle(Buffer.from('Café_du_Nord', 'utf8')), 'Café du Nord')
    })

    it('collapses repeated whitespace and trims', function() {
      assert.equal(normalizeTitle('  Alpha__Beta  '), 'Alpha Beta')
    })

    it('returns null for empty input', function() {
      assert.isNull(normalizeTitle(''))
      assert.isNull(normalizeTitle(null))
    })
  })

  describe('titlesForQidsViaApi', function() {
    it('maps QIDs to current titles per wiki', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              eswiki: { site: 'eswiki', title: 'Alfa' }
            } },
            Q20: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Beta' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10', 'Q20'], { languages: ['en', 'es'] })

      assert.deepEqual(result.get('Q10'), [
        { wikipedia: 'en', title: 'Alpha' },
        { wikipedia: 'es', title: 'Alfa' }
      ])
      assert.deepEqual(result.get('Q20'), [{ wikipedia: 'en', title: 'Beta' }])
    })

    it('filters to the requested languages', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              dewiki: { site: 'dewiki', title: 'Alpha (DE)' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10'], { languages: ['en'] })
      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('ignores non-wikipedia sitelinks', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              enwikiquote: { site: 'enwikiquote', title: 'Alpha' },
              commonswiki: { site: 'commonswiki', title: 'Category:Alpha' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10'], {})
      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('batches requests at 50 ids, the API limit', async function() {
      const qids = Array.from({ length: 120 }, (_, i) => `Q${i + 1}`)
      let calls = 0

      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .times(3)
        .reply(200, function() {
          calls++
          return { entities: {} }
        })

      await titlesForQidsViaApi(qids, {})
      assert.equal(calls, 3)
    })

    it('omits entities the API reports as missing', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, { entities: { Q99: { missing: '' } } })

      const result = await titlesForQidsViaApi(['Q99'], {})
      assert.isFalse(result.has('Q99'))
    })
  })
})
