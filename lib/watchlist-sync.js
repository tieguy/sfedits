/**
 * Dynamic Watchlist Sync
 *
 * Pulls an article list from a WikiProject / task force via the
 * PageAssessments API (list=projectpages) instead of hard-coding titles in
 * config. Task force membership is declared by talk-page banners (e.g.
 * {{WikiProject California|sfba=yes}}), and PageAssessments exposes the
 * resulting article list along with class/importance ratings — which lets a
 * config filter like ["Top", "High"] keep a 10k-article task force from
 * turning the bot into a firehose.
 *
 * Config (per account) — two source types.
 *
 * 1. PageAssessments, filtered by importance:
 *   "watchlist_source": {
 *     "project": "San Francisco Bay Area",     // PageAssessments project name
 *     "wikipedia": "English Wikipedia",        // wikichanges feed name (default)
 *     "api_url": "https://en.wikipedia.org/w/api.php",  // (default)
 *     "importance": ["Top", "High"],           // omit to take everything
 *     "refresh_hours": 24                      // (default)
 *   }
 *
 * 2. A published list of titles, chosen by whatever method the operator likes:
 *   "watchlist_source": {
 *     "titles_url": "https://example.toolforge.org/watchlist-500.json",
 *     "wikipedia": "English Wikipedia",
 *     "refresh_hours": 24
 *   }
 *
 * Type 2 exists because importance ratings are not always a good selector —
 * for the SFBA task force they are measurably uncalibrated, so the list is
 * built by `scripts/rank.js` and published instead. The bot deliberately does
 * not know how the list was chosen: keeping selection policy out of here is
 * what lets the same bot serve a region that ranks its articles differently.
 * `titles_url` (or `titles_file`) replaces the PageAssessments fetch; the
 * refresh timer, cache, last-good fallback and isWatched() are unchanged.
 *
 * The fetched list is cached to data/watchlist-<project>.json so a restart
 * (or a Wikipedia API outage) falls back to the last good list instead of an
 * empty watchlist. Static config.watchlist entries are always honored in
 * addition to the dynamic list — matching happens in isWatched().
 *
 * @see https://www.mediawiki.org/wiki/Extension:PageAssessments
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_API_URL = 'https://en.wikipedia.org/w/api.php'
const DEFAULT_WIKIPEDIA = 'English Wikipedia'
const DEFAULT_REFRESH_HOURS = 24
const PAGE_LIMIT = 500

// Wikimedia API etiquette requires a descriptive User-Agent with contact info
const { userAgent } = require('./user-agent')
const USER_AGENT = userAgent('watchlist-sync')

const { actionSession } = require('./mw-api')

/**
 * Fetch all article titles for a PageAssessments project, following
 * continuation until the list is exhausted.
 *
 * @param {Object} source - watchlist_source config stanza
 * @returns {Promise<string[]>} Article titles (mainspace only, importance-filtered)
 * @throws {Error} On network failure or API error response
 */
async function fetchProjectArticles(source) {
  const apiUrl = source.api_url || DEFAULT_API_URL
  const importance = source.importance
    ? new Set(source.importance.map(i => i.toLowerCase()))
    : null

  // actionSession accepts a full api.php URL as well as a bare host.
  const session = await actionSession(apiUrl, 'watchlist-sync')

  const params = {
    action: 'query',
    list: 'projectpages',
    wppprojects: source.project,
    wpplimit: PAGE_LIMIT
  }
  if (importance) params.wppassessments = 'true'

  const titles = []
  for await (const data of session.requestAndContinue(params)) {
    const projects = data.query?.projects || {}
    for (const pages of Object.values(projects)) {
      for (const page of pages) {
        if (page.ns !== 0) continue
        if (importance) {
          const pageImportance = (page.assessment?.importance || '').toLowerCase()
          if (!importance.has(pageImportance)) continue
        }
        titles.push(page.title)
      }
    }
  }

  return titles
}

/**
 * Fetch a plain list of titles, either over HTTP (`titles_url`) or from a
 * local file (`titles_file`).
 *
 * This is the generic escape hatch from PageAssessments: the bot is told
 * *which titles* to watch and stays ignorant of how the list was chosen. It
 * keeps region-specific selection policy (for SFBA, `scripts/rank.js`) out of
 * the bot, and lets any region publish a list by any method it likes.
 *
 * Accepts either a bare JSON array or a `{ titles: [...] }` envelope, so a
 * published file can carry provenance metadata alongside the list.
 *
 * @param {Object} source - watchlist_source config stanza
 * @returns {Promise<string[]>} Article titles
 * @throws {Error} On network failure, HTTP error, or unrecognised payload
 */
async function fetchTitlesList(source) {
  let payload

  if (source.titles_file) {
    payload = JSON.parse(fs.readFileSync(source.titles_file, 'utf8'))
  } else {
    const response = await fetch(source.titles_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) {
      throw new Error(`Title list fetch returned ${response.status}`)
    }
    payload = await response.json()
  }

  const titles = Array.isArray(payload) ? payload : payload?.titles
  if (!Array.isArray(titles)) {
    throw new Error('payload is not a title list (expected an array, or { titles: [...] })')
  }
  return titles
}

/**
 * Identity of a watchlist source, used for cache filenames and log messages.
 * A title list has no project name, so it is keyed by its URL or path.
 */
