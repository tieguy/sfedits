/**
 * Region resolver: a Wikidata place QID in, an article set out.
 *
 * Two membership strategies, chosen by scale rather than by preference. There
 * is no single query that works from "Balmy Alley" to "California":
 *
 *  - admin: the region is a real administrative entity, so P131* returns its
 *    whole hierarchy in one relational hop. Coordinate-free, so it catches
 *    items with no precise point, and it never scans a polygon.
 *  - geo: the region is an informal neighborhood with no administrative
 *    sub-entities, so membership means "inside this boundary". Only viable
 *    because the candidate set around one neighborhood is small.
 *
 * @see docs/design-plans/2026-07-23-place-bot-platform.md
 */

const { sparqlRows, sparqlChunked } = require('./sparql')

/**
 * Wikidata classes that mean "this is an administrative entity with
 * sub-entities", so P131* will return a populated hierarchy. Anything else
 * place-like falls through to the spatial strategy.
 */
const ADMIN_CLASSES = new Set([
  'Q6256',      // country
  'Q7275',      // state
  'Q35657',     // U.S. state
  'Q28575',     // county
  'Q13220204',  // county of a U.S. state
  'Q62049',     // consolidated city-county
  'Q515',       // city
  'Q1093829',   // city of the United States
  'Q15284',     // municipality
  'Q3957',      // town
  'Q532',       // village
  'Q56061'      // administrative territorial entity
])

/** Parse a WKT point literal as emitted by WDQS. */
function parsePoint(wkt) {
  const match = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt || '')
  if (!match) return null
  return { lon: Number(match[1]), lat: Number(match[2]) }
}

/**
 * Resolve a place QID into a descriptor: what it is, where it is, and which
 * membership strategy applies.
 *
 * @param {string} qid - e.g. "Q62"
 * @param {Object} [options]
 * @param {'auto'|'admin'|'geo'} [options.strategy='auto']
 * @returns {Promise<{qid, label, classes, strategy, osmRelationId, centroid}>}
 * @throws {Error} when the QID is not a place, or a geo region has no coordinate
 */
async function resolveRegion(qid, options = {}) {
  const { strategy: requested = 'auto' } = options

  const rows = await sparqlRows(`
    SELECT ?cls ?label ?osm ?coord WHERE {
      wd:${qid} wdt:P31 ?cls .
      OPTIONAL { wd:${qid} wdt:P402 ?osm }
      OPTIONAL { wd:${qid} wdt:P625 ?coord }
      OPTIONAL {
        wd:${qid} rdfs:label ?label .
        FILTER(LANG(?label) = "en")
      }
    }
  `)

  if (rows.length === 0) {
    throw new Error(`${qid} is not a usable place: no instance-of (P31) statement`)
  }

  const classes = rows.map(r => r.cls).filter(Boolean)
  const label = rows.find(r => r.label)?.label || qid
  const osmRelationId = rows.find(r => r.osm)?.osm || null
  const centroid = parsePoint(rows.find(r => r.coord)?.coord)

  const strategy = requested === 'auto'
    ? (classes.some(c => ADMIN_CLASSES.has(c)) ? 'admin' : 'geo')
    : requested

  if (strategy === 'geo' && !centroid) {
    throw new Error(
      `${qid} (${label}) needs the geo strategy but has no coordinate (P625) to seed from`)
  }

  return { qid, label, classes, strategy, osmRelationId, centroid }
}

module.exports = {
  resolveRegion,
  ADMIN_CLASSES,
  parsePoint
}
