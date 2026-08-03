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

const DEFAULT_CONNECTION_LIMIT = 5

/**
 * Build connector options from a topic_store config stanza.
 *
 * Toolforge supplies ToolsDB credentials as env vars under the build service,
 * which is how the fork deploys. Explicit config wins so a developer can point
 * at a local container with neither env var set.
 *
 * Config (global stanza in config.json):
 *   "topic_store": {
 *     "host": "tools.db.svc.wikimedia.cloud",
 *     "database": "s51234__sfedits",
 *     "user": "s51234",              // omit to read TOOL_TOOLSDB_USER
 *     "password": "...",             // omit to read TOOL_TOOLSDB_PASSWORD
 *     "connection_limit": 5
 *   }
 */
function connectionOptions(stanza = {}, env = process.env) {
  const user = stanza.user || env.TOOL_TOOLSDB_USER
  const password = stanza.password || env.TOOL_TOOLSDB_PASSWORD

  if (!user || !password) {
    throw new Error(
      'topic_store needs a user and password, from config or from ' +
      'TOOL_TOOLSDB_USER / TOOL_TOOLSDB_PASSWORD')
  }

  return {
    host: stanza.host || 'tools.db.svc.wikimedia.cloud',
    port: stanza.port || 3306,
    database: stanza.database,
    user,
    password,
    connectionLimit: stanza.connection_limit || DEFAULT_CONNECTION_LIMIT,
    bigIntAsNumber: true
  }
}

/**
 * MariaDB implements JSON as LONGTEXT, and whether the connector auto-parses
 * it depends on driver options and on the server's column-format flag. Treat
 * both shapes as possible everywhere, or a rebuild will hand a raw '["en"]'
 * string to code expecting an array and die on `.map is not a function`.
 */
