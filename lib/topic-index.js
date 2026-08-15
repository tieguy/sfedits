/**
 * The in-RAM index the bot's hot path matches against.
 *
 * The store is the source of truth, but no edit ever queries it: at ~10 edits
 * a second across the feed, a per-edit round trip would be both slow and
 * rude to ToolsDB. Instead the index is loaded once and reloaded when the
 * store's generation moves, so matching stays the same two hash lookups the
 * bot has always done against a static watchlist.
 *
 * A failed refresh keeps the previous index. A database blip should degrade to
 * "slightly stale" rather than to "silently watching nothing" - the same
 * reasoning behind the disk-cache fallback in lib/watchlist-sync.js.
 */

const DEFAULT_REFRESH_SECONDS = 60

function createTopicIndex(store, options = {}) {
  const { refreshSeconds = DEFAULT_REFRESH_SECONDS } = options

  let index = { byWiki: new Map(), generation: null, topicCount: 0, titleCount: 0 }
  let refreshedAt = null

  /**
   * Reload if the store's generation has moved.
   * @returns {Promise<{ok: boolean, rebuilt: boolean, error?: string}>}
   */
  async function refresh() {
    try {
      const next = await store.getWatchIndex({ requireSubscription: true })

      if (index.generation !== null && next.generation === index.generation) {
        return { ok: true, rebuilt: false }
      }

      index = next
      refreshedAt = Date.now()
      return { ok: true, rebuilt: true }
    } catch (error) {
      console.error('Topic index refresh failed (keeping previous index):', error.message)
      return { ok: false, rebuilt: false, error: error.message }
    }
  }

  /**
   * Which topics watch this edit's page.
   *
   * The store keys articles by language code ('es'), but the stream labels
   * edits with a display name ('Spanish Wikipedia'), so the label can never
   * be the lookup key. The wiki's URL is the one identifier both sides
   * share; a non-Wikipedia host (Commons, Wikidata) is never watched.
   *
   * @param {Object} edit - needs .wikipediaUrl and .page
   * @returns {number[]} topic ids, empty when unwatched
   */
  function topicsForEdit(edit) {
    const match = /^https:\/\/([a-z\d-]+)\.wikipedia\.org$/
      .exec(edit.wikipediaUrl || '')
    if (!match) return []
    const titles = index.byWiki.get(match[1])
    if (!titles) return []
    const topicIds = titles.get(edit.page)
    return topicIds ? Array.from(topicIds) : []
  }

  function stats() {
    return {
      generation: index.generation,
      topicCount: index.topicCount,
      titleCount: index.titleCount,
      refreshedAt
    }
  }

  /** Start periodic refreshes. Returns the timer so callers can clear it. */
  function start() {
    const timer = setInterval(() => {
      refresh().catch(error =>
        console.error('Topic index refresh error:', error.message))
    }, refreshSeconds * 1000)
    timer.unref()
    return timer
  }

  return {
    refresh,
    topicsForEdit,
    stats,
    start,
    // Test seams: let a test install a known index without a database.
    _indexForTest: () => index,
    _setIndexForTest: (value) => { index = value }
  }
}

module.exports = { createTopicIndex, DEFAULT_REFRESH_SECONDS }
