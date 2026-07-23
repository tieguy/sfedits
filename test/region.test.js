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
})
