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

// Sleep that can be aborted via a signal. If aborted, throws AbortError immediately.
const sleep = async (ms, signal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }
  })
}

// Retry semantics ported from the tested apiGet in place-bot-platform-design
// scripts/reassess.js: 429 waits are free (separate maxRateLimitWaits cap,
// Retry-After authoritative); 5xx/network errors get `tries` attempts with
// linear backoff; permanent non-429 4xx never retries. 503 + Retry-After
// is treated like 429 (free wait), per Wikimedia load-shedding practice.
async function wmFetch(url, {
  component,
  tries = 4,
  backoffMs = 2000,
  rateLimitWaitMs = 10000,
  maxRateLimitWaits = 60,
  maxRetryAfterMs = 5 * 60 * 1000,
  maxTotalWaitMs = 10 * 60 * 1000,
  timeoutMs = 30000,
  headers = {},
  signal,
  ...fetchOpts
} = {}) {
  // component is required for attribution; match user-agent.js's contract
  if (!component || typeof component !== 'string') {
    throw new Error('wmFetch requires component (string)')
  }

  // Build headers ONCE before the loop: set compliance headers using the
  // Headers API (which normalizes key case-insensitivity), taking precedence
  // over caller-supplied headers.
  const headersObj = new Headers(headers)
  headersObj.set('User-Agent', userAgent(component))
  headersObj.set('Accept-Encoding', 'gzip')

  // Compose caller's signal with timeout ONCE before the loop.
  const abortSignals = [AbortSignal.timeout(timeoutMs)]
  if (signal) abortSignals.push(signal)
  const composedSignal = AbortSignal.any(abortSignals)

  let limitWaits = 0
  let totalWaitMs = 0
  for (let attempt = 1; ; ) {
    // Check if caller's signal is already aborted before attempting the request
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    let res
    try {
      res = await fetch(url, {
        ...fetchOpts,
        headers: headersObj,
        signal: composedSignal
      })
    } catch (error) {
      // If the caller's signal aborted, honor it immediately (don't retry)
      if (signal?.aborted) throw error

      if (attempt >= tries) throw error
      await sleep(backoffMs * attempt, signal)
      attempt++
      continue
    }
    if (res.status === 429) {
      if (limitWaits >= maxRateLimitWaits) throw new Error('HTTP 429')
      limitWaits++
      const after = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : rateLimitWaitMs
      const clampedWaitMs = Math.min(waitMs, maxRetryAfterMs)
      if (totalWaitMs + clampedWaitMs > maxTotalWaitMs) throw new Error('HTTP 429')
      console.warn(`[wmFetch] 429 rate limit wait: ${clampedWaitMs}ms (wait ${limitWaits}/${maxRateLimitWaits}, total ${totalWaitMs}ms/${maxTotalWaitMs}ms)`)
      await sleep(clampedWaitMs, signal)
      totalWaitMs += clampedWaitMs
      continue
    }
    // 503 with Retry-After is treated like 429: free wait, server asked us to slow down
    if (res.status === 503 && res.headers.has('retry-after')) {
      if (limitWaits >= maxRateLimitWaits) throw new Error(`HTTP ${res.status}`)
      limitWaits++
      const after = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : rateLimitWaitMs
      const clampedWaitMs = Math.min(waitMs, maxRetryAfterMs)
      if (totalWaitMs + clampedWaitMs > maxTotalWaitMs) throw new Error(`HTTP ${res.status}`)
      console.warn(`[wmFetch] 503 rate limit wait: ${clampedWaitMs}ms (wait ${limitWaits}/${maxRateLimitWaits}, total ${totalWaitMs}ms/${maxTotalWaitMs}ms)`)
      await sleep(clampedWaitMs, signal)
      totalWaitMs += clampedWaitMs
      continue
    }
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500
      if (permanent || attempt >= tries) throw new Error(`HTTP ${res.status}`)
      await sleep(backoffMs * attempt, signal)
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
  // component is required for attribution; match user-agent.js's contract
  if (!component || typeof component !== 'string') {
    throw new Error('actionSession requires component (string)')
  }

  if (sessions.has(host)) return sessions.get(host)
  // Session is m3api's DEFAULT export.
  const promise = loadM3api().then(({ default: Session }) => new Session(host, {
    formatversion: 2,
    errorformat: 'plaintext',
    maxlag: 5
  }, {
    userAgent: userAgent(component)
  })).catch(error => {
    // Clean up poisoned cache on rejection so next call can retry
    sessions.delete(host)
    throw error
  })
  sessions.set(host, promise)
  return promise
}

// Test hook: sessions are process-wide state.
function _resetSessions() {
  sessions.clear()
}

// --- MediaWiki REST API (/w/rest.php) via m3api-rest ---

let m3apiRestModule = null

async function loadM3apiRest() {
  if (!m3apiRestModule) m3apiRestModule = await import('m3api-rest')
  return m3apiRestModule
}

// GET a MediaWiki REST path on a cached session. `path` is RELATIVE to
// rest.php (e.g. '/v1/revision/A/compare/B') — m3api-rest derives the rest.php
// base from the session's api.php URL and appends this path. Pre-encode any
// path segments. component is required for attribution.
async function restGetJson(host, path, { component, ...options } = {}) {
  // component is required for attribution; match user-agent.js's contract
  if (!component || typeof component !== 'string') {
    throw new Error('restGetJson requires component (string)')
  }
  const [session, { getJson }] = await Promise.all([
    actionSession(host, component),
    loadM3apiRest()
  ])
  return getJson(session, path, options)
}

module.exports = { wmFetch, wmFetchJson, actionSession, restGetJson, _resetSessions }
