// Shared Wikimedia API client (LUI-94).
//
// Transport facade only: owns User-Agent, gzip, maxlag, 429/Retry-After and
// timeout behavior for every Wikimedia-facing request in the repo. Domain
// logic stays in consumers. Action API traffic rides m3api, /w/rest.php rides
// m3api-rest (both ESM-only — the import() boundary is contained here), and
// endpoints no library covers (pageviews, RESTBase summaries, thumbnails,
// WDQS) go through wmFetch below.
//
// Never issues parallel requests at Wikimedia hosts; m3api's request
// combining merges concurrent compatible calls into one HTTP request.

const { userAgent } = require('./user-agent')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Retry semantics ported from the tested apiGet in place-bot-platform-design
// scripts/reassess.js: 429 waits are free (separate maxRateLimitWaits cap,
// Retry-After authoritative); 5xx/network errors get `tries` attempts with
// linear backoff; permanent non-429 4xx never retries.
async function wmFetch(url, {
  component = 'mw-api',
  tries = 4,
  backoffMs = 2000,
  rateLimitWaitMs = 10000,
  maxRateLimitWaits = 60,
  timeoutMs = 30000,
  headers = {},
  ...fetchOpts
} = {}) {
  let limitWaits = 0
  for (let attempt = 1; ; ) {
    let res
    try {
      res = await fetch(url, {
        ...fetchOpts,
        headers: {
          'User-Agent': userAgent(component),
          'Accept-Encoding': 'gzip',
          ...headers
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (attempt >= tries) throw error
      await sleep(backoffMs * attempt)
      attempt++
      continue
    }
    if (res.status === 429) {
      if (limitWaits >= maxRateLimitWaits) throw new Error('HTTP 429')
      limitWaits++
      // Retry-After is authoritative when the server sends it.
      const after = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : rateLimitWaitMs)
      continue
    }
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500
      if (permanent || attempt >= tries) throw new Error(`HTTP ${res.status}`)
      await sleep(backoffMs * attempt)
      attempt++
      continue
    }
    return res
  }
}

async function wmFetchJson(url, opts = {}) {
  const res = await wmFetch(url, opts)
  return res.json()
}

// --- Action API via m3api (ESM; contained behind one lazy import) ---

let m3apiModule = null
const sessions = new Map()

async function loadM3api() {
  if (!m3apiModule) m3apiModule = await import('m3api/node.js')
  return m3apiModule
}

// One cached Session per wiki host. The first caller's component names the
// session's User-Agent; later callers share it (transport identity is
// per-operator, not per-module). There is deliberately NO constructor options
// param — a cache hit would silently discard it. Per-call knobs (e.g.
// maxRetriesSeconds for bulk callers) go on the request:
// session.request(params, { maxRetriesSeconds: 600 }).
// Accept-Encoding on this path comes from undici's dispatcher (gzip/deflate/br
// by default) — invisible to nock, verified live in Phase 5.
async function actionSession(host, component) {
  if (sessions.has(host)) return sessions.get(host)
  // Session is m3api's DEFAULT export.
  const promise = loadM3api().then(({ default: Session }) => new Session(host, {
    formatversion: 2,
    errorformat: 'plaintext',
    maxlag: 5
  }, {
    userAgent: userAgent(component)
  }))
  sessions.set(host, promise)
  return promise
}

// Test hook: sessions are process-wide state.
function _resetSessions() {
  sessions.clear()
}

module.exports = { wmFetch, wmFetchJson, actionSession, _resetSessions }
