const { assert } = require('chai')
const { describe, it, afterEach } = require('mocha')
const nock = require('nock')

const { fetchBoundary } = require('../lib/osm-boundary')

const OVERPASS = 'https://overpass-api.de'

describe('osm-boundary', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  it('stitches multiple outer ways into a single closed ring', async function() {
    // Real SF boundary structure: multiple ways that chain together
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        id: 111968,
        members: [
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 0 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 1, lon: 0 },
              { lat: 1, lon: 1 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 1, lon: 1 },
              { lat: 0, lon: 1 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 1 },
              { lat: 0, lon: 0 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('111968')

    assert.equal(polygon.type, 'Feature')
    assert.equal(polygon.geometry.type, 'Polygon')
    // ring is closed
    const ring = polygon.geometry.coordinates[0]
    assert.deepEqual(ring[0], ring[ring.length - 1])
    // all 4 corners preserved
    assert.equal(ring.length, 5) // 4 corners + 1 closing
  })

  it('handles ways that must be reversed to chain', async function() {
    // Some OSM boundaries have ways that chain in reverse
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 0 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 1, lon: 1 },  // this end matches previous way end if reversed
              { lat: 1, lon: 0 }   // need to reverse to chain with way 0
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 1, lon: 1 },
              { lat: 0, lon: 1 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 1 },
              { lat: 0, lon: 0 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('1234')

    const ring = polygon.geometry.coordinates[0]
    // Should be closed and have the right number of points
    assert.deepEqual(ring[0], ring[ring.length - 1])
    assert.equal(ring.length, 5) // 4 corners + 1 closing
  })

  it('handles separate outer rings (true multipolygon)', async function() {
    // Island + enclave = two separate outer rings
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          // Ring 1
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 0 },
              { lat: 1, lon: 1 },
              { lat: 0, lon: 1 },
              { lat: 0, lon: 0 }
            ]
          },
          // Ring 2
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 5, lon: 5 },
              { lat: 6, lon: 5 },
              { lat: 6, lon: 6 },
              { lat: 5, lon: 6 },
              { lat: 5, lon: 5 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('333')
    assert.equal(polygon.geometry.type, 'MultiPolygon')
    assert.equal(polygon.geometry.coordinates.length, 2)
  })

  it('includes inner ways as holes in polygons', async function() {
    // A boundary with an enclave/hole
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          // Outer ring
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 10, lon: 0 },
              { lat: 10, lon: 10 },
              { lat: 0, lon: 10 },
              { lat: 0, lon: 0 }
            ]
          },
          // Inner ring (hole)
          {
            type: 'way', role: 'inner',
            geometry: [
              { lat: 2, lon: 2 },
              { lat: 8, lon: 2 },
              { lat: 8, lon: 8 },
              { lat: 2, lon: 8 },
              { lat: 2, lon: 2 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('hole-test')

    assert.equal(polygon.geometry.type, 'Polygon')
    // GeoJSON represents holes as additional rings in the coordinates array
    assert.equal(polygon.geometry.coordinates.length, 2)
    // First is outer, second is inner
    const [outer, inner] = polygon.geometry.coordinates
    assert.equal(outer.length, 5)
    assert.equal(inner.length, 5)
  })

  it('builds a GeoJSON polygon from an Overpass relation', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        id: 2222222,
        members: [{
          type: 'way',
          role: 'outer',
          geometry: [
            { lat: 37.75, lon: -122.42 },
            { lat: 37.77, lon: -122.42 },
            { lat: 37.77, lon: -122.40 },
            { lat: 37.75, lon: -122.40 }
          ]
        }]
      }]
    })

    const polygon = await fetchBoundary('2222222')

    assert.equal(polygon.type, 'Feature')
    assert.equal(polygon.geometry.type, 'Polygon')
    // ring is closed
    const ring = polygon.geometry.coordinates[0]
    assert.deepEqual(ring[0], ring[ring.length - 1])
    assert.isTrue(nock.isDone())
  })

  it('throws when the relation has no usable geometry', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, { elements: [] })

    try {
      await fetchBoundary('404404')
      assert.fail('expected fetchBoundary to throw')
    } catch (error) {
      assert.include(error.message, '404404')
    }
  })

  it('surfaces Overpass quota exhaustion distinctly', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(429, 'rate limited')

    try {
      await fetchBoundary('555')
      assert.fail('expected fetchBoundary to throw')
    } catch (error) {
      assert.include(error.message, 'rate limit')
    }
  })
})
