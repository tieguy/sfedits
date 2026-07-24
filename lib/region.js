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

const { sparqlRows } = require('./sparql')
const { fetchBoundary } = require('./osm-boundary')

// Turf v7 ships dual ESM/CJS builds; under require() the function is on
// .default in some resolutions and bare in others.
const turfPointInPolygon = require('@turf/boolean-point-in-polygon')
const booleanPointInPolygon =
  typeof turfPointInPolygon === 'function' ? turfPointInPolygon : turfPointInPolygon.default

/** Regex for a valid Wikidata QID: Q followed by one or more digits, no leading zeros. */
const QID = /^Q[1-9]\d*$/

/** Regex for a valid wiki language code.
 * Note: Wikipedia language codes are NOT BCP 47 - "simple", "tokipona" and
 * "zh-classical" are all live wikis that BCP 47 length rules would reject. So the
 * subtag length is deliberately unbounded; length was never the security property.
 * What blocks SPARQL injection is the ALPHABET: anchored ^...$ over [a-z0-9-] only,
 * which admits no quote, brace, space, newline or any other metacharacter. */
const LANG = /^[a-z]{2,}(-[a-z0-9]+)*$/i

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
  // Number.isFinite is the load-bearing guard: it catches float overflow on absurdly
  // long literals (400 nines -> Infinity) AND every malformed numeric the regex might
  // otherwise admit. The tight regex above is defense-in-depth that isFinite currently
  // subsumes - no known input distinguishes them - so do not delete this check on the
  // assumption the regex covers it. It does not; the reverse is true.
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
  const classes = [...new Set(rows.map(r => r.cls).filter(c => QID.test(c)))]
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

/** WDQS reports a query timeout as an AbortSignal.timeout, or a 5xx whose body names it. */
function isTimeout(error) {
  return error.name === 'TimeoutError' || error.name === 'AbortError' ||
    Boolean(error.body && /timeout/i.test(error.body))
}

/**
 * Run a single unchunked closure query for an administrative region, translating a
 * WDQS timeout into a scope error.
 *
 * The admin strategy resolves the whole P131* hierarchy in one relational hop. That is
 * cheap for the regions in scope - New Zealand's whole-country histogram is ~4s live,
 * California's ~27s - and chunking it over every direct P131 child is catastrophically
 * worse (a city has thousands of children, so that is thousands of sequential queries).
 * The one thing a single query cannot do is resolve a region whose closure is too large
 * to count inside the 60s WDQS budget - a whole large country like the USA, which is
 * deliberately out of scope. A timeout there is not a bug to retry around; it is the
 * scale limit announcing itself, so say so plainly.
 *
 * @see place-bot-region-scale-scope
 */
async function runRegionQuery(region, query) {
  try {
    return await sparqlRows(query)
  } catch (error) {
    if (isTimeout(error)) {
      throw new Error(
        `${region.qid} (${region.label || region.qid}) is too large to resolve in a single ` +
        'query: WDQS timed out. Very large regions such as whole large countries (e.g. the ' +
        'USA) are out of scope. If this region is legitimately sized, WDQS may be transiently ' +
        'overloaded - retry.')
    }
    throw error
  }
}

/**
 * Administrative containment: everything whose located-in chain reaches the
 * region, with its Wikipedia articles in the requested languages.
 *
 * @param {Object} region - descriptor from resolveRegion()
 * @param {Object} [options]
 * @param {string[]} [options.languages] - wiki language codes; omit for all
 * @returns {Promise<Array<{qid, cls, lang, wikipedia, title, source}>>}
 */
