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

const { actionSession } = require('./mw-api')

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

  const session = await actionSession('www.wikidata.org', 'title-resolver')

  for (const batch of chunk(qids, API_BATCH_SIZE)) {
    const data = await session.request({
      action: 'wbgetentities', ids: batch.join('|'), props: 'sitelinks'
    })

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

/** Mainspace only - the bot watches articles, not talk or project pages. */
const NS_MAIN = 0

/**
 * Connect to a Wiki Replica for one wiki.
 *
 * analytics rather than web: a rebuild is a batch job, and the web endpoint's
 * 5-minute timeout is aimed at interactive queries. Credentials come from the
 * same place as ToolsDB.
 *
 * @param {string} wikipedia - language code, e.g. "en"
 * @param {Object} [options]
 */
function connectReplica(wikipedia, options = {}) {
  const env = options.env || process.env
  const dbname = `${wikipedia.replace(/-/g, '_')}wiki`

  const user = options.user || env.TOOL_REPLICA_USER || env.TOOL_TOOLSDB_USER
  const password = options.password || env.TOOL_REPLICA_PASSWORD || env.TOOL_TOOLSDB_PASSWORD

  if (!user || !password) {
    throw new Error(
      'Wiki Replica access needs TOOL_REPLICA_USER / TOOL_REPLICA_PASSWORD ' +
      '(or the TOOLSDB equivalents)')
  }

  return require('mariadb').createPool({
    host: options.host || `${dbname}.analytics.db.svc.wikimedia.cloud`,
    port: options.port || 3306,
    database: `${dbname}_p`,
    user,
    password,
    connectionLimit: options.connectionLimit || 2,
    bigIntAsNumber: true
  })
}

/**
 * Resolve QIDs to titles with one SQL join instead of N API calls.
 *
 * page_props stores each page's Wikidata item locally on every wiki, so this
 * needs no cross-database join and no network round trip per QID.
 *
 * @param {Object} pool - a mariadb pool for one wiki's replica
 * @param {string[]} qids
 * @param {string} wikipedia - language code, used to label results
 * @returns {Promise<Map<string, Array<{wikipedia, title}>>>}
 */
async function titlesForQidsViaReplica(pool, qids, wikipedia) {
  const result = new Map()
  if (qids.length === 0) return result

  for (const batch of chunk(qids, 500)) {
    const placeholders = batch.map(() => '?').join(',')
    const rows = await pool.query(
      `SELECT pp.pp_value AS qid, p.page_title AS title
       FROM page_props pp
       JOIN page p ON p.page_id = pp.pp_page
       WHERE pp.pp_propname = 'wikibase_item'
         AND p.page_namespace = ?
         AND pp.pp_value IN (${placeholders})`,
      [NS_MAIN, ...batch])

    for (const row of rows) {
      // pp_value is a BLOB and page_title a varbinary: both arrive as Buffers.
      const qid = normalizeTitle(row.qid)
      const title = normalizeTitle(row.title)
      if (!qid || !title) continue

      const existing = result.get(qid) || []
      existing.push({ wikipedia, title })
      result.set(qid, existing)
    }
  }

  return result
}

/**
 * Extract the destination title from a move log entry.
 *
 * MediaWiki >= 1.27 stores log_params as JSON keyed "4::target"; older rows
 * use a newline-delimited string whose first line is the target. Both appear
 * on the replicas because the table is never rewritten.
 */
function parseMoveTarget(params) {
  const text = Buffer.isBuffer(params) ? params.toString('utf8') : String(params || '')
  if (!text) return null

  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      return normalizeTitle(parsed['4::target'] || null)
    } catch {
      return null
    }
  }

  return normalizeTitle(text.split('\n')[0])
}

/**
 * Page moves in mainspace since a timestamp.
 *
 * This is what keeps a title-keyed index from silently going dead. A rebuild
 * would eventually catch a rename anyway, by way of the QID resolving to a new
 * title - but the move log catches it in one cheap query rather than by
 * diffing every title in the region.
 *
 * @param {Object} pool - a mariadb pool for one wiki's replica
 * @param {string} sinceTimestamp - MediaWiki format, e.g. "20260722000000"
 * @returns {Promise<Array<{from: string, to: string}>>}
 */
async function movesSince(pool, sinceTimestamp) {
  const rows = await pool.query(
    `SELECT log_title, log_params
     FROM logging
     WHERE log_type = 'move'
       AND log_action IN ('move', 'move_redir')
       AND log_namespace = ?
       AND log_timestamp >= ?
     ORDER BY log_timestamp`,
    [NS_MAIN, sinceTimestamp])

  const moves = []
  for (const row of rows) {
    const from = normalizeTitle(row.log_title)
    const to = parseMoveTarget(row.log_params)
    if (from && to) moves.push({ from, to })
  }
  return moves
}

module.exports = {
  titlesForQidsViaApi,
  titlesForQidsViaReplica,
  connectReplica,
  movesSince,
  parseMoveTarget,
  normalizeTitle,
  siteToWikipedia,
  chunk,
  API_BATCH_SIZE
}
