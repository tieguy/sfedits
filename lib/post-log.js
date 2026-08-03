/**
 * Log of social posts and the Wikipedia revisions they publicize
 *
 * Each posted edit is recorded so the revdel sweeper (lib/revdel-check.js)
 * can later delete posts whose underlying revision has been hidden
 * (RevisionDelete) or suppressed (oversight) on-wiki.
 *
 * Storage: newline-delimited JSON in data/posted-log.jsonl. Volume is a
 * handful of posts per day, so read-modify-rewrite updates are fine.
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_LOG_FILE = path.join(__dirname, '..', 'data', 'posted-log.jsonl')

/**
 * Extract the wiki host and revision id from a diff URL
 * (e.g. https://en.wikipedia.org/w/index.php?diff=123&oldid=456).
 * @returns {{host: string, revId: number}|null}
 */
function extractRevisionInfo(diffUrl) {
  try {
    const url = new URL(diffUrl)
    const revId = parseInt(url.searchParams.get('diff'), 10)
    if (!Number.isInteger(revId)) return null
    return { host: url.host, revId }
  } catch (e) {
    return null
  }
}

function entryKey(entry) {
  return `${entry.host}:${entry.revId}`
}

function readAll(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch (e) { return null }
      })
      .filter(Boolean)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

function writeAll(entries, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
}

/**
 * Record a post that just went out.
 *
 * Supports both legacy individual fields and new deliveries array format.
 * The new shape is preferred for entries posted through the unified delivery layer.
 *
 * @param {Object} params
 * @param {string} params.diffUrl - Wikipedia diff URL that was posted
 * @param {string} params.page - Article title
 * @param {Array} [params.deliveries] - New format: array of { type, postId, deleted, subscriptionId? }
 * @param {string|null} [params.blueskyUri] - Legacy: at:// URI of the Bluesky post
 * @param {string|null} [params.mastodonId] - Legacy: Mastodon status id
 * @param {string|null} [params.discordMessageId] - Legacy: Discord webhook message id
 */
function recordPost({
  diffUrl,
  page,
  deliveries = null,
  blueskyUri = null,
  mastodonId = null,
  discordMessageId = null
}, logFile = DEFAULT_LOG_FILE) {
  const info = extractRevisionInfo(diffUrl)
  if (!info) {
    console.error(`[post-log] Could not extract revision from ${diffUrl} - post not recorded`)
    return null
  }
  const entry = {
    host: info.host,
    revId: info.revId,
    page,
    postedAt: new Date().toISOString(),
    status: 'active',
    missingCount: 0
  }

  // Use new format if deliveries array is provided
  if (deliveries && Array.isArray(deliveries) && deliveries.length > 0) {
    entry.deliveries = deliveries
  } else {
    // Fall back to legacy format for backward compatibility
    if (blueskyUri !== null) entry.blueskyUri = blueskyUri
    if (mastodonId !== null) entry.mastodonId = mastodonId
    if (discordMessageId !== null) entry.discordMessageId = discordMessageId
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n')
  return entry
}

/**
 * Load entries still eligible for revdel sweeping: active status and
 * posted within the last maxAgeDays.
 */
function loadActive(maxAgeDays = 30, logFile = DEFAULT_LOG_FILE) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  return readAll(logFile).filter(e =>
    e.status === 'active' && Date.parse(e.postedAt) >= cutoff
  )
}

/**
 * Apply updates to matching entries (matched by host:revId).
 * @param {Object[]} updated - Entries with modified fields
 */
function updateEntries(updated, logFile = DEFAULT_LOG_FILE) {
  if (!updated.length) return
  const byKey = new Map(updated.map(e => [entryKey(e), e]))
  const all = readAll(logFile).map(e => byKey.get(entryKey(e)) || e)
  writeAll(all, logFile)
}

/**
 * Extract delivery array from an entry, handling both new and legacy formats.
 *
 * New format entries have a deliveries array:
 *   { deliveries: [ { type, postId, deleted }, ... ] }
 *
 * Legacy format entries have individual fields:
 *   { blueskyUri, blueskyDeleted, mastodonId, mastodonDeleted, discordMessageId, discordDeleted }
 *
 * This accessor bridges the two so revdel and post-log users can treat all entries uniformly.
 *
 * @param {Object} entry - A posted-log entry
 * @returns {Array} Array of { type, postId, deleted, subscriptionId? } objects
 */
function entryDeliveries(entry) {
  // New format: direct access to deliveries array
  if (entry.deliveries && Array.isArray(entry.deliveries)) {
    return entry.deliveries
  }

  // Legacy format: convert individual fields to array form
  const deliveries = []
  if (entry.blueskyUri) {
    deliveries.push({
      type: 'bluesky',
      postId: entry.blueskyUri,
      deleted: entry.blueskyDeleted || false
    })
  }
  if (entry.mastodonId) {
    deliveries.push({
      type: 'mastodon',
      postId: entry.mastodonId,
      deleted: entry.mastodonDeleted || false
    })
  }
  if (entry.discordMessageId) {
    deliveries.push({
      type: 'discord',
      postId: entry.discordMessageId,
      deleted: entry.discordDeleted || false
    })
  }
  return deliveries
}

module.exports = {
  extractRevisionInfo,
  recordPost,
  loadActive,
  updateEntries,
  entryDeliveries,
  DEFAULT_LOG_FILE
}
