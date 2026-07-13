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
 * @param {Object} params
 * @param {string} params.diffUrl - Wikipedia diff URL that was posted
 * @param {string} params.page - Article title
 * @param {string|null} params.blueskyUri - at:// URI of the Bluesky post
 * @param {string|null} params.mastodonId - Mastodon status id
 */
function recordPost({ diffUrl, page, blueskyUri = null, mastodonId = null }, logFile = DEFAULT_LOG_FILE) {
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
    blueskyUri,
    mastodonId,
    status: 'active',
    missingCount: 0
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

module.exports = {
  extractRevisionInfo,
  recordPost,
  loadActive,
  updateEntries,
  DEFAULT_LOG_FILE
}
