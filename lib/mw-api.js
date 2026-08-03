// Shared Wikimedia API client (LUI-94).
//
// Transport facade only: owns User-Agent, gzip, maxlag, 429/Retry-After and
// socket timeout behavior for every Wikimedia-facing request in the repo.
// Domain logic stays in consumers. Action API traffic rides m3api, /w/rest.php
// rides m3api-rest (both ESM-only — the import() boundary is contained here),
// and endpoints no library covers (pageviews, RESTBase summaries, thumbnails,
// WDQS) go through wmFetch below.
//
// Never issues parallel requests at Wikimedia hosts; callers must be serial.
// (m3api has an opt-in combining mechanism via mixCombiningSessionInto, which
// this repo does not use.)

const { userAgent } = require('./user-agent')

// Sleep that can be aborted via a signal. If aborted, throws AbortError immediately.
const sleep = async (ms, signal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  let timer = null
  let abortHandler = null
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(resolve, ms)
      if (signal) {
        abortHandler = () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }
    })
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

// Retry semantics ported from the tested apiGet in place-bot-platform-design
// scripts/reassess.js: 429 waits are free (separate maxRateLimitWaits cap,
// Retry-After authoritative); 5xx/network errors get `tries` attempts with
// linear backoff; permanent non-429 4xx never retries. 503 + Retry-After
// is treated like 429 (free wait), per Wikimedia load-shedding practice.
// Helper to handle rate limit waits (429 or 503 with Retry-After)
async function waitForRateLimit(res, state, { rateLimitWaitMs, maxRetryAfterMs, maxRateLimitWaits, maxTotalWaitMs, signal }) {
  if (state.limitWaits >= maxRateLimitWaits) throw new Error(`HTTP ${res.status}`)
  state.limitWaits++
  const after = Number(res.headers.get('retry-after'))
  const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : rateLimitWaitMs
  const clampedWaitMs = Math.min(waitMs, maxRetryAfterMs)
  if (state.totalWaitMs + clampedWaitMs > maxTotalWaitMs) throw new Error(`HTTP ${res.status}`)
  console.warn(`[wmFetch] ${res.status} rate limit wait: ${clampedWaitMs}ms (wait ${state.limitWaits}/${maxRateLimitWaits}, total ${state.totalWaitMs}ms/${maxTotalWaitMs}ms)`)
  await sleep(clampedWaitMs, signal)
  state.totalWaitMs += clampedWaitMs
}

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

  const state = { limitWaits: 0, totalWaitMs: 0 }
  for (let attempt = 1; ; ) {
    // Check if caller's signal is already aborted before attempting the request
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    // Compose a fresh timeout signal for this attempt, so each attempt gets
    // a separate timeout that doesn't span waits between retries.
    const attemptAbortSignals = [AbortSignal.timeout(timeoutMs)]
    if (signal) attemptAbortSignals.push(signal)
    const composedSignal = AbortSignal.any(attemptAbortSignals)

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
    // 429 or 503 with Retry-After: free wait (doesn't consume a retry attempt)
    if (res.status === 429 || (res.status === 503 && res.headers.has('retry-after'))) {
      await waitForRateLimit(res, state, { rateLimitWaitMs, maxRetryAfterMs, maxRateLimitWaits, maxTotalWaitMs, signal })
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

// Socket-level timeouts (headers and body) for undici dispatchers, preventing
// socket hangs in session.request() and session.fetch() (which m3api-rest uses).
// These are independent of m3api's retry loop — Retry-After waits happen between
// attempts, not during socket I/O, so maxRetriesSeconds budgets still work.
const ACTION_SESSION_HEADERS_TIMEOUT_MS = 30000
const ACTION_SESSION_BODY_TIMEOUT_MS = 30000

// One cached Session per wiki host. The first caller's component names the
// session's User-Agent; later callers share it (transport identity is
// per-operator, not per-module). There is deliberately NO constructor options
// param — a cache hit would silently discard it. Per-call knobs (e.g.
// maxRetriesSeconds for bulk callers) go on the request:
// session.request(params, { maxRetriesSeconds: 600 }).
// Socket timeout is enforced via undici's dispatcher headersTimeout/bodyTimeout
// (gzip/deflate/br by default) — invisible to nock, unit-verified under Node 22 for both.
// The single `timeoutMs` parameter sets both headersTimeout and bodyTimeout to the
// same value; a caller passing timeoutMs:2000 gets 2s for inter-header waits and
// 2s for inter-chunk body reads.
async function actionSession(host, component, { timeoutMs = ACTION_SESSION_HEADERS_TIMEOUT_MS } = {}) {
  // component is required for attribution; match user-agent.js's contract
  if (!component || typeof component !== 'string') {
    throw new Error('actionSession requires component (string)')
  }

  // Cache key is host only; different timeouts share the same session since
  // the timeout is enforced at the socket level by the dispatcher.
  if (sessions.has(host)) return sessions.get(host)
  // Session is m3api's DEFAULT export.
  const promise = loadM3api().then(({ default: Session }) => {
    const session = new Session(host, {
      formatversion: 2,
      errorformat: 'plaintext',
      maxlag: 5
    }, {
      userAgent: userAgent(component)
    })
    // Override the agent with one that has socket-level timeouts.
    // FetchNodeSession creates this.agent in its constructor; we replace it
    // with a CookieAgent that has headersTimeout and bodyTimeout set.
    return applyTimeoutAgent(session, timeoutMs, timeoutMs)
  }).catch(error => {
    // Clean up poisoned cache on rejection so next call can retry
    sessions.delete(host)
    throw error
  })
  sessions.set(host, promise)
  return promise
}

// Replace the session's agent with one that has socket-level timeouts.
// This bounds the underlying undici dispatcher's headers and body timeouts
// for all requests (both session.request and session.fetch).
// Mutates the session in-place (returns it for chaining).
// Apply socket-level timeouts to a session's agent. When called from actionSession,
// both headersTimeoutMs and bodyTimeoutMs are set to the same value (the caller's
// timeoutMs parameter), so a single timeout value enforces both inter-header and
// inter-chunk body read waits.
async function applyTimeoutAgent(session, headersTimeoutMs = ACTION_SESSION_HEADERS_TIMEOUT_MS, bodyTimeoutMs = ACTION_SESSION_BODY_TIMEOUT_MS) {
  // Dynamically import CookieAgent from the already-loaded m3api module
  // to avoid a separate import; it uses the same undici/http-cookie-agent.
  const { CookieAgent } = await import('http-cookie-agent/undici')
  const { CookieJar } = await import('tough-cookie')

  // Close the original agent before replacing it to avoid resource leaks.
  const oldAgent = session.agent
  if (oldAgent?.close) {
    try { await oldAgent.close() } catch { /* best-effort */ }
  }

  // Create a new CookieAgent with the timeout options.
  // The original session.agent already has a CookieJar through its factory;
  // we create a fresh jar here (the jar is per-session, not shared).
  session.agent = new CookieAgent({
    cookies: { jar: new CookieJar() },
    headersTimeout: headersTimeoutMs,
    bodyTimeout: bodyTimeoutMs
  })
  return session
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
