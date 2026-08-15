/**
 * The significance filter stage: classify "did this edit change what a
 * reader sees?" once per edit, apply the verdict per consumer.
 *
 * Dependencies (fetch, classify, log) are injected so the conservative-pass
 * invariant — ANY failure keeps every consumer — is enforced by unit tests,
 * not by hope. page-watch.js supplies the real ones.
 */
const { needsSignificanceCheck, significanceDropReason, normalizeEditFilters } = require('./edit-filters')
const { classifyEdit } = require('./edit-significance')
const { fetchRevisionPair } = require('./revision-pair')

/**
 * @param {object} edit  the edit object (needs .page and .url)
 * @param {Array} consumers  consumers with .editFilters
 * @param {object} [deps]  injectable for tests:
 *   fetchRevisionPair(diffUrl), classify(prev, curr, opts), log(line), label(consumer)
 * @returns {Promise<Array>} the consumers to keep
 */
async function filterBySignificance(edit, consumers, deps = {}) {
  const fetch = deps.fetchRevisionPair || fetchRevisionPair
  const classify = deps.classify || classifyEdit
  const log = deps.log || console.log
  // Real consumers carry subType ('discord'|'mastodon'|...); page-watch
  // injects its richer consumerLabel, so this is only a fallback.
  const label = deps.label || (c => c.subType || c.type || 'consumer')

  const optedIn = consumers.filter(c => needsSignificanceCheck(c.editFilters))
  if (optedIn.length === 0) return consumers

  let verdict = null
  try {
    const pair = await fetch(edit.url)
    if (pair) {
      // Channel overrides come only from opted-in consumers; the live config
      // gives all deliveries one policy, so first-match is deliberate.
      const channels = optedIn
        .map(c => normalizeEditFilters(c.editFilters).substantive_channels)
        .find(Boolean) || undefined
      verdict = classify(pair.prev, pair.curr, { channels })
      log(`substantive-verdict: ${edit.page} substantive=${verdict.substantive}` +
        ` reasons=[${verdict.reasons.join(',')}] ignored=[${verdict.ignored.join(',')}]` +
        (verdict.fallback ? ` fallback=${verdict.fallback}` : '') +
        (pair.tags && pair.tags.length ? ` tags=[${pair.tags.join(',')}]` : ''))
    }
  } catch (err) {
    log(`substantive-verdict: ${edit.page} classification failed, passing (${err.message})`)
    verdict = null
  }

  const kept = []
  for (const consumer of consumers) {
    const reason = significanceDropReason(verdict, consumer.editFilters)
    if (reason) {
      log(`filtered: ${edit.page} for ${label(consumer)} (${reason})`)
    } else {
      kept.push(consumer)
    }
  }
  return kept
}

module.exports = { filterBySignificance }
