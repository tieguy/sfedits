/**
 * Topic store: the durable, queryable source of truth for what each bot
 * watches and where its posts go.
 *
 * Two people who ask for the same feed get one topic row between them - one
 * rebuild, one diff render per edit - and differ only in their subscription.
 * That dedup is enforced by a UNIQUE index over (region_qid, filters_hash),
 * where the hash is taken over NORMALIZED inputs so that selection order
 * cannot accidentally mint a second identical feed.
 *
 * The bot's hot path never queries this store per edit. It loads an in-RAM
 * index at startup and reloads it when a generation bumps; see getWatchIndex().
 *
 * Storage is MariaDB (ToolsDB in production). Not SQLite: Toolforge's
 * NFS-backed home storage is the documented bad case for it, and the
 * topic/subscription model is relational anyway.
 *
 * @see docs/design-plans/2026-07-23-place-bot-platform.md
 */

const crypto = require('crypto')

/**
 * Reduce a filter selection to canonical form.
 *
 * Order must not matter and case must not matter, or "Mission+en+places" and
 * "Mission+places+EN" would hash differently and split one shared feed into
 * two identical ones. Empty is normalized to null - "no language filter" and
 * "an empty list of languages" are the same request.
 *
 * @param {Object} filters
 * @param {string[]} [filters.languages]
 * @param {string[]} [filters.entityFilters] - class QIDs
 * @param {string} [filters.strategy]
 * @returns {{languages: string[]|null, entityFilters: string[]|null, strategy: string}}
 */
function normalizeFilters(filters = {}) {
  const dedupeSort = (values, transform = v => v) => {
    if (!Array.isArray(values) || values.length === 0) return null
    const set = new Set(values.map(v => transform(String(v).trim())).filter(Boolean))
    if (set.size === 0) return null
    return Array.from(set).sort()
  }

  return {
    languages: dedupeSort(filters.languages, v => v.toLowerCase()),
    entityFilters: dedupeSort(filters.entityFilters),
    strategy: filters.strategy || 'auto'
  }
}

/**
 * Stable hash of a normalized selection. This is the dedup key.
 * @returns {string} 64-char hex sha256
 */
function filtersHash(filters = {}) {
  const normalized = normalizeFilters(filters)
  const canonical = JSON.stringify([
    normalized.strategy,
    normalized.entityFilters,
    normalized.languages
  ])
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

module.exports = {
  normalizeFilters,
  filtersHash
}
