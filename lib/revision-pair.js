/**
 * Fetch the wikitext of both sides of a diff URL, plus the new revision's
 * change tags, in one batched Action API request. Feeds
 * lib/edit-significance.js via lib/significance-stage.js; the stage owns
 * the conservative-pass policy (a throw here must not drop the edit).
 */
const { actionSession } = require('./mw-api')
const { parseDiffParams } = require('./compare-diff')

/**
 * @param {string} diffUrl  the edit's diff URL (edit.url)
 * @returns {Promise<{prev: string|null, curr: string|null, tags: string[]}|null>}
 *   null when the URL has no usable revision pair (new pages, odd URLs).
 */
async function fetchRevisionPair(diffUrl) {
  const parsed = parseDiffParams(diffUrl)
  if (!parsed || !parsed.fromrev || !parsed.torev) return null
  const session = await actionSession(parsed.host, 'edit-significance')
  const resp = await session.request({
    action: 'query', prop: 'revisions',
    revids: `${parsed.fromrev}|${parsed.torev}`,
    rvslots: 'main', rvprop: 'ids|content|tags',
    formatversion: 2
  })
  const byId = new Map()
  for (const page of resp.query?.pages || []) {
    for (const r of page.revisions || []) {
      byId.set(r.revid, r)
    }
  }
  const from = byId.get(parsed.fromrev)
  const to = byId.get(parsed.torev)
  return {
    prev: from?.slots?.main?.content ?? null,
    curr: to?.slots?.main?.content ?? null,
    tags: to?.tags || []
  }
}

module.exports = { fetchRevisionPair }