async function articlesByAdmin(region, options = {}) {
  // region.qid is interpolated straight into the query below, so it is the injection
  // boundary and must be validated here.
  assertQid(region.qid, 'Region QID')

  const { languages = null } = options

  // Validate language codes early to fail fast on bad input
  if (languages && languages.length > 0) {
    for (const lang of languages) {
      assertLang(lang)
    }
  }

  const rows = await runRegionQuery(region, `
    SELECT ?item ?cls ?article ?lang WHERE {
      ?item wdt:P131* wd:${region.qid} .
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
      ${languageFilter(languages)}
    }
  `)

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

/** Default radius for the candidate seed, in km. wikibase:around takes km only. */
const DEFAULT_SEED_RADIUS_KM = 5

/**
 * Geographic containment: seed candidates from a radius around the centroid,
 * then filter by the actual boundary.
 *
 * The radius seed exists because there is no way to ask WDQS "give me
 * everything inside this arbitrary polygon" - the polygon lives in OSM, not
 * Wikidata. So we over-fetch a disc that covers the neighborhood and discard
 * what falls outside. This only works because neighborhoods are small; it is
 * exactly why administrative regions use the relational strategy instead.
 *
 * @param {Object} region - descriptor from resolveRegion(), needs a centroid
 * @param {Object} options
 * @param {Object} options.boundary - GeoJSON Feature from fetchBoundary()
 * @param {string[]} [options.languages]
 * @param {number} [options.radiusKm]
 * @returns {Promise<Array<{qid, cls, lang, wikipedia, title, source}>>}
 * @throws {Error} if region QID is invalid, no boundary, no centroid, or radius is invalid
 */
async function articlesByGeo(region, options = {}) {
  // Validate the region QID early
  assertQid(region.qid, 'Region QID')

  const {
    boundary,
    languages = null,
    radiusKm = DEFAULT_SEED_RADIUS_KM
  } = options

  if (!boundary) {
    throw new Error(`${region.qid} needs a boundary polygon for the geo strategy`)
  }
  if (!region.centroid) {
    throw new Error(`${region.qid} needs a centroid to seed the geo strategy`)
  }

  // Validate radius: must be finite and positive
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error(`radius must be a finite positive number, got ${JSON.stringify(radiusKm)}`)
  }

  // Validate language codes early to fail fast on bad input
  if (languages && languages.length > 0) {
    for (const lang of languages) {
      assertLang(lang)
    }
  }

  const { lon, lat } = region.centroid
  // Validate centroid coordinates before interpolating into SPARQL
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error(`centroid coordinates must be finite numbers, got lon=${JSON.stringify(lon)} lat=${JSON.stringify(lat)}`)
  }

  const rows = await sparqlRows(`
    SELECT ?item ?cls ?coord ?article ?lang WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radiusKm}" .
      }
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
      ${languageFilter(languages)}
    }
  `)

  const seen = new Set()
  const articles = []

  for (const row of rows) {
    const point = parsePoint(row.coord)
    if (!point) continue

    const inside = booleanPointInPolygon([point.lon, point.lat], boundary)
    if (!inside) continue

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
      source: 'geo'
    })
  }

  return articles
}

/**
 * Count articles bucketed by entity class and language.
 *
 * This exists so the create flow can show a live count without re-querying on
 * every checkbox toggle: one aggregation returns a few hundred cells no matter
 * how big the region is, and every subsequent toggle is a local sum over those
 * cells. It is an estimate by design - a region big enough to time out returns
 * partial: true, and the dry run remains the source of truth.
 *
 * Counts pages, not distinct items, because pages are what drive post volume.
 *
 * @param {Object} region - descriptor from resolveRegion()
 * @param {Object} [options]
 * @param {number} [options.retries]
 * @param {number} [options.retryDelayMs]
 * @returns {Promise<{cells: Array<{cls, lang, count}>, total: number, partial: boolean}>}
 */
