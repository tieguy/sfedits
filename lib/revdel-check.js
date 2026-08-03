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

const Mastodon = require('./mastodon-client')
const { createAuthenticatedAgent } = require('./bluesky-client')
const { loadActive, updateEntries, DEFAULT_LOG_FILE, entryDeliveries } = require('./post-log')

const { actionSession } = require('./mw-api')
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
  const session = await actionSession(host, 'revdel-check', { timeoutMs: FETCH_TIMEOUT_MS })
  return session.request({
    action: 'query', prop: 'revisions', revids: revIds.join('|'), rvprop: 'ids|user|sha1'
  })
}

/**
 * Delete an entry's posts on all platforms and subscriptions.
 *
 * Per-delivery success is tracked on each element in the deliveries array
 * so a partial failure retries only the failed delivery on the next sweep.
 *
 * For Discord deliveries: subscriptionId absent → use account webhook;
 * present → look up subscription via topic store and use its delivery_config.webhook_url.
 *
 * @param {Object} entry - Posted-log entry (new or legacy format)
 * @param {Object} account - Account config with credentials
 * @param {Object} [topicStore] - Optional topic store for subscription webhook lookup
 * @returns {Object} - Updated entry ('deleted' only when all posts are gone)
 */
async function deletePosts(entry, account, topicStore) {
  const updated = { ...entry }
  const deliveries = entryDeliveries(entry)

  // IMPORTANT 7: Construct updated deliveries array for consistent mutation handling
  // Copy each delivery so mutations are captured for the result
  const updatedDeliveries = deliveries.map(d => ({ ...d }))
  let useNewFormat = entry.deliveries && Array.isArray(entry.deliveries)

  // Delete each delivery independently
  for (let i = 0; i < updatedDeliveries.length; i++) {
    const delivery = updatedDeliveries[i]
    if (delivery.deleted) {
      // Already deleted, skip
      continue
    }

    try {
      if (delivery.type === 'bluesky') {
        const agent = await createAuthenticatedAgent(account.bluesky)
        await agent.deletePost(delivery.postId)
        delivery.deleted = true
        console.log(`[revdel] Deleted Bluesky post for ${entry.host}:${entry.revId} (${entry.reason})`)
      } else if (delivery.type === 'mastodon') {
        const M = Mastodon.client({
          access_token: account.mastodon.access_token,
          instance: account.mastodon.instance
        })
        await M.deleteStatus(delivery.postId)
        delivery.deleted = true
        console.log(`[revdel] Deleted Mastodon post for ${entry.host}:${entry.revId} (${entry.reason})`)
      } else if (delivery.type === 'discord') {
        let webhookUrl = null

        if (delivery.subscriptionId) {
          // Look up subscription webhook
          if (!topicStore) {
            console.warn(
              `[revdel] Cannot delete subscription discord post ${delivery.postId}: ` +
              `topicStore not available - will retry on next sweep`)
            // Leave delivery.deleted = false so it retries when topicStore is available
            continue
          }

          try {
            const subscription = await topicStore.subscriptionById(delivery.subscriptionId)
            if (!subscription) {
              console.error(
                `[revdel] Subscription ${delivery.subscriptionId} not found - ` +
                `cannot delete discord message for ${entry.host}:${entry.revId}`)
              // Mark as deleted since there's nothing to delete
              delivery.deleted = true
              continue
            }
            webhookUrl = subscription.deliveryConfig?.webhook_url
            if (!webhookUrl) {
              console.error(
                `[revdel] Subscription ${delivery.subscriptionId} has no webhook_url - ` +
                `cannot delete discord message for ${entry.host}:${entry.revId}`)
              delivery.deleted = true
              continue
            }
          } catch (error) {
            console.error(
              `[revdel] Failed to load subscription ${delivery.subscriptionId}: ${error.message}`)
            continue
          }
        } else {
          // Use account webhook
          webhookUrl = account.discord?.webhook_url
          if (!webhookUrl) {
            console.error(
              `[revdel] No Discord webhook configured - cannot delete message for ${entry.host}:${entry.revId}`)
            delivery.deleted = true
            continue
          }
        }

        // Delete the message
        const res = await fetch(`${webhookUrl}/messages/${delivery.postId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        })
        // 404 = already gone: that's the outcome we wanted
        if (!res.ok && res.status !== 404) {
          throw new Error(`HTTP ${res.status}`)
        }
        delivery.deleted = true
        console.log(`[revdel] Deleted Discord message for ${entry.host}:${entry.revId} (${entry.reason})`)
      }
    } catch (error) {
      console.error(`[revdel] ${delivery.type} delete failed for ${entry.host}:${entry.revId}: ${error.message}`)
    }
  }

  // Update the entry with modified deliveries
  if (useNewFormat) {
    updated.deliveries = updatedDeliveries
  } else {
    // Update legacy format fields
    for (const delivery of updatedDeliveries) {
      if (delivery.type === 'bluesky') {
        updated.blueskyDeleted = delivery.deleted
      } else if (delivery.type === 'mastodon') {
        updated.mastodonDeleted = delivery.deleted
      } else if (delivery.type === 'discord') {
        updated.discordDeleted = delivery.deleted
      }
    }
  }

  // Entry is fully deleted when every delivery is deleted, or when there are
  // no deliveries (vacuously complete - nothing to take down).
  const allDeleted = updatedDeliveries.length === 0 || updatedDeliveries.every(d => d.deleted)
  if (allDeleted) {
    updated.status = 'deleted'
    updated.deletedAt = new Date().toISOString()
    updated.deletedReason = entry.reason
    if (updatedDeliveries.length === 0) {
      console.log(`[revdel] Marking zero-delivery entry ${entry.host}:${entry.revId} as deleted (no posts to take down)`)
    }
  }
  // else: stays active; hidden state will re-classify next sweep and retry
  return updated
}

/**
 * Run one sweep: check all recently-posted revisions, delete posts for
 * hidden revisions, bump/reset missing counters.
 *
 * @param {Object} account - Account config with credentials
 * @param {string} [logFile] - Path to posted-log.jsonl file
 * @param {Object} [topicStore] - Optional topic store for subscription webhook lookup
 */
async function sweep(account, logFile = DEFAULT_LOG_FILE, topicStore = null) {
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
    deleted.push(await deletePosts(entry, account, topicStore))
  }

  updateEntries([...toUpdate, ...deleted], logFile)
  if (toDelete.length || toUpdate.length) {
    console.log(`[revdel] Sweep: ${entries.length} checked, ${deleted.filter(e => e.status === 'deleted').length} deleted, ${toUpdate.length} counters updated`)
  }
  return { checked: entries.length, deleted: deleted.filter(e => e.status === 'deleted').length }
}

/**
 * Start the periodic sweeper. Returns the interval handle.
 * @param {Object} account - Account config with credentials
 * @param {number} [intervalMs] - Sweep interval in milliseconds
 * @param {Object} [topicStore] - Optional topic store for subscription webhook lookup
 */
function startSweeper(account, intervalMs = SWEEP_INTERVAL_MS, topicStore = null) {
  const run = () => sweep(account, DEFAULT_LOG_FILE, topicStore).catch(err => console.error('[revdel] Sweep error:', err.message))
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