function parseJsonColumn(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Rows come back with snake_case columns; callers deal in camelCase. */
function rowToTopic(row) {
  return {
    id: Number(row.id),
    regionQid: String(row.region_qid),
    filtersHash: String(row.filters_hash),
    entityFilters: parseJsonColumn(row.entity_filters),
    languages: parseJsonColumn(row.languages),
    strategy: String(row.strategy),
    generation: Number(row.generation),
    displayName: row.display_name || null,
    lastBuiltAt: row.last_built_at || null
  }
}

function rowToSubscription(row) {
  return {
    id: Number(row.id),
    topicId: Number(row.topic_id),
    ownerUser: String(row.owner_user),
    deliveryType: String(row.delivery_type),
    deliveryConfig: parseJsonColumn(row.delivery_config),
    displayName: row.display_name || null,
    status: String(row.status),
    editFilters: parseJsonColumn(row.edit_filters)
  }
}

/**
 * @param {Object} options
 * @param {Object} [options.pool] - an existing mariadb pool (tests pass one)
 * @param {Object} [options.config] - topic_store stanza, used when no pool given
 */
function createTopicStore({ pool: existingPool = null, config = null, env = process.env } = {}) {
  const pool = existingPool || require('mariadb').createPool(connectionOptions(config, env))

  /**
   * Find or create the topic for a region + filter selection.
   * @returns {Promise<{id, regionQid, created}>}
   */
  async function upsertTopic(regionQid, filters = {}) {
    const normalized = normalizeFilters(filters)
    const hash = filtersHash(filters)

    const existing = await pool.query(
      'SELECT * FROM topics WHERE region_qid = ? AND filters_hash = ?', [regionQid, hash])

    if (existing.length > 0) {
      return { ...rowToTopic(existing[0]), created: false }
    }

    try {
      const result = await pool.query(
        `INSERT INTO topics
           (region_qid, filters_hash, entity_filters, languages, strategy, display_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          regionQid,
          hash,
          normalized.entityFilters ? JSON.stringify(normalized.entityFilters) : null,
          normalized.languages ? JSON.stringify(normalized.languages) : null,
          normalized.strategy,
          filters.displayName || null
        ])

      const created = await pool.query('SELECT * FROM topics WHERE id = ?', [result.insertId])
      return { ...rowToTopic(created[0]), created: true }
    } catch (error) {
      // Lost a race with a concurrent creator; the UNIQUE index did its job.
      if (error.code !== 'ER_DUP_ENTRY') throw error
      const raced = await pool.query(
        'SELECT * FROM topics WHERE region_qid = ? AND filters_hash = ?', [regionQid, hash])
      return { ...rowToTopic(raced[0]), created: false }
    }
  }

  async function getTopic(topicId) {
    const rows = await pool.query('SELECT * FROM topics WHERE id = ?', [topicId])
    return rows.length > 0 ? rowToTopic(rows[0]) : null
  }

  async function topicsForRegion(regionQid) {
    const rows = await pool.query(
      'SELECT * FROM topics WHERE region_qid = ? ORDER BY id', [regionQid])
    return rows.map(rowToTopic)
  }

  /**
   * Find or create the shared article row for a (wikipedia, qid) pair.
   *
   * @param {Object} article
   * @param {Object} [options]
   * @param {boolean} [options.reportTitleChange] - return whether the title
   *   moved instead of the row id; callers use this to detect renames
   * @returns {Promise<number|boolean>}
   */
  async function upsertArticle(article, { reportTitleChange = false } = {}) {
    const existing = await pool.query(
      'SELECT id, title FROM articles WHERE wikipedia = ? AND wikidata_qid = ?',
      [article.wikipedia, article.qid])

    if (existing.length > 0) {
      // Titles change; the QID is the identity, so keep the title current.
      const changed = String(existing[0].title) !== article.title
      if (changed) {
        await pool.query('UPDATE articles SET title = ? WHERE id = ?',
          [article.title, existing[0].id])
      }
      return reportTitleChange ? changed : Number(existing[0].id)
    }

    const result = await pool.query(
      'INSERT INTO articles (wikipedia, title, wikidata_qid) VALUES (?, ?, ?)',
      [article.wikipedia, article.title, article.qid])
    return reportTitleChange ? true : Number(result.insertId)
  }

  /**
   * Replace a topic's membership with the given set, as a diff.
   *
   * Departed articles are marked removed rather than deleted, so provenance
   * survives and a returning article can be revived. The generation bump is
   * what tells a running bot its in-RAM index is stale.
   *
   * @returns {Promise<{added: string[], removed: string[], unchanged: number, renamed: number}>}
   */
  async function setTopicArticles(topicId, articles) {
    const desired = new Map()
    for (const article of articles) {
      desired.set(`${article.wikipedia}:${article.qid}`, article)
    }

    const currentRows = await pool.query(
      `SELECT ta.article_id, ta.removed_at, a.wikipedia, a.wikidata_qid
       FROM topic_articles ta
       JOIN articles a ON a.id = ta.article_id
       WHERE ta.topic_id = ?`, [topicId])

    const current = new Map()
    for (const row of currentRows) {
      current.set(`${row.wikipedia}:${row.wikidata_qid}`, {
        articleId: Number(row.article_id),
        removed: row.removed_at !== null
      })
    }

    const added = []
    const removed = []
    let unchanged = 0
    let renamedCount = 0

    for (const [key, article] of desired) {
      const existing = current.get(key)

      if (existing && !existing.removed) {
        unchanged++
        // A pure rename lands here: the (wikipedia, qid) key is unchanged, so
        // it is neither an add nor a remove - only the title moved. It still
        // has to bump the generation, or a running bot keeps matching the OLD
        // title until some unrelated add/remove happens to bump the counter.
        // Silently matching a dead title is the exact failure rename detection
        // exists to prevent.
        const titleChanged = await upsertArticle(article, { reportTitleChange: true })
        if (titleChanged) renamedCount++
        continue
      }

      const articleId = await upsertArticle(article)

      if (existing) {
        await pool.query(
          `UPDATE topic_articles SET removed_at = NULL, added_at = CURRENT_TIMESTAMP
           WHERE topic_id = ? AND article_id = ?`, [topicId, articleId])
      } else {
        await pool.query(
          `INSERT INTO topic_articles (topic_id, article_id, source, score)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE removed_at = NULL`,
          [topicId, articleId, article.source || 'admin', article.score ?? null])
      }
      added.push(article.qid)
    }

    for (const [key, existing] of current) {
      if (desired.has(key) || existing.removed) continue
      await pool.query(
        `UPDATE topic_articles SET removed_at = CURRENT_TIMESTAMP
         WHERE topic_id = ? AND article_id = ?`, [topicId, existing.articleId])
      removed.push(key.split(':')[1])
    }

    if (added.length > 0 || removed.length > 0 || renamedCount > 0) {
      await pool.query(
        `UPDATE topics SET generation = generation + 1, last_built_at = CURRENT_TIMESTAMP
         WHERE id = ?`, [topicId])
    }

    return { added, removed, unchanged, renamed: renamedCount }
  }

  async function addSubscription(topicId, subscription) {
    const result = await pool.query(
      `INSERT INTO subscriptions
         (topic_id, owner_user, delivery_type, delivery_config, display_name, edit_filters)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        topicId,
        subscription.ownerUser,
        subscription.deliveryType,
        JSON.stringify(subscription.deliveryConfig),
        subscription.displayName || null,
        subscription.editFilters ? JSON.stringify(subscription.editFilters) : null
      ])
    return { id: Number(result.insertId), topicId }
  }

  async function subscriptionsForTopic(topicId, { includeInactive = false } = {}) {
    const sql = includeInactive
      ? 'SELECT * FROM subscriptions WHERE topic_id = ? ORDER BY id'
      : `SELECT * FROM subscriptions WHERE topic_id = ? AND status = 'active' ORDER BY id`
    const rows = await pool.query(sql, [topicId])
    return rows.map(rowToSubscription)
  }

  async function setSubscriptionStatus(subscriptionId, status) {
    await pool.query('UPDATE subscriptions SET status = ? WHERE id = ?',
      [status, subscriptionId])
  }

  async function setSubscriptionFilters(subscriptionId, filters) {
    await pool.query('UPDATE subscriptions SET edit_filters = ? WHERE id = ?',
      [filters ? JSON.stringify(filters) : null, subscriptionId])
  }

  async function subscriptionById(subscriptionId) {
    const rows = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId])
    if (rows.length === 0) return null
    return rowToSubscription(rows[0])
  }

  async function removeSubscription(subscriptionId) {
    await pool.query('DELETE FROM subscriptions WHERE id = ?', [subscriptionId])
  }

  /**
   * Delete topics no subscription references any more.
   *
   * Topic lifetime is deliberately decoupled from any one owner: if the person
   * who created a feed deletes their subscription, everyone else's keeps
   * working. Only when the last one leaves does the topic go.
   *
   * @returns {Promise<number[]>} ids of collected topics
   */
  async function collectOrphanTopics() {
    const rows = await pool.query(
      `SELECT t.id FROM topics t
       LEFT JOIN subscriptions s ON s.topic_id = t.id
       WHERE s.id IS NULL`)

    const ids = rows.map(r => Number(r.id))
    if (ids.length === 0) return []

    await pool.query(
      `DELETE FROM topics WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    return ids
  }

  /**
   * Build the index the bot's hot path matches against.
   *
   * Shape is Map<wikipedia, Map<title, Set<topicId>>> so a match is two hash
   * lookups regardless of how many titles are watched - the same O(1) cost the
   * bot has always had with a static watchlist, just sourced from the store.
   *
   * The generation is the sum of every topic's generation. It is not
   * meaningful as a number; it only has to change when anything rebuilds, so a
   * running bot can notice its index is stale without diffing the whole thing.
   *
   * @param {Object} [options]
   * @param {boolean} [options.requireSubscription=false] - skip topics nobody
   *   is subscribed to; a rebuild job wants them, delivery does not
   * @returns {Promise<{byWiki: Map, generation: number, topicCount: number, titleCount: number}>}
   */
  async function getWatchIndex({ requireSubscription = false } = {}) {
    const subscriptionJoin = requireSubscription
      ? `JOIN subscriptions s ON s.topic_id = t.id AND s.status = 'active'`
      : ''

    const rows = await pool.query(`
      SELECT DISTINCT a.wikipedia, a.title, t.id AS topic_id
      FROM topic_articles ta
      JOIN articles a ON a.id = ta.article_id
      JOIN topics t ON t.id = ta.topic_id
      ${subscriptionJoin}
      WHERE ta.removed_at IS NULL
    `)

    const byWiki = new Map()
    const topics = new Set()
    let titleCount = 0

    for (const row of rows) {
      const wikipedia = String(row.wikipedia)
      const title = String(row.title)
      const topicId = Number(row.topic_id)

      let titles = byWiki.get(wikipedia)
      if (!titles) {
        titles = new Map()
        byWiki.set(wikipedia, titles)
      }

      let topicIds = titles.get(title)
      if (!topicIds) {
        topicIds = new Set()
        titles.set(title, topicIds)
        titleCount++
      }
      topicIds.add(topicId)
      topics.add(topicId)
    }

    const generationRow = await pool.query(
      'SELECT COALESCE(SUM(generation), 0) AS g FROM topics')

    return {
      byWiki,
      generation: Number(generationRow[0].g),
      topicCount: topics.size,
      titleCount
    }
  }

  async function close() {
    await pool.end()
  }

  return {
    pool,
    upsertTopic,
    getTopic,
    topicsForRegion,
    upsertArticle,
    setTopicArticles,
    getWatchIndex,
    addSubscription,
    subscriptionsForTopic,
    setSubscriptionStatus,
    setSubscriptionFilters,
    subscriptionById,
    removeSubscription,
    collectOrphanTopics,
    close
  }
}

module.exports = {
  createTopicStore,
  connectionOptions,
  parseJsonColumn,
  normalizeFilters,
  filtersHash
}
