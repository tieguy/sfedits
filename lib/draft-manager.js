const fs = require('fs')
const path = require('path')

const DRAFTS_DIR = path.join(__dirname, '../drafts')
const SCREENSHOTS_DIR = path.join(DRAFTS_DIR, 'screenshots')

/**
 * Initialize drafts directory structure
 */
function initDraftsDir() {
  if (!fs.existsSync(DRAFTS_DIR)) {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true })
  }
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
  }
}

/**
 * Save a draft
 * @param {Object} options - Draft options
 * @param {string} options.text - Post text
 * @param {string} options.screenshot - Path to screenshot file
 * @param {string} options.diffUrl - Wikipedia diff URL
 * @param {string} options.article - Article name
 * @param {string} options.editor - Editor username/IP
 * @param {Object} options.statusData - Full status data (pageUrl, userUrl, etc.)
 * @returns {string} - Draft ID (timestamp)
 */
function saveDraft(options) {
  initDraftsDir()

  const timestamp = Date.now()
  const draftId = `${timestamp}`

  // Copy screenshot to drafts directory if provided
  let screenshotPath = null
  if (options.screenshot) {
    const screenshotFilename = `${timestamp}.png`
    const screenshotDest = path.join(SCREENSHOTS_DIR, screenshotFilename)
    fs.copyFileSync(options.screenshot, screenshotDest)
    screenshotPath = `drafts/screenshots/${screenshotFilename}`
  }

  const draft = {
    id: draftId,
    timestamp: new Date(timestamp).toISOString(),
    text: options.text,
    screenshot: screenshotPath,
    diff_url: options.diffUrl,
    article: options.article,
    editor: options.editor,
    status_data: options.statusData,
    posted_to: [] // Track which platforms have successfully posted
  }

  const draftPath = path.join(DRAFTS_DIR, `${draftId}.json`)
  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2))

  console.log(`✓ Draft saved: ${draftId}`)
  return draftId
}

/**
 * List all pending drafts
 * @returns {Array} - Array of draft objects sorted by timestamp (newest first)
 */
function listDrafts() {
  initDraftsDir()

  const files = fs.readdirSync(DRAFTS_DIR)
  const draftFiles = files.filter(f => f.endsWith('.json'))

  const drafts = draftFiles.map(file => {
    const content = fs.readFileSync(path.join(DRAFTS_DIR, file), 'utf8')
    return JSON.parse(content)
  })

  // Sort by timestamp descending (newest first)
  drafts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

  return drafts
}

/**
 * Get a single draft by ID
 * @param {string} draftId - Draft ID
 * @returns {Object|null} - Draft object or null if not found
 */
function getDraft(draftId) {
  const draftPath = path.join(DRAFTS_DIR, `${draftId}.json`)

  if (!fs.existsSync(draftPath)) {
    return null
  }

  const content = fs.readFileSync(draftPath, 'utf8')
  return JSON.parse(content)
}

/**
 * Delete a draft (after posting or rejecting)
 * @param {string} draftId - Draft ID
 */
function deleteDraft(draftId) {
  const draftPath = path.join(DRAFTS_DIR, `${draftId}.json`)

  if (fs.existsSync(draftPath)) {
    // Get draft to find screenshot path
    const draft = getDraft(draftId)

    // Delete draft file
    fs.unlinkSync(draftPath)

    // Delete screenshot if it exists
    if (draft && draft.screenshot) {
      const screenshotPath = path.join(__dirname, '..', draft.screenshot)
      if (fs.existsSync(screenshotPath)) {
        fs.unlinkSync(screenshotPath)
      }
    }

    console.log(`✓ Draft deleted: ${draftId}`)
  }
}

/**
 * Get count of pending drafts
 * @returns {number} - Number of pending drafts
 */
function getDraftCount() {
  initDraftsDir()
  const files = fs.readdirSync(DRAFTS_DIR)
  return files.filter(f => f.endsWith('.json')).length
}

module.exports = {
  saveDraft,
  listDrafts,
  getDraft,
  deleteDraft,
  getDraftCount,
  DRAFTS_DIR,
  SCREENSHOTS_DIR
}