async function regionHistogram(region, options = {}) {
  // The geo strategy's membership test is a client-side polygon filter, so
  // there is no SPARQL aggregation that can answer it - the polygon lives in
  // OSM, not Wikidata. Bucket the actual article list instead. That is only
  // affordable because geo regions are small by construction (10^2-10^3); it
  // is exactly why administrative regions do not use this path.
  if (region.strategy === 'geo') {
    if (!options.boundary) {
      throw new Error(
        `${region.qid} needs a boundary polygon to compute a geo histogram`)
    }

    const articles = await articlesByGeo(region, {
      boundary: options.boundary,
      languages: options.languages,
      radiusKm: options.radiusKm
    })

    const merged = new Map()
    for (const article of articles) {
      const key = `${article.cls}|${article.lang}`
      merged.set(key, (merged.get(key) || 0) + 1)
    }

    const cells = Array.from(merged.entries()).map(([key, count]) => {
      const [cls, lang] = key.split('|')
      return { cls, lang, count }
    })

    return {
      cells,
      total: cells.reduce((sum, cell) => sum + cell.count, 0),
      partial: false
    }
  }

  // region.qid is interpolated into the query, so it is the injection boundary.
  assertQid(region.qid, 'Region QID')

  const rows = await runRegionQuery(region, `
    SELECT ?cls ?lang (COUNT(DISTINCT ?article) AS ?count) WHERE {
      ?item wdt:P131* wd:${region.qid} .
      ?item wdt:P31 ?cls .
      ?article schema:about ?item ;
               schema:inLanguage ?lang ;
               schema:isPartOf ?site .
      FILTER(CONTAINS(STR(?site), ".wikipedia.org"))
    }
    GROUP BY ?cls ?lang
  `)

  // A GROUP BY returns each (cls, lang) once, but merge defensively so a duplicated
  // row cannot overwrite or double-list a cell.
  const merged = new Map()
  for (const row of rows) {
    const key = `${row.cls}|${row.lang}`
    const count = Number(row.count) || 0
    merged.set(key, (merged.get(key) || 0) + count)
  }

  const cells = Array.from(merged.entries()).map(([key, count]) => {
    const [cls, lang] = key.split('|')
    return { cls, lang, count }
  })

  const total = cells.reduce((sum, cell) => sum + cell.count, 0)

  // A single query either succeeds whole or throws; there is no partial state.
  return { cells, total, partial: false }
}

/**
 * Sum the histogram cells matching a filter selection. Pure and synchronous -
 * this is what makes toggling filters feel instant in the create flow.
 *
 * @param {Object} histogram - from regionHistogram()
 * @param {Object} [selection]
 * @param {string[]} [selection.classes] - class QIDs; omit for all
 * @param {string[]} [selection.languages] - language codes; omit for all
 * @returns {number}
 */
function countFromHistogram(histogram, selection = {}) {
  const { classes = null, languages = null } = selection
  const classSet = classes ? new Set(classes) : null
  const langSet = languages ? new Set(languages) : null

  return histogram.cells.reduce((sum, cell) => {
    if (classSet && !classSet.has(cell.cls)) return sum
    if (langSet && !langSet.has(cell.lang)) return sum
    return sum + cell.count
  }, 0)
}

/**
 * Resolve a boundary polygon for a region, degrading gracefully when the place
 * has no OSM boundary (P402) of its own: fall back to the smallest boundaried
 * region that contains it, then to a radius around its point. Takes the region
 * descriptor (not a bare QID) because resolveRegion() has already fetched P402
 * and the centroid - re-querying them would be wasteful.
 *
 * @param {Object} region - descriptor from resolveRegion() (qid, osmRelationId, centroid)
 * @returns {Promise<Object>} a BoundaryResolution
 * @see docs/design-plans/2026-07-24-boundary-resolution.md
 */
const MAX_CONTAINER_DEPTH = 5

/**
 * One upward step of the P131 walk: the parents of `childQids`, each annotated
 * with whether it carries a boundary (P402), its class, and its area (P2046).
 * Only clean QIDs are interpolated - childQids come from prior WDQS output.
 */
