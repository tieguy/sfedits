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

/** Regex for a valid Wikidata QID: Q followed by one or more digits, no leading zeros. */
const QID = /^Q[1-9]\d*$/

/** Regex for a valid wiki language code: 2-12 letter primary code, optionally with 2-8 letter subtags.
 * Note: Wikipedia language codes are NOT BCP 47 (e.g., "simple", "tokipona"). This regex
 * permits only ASCII alphanumerics and hyphens, blocking SPARQL metacharacters. */
const LANG = /^[a-z]{2,12}(-[a-z0-9]{2,8})*$/i

/**
 * Validate a QID string and throw a descriptive error if invalid.
 * @param {string} qid - A Wikidata QID like "Q62"
 * @param {string} [what='QID'] - Context for the error message
 * @throws {Error} if the QID is not a valid format
 * @returns {string} the validated QID
 */
function assertQid(qid, what = 'QID') {
  if (typeof qid !== 'string' || !QID.test(qid)) {
    throw new Error(`${what} must look like "Q62", got ${JSON.stringify(qid)}`)
  }
  return qid
}

/**
 * Validate a language code string and throw a descriptive error if invalid.
 * @param {string} lang - A language code like "en" or "zh-Hans"
 * @throws {Error} if the language code is not valid
 * @returns {string} the validated language code
 */
function assertLang(lang) {
  if (typeof lang !== 'string' || !LANG.test(lang)) {
    throw new Error(`Wiki language code must match the pattern (e.g., "en", "zh-Hans", "simple"), got ${JSON.stringify(lang)}`)
  }
  return lang
}

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

/**
 * Parse a WKT point literal as emitted by WDQS.
 * Note: globe-prefixed coordinates like "<http://www.wikidata.org/entity/Q111> Point(...)"
 * are parsed but the globe is silently discarded; we always return Earth coordinates.
 * Scientific notation and leading '+' signs are not handled (WDQS does not emit them).
 */
function parsePoint(wkt) {
  const match = /Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(wkt || '')
  if (!match) return null
  const lon = Number(match[1])
  const lat = Number(match[2])
  // Guard against float overflow on absurdly long numeric literals (e.g., 400 consecutive 9s).
  // The tight regex alone prevents NaN from malformed inputs like "1.2.3".
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return { lon, lat }
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
  // Validate the input QID early to fail fast on typos
  assertQid(qid, 'Input QID')

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

  // Deduplicate classes that may appear multiple times from the OPTIONAL cross product.
  // Filter to only valid QIDs; anomalies like bnodes or genids are silently skipped.
  const classes = [...new Set(rows.map(r => r.cls).filter(Boolean).filter(c => QID.test(c)))]
  const label = rows.find(r => r.label)?.label || qid
  // P402 (OSM relation ID) and P625 (coordinate) may have multiple statements marked preferred/deprecated.
  // We pick the first one found; any valid statement is acceptable.
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

/**
 * Turn a sitelink URL into a (wikipedia, title) pair.
 * "https://en.wikipedia.org/wiki/Caf%C3%A9_du_Nord" -> { wikipedia: 'en', title: 'Café du Nord' }
 * Returns null if the URL is not a valid Wikipedia sitelink or has malformed percent-encoding.
 */
function parseSitelink(url) {
  const match = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i.exec(url || '')
  if (!match) return null
  let title
  try {
    title = decodeURIComponent(match[2])
  } catch (error) {
    // Malformed percent-encoding (e.g., %E0%A4%A) throws URIError; treat as invalid URL
    return null
  }
  return {
    wikipedia: match[1],
    title: title.replace(/_/g, ' ')
  }
}

/** VALUES clause for a language filter, or empty string for "all languages". */
function languageFilter(languages) {
  if (!languages || languages.length === 0) return ''
  // Validate each language code to prevent SPARQL injection
  for (const lang of languages) {
    assertLang(lang)
  }
  const values = languages.map(l => `"${l}"`).join(' ')
  return `VALUES ?lang { ${values} }`
}

/**
 * Find the region's immediate sub-entities, to use as chunk anchors.
 *
 * Anchoring each closure query at one sub-entity is what keeps a county- or
 * state-scale query inside the WDQS budget - the same trick the Bay Area claim
 * watcher uses to avoid a nine-county union timing out.
 */
async function subEntities(regionQid) {
  assertQid(regionQid, 'Region QID in subEntities')
  const rows = await sparqlRows(`
    SELECT ?sub WHERE { ?sub wdt:P131 wd:${regionQid} }
  `)
  // Filter to only valid QIDs; anomalies are silently skipped. Each sub will be interpolated
  // into a SPARQL query, so we guarantee only clean QIDs reach that point.
  return rows.map(r => r.sub).filter(s => QID.test(s))
}

/**
 * Administrative containment: everything whose located-in chain reaches the
 * region, with its Wikipedia articles in the requested languages.
 *
 * @param {Object} region - descriptor from resolveRegion()
 * @param {Object} [options]
 * @param {string[]} [options.languages] - wiki language codes; omit for all
 * @param {(chunk: string, error: Error) => void} [options.onChunkError]
 * @returns {Promise<Array<{qid, cls, lang, wikipedia, title, source}>>}
 */
async function articlesByAdmin(region, options = {}) {
  const { languages = null, onChunkError = null } = options

  // Validate language codes early to fail fast on bad input
  if (languages && languages.length > 0) {
    for (const lang of languages) {
      assertLang(lang)
    }
  }

  // Chunk on sub-entities when there are any; otherwise the region is small
  // enough (or flat enough) to query in one shot anchored at itself.
  const subs = await subEntities(region.qid)
  const anchors = subs.length > 0 ? subs : [region.qid]

  const rows = await sparqlChunked(anchors, anchor => `
    SELECT ?item ?cls ?article ?lang WHERE {
      ?item wdt:P131* wd:${anchor} .
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
      ${languageFilter(languages)}
    }
  `, { onChunkError })

  const seen = new Set()
  const articles = []

  for (const row of rows) {
    const sitelink = parseSitelink(row.article)
    if (!sitelink) continue

    const key = `${sitelink.wikipedia}:${sitelink.title}`
    if (seen.has(key)) continue
    seen.add(key)

    articles.push({
      qid: row.item,
      cls: row.cls,
      lang: row.lang,
      wikipedia: sitelink.wikipedia,
      title: sitelink.title,
      source: 'admin'
    })
  }

  return articles
}

module.exports = {
  resolveRegion,
  articlesByAdmin,
  parseSitelink,
  parsePoint,
  ADMIN_CLASSES,
  assertQid,
  assertLang
}
