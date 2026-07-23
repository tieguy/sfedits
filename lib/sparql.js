/**
 * Shared Wikidata Query Service access.
 *
 * Extracted from lib/wikidata-claim-watch.js, which learned the hard way that
 * a single query spanning nine counties times out while nine queries anchored
 * at one county each do not. WDQS degraded further through 2026 - queries that
 * were sub-second historically now run 9-27s - and the service budget is 60s
 * of query time per minute per (IP, User-Agent). So chunking is a correctness
 * requirement, not a tuning knob, and every caller that can chunk should.
 *
 * @see https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/query_limits
 */

const SPARQL_URL = 'https://query.wikidata.org/sparql'
const USER_AGENT = 'sfedits-region/1.0 (https://github.com/tieguy/sfedits)'
const ENTITY_PREFIX = 'http://www.wikidata.org/entity/'
const QUERY_TIMEOUT_MS = 60000

const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 2000

/** Strip the entity URI prefix so callers deal in bare QIDs. */
function bareQid(value) {
  return value.startsWith(ENTITY_PREFIX) ? value.slice(ENTITY_PREFIX.length) : value
}

/**
 * Execute a SPARQL SELECT and return the raw bindings.
 * @throws {Error} on non-200, with the body text attached for timeout detection
 */
async function sparqlRaw(query) {
  const response = await fetch(SPARQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/sparql-results+json'
    },
    body: new URLSearchParams({ format: 'json', query }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error = new Error(`SPARQL returned ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  const data = await response.json()
  return data.results.bindings
}

/**
 * Single-column SELECT returning bare QIDs. Preserves the exact contract the
 * claim watcher has always relied on.
 * @returns {Promise<string[]>}
 */
async function sparqlSelect(query) {
  const bindings = await sparqlRaw(query)
  return bindings.map(b => bareQid(Object.values(b)[0].value))
}

/**
 * Multi-column SELECT. Entity URIs are reduced to bare QIDs; everything else
 * (sitelink URLs, labels, counts) passes through as-is. Unbound OPTIONAL
 * columns are simply absent from the row object.
 * @returns {Promise<Object[]>}
 */
async function sparqlRows(query) {
  const bindings = await sparqlRaw(query)
  return bindings.map(binding => {
    const row = {}
    for (const [key, cell] of Object.entries(binding)) {
      row[key] = bareQid(cell.value)
    }
    return row
  })
}

/** WDQS signals overload by status and by body text, not by header. */
function isRetryable(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  if (error.status === 429) return true
  if (error.status && error.status >= 500) return true
  return Boolean(error.body && /timeout|too many requests/i.test(error.body))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Run one query per chunk, sequentially, concatenating the rows.
 *
 * Sequential on purpose: the WDQS budget is query-seconds per minute, so
 * firing chunks in parallel spends the same budget faster and gets throttled.
 *
 * A chunk that fails after its retries does not fail the whole call - it is
 * reported through onChunkError and omitted. A partial region list is more
 * useful than none, and the caller decides whether to treat it as fatal.
 *
 * @param {string[]} chunks - anchors (QIDs, classes) to build queries from
 * @param {(chunk: string) => string} buildQuery
 * @param {Object} [options]
 * @param {number} [options.retries=2]
 * @param {number} [options.retryDelayMs=2000]
 * @param {(chunk: string, error: Error) => void} [options.onChunkError]
 * @returns {Promise<Object[]>}
 */
async function sparqlChunked(chunks, buildQuery, options = {}) {
  const {
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    onChunkError = null
  } = options

  const rows = []

  for (const chunk of chunks) {
    let lastError = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const chunkRows = await sparqlRows(buildQuery(chunk))
        for (const r of chunkRows) rows.push(r)
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < retries && isRetryable(error)) {
          if (retryDelayMs > 0) await sleep(retryDelayMs)
          continue
        }
        break
      }
    }

    if (lastError) {
      if (onChunkError) onChunkError(chunk, lastError)
      else console.error(`SPARQL chunk ${chunk} failed: ${lastError.message}`)
    }
  }

  return rows
}

module.exports = {
  sparqlSelect,
  sparqlRows,
  sparqlChunked,
  isRetryable,
  SPARQL_URL,
  USER_AGENT
}
