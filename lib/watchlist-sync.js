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
 * Config (per account):
 *   "watchlist_source": {
 *     "project": "San Francisco Bay Area",     // PageAssessments project name
 *     "wikipedia": "English Wikipedia",        // wikichanges feed name (default)
 *     "api_url": "https://en.wikipedia.org/w/api.php",  // (default)
 *     "importance": ["Top", "High"],           // omit to take everything
 *     "refresh_hours": 24                      // (default)
 *   }
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

  const titles = []
  let continueToken = null

  do {
    const params = new URLSearchParams({
      action: 'query',
      list: 'projectpages',
      wppprojects: source.project,
      wpplimit: String(PAGE_LIMIT),
      format: 'json',
      formatversion: '2',
      maxlag: '5'
    })
    if (importance) {
      params.set('wppassessments', 'true')
    }
    if (continueToken) {
      params.set('wppcontinue', continueToken)
      params.set('continue', '-||')
    }

    const response = await fetch(`${apiUrl}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) {
      throw new Error(`PageAssessments API returned ${response.status}`)
    }
    const data = await response.json()
    if (data.error) {
      throw new Error(`PageAssessments API error: ${data.error.code} - ${data.error.info}`)
    }

    const projects = data.query?.projects || {}
    // The API keys results by project name; take whatever project(s) came back
    for (const pages of Object.values(projects)) {
      for (const page of pages) {
        // Mainspace articles only — the project also tags templates, categories, etc.
        if (page.ns !== 0) continue
        if (importance) {
          const pageImportance = (page.assessment?.importance || '').toLowerCase()
          if (!importance.has(pageImportance)) continue
        }
        titles.push(page.title)
      }
    }

    continueToken = data.continue?.wppcontinue || null
  } while (continueToken)

  return titles
}

/**
 * Cache file path for a project's article list
 */
function cachePath(dataDir, project) {
  const safeName = project.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
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
  const cacheFile = cachePath(dataDir, source.project)

  let titles
  try {
    titles = await fetchProjectArticles(source)

    // A fetch of ZERO articles almost always means the project name is
    // wrong: PageAssessments returns an empty result, not an error, for
    // unknown projects (task forces need their full name, e.g.
    // "California/San Francisco Bay Area task force"). Treat it as a
    // failure so the in-memory/cache fallbacks kick in instead of
    // silently wiping a working watchlist.
    if (titles.length === 0) {
      throw new Error(`returned 0 articles - is "${source.project}" the full PageAssessments project name?`)
    }

    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ fetched_at: new Date().toISOString(), titles }))
    } catch (e) {
      console.error('Could not write watchlist cache:', e.message)
    }
    console.log(`✓ Watchlist sync: ${titles.length} articles from "${source.project}"`)
  } catch (error) {
    console.error(`Watchlist sync failed for "${source.project}":`, error.message)
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
    if (!account.watchlist_source.project) {
      console.error('watchlist_source is missing "project" - skipping dynamic watchlist')
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
  refreshWatchlist,
  startWatchlistSync,
  isWatched,
  cachePath
}
