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

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const USER_AGENT = 'sfedits-region/1.0 (https://github.com/tieguy/sfedits)'
const TIMEOUT_MS = 60000

/** Stitch open line segments (ways) into closed rings.
 *
 *  In real OSM boundaries, a single ring is normally SPLIT across many way
 *  segments, each carrying only a partial open linestring. Ring stitching joins
 *  these end-to-end (reversing ways as needed to make endpoints match) until
 *  a ring closes.
 *
 *  @param {Array<Array<[number, number]>>} ways - arrays of [lon, lat] pairs
 *  @returns {Array<Array<[number, number]>>} - closed rings
 */
function stitchRings(ways) {
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
    let ringClosed = false

    // Try to extend the ring by chaining other ways
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
      if (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
        ringClosed = true
      } else if (!found) {
        // No more ways to chain; ring is incomplete
        break
      }
    }

    // Only include valid rings (at least 3 distinct points)
    if (ring.length >= 3) {
      rings.push(closeRing(ring))
    }
  }

  return rings
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
  const outerRings = stitchRings(outerWays)

  if (outerRings.length === 0) {
    throw new Error(`OSM relation ${relationId} has no usable outer boundary geometry`)
  }

  // Stitch inner ways into closed rings (holes)
  const innerRings = stitchRings(innerWays)

  // Build GeoJSON geometry
  let geometry

  if (outerRings.length === 1) {
    // Single polygon: outer ring + optional holes
    geometry = {
      type: 'Polygon',
      coordinates: [outerRings[0], ...innerRings]
    }
  } else {
    // MultiPolygon: each outer ring can have its own holes
    // For now, attach all holes to the first ring (OSM structure usually keeps them with the boundary)
    geometry = {
      type: 'MultiPolygon',
      coordinates: outerRings.map((ring, i) => i === 0 ? [ring, ...innerRings] : [ring])
    }
  }

  return { type: 'Feature', properties: { osmRelationId: String(relationId) }, geometry }
}

module.exports = { fetchBoundary, OVERPASS_URL }