async function p131Level(childQids) {
  const clean = childQids.filter(q => QID.test(q))
  if (clean.length === 0) return { bounded: [], parents: [] }
  const values = clean.map(q => `wd:${q}`).join(' ')
  const rows = await sparqlRows(`
    SELECT ?parent ?parentLabel ?osm ?cls ?area WHERE {
      VALUES ?child { ${values} }
      ?child wdt:P131 ?parent .
      OPTIONAL { ?parent wdt:P402 ?osm }
      OPTIONAL { ?parent wdt:P31 ?cls }
      OPTIONAL { ?parent wdt:P2046 ?area }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }
  `)
  const byParent = new Map()
  for (const r of rows) {
    if (!QID.test(r.parent)) continue
    let p = byParent.get(r.parent)
    if (!p) {
      p = { qid: r.parent, label: r.parentLabel || r.parent, cls: null, area: null, bounded: false }
      byParent.set(r.parent, p)
    }
    if (r.osm) p.bounded = true
    if (r.cls && QID.test(r.cls) && !p.cls) p.cls = r.cls
    if (r.area) {
      const a = parseFloat(r.area)
      if (Number.isFinite(a) && (p.area === null || a < p.area)) p.area = a
    }
  }
  const all = [...byParent.values()]
  return { bounded: all.filter(p => p.bounded), parents: all.map(p => p.qid) }
}

/** Smallest known area first; arealess candidates remain eligible but sort last. */
function smallestByArea(bounded) {
  return bounded.slice().sort((a, b) => {
    if (a.area === null && b.area === null) return 0
    if (a.area === null) return 1
    if (b.area === null) return -1
    return a.area - b.area
  })[0]
}

async function resolveBoundary(region) {
  // Tier 1 (self): the place has its own OSM boundary.
  if (region.osmRelationId) {
    const boundary = await fetchBoundary(region.osmRelationId)
    return { source: 'self', exact: true, boundary }
  }

  assertQid(region.qid, 'Region QID')

  // Tier 2 (container): walk P131 upward one level at a time - not a P131+
  // property path - so the FIRST boundaried ancestor found is the smallest,
  // closest container rather than an arbitrary one (city vs. state vs. country).
  const visited = new Set([region.qid])
  let frontier = [region.qid]
  for (let depth = 0; depth < MAX_CONTAINER_DEPTH && frontier.length > 0; depth++) {
    const { bounded, parents } = await p131Level(frontier)
    if (bounded.length > 0) {
      const best = smallestByArea(bounded)
      return {
        source: 'container',
        exact: false,
        suggestion: { qid: best.qid, label: best.label, class: best.cls, via: 'p131' }
      }
    }
    frontier = parents.filter(p => !visited.has(p))
    for (const p of frontier) visited.add(p)
  }
}

/**
 * Resolve a place QID to its article set, choosing the membership strategy by
 * region type. The single entry point callers should use.
 *
 * @param {string} qid
 * @param {Object} [options]
 * @param {'auto'|'admin'|'geo'} [options.strategy='auto']
 * @param {string[]} [options.languages]
 * @param {number} [options.radiusKm]
 * @returns {Promise<{region: Object, articles: Array}>}
 */
async function articlesForRegion(qid, options = {}) {
  const region = await resolveRegion(qid, { strategy: options.strategy || 'auto' })

  if (region.strategy === 'admin') {
    const articles = await articlesByAdmin(region, options)
    return { region, articles }
  }

  if (!region.osmRelationId) {
    throw new Error(
      `${qid} (${region.label}) needs the geo strategy but has no OSM boundary (P402)`)
  }

  const boundary = await fetchBoundary(region.osmRelationId)
  const articles = await articlesByGeo(region, { ...options, boundary })
  return { region, articles }
}

module.exports = {
  articlesForRegion,
  resolveRegion,
  resolveBoundary,
  articlesByAdmin,
  articlesByGeo,
  regionHistogram,
  countFromHistogram,
  parseSitelink,
  parsePoint,
  ADMIN_CLASSES,
  assertQid,
  assertLang,
  DEFAULT_SEED_RADIUS_KM
}
