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
  const fetchPair = deps.fetchRevisionPair || fetchRevisionPair
  const classify = deps.classify || classifyEdit
  const log = deps.log || console.log
  // Real consumers carry subType ('discord'|'mastodon'|...); page-watch
  // injects its richer consumerLabel, so this is only a fallback.
  const label = deps.label || (c => c.subType || c.type || 'consumer')

  const optedIn = consumers.filter(c => needsSignificanceCheck(c.editFilters))
  if (optedIn.length === 0) return consumers

  let verdict = null
  try {
    const pair = await fetchPair(edit.url)
    if (pair) {
      // Channel overrides come only from opted-in consumers; the live config
      // gives all deliveries one policy, so first-match is deliberate.
      const normalizedChannels = optedIn.map(c => normalizeEditFilters(c.editFilters).substantive_channels)
      // Warn when opted-in consumers carry genuinely differing channel
      // policies. Key order must not read as a difference, so compare with
      // sorted keys; consumers with no policy (null) are not part of the
      // comparison or the warning.
      const canonical = c => c === null ? null
        : JSON.stringify(Object.keys(c).sort().reduce((o, k) => { o[k] = c[k]; return o }, {}))
      const configured = optedIn
        .map((c, i) => ({ name: label(c), policy: canonical(normalizedChannels[i]) }))
        .filter(x => x.policy !== null)
      if (new Set(configured.map(x => x.policy)).size > 1) {
        log(`CHANNEL OVERRIDE CONFLICT: [${configured.map(x => x.name).join(', ')}] carry ` +
          `differing substantive_channels; applying the first configured policy (${configured[0].name}'s)`)
      }
      const channels = normalizedChannels.find(Boolean) || undefined
      // lang defaults to 'en'; parsed host available in edit.url if non-en feed ever opts in
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