function sourceKey(source) {
  return source.titles_url || source.titles_file || source.project
}

/** True when this source publishes its own titles rather than using ratings. */
function usesTitleList(source) {
  return Boolean(source.titles_url || source.titles_file)
}

/**
 * Resolve a watchlist_source to titles, whichever type it is. Both the bot and
 * the public coverage page go through here so they cannot disagree about what
 * the bot is watching - the page previously called fetchProjectArticles()
 * directly and rendered an empty list under a titles_url config.
 *
 * @param {Object} source - watchlist_source config stanza
 * @returns {Promise<string[]>} Article titles
 */
async function fetchSourceTitles(source) {
  return usesTitleList(source)
    ? fetchTitlesList(source)
    : fetchProjectArticles(source)
}

/**
 * Cache file path for a source's article list
 */
function cachePath(dataDir, key) {
  const safeName = key.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
  return path.join(dataDir, `watchlist-${safeName}.json`)
}

/**
 * Fetch the project article list and update the account's dynamic watchlist,
 * falling back to the on-disk cache when the API is unreachable. Never
 * throws — a failed refresh keeps the previous in-memory list.
 *
 * @param {Object} account - Account config (mutated: dynamicWatchlist)
 * @param {Object} opts
 * @param {string} opts.dataDir - Directory for cache files
 * @returns {Promise<number>} Number of articles now being watched dynamically
 */
async function refreshWatchlist(account, { dataDir }) {
  const source = account.watchlist_source
  const wikipedia = source.wikipedia || DEFAULT_WIKIPEDIA
  // A title list takes precedence: an account that publishes its own list has
  // opted out of PageAssessments, even if a stale "project" is still in config.
  const isTitleList = usesTitleList(source)
  const key = sourceKey(source)
  const cacheFile = cachePath(dataDir, key)

  let titles
  try {
    titles = await fetchSourceTitles(source)

    // A fetch of ZERO articles almost always means the source is
    // misconfigured: PageAssessments returns an empty result, not an error,
    // for unknown projects (task forces need their full name, e.g.
    // "California/San Francisco Bay Area task force"), and a half-written
    // title list is an empty array. Treat it as a failure so the
    // in-memory/cache fallbacks kick in instead of silently wiping a
    // working watchlist.
    if (titles.length === 0) {
      throw new Error(isTitleList
        ? 'returned 0 articles - is the published title list empty or half-written?'
        : `returned 0 articles - is "${source.project}" the full PageAssessments project name?`)
    }

    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ fetched_at: new Date().toISOString(), titles }))
    } catch (e) {
      console.error('Could not write watchlist cache:', e.message)
    }
    console.log(`✓ Watchlist sync: ${titles.length} articles from "${key}"`)
  } catch (error) {
    console.error(`Watchlist sync failed for "${key}":`, error.message)
    if (account.dynamicWatchlist?.[wikipedia]) {
      console.error('  Keeping previous in-memory watchlist')
      return account.dynamicWatchlist[wikipedia].size
    }
    try {
      titles = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).titles
      console.error(`  Loaded ${titles.length} articles from cache`)
    } catch {
      console.error('  No cache available - dynamic watchlist is empty until next refresh')
      titles = []
    }
  }

  account.dynamicWatchlist = account.dynamicWatchlist || {}
  account.dynamicWatchlist[wikipedia] = new Set(titles)
  return titles.length
}

/**
 * Perform the initial watchlist fetch and schedule periodic refreshes for
 * every account that declares a watchlist_source.
 *
 * @param {Object} config - Full bot config
 * @param {Object} opts
 * @param {string} opts.dataDir - Directory for cache files
 * @returns {Promise<NodeJS.Timeout[]>} Refresh timers (unref'd)
 */
async function startWatchlistSync(config, { dataDir }) {
  const timers = []
  for (const account of config.accounts || []) {
    if (!account.watchlist_source) continue
    if (!sourceKey(account.watchlist_source)) {
      console.error('watchlist_source needs "project", "titles_url" or "titles_file" - skipping dynamic watchlist')
      continue
    }

    await refreshWatchlist(account, { dataDir })

    const hours = account.watchlist_source.refresh_hours || DEFAULT_REFRESH_HOURS
    const timer = setInterval(() => {
      refreshWatchlist(account, { dataDir }).catch(e =>
        console.error('Watchlist refresh error:', e.message))
    }, hours * 60 * 60 * 1000)
    timer.unref()
    timers.push(timer)
  }
  return timers
}

/**
 * Check whether an edit's page is watched by this account, via either the
 * static config watchlist or the dynamically synced project list.
 *
 * @param {Object} account - Account config
 * @param {Object} edit - wikichanges edit ({ wikipedia, page })
 * @returns {boolean}
 */
function isWatched(account, edit) {
  if (account.watchlist?.[edit.wikipedia]?.[edit.page]) {
    return true
  }
  const dynamic = account.dynamicWatchlist?.[edit.wikipedia]
  return Boolean(dynamic && dynamic.has(edit.page))
}

module.exports = {
  fetchProjectArticles,
  fetchTitlesList,
  fetchSourceTitles,
  usesTitleList,
  refreshWatchlist,
  startWatchlistSync,
  isWatched,
  cachePath,
  sourceKey
}
