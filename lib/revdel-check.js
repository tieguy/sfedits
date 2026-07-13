/**
 * Revdel sweeper: delete social posts whose Wikipedia revision was hidden
 *
 * The bot's posts republish revision content (screenshot) and the editor's
 * name (post text). If the community later hides that revision -
 * RevisionDelete or oversight suppression, often *because* it contained
 * PII or defamation - the posts should not keep it public.
 *
 * Detection is by polling (not EventStreams): full suppression is not
 * reliably announced on public streams, but it is observable by
 * re-querying the revision. Evidence is treated asymmetrically:
 *
 *  - hidden:  the API affirmatively reports texthidden/userhidden/etc.
 *             Strong signal - delete immediately.
 *  - missing: the revision is simply absent (badrevids). Weak signal -
 *             a transient API problem can look identical - so it must be
 *             observed on two consecutive sweeps before posts are deleted.
 *             (Page deletion also lands here, and also warrants removal.)
 *
 * userhidden alone still triggers deletion: the post text names the editor.
 */

const Mastodon = require('mastodon')
const { createAuthenticatedAgent } = require('./bluesky-client')
const { loadActive, updateEntries, DEFAULT_LOG_FILE } = require('./post-log')

const USER_AGENT = 'sfedits-bot/1.0 (https://github.com/edsu/anon; Contact via GitHub issues)'
const FETCH_TIMEOUT_MS = 15000
const BATCH_SIZE = 50
const SWEEP_INTERVAL_MS = 20 * 60 * 1000
const MAX_AGE_DAYS = 30

const HIDDEN_FLAGS = ['texthidden', 'sha1hidden', 'userhidden', 'commenthidden', 'suppressed']

/**
 * Classify each queried revision id from a MediaWiki API response
 * (action=query&prop=revisions&formatversion=2).
 * @returns {Map<number, 'visible'|'hidden'|'missing'>}
 */
function classifyRevisions(apiResponse, queriedRevIds) {
  const result = new Map()

  for (const page of apiResponse?.query?.pages || []) {
    for (const rev of page.revisions || []) {
      const hidden = HIDDEN_FLAGS.some(flag => rev[flag])
      result.set(rev.revid, hidden ? 'hidden' : 'visible')
    }
  }
  for (const bad of Object.values(apiResponse?.query?.badrevids || {})) {
    result.set(bad.revid, 'missing')
  }

  // Anything queried but absent from the response entirely: treat as
  // missing (weak signal, same confirmation rules apply)
  for (const revId of queriedRevIds) {
    if (!result.has(revId)) result.set(revId, 'missing')
  }
  return result
}

/**
 * Decide what to do with each log entry given this sweep's classifications.
 * Pure function.
 * @returns {{toDelete: Object[], toUpdate: Object[]}} - toUpdate entries
 *   carry adjusted missingCount; toDelete entries should have their posts
 *   removed (and are not included in toUpdate).
 */
function decideActions(entries, classifications) {
  const toDelete = []
  const toUpdate = []

  for (const entry of entries) {
    const state = classifications.get(entry.revId)
    if (state === 'hidden') {
      toDelete.push({ ...entry, reason: 'hidden' })
    } else if (state === 'missing') {
      if ((entry.missingCount || 0) >= 1) {
        toDelete.push({ ...entry, reason: 'missing' })
      } else {
        toUpdate.push({ ...entry, missingCount: (entry.missingCount || 0) + 1 })
      }
    } else if (state === 'visible' && entry.missingCount > 0) {
      toUpdate.push({ ...entry, missingCount: 0 })
    }
    // state undefined (host batch failed): no change this sweep
  }
  return { toDelete, toUpdate }
}

