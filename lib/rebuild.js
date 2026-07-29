/**
 * Topic rebuild: re-resolve a region and set-diff against stored membership.
 *
 * Two useful signals fall out of the diff rather than needing their own
 * machinery:
 *  - a QID that has never been seen in this topic before IS the "something in
 *    this place just got a Wikipedia article" signal
 *  - a QID whose title changed IS a rename, which is what keeps the
 *    title-keyed hot-path index from silently going dead
 *
 * The job refuses to apply an incomplete result. A partial or failed resolve
 * that got written through would empty a working watchlist, and a bot that
 * silently stops posting is worse than one that logs an error.
 */

const { articlesForRegion } = require('./region')

/**
 * Default resolver: the real Phase 1 region resolver.
 *
 * A geo region with no boundary of its own resolves to a CONTAINER (a whole
 * city standing in for a neighborhood). That is a judgement call for a human,
 * not something a nightly job should silently adopt, so it is refused here and
 * surfaced with the suggested container in the message.
 */
async function defaultResolver(regionQid, topic) {
  const result = await articlesForRegion(regionQid, {
    strategy: topic.strategy,
    languages: topic.languages
  })

  if (result.needsConfirmation) {
    const suggested = result.suggestion ? result.suggestion.qid : 'unknown'
    throw new Error(
      `${regionQid} has no boundary of its own; the resolver suggests ` +
      `${suggested} instead. Confirm the boundary before rebuilding.`)
  }

  return result
}

/**
 * Rebuild one topic.
 *
 * @param {Object} store - from createTopicStore()
 * @param {number} topicId
 * @param {Object} [options]
 * @param {Function} [options.resolver] - (regionQid, topic) => {articles, partial}
 * @returns {Promise<{ok, topicId, added, removed, renamed, newArticles, error}>}
 */
async function rebuildTopic(store, topicId, options = {}) {
  const { resolver = defaultResolver } = options

  const topic = await store.getTopic(topicId)
  if (!topic) {
    return { ok: false, topicId, error: `topic ${topicId} does not exist` }
  }

  let resolved
  try {
    resolved = await resolver(topic.regionQid, topic)
  } catch (error) {
    return { ok: false, topicId, error: error.message }
  }

  if (resolved.needsConfirmation) {
    const suggested = resolved.suggestion ? resolved.suggestion.qid : 'unknown'
    return {
      ok: false,
      topicId,
      error: `${topic.regionQid} has no boundary of its own; the resolver ` +
        `suggests ${suggested} instead. Confirm the boundary before rebuilding.`
    }
  }

  if (resolved.partial) {
    return {
      ok: false,
      topicId,
      error: `resolve for ${topic.regionQid} was partial; refusing to apply ` +
        'an incomplete article set over a working one'
    }
  }

  // Snapshot QID -> title BEFORE the write.
  //
  // This ordering is load-bearing. setTopicArticles() calls upsertArticle(),
  // which does `UPDATE articles SET title = ?` - so after the write, every
  // stored title is already the new one and a rename is undetectable. The
  // snapshot has to be keyed by QID, not by title, because the title is
  // exactly the thing that changed.
  const priorTitles = await titlesByQid(store, topicId)
  // Keys are "wiki:qid"; the new-article test only cares about the QID.
  const knownQids = new Set(
    Array.from(priorTitles.keys()).map(key => key.slice(key.indexOf(':') + 1)))

  const diff = await store.setTopicArticles(topicId, resolved.articles)

  const renamed = []
  for (const article of resolved.articles) {
    const previous = priorTitles.get(`${article.wikipedia}:${article.qid}`)
    if (previous && previous !== article.title) {
      renamed.push({ qid: article.qid, from: previous, to: article.title })
    }
  }

  // A rename must not be reported as an arrival or a departure. The store
  // already keys membership by QID so it reports neither, but filtering here
  // keeps that guarantee local to this function rather than assumed of it.
  const renamedQids = new Set(renamed.map(r => r.qid))
  const added = diff.added.filter(qid => !renamedQids.has(qid))
  const removed = diff.removed.filter(qid => !renamedQids.has(qid))

  const newArticles = added.filter(qid => !knownQids.has(qid))

  return { ok: true, topicId, added, removed, renamed, newArticles }
}

/**
 * Every ('wiki:qid' -> title) this topic currently holds, INCLUDING departed
 * articles.
 *
 * Serves two purposes at once, both of which need the pre-write state:
 *  - its values are the old titles, for rename detection
 *  - its keys are every QID ever seen in this topic, so "new article" means
 *    never-before-seen rather than merely absent-last-night. An article that
 *    leaves and comes back must not re-trigger the new-article signal.
 */
async function titlesByQid(store, topicId) {
  const rows = await store.pool.query(
    `SELECT a.wikipedia, a.wikidata_qid AS qid, a.title
     FROM topic_articles ta
     JOIN articles a ON a.id = ta.article_id
     WHERE ta.topic_id = ?`, [topicId])

  const titles = new Map()
  for (const row of rows) {
    titles.set(`${row.wikipedia}:${row.qid}`, String(row.title))
  }
  return titles
}

/**
 * Rebuild every topic. One topic's failure never stops the others - a single
 * bad region should not take the whole nightly pass down.
 *
 * Sequential on purpose: rebuilds are SPARQL-heavy and the WDQS budget is
 * shared, so running them in parallel just spends it faster.
 *
 * @returns {Promise<Array>} one result object per topic
 */
async function rebuildAll(store, options = {}) {
  const rows = await store.pool.query('SELECT id FROM topics ORDER BY id')
  const results = []

  for (const row of rows) {
    results.push(await rebuildTopic(store, Number(row.id), options))
  }

  return results
}

module.exports = { rebuildTopic, rebuildAll, defaultResolver }
