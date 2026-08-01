/**
 * Fetch an OSM boundary polygon as GeoJSON, given the relation id that
 * Wikidata's P402 points at.
 *
 * Overpass rather than the raw OSM API: the OSM API's /full endpoint is
 * explicitly not for bulk use and caps concurrency at two, while Overpass is
 * built for exactly this query shape, allows ~1M requests/day, and signals
 * quota exhaustion cleanly with HTTP 429.
 *
 * A descriptive User-Agent is mandatory under OSM Foundation policy, and
 * faking another app's is grounds for a block.
 *
 * @see https://operations.osmfoundation.org/policies/api/
 */

const turfPointInPolygon = require('@turf/boolean-point-in-polygon')
const booleanPointInPolygon =
  typeof turfPointInPolygon === 'function' ? turfPointInPolygon : turfPointInPolygon.default

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const { userAgent } = require('./user-agent')
const USER_AGENT = userAgent('region')
const TIMEOUT_MS = 60000

/** Stitch open line segments (ways) into closed rings.
 *
 *  In real OSM boundaries, a single ring is normally SPLIT across many way
 *  segments, each carrying only a partial open linestring. Ring stitching joins
 *  these end-to-end (reversing ways as needed to make endpoints match) until
 *  a ring closes.
 *
 *  @param {Array<Array<[number, number]>>} ways - arrays of [lon, lat] pairs
 *  @param {string} [role='outer'] - OSM role ('outer' or 'inner') for error messages
 *  @returns {Array<Array<[number, number]>>} - closed rings
 *  @throws {Error} if an outer ring cannot be closed; warns for inner rings
 */
function stitchRings(ways, role = 'outer') {
  if (ways.length === 0) return []

  const rings = []
  const unused = new Set(ways.map((_, i) => i))

  while (unused.size > 0) {
    // Start a new ring
    const ringIndices = []
    let current = Array.from(unused)[0]
    unused.delete(current)
    ringIndices.push(current)

    let ring = [...ways[current]]
    let ringClosed = isClosed(ring)

    // Try to extend the ring by chaining other ways, but only if not already closed
    while (!ringClosed && unused.size > 0) {
      const ringStart = ring[0]
      const ringEnd = ring[ring.length - 1]

      let found = false

      for (const wayIdx of unused) {
        const way = ways[wayIdx]
        const wayStart = way[0]
        const wayEnd = way[way.length - 1]

        // Check if way connects to end of ring (forward)
        if (ringEnd[0] === wayStart[0] && ringEnd[1] === wayStart[1]) {
          ring.push(...way.slice(1)) // Add way, skip duplicate start point
          unused.delete(wayIdx)
          ringIndices.push(wayIdx)
          found = true
          break
        }

        // Check if way connects to end of ring (reversed)
        if (ringEnd[0] === wayEnd[0] && ringEnd[1] === wayEnd[1]) {
          const reversed = [...way].reverse()
          ring.push(...reversed.slice(1)) // Add reversed way, skip duplicate start
          unused.delete(wayIdx)
          ringIndices.push(wayIdx)
          found = true
          break
        }

        // Check if way connects to start of ring (reversed prepend)
        if (ringStart[0] === wayEnd[0] && ringStart[1] === wayEnd[1]) {
          const reversed = [...way].reverse()
          ring = [...reversed.slice(0, -1), ...ring] // Prepend reversed way
          unused.delete(wayIdx)
          ringIndices.unshift(wayIdx)
          found = true
          break
        }

        // Check if way connects to start of ring (forward prepend)
        if (ringStart[0] === wayStart[0] && ringStart[1] === wayStart[1]) {
          ring = [...way.slice(0, -1), ...ring] // Prepend way
          unused.delete(wayIdx)
          ringIndices.unshift(wayIdx)
          found = true
          break
        }
      }

      // Check if ring is now closed
      if (isClosed(ring)) {
        ringClosed = true
      } else if (!found) {
        // No more ways can chain onto this ring. Whether that is recoverable depends on
        // how many ways went into it, which the post-loop block below decides - a single
        // open way is closeable, a multi-way chain that ran out of segments is not.
        // Deliberately no throw here: an earlier revision threw in-loop AND post-loop for
        // the same condition, and the in-loop copy returned [] for inner rings, discarding
        // every hole already stitched rather than just the bad one.
        break
      }
    }

    // After extension attempts, handle the result
    if (ringClosed && ring.length >= 4) {
      // Ring is properly closed with valid point count
      rings.push(ring)
    } else if (!ringClosed && ringIndices.length === 1 && ring.length >= 3) {
      // Single open way: try to close it
      rings.push(closeRing(ring))
    } else if (!ringClosed) {
      // Multi-way chain that couldn't close, or degenerate single way
      const msg = `OSM relation has an unclosed ${role} ring (ways stitched: ${ringIndices.join(',')})`
      if (role === 'inner') {
        console.warn(msg)
        // Don't add this ring to the results
      } else {
        throw new Error(msg)
      }
    }
    // Note: ring.length < 3 is silently skipped (degenerate)
  }

  return rings
}

