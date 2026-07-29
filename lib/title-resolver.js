/**
 * QID -> current article titles.
 *
 * Membership identity is the QID, because Wikipedia renames articles
 * constantly and a title-keyed list silently stops matching when it happens.
 * But the edit feed emits titles, so the bot still matches on a title index -
 * one derived from QIDs and refreshed on the rebuild cadence.
 *
 * Two backends:
 *  - replicas: on Toolforge, a plain SQL join against page_props. No API rate
 *    limits, and page-move detection comes from the same database.
 *  - api: everywhere else (development, CI). Correct but rate-limited.
 *
 * Resolution is a BATCH-time concern. Neither backend belongs in the per-edit
 * hot path, which stays an in-RAM lookup.
 *
 * @see https://wikitech.wikimedia.org/wiki/Wiki_Replicas
 */

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
const USER_AGENT = 'sfedits-title-resolver/1.0 (https://github.com/tieguy/sfedits)'

/** wbgetentities caps at 50 ids per request. */
const API_BATCH_SIZE = 50

/**
 * Canonical title form: spaces, not underscores; decoded from Buffer if the
 * replicas handed one over.
 *
 * Both traps live here. page_title is varbinary, so the driver returns a
 * Buffer that will never compare equal to a string; and replica titles are
 * underscored while EventStreams and the API emit spaces. Normalizing in only
 * one direction is how a title index silently matches nothing at all.
 */
function normalizeTitle(value) {
  if (value === null || value === undefined) return null
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  const normalized = text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

/**
 * Wikimedia sites whose dbname ends in "wiki" but which are not a language
 * edition of Wikipedia. Without this, `commonswiki` resolves to the "commons"
 * Wikipedia, and File: pages start showing up in a place feed.
 */
const NON_WIKIPEDIA_SITES = new Set([
  'commonswiki', 'metawiki', 'specieswiki', 'wikidatawiki', 'mediawikiwiki',
  'sourceswiki', 'incubatorwiki', 'outreachwiki', 'foundationwiki', 'testwiki'
])

/** "enwiki" -> "en"; anything that is not a Wikipedia returns null. */
function siteToWikipedia(site) {
  if (NON_WIKIPEDIA_SITES.has(site)) return null
  const match = /^([a-z_]+)wiki$/.exec(site)
  if (!match) return null
  return match[1].replace(/_/g, '-')
}

function chunk(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Resolve QIDs to titles using the Wikidata API.
 *
 * @param {string[]} qids
 * @param {Object} [options]
 * @param {string[]} [options.languages] - wiki codes; omit for all Wikipedias
 * @returns {Promise<Map<string, Array<{wikipedia, title}>>>}
 */
async function titlesForQidsViaApi(qids, options = {}) {
  const { languages = null } = options
  const wanted = languages ? new Set(languages) : null
  const result = new Map()

  for (const batch of chunk(qids, API_BATCH_SIZE)) {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'sitelinks',
      format: 'json',
      formatversion: '2'
    })

    const response = await fetch(`${WIKIDATA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) {
      throw new Error(`Wikidata API returned ${response.status}`)
    }

    const data = await response.json()

    for (const [qid, entity] of Object.entries(data.entities || {})) {
      if (!entity || entity.missing !== undefined) continue

      const titles = []
      for (const sitelink of Object.values(entity.sitelinks || {})) {
        const wikipedia = siteToWikipedia(sitelink.site)
        if (!wikipedia) continue
        if (wanted && !wanted.has(wikipedia)) continue

        const title = normalizeTitle(sitelink.title)
        if (title) titles.push({ wikipedia, title })
      }

      if (titles.length > 0) result.set(qid, titles)
    }
  }

  return result
}

module.exports = {
  titlesForQidsViaApi,
  normalizeTitle,
  siteToWikipedia,
  chunk,
  WIKIDATA_API,
  API_BATCH_SIZE
}
