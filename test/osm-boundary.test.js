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
    // Verify the exact coordinate ordering after reversal (format is [lon, lat])
    assert.deepEqual(ring, [
      [0, 0], [0, 1], [1, 1], [1, 0], [0, 0]
    ])
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
    // Verify nesting depth: coordinates[i][j][k] must exist and be a number pair
    for (let i = 0; i < 2; i++) {
      assert.isArray(polygon.geometry.coordinates[i], `coordinates[${i}] must be array`)
      assert.isArray(polygon.geometry.coordinates[i][0], `coordinates[${i}][0] must be array (outer ring)`)
      assert.isNumber(polygon.geometry.coordinates[i][0][0][0], `coordinates[${i}][0][0][0] must be number`)
      assert.isNumber(polygon.geometry.coordinates[i][0][0][1], `coordinates[${i}][0][0][1] must be number`)
    }
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

  it('throws when outer ways cannot be stitched into a closed ring', async function() {
    // Three ways that form an incomplete chain, never closing
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
              { lat: 1, lon: 0 },
              { lat: 1, lon: 1 }
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

    const err = await fetchBoundary('incomplete').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject')
    assert.include(err.message, 'unclosed')
  })

  it('rejects zero-area rings created by duplicate ways', async function() {
    // A square split into 4 ways, but one way is listed twice (duplicate)
    // This creates a 3-point "ring" that violates the 4-point minimum
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
          },
          // Duplicate of first way - will create a zero-area 3-point ring if stitched alone
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 0 }
            ]
          }
        ]
      }]
    })

    const err = await fetchBoundary('degenerate').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject')
    assert.include(err.message, 'unclosed')
  })

  it('rejects zero-area rings with only 3 points', async function() {
    // Two ways form a closed 3-point ring [[0,0],[1,1],[0,0]] which has zero area
    // (a degenerate line segment). This must be rejected via the ring.length >= 4 guard.
    // The test includes one valid square so we can verify the boundary has at least
    // one valid ring and we're genuinely rejecting the zero-area one, not failing entirely.
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          // Two ways that close into a degenerate 3-point ring [[0,0],[1,1],[0,0]]
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 1 }
            ]
          },
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 1, lon: 1 },
              { lat: 0, lon: 0 }
            ]
          },
          // One valid square that should be accepted
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 10, lon: 10 },
              { lat: 11, lon: 10 },
              { lat: 11, lon: 11 },
              { lat: 10, lon: 11 },
              { lat: 10, lon: 10 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('zero-area-ring-test')
    // Should have exactly one polygon (the valid square), not including the degenerate 3-point ring
    assert.equal(polygon.geometry.type, 'Polygon')
    const outerRing = polygon.geometry.coordinates[0]
    assert.equal(outerRing.length, 5) // 4 corners + closing point
  })

  it('associates holes with the correct outer ring in a multipolygon', async function() {
    // Two outer lobes A (0,0)..(10,10) and B (20,20)..(30,30)
    // Inner hole (22,22)..(28,28) belongs INSIDE B, not A
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          // Outer lobe A
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
          // Outer lobe B
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 20, lon: 20 },
              { lat: 30, lon: 20 },
              { lat: 30, lon: 30 },
              { lat: 20, lon: 30 },
              { lat: 20, lon: 20 }
            ]
          },
          // Inner hole (should go to B, not A)
          {
            type: 'way', role: 'inner',
            geometry: [
              { lat: 22, lon: 22 },
              { lat: 28, lon: 22 },
              { lat: 28, lon: 28 },
              { lat: 22, lon: 28 },
              { lat: 22, lon: 22 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('multihole')
    assert.equal(polygon.geometry.type, 'MultiPolygon')
    assert.equal(polygon.geometry.coordinates.length, 2)

    // Lobe A should have no holes
    assert.equal(polygon.geometry.coordinates[0].length, 1)
    // Lobe B should have 1 hole
    assert.equal(polygon.geometry.coordinates[1].length, 2)
  })

  it('throws when a hole is not contained by any outer ring', async function() {
    // A hole that doesn't belong to any outer ring
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
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
          // Hole completely outside the outer ring
          {
            type: 'way', role: 'inner',
            geometry: [
              { lat: 50, lon: 50 },
              { lat: 55, lon: 50 },
              { lat: 55, lon: 55 },
              { lat: 50, lon: 55 },
              { lat: 50, lon: 50 }
            ]
          }
        ]
      }]
    })

    const err = await fetchBoundary('orphan-hole').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject')
    assert.include(err.message, 'hole not contained')
  })

  it('throws on non-200/non-429 Overpass response', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(500, 'Server error')

    const err = await fetchBoundary('999').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject')
    assert.include(err.message, 'Overpass returned')
    assert.include(err.message, '500')
  })

  it('throws when relation exists but has no outer members', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        id: 111,
        members: [
          // No outer role members
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

    const err = await fetchBoundary('111').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject')
    assert.include(err.message, 'no usable outer')
  })

  it('throws when stitchRings cannot close an outer way', async function() {
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        id: 222,
        members: [
          // Single open way that is not closed and cannot be stitched
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 0 }
            ]
          }
        ]
      }]
    })

    const err = await fetchBoundary('222').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject')
    assert.include(err.message, 'unclosed')
  })

  it('does not extend already-closed ways beyond their natural boundary', async function() {
    // Two completely separate closed ways; they should NOT merge even though
    // they share an endpoint. Each should form its own ring. This is a critical test
    // for the isClosed() guard that prevents stitching of already-closed ways.
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          // Closed square 1: (0,0) to (1,0) to (1,1) to (0,1) back to (0,0)
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
          // Closed square 2: starts/ends at (0,0), goes the opposite direction
          // (-1,0) to (-1,-1) to (0,-1) back to (0,0)
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: -1, lon: 0 },
              { lat: -1, lon: -1 },
              { lat: 0, lon: -1 },
              { lat: 0, lon: 0 }
            ]
          }
        ]
      }]
    })

    const polygon = await fetchBoundary('touching-squares')
    assert.equal(polygon.geometry.type, 'MultiPolygon')
    // Should have two separate polygons, not merged into one self-intersecting polygon
    assert.equal(polygon.geometry.coordinates.length, 2)
    // Each polygon should be valid (closed ring)
    for (const poly of polygon.geometry.coordinates) {
      const ring = poly[0]
      assert.deepEqual(ring[0], ring[ring.length - 1], 'outer ring must be closed')
    }
  })

  it('drops a malformed inner way with a warning instead of aborting', async function() {
    // A valid outer boundary plus one dangling 2-point inner way (uncloseable)
    // Should gracefully drop the inner ring with a console.warn, not throw
    const warnings = []
    const originalWarn = console.warn
    console.warn = msg => warnings.push(msg)

    try {
      nock(OVERPASS).post('/api/interpreter').reply(200, {
        elements: [{
          type: 'relation',
          members: [
            // Valid outer square
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
            // Dangling inner way - cannot be closed
            {
              type: 'way', role: 'inner',
              geometry: [
                { lat: 2, lon: 2 },
                { lat: 8, lon: 2 }
              ]
            }
          ]
        }]
      })

      const polygon = await fetchBoundary('inner-defect')

      // Should succeed with just the valid outer ring, no inner ring
      assert.equal(polygon.geometry.type, 'Polygon')
      assert.equal(polygon.geometry.coordinates.length, 1, 'should have only outer ring, no inner rings')
      // Should have warned about the malformed inner way
      assert.equal(warnings.length, 1)
      assert.include(warnings[0], 'unclosed inner ring')
    } finally {
      console.warn = originalWarn
    }
  })

  it('still throws when an outer way cannot be closed', async function() {
    // A dangling outer way should still throw immediately
    nock(OVERPASS).post('/api/interpreter').reply(200, {
      elements: [{
        type: 'relation',
        members: [
          // Dangling outer way - cannot be closed
          {
            type: 'way', role: 'outer',
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 10, lon: 0 }
            ]
          }
        ]
      }]
    })

    const err = await fetchBoundary('bad-outer').then(() => null, e => e)
    assert.isNotNull(err, 'expected fetchBoundary to reject for unclosed outer ring')
    assert.include(err.message, 'unclosed outer ring')
  })
})