/** Check if a ring is closed (first point equals last point).
 *
 * Shared nodes in Overpass output are byte-identical across all ways referencing them,
 * confirmed empirically against real relations (e.g., OSM relation 111968 with 19 outer ways).
 * This permits exact === comparison; epsilon comparison is not needed.
 *
 * @param {Array<[number, number]>} ring - array of [lon, lat] pairs
 * @returns {boolean} true if first and last points are equal
 */
function isClosed(ring) {
  if (ring.length < 2) return false
  return ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
}

/** Close a linear ring if Overpass returned it open. */
function closeRing(ring) {
  if (ring.length === 0) return ring
  const [first] = ring
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, first]
  }
  return ring
}

/**
 * @param {string|number} relationId - OSM relation id from Wikidata P402
 * @returns {Promise<Object>} GeoJSON Feature with a Polygon or MultiPolygon
 * @throws {Error} on rate limit, transport failure, or missing geometry
 */
async function fetchBoundary(relationId) {
  const query = `[out:json][timeout:60];relation(${relationId});out geom;`

  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })

  if (response.status === 429) {
    throw new Error(`Overpass rate limit hit fetching relation ${relationId}`)
  }
  if (!response.ok) {
    throw new Error(`Overpass returned ${response.status} for relation ${relationId}`)
  }

  const data = await response.json()
  const relation = (data.elements || []).find(e => e.type === 'relation')

  // Separate outer and inner ways
  const outerWays = (relation?.members || [])
    .filter(m => m.type === 'way' && m.role === 'outer' && Array.isArray(m.geometry))
    .map(m => m.geometry.map(p => [p.lon, p.lat]))

  const innerWays = (relation?.members || [])
    .filter(m => m.type === 'way' && m.role === 'inner' && Array.isArray(m.geometry))
    .map(m => m.geometry.map(p => [p.lon, p.lat]))

  if (outerWays.length === 0) {
    throw new Error(`OSM relation ${relationId} has no usable outer boundary geometry`)
  }

  // Stitch outer ways into closed rings
  const outerRings = stitchRings(outerWays, 'outer')

  if (outerRings.length === 0) {
    throw new Error(`OSM relation ${relationId} has no usable outer boundary geometry`)
  }

  // Stitch inner ways into closed rings (holes)
  const innerRings = stitchRings(innerWays, 'inner')

  // Build GeoJSON geometry
  let geometry

  if (outerRings.length === 1) {
    // Single polygon: outer ring + optional holes
    // Validate that all holes are actually contained by the outer ring
    const outerPolygon = { type: 'Polygon', coordinates: [outerRings[0]] }
    for (const hole of innerRings) {
      const testPoint = hole[1] || hole[0]
      if (!booleanPointInPolygon(testPoint, outerPolygon)) {
        throw new Error(`OSM relation ${relationId} has a hole not contained by any outer ring`)
      }
    }

    geometry = {
      type: 'Polygon',
      coordinates: [outerRings[0], ...innerRings]
    }
  } else {
    // MultiPolygon: associate each hole with the outer ring that contains it.
    // A hole belongs to an outer ring if the hole's representative point is inside that ring.
    const polygons = outerRings.map(ring => [ring])

    for (const hole of innerRings) {
      // Use the second point of the hole as the representative point (avoid potential edge issues with the first)
      const testPoint = hole[1] || hole[0]
      let associated = false

      for (let i = 0; i < outerRings.length; i++) {
        const outerPolygon = { type: 'Polygon', coordinates: [outerRings[i]] }
        if (booleanPointInPolygon(testPoint, outerPolygon)) {
          polygons[i].push(hole)
          associated = true
          break
        }
      }

      if (!associated) {
        throw new Error(`OSM relation ${relationId} has a hole not contained by any outer ring`)
      }
    }

    geometry = {
      type: 'MultiPolygon',
      coordinates: polygons
    }
  }

  return { type: 'Feature', properties: { osmRelationId: String(relationId) }, geometry }
}

module.exports = { fetchBoundary, OVERPASS_URL }
