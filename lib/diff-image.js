/**
 * Diff image capture orchestration
 *
 * Preferred path: fetch the structured diff from the MediaWiki compare API,
 * render our own compact HTML, and screenshot that. Produces a readable
 * image plus descriptive alt text.
 *
 * Fallback path: screenshot the live Wikipedia diff page (the original
 * behavior), with generic alt text.
 */

const {
  fetchCompareDiff,
  fetchPageSummary,
  fetchImageAsDataUri,
  fetchBlpStatus,
  parseDiffParams,
  buildDiffModel,
  renderDiffHtml,
  summarizeDiff,
  buildAltText
} = require('./compare-diff')
const { renderDiffModelToFile } = require('./diff-render-native')

/**
 * The browser paths are optional: puppeteer may be absent on hosts where
 * only the native renderer is used (e.g. Toolforge). Lazy-require so the
 * module loads either way.
 */
function browser() {
  try {
    return require('./screenshot')
  } catch (e) {
    return null
  }
}

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
 * @returns {Promise<{screenshot: string, altText: string|null, summary: Object|null, article: Object|null}|null>}
 *   Screenshot path, alt text, structured change summary
 *   ({counts, sentence, added, removed}), and article meta
 *   ({description, thumbnailUrl}). Everything except screenshot is null
 *   when the fallback (raw page screenshot) was used.
 */
async function captureDiffImage(diffUrl, page) {
  try {
    const [diff, meta] = await Promise.all([
      fetchCompareDiff(diffUrl),
      fetchArticleMeta(diffUrl, page)
    ])
    if (diff && diff.length > 0) {
      const model = buildDiffModel(diff, page, meta)

      // Preferred: native renderer, no browser involved
      let screenshot = null
      try {
        screenshot = await renderDiffModelToFile(model)
      } catch (error) {
        console.error(`[captureDiffImage] Native render failed, trying browser: ${error.message}`)
        const b = browser()
        if (b) {
          screenshot = await b.takeHtmlScreenshot(renderDiffHtml(diff, page, meta))
        }
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
    console.error(`[captureDiffImage] Compare API path failed, falling back to page screenshot: ${error.message}`)
  }

  // Last resort: screenshot the live diff page (needs a browser). Wait
  // for the diff table to fully render first (same delay as always).
  const b = browser()
  if (!b) return null
  await new Promise(r => setTimeout(r, 2000))
  const screenshot = await b.takeScreenshot(diffUrl)
  return screenshot ? { screenshot, altText: null, summary: null, article: null } : null
}

module.exports = { captureDiffImage }