async function queryRevisions(host, revIds) {
  const url = `https://${host}/w/api.php?action=query&prop=revisions&revids=${revIds.join('|')}` +
    `&rvprop=ids|user|sha1&format=json&formatversion=2`
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`)
  return res.json()
}

/**
 * Delete an entry's posts on both platforms. Per-platform success is
 * tracked on the entry so a partial failure retries only the failed
 * platform on the next sweep.
 * @returns {Object} - Updated entry ('deleted' only when all posts are gone)
 */
async function deletePosts(entry, account) {
  const updated = { ...entry }

  if (updated.blueskyUri && !updated.blueskyDeleted) {
    try {
      const agent = await createAuthenticatedAgent(account.bluesky)
      await agent.deletePost(updated.blueskyUri)
      updated.blueskyDeleted = true
      console.log(`[revdel] Deleted Bluesky post for ${entry.host}:${entry.revId} (${entry.reason})`)
    } catch (error) {
      console.error(`[revdel] Bluesky delete failed for ${entry.host}:${entry.revId}: ${error.message}`)
    }
  }

  if (updated.mastodonId && !updated.mastodonDeleted) {
    try {
      const M = new Mastodon({
        access_token: account.mastodon.access_token,
        api_url: account.mastodon.instance + '/api/v1/'
      })
      await M.delete(`statuses/${updated.mastodonId}`, {})
      updated.mastodonDeleted = true
      console.log(`[revdel] Deleted Mastodon post for ${entry.host}:${entry.revId} (${entry.reason})`)
    } catch (error) {
      console.error(`[revdel] Mastodon delete failed for ${entry.host}:${entry.revId}: ${error.message}`)
    }
  }

  const blueskyDone = !updated.blueskyUri || updated.blueskyDeleted
  const mastodonDone = !updated.mastodonId || updated.mastodonDeleted
  if (blueskyDone && mastodonDone) {
    updated.status = 'deleted'
    updated.deletedAt = new Date().toISOString()
    updated.deletedReason = entry.reason
  }
  // else: stays active; hidden state will re-classify next sweep and retry
  return updated
}

/**
 * Run one sweep: check all recently-posted revisions, delete posts for
 * hidden revisions, bump/reset missing counters.
 */
async function sweep(account, logFile = DEFAULT_LOG_FILE) {
  const entries = loadActive(MAX_AGE_DAYS, logFile)
  if (!entries.length) return { checked: 0, deleted: 0 }

  const byHost = new Map()
  for (const e of entries) {
    if (!byHost.has(e.host)) byHost.set(e.host, [])
    byHost.get(e.host).push(e)
  }

  const classifications = new Map()
  for (const [host, hostEntries] of byHost) {
    const revIds = hostEntries.map(e => e.revId)
    for (let i = 0; i < revIds.length; i += BATCH_SIZE) {
      const batch = revIds.slice(i, i + BATCH_SIZE)
      try {
        const response = await queryRevisions(host, batch)
        for (const [revId, state] of classifyRevisions(response, batch)) {
          classifications.set(revId, state)
        }
      } catch (error) {
        // Leave this batch unclassified: no state changes, retry next sweep
        console.error(`[revdel] Query failed for ${host}: ${error.message}`)
      }
    }
  }

  const { toDelete, toUpdate } = decideActions(entries, classifications)

  const deleted = []
  for (const entry of toDelete) {
    deleted.push(await deletePosts(entry, account))
  }

  updateEntries([...toUpdate, ...deleted], logFile)
  if (toDelete.length || toUpdate.length) {
    console.log(`[revdel] Sweep: ${entries.length} checked, ${deleted.filter(e => e.status === 'deleted').length} deleted, ${toUpdate.length} counters updated`)
  }
  return { checked: entries.length, deleted: deleted.filter(e => e.status === 'deleted').length }
}

/**
 * Start the periodic sweeper. Returns the interval handle.
 */
function startSweeper(account, intervalMs = SWEEP_INTERVAL_MS) {
  const run = () => sweep(account).catch(err => console.error('[revdel] Sweep error:', err.message))
  const handle = setInterval(run, intervalMs)
  // First sweep shortly after startup (not immediately, to let the IRC
  // connection settle first)
  setTimeout(run, 60 * 1000)
  return handle
}

module.exports = {
  classifyRevisions,
  decideActions,
  deletePosts,
  sweep,
  startSweeper,
  SWEEP_INTERVAL_MS,
  MAX_AGE_DAYS
}
