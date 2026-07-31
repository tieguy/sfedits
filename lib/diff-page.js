const https = require('https')

const { userAgent } = require('./user-agent')
const USER_AGENT = userAgent('diff-page')

/**
 * Fetch the raw HTML of a Wikipedia diff page.
 * Resolves to '' on any network error so callers can fail open
 * (treat "unknown" as "don't block").
 * @param {string} diffUrl - Wikipedia diff URL
 * @returns {Promise<string>} - Page HTML, or '' on error
 */
function fetchDiffHtml(diffUrl) {
  return new Promise((resolve) => {
    const options = { headers: { 'User-Agent': USER_AGENT } }
    https.get(diffUrl, options, (res) => {
      let html = ''
      res.on('data', (chunk) => html += chunk)
      res.on('end', () => resolve(html))
    }).on('error', () => resolve(''))
  })
}

/**
 * Normalize a Wikipedia page title for comparison.
 * Wikipedia treats spaces and underscores as equivalent in titles.
 * @param {string} name - Page title
 * @returns {string} - Normalized title
 */
function normalizePage(name) {
  return (name || '').replace(/_/g, ' ').trim()
}

/**
 * Extract the canonical page name from Wikipedia diff page HTML.
 * Reads `wgPageName` from the embedded mw.config block, which is the
 * authoritative prefixed title (e.g. "Wikipedia:Articles_for_deletion/Roza_Gough").
 * @param {string} html - Diff page HTML
 * @returns {string|null} - Page title with spaces, or null if not found
 */
function extractPageName(html) {
  if (!html) return null
  const m = html.match(/"wgPageName"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return null
  // The captured value is a JSON string body; decode escapes like \/ and \uXXXX.
  let name
  try {
    name = JSON.parse('"' + m[1] + '"')
  } catch (e) {
    name = m[1]
  }
  return normalizePage(name)
}

/**
 * Verify that a diff's HTML actually belongs to the expected page.
 * Guards against the IRC feed parser splicing a stale page title onto a
 * different edit's URL. Fails open: if the page can't be determined from
 * the HTML, returns match=true so a network/parse hiccup never suppresses
 * a legitimate post. Only a positively confirmed mismatch blocks.
 * @param {string} html - Diff page HTML
 * @param {string} expectedPage - The page name the bot believes was edited
 * @returns {{match: boolean, actualPage: string|null}}
 */
function verifyDiffPage(html, expectedPage) {
  const actualPage = extractPageName(html)
  if (!actualPage) {
    return { match: true, actualPage: null }
  }
  return { match: normalizePage(actualPage) === normalizePage(expectedPage), actualPage }
}

module.exports = {
  fetchDiffHtml,
  normalizePage,
  extractPageName,
  verifyDiffPage
}
