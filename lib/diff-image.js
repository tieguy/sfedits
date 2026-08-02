/**
 * Diff image capture orchestration
 *
 * Single path: fetch the structured diff from the MediaWiki compare API,
 * render it to PNG via satori + resvg (renderDiffModelToFile), and return
 * a fully-populated result object with screenshot path, alt text, summary,
 * and article metadata. Returns null if the compare fetch fails or native
 * rendering fails.
 */

const {
  fetchCompareDiff,
  fetchPageSummary,
  fetchImageAsDataUri,
  fetchBlpStatus,
  parseDiffParams,
  buildDiffModel,
  summarizeDiff,
  buildAltText
} = require('./compare-diff')
const { renderDiffModelToFile } = require('./diff-render-native')

/**
 * Fetch the article's lead-image thumbnail (as a data URI for our HTML
 * render, plus the plain URL for embed use) and Wikidata description.
 * Fail-soft: missing pieces come back null.
 */
async function fetchArticleMeta(diffUrl, page) {
  const params = parseDiffParams(diffUrl)
  if (!params) return { description: null, imageDataUri: null, thumbnailUrl: null, blp: null }
  const [{ description, thumbnailUrl }, blpStatus] = await Promise.all([
    fetchPageSummary(params.host, page),
    fetchBlpStatus(params.host, page)
  ])
  const imageDataUri = thumbnailUrl ? await fetchImageAsDataUri(thumbnailUrl) : null
  return { description, imageDataUri, thumbnailUrl, blp: blpStatus }
}

/**
 * Capture a diff image for posting.
 * @param {string} diffUrl - Wikipedia diff URL
 * @param {string} page - Article title
 * @returns {Promise<{screenshot: string, altText: string, summary: Object, article: Object}|null>}
 *   Fully-populated result object: screenshot path, alt text, structured
 *   change summary ({counts, sentence, added, removed}), and article meta
 *   ({description, thumbnailUrl, blp}). Returns null if compare fetch or
 *   native rendering fails.
 */
async function captureDiffImage(diffUrl, page) {
  try {
    const [diff, meta] = await Promise.all([
      fetchCompareDiff(diffUrl),
      fetchArticleMeta(diffUrl, page)
    ])
    if (diff && diff.length > 0) {
      const model = buildDiffModel(diff, page, meta)

      // Native renderer, no browser involved
      let screenshot = null
      try {
        screenshot = await renderDiffModelToFile(model)
      } catch (error) {
        console.error(`[captureDiffImage] Native render failed: ${error.message}`)
        return null
      }

      if (screenshot) {
        return {
          screenshot,
          altText: buildAltText(diff, page, meta.description),
          summary: summarizeDiff(diff),
          article: { description: meta.description, thumbnailUrl: meta.thumbnailUrl, blp: meta.blp }
        }
      }
    }
  } catch (error) {
    console.error(`[captureDiffImage] Compare API path failed: ${error.message}`)
    return null
  }

  return null
}

module.exports = { captureDiffImage }
