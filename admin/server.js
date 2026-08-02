#!/usr/bin/env node

const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { captureDiffImage } = require('../lib/diff-image')
const { recordPost } = require('../lib/post-log')
const bluesky = require('../lib/bluesky-platform')
const mastodon = require('../lib/mastodon-platform')
const { articlesForRegion } = require('../lib/region')

const app = express()
const PORT = process.env.PORT || 3000

// Session management with crypto-random tokens
const sessions = new Map() // sessionToken -> { created: Date, expires: Date }
const SESSION_DURATION = 24 * 60 * 60 * 1000 // 24 hours

// One-time login codes
const loginCodes = new Map() // code -> { created: Date, expires: Date }
const CODE_DURATION = 10 * 60 * 1000 // 10 minutes

// Import draft manager from parent directory
const { listDrafts, getDraft, deleteDraft, DRAFTS_DIR, SCREENSHOTS_DIR } = require('../lib/draft-manager')

// Middleware
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// Clean up expired sessions and codes periodically
setInterval(() => {
  const now = Date.now()

  // Clean sessions
  for (const [token, session] of sessions.entries()) {
    if (session.expires < now) {
      sessions.delete(token)
    }
  }

  // Clean login codes
  for (const [code, data] of loginCodes.entries()) {
    if (data.expires < now) {
      loginCodes.delete(code)
    }
  }
}, 60 * 1000) // Check every minute

// Session-based authentication middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.substring(7)
  const session = sessions.get(token)

  if (!session || session.expires < Date.now()) {
    sessions.delete(token)
    return res.status(403).json({ error: 'Session expired or invalid' })
  }

  next()
}

// Load config (same as bot). SFEDITS_CONFIG (full config as a JSON env
// var) wins; otherwise CONFIG_PATH or the repo-root config.json.
const { loadConfig: loadSharedConfig } = require('../lib/config')
function loadConfig() {
  if (process.env.SFEDITS_CONFIG) {
    return loadSharedConfig()
  }
  return loadSharedConfig({ path: process.env.CONFIG_PATH || path.join(__dirname, '../config.json') })
}

// API Routes

/**
 * POST /api/auth/request-code
 * DISABLED: Admin DM login was removed during PII alert removal phase
 *
 * The Bluesky DM endpoint was originally implemented to DM the login code to
 * whoever most recently contacted the bot. Without a configured recipient (removed
 * with PII alerts), this became an authentication bypass: any client could request
 * a code to an unbounded DM recipient.
 *
 * TODO: Re-enable once a proper recipient config key is added in a follow-up phase.
 * For now, this endpoint is hard-disabled.
 */
app.post('/api/auth/request-code', (req, res) => {
  res.status(501).json({ error: 'Admin DM login is not configured' })
})

/**
 * POST /api/auth/verify-code
 * Verify login code and receive session token
 */
app.post('/api/auth/verify-code', (req, res) => {
  const { code } = req.body

  if (!code) {
    return res.status(400).json({ error: 'Code required' })
  }

  const codeData = loginCodes.get(code)

  if (!codeData) {
    return res.status(401).json({ error: 'Invalid code' })
  }

  if (codeData.expires < Date.now()) {
    loginCodes.delete(code)
    return res.status(401).json({ error: 'Code expired' })
  }

  // Code is valid - delete it and create session
  loginCodes.delete(code)

  const sessionToken = crypto.randomBytes(32).toString('hex')
  const now = Date.now()

  sessions.set(sessionToken, {
    created: now,
    expires: now + SESSION_DURATION
  })

  res.json({
    valid: true,
    token: sessionToken,
    expiresIn: SESSION_DURATION
  })
})

/**
 * GET /api/drafts
 * List all pending drafts
 */
app.get('/api/drafts', requireAuth, (req, res) => {
  try {
    const drafts = listDrafts()
    res.json({ drafts, count: drafts.length })
  } catch (error) {
    console.error('Error listing drafts:', error)
    res.status(500).json({ error: 'Failed to list drafts' })
  }
})

/**
 * GET /api/drafts/:id
 * Get a specific draft
 */
app.get('/api/drafts/:id', requireAuth, (req, res) => {
  try {
    const draft = getDraft(req.params.id)
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' })
    }
    res.json(draft)
  } catch (error) {
    console.error('Error getting draft:', error)
    res.status(500).json({ error: 'Failed to get draft' })
  }
})

/**
 * POST /api/drafts/:id/post
 * Post a draft to its platform
 */
app.post('/api/drafts/:id/post', requireAuth, async (req, res) => {
  try {
    const draft = getDraft(req.params.id)
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' })
    }

    const config = loadConfig()
    const account = config.accounts[0]

    const results = []
    const postedTo = draft.posted_to || []
    let blueskyUri = null
    let mastodonId = null

    // Render diff for posting (admin console doesn't save it in draft)
    const capture = await captureDiffImage(draft.diff_url, draft.article)
    if (!capture) {
      throw new Error('Failed to capture screenshot')
    }
    const screenshot = capture.screenshot

    try {
      // Prepare metadata for posting
      const metadata = {
        page: draft.article,
        name: draft.status_data.name,
        pageUrl: draft.status_data.pageUrl,
        userUrl: draft.status_data.userUrl,
        altText: capture.altText
      }

      // Post to Bluesky if configured and not already posted
      if (account.bluesky && !postedTo.includes('bluesky')) {
        try {
          const result = await bluesky.post({
            account: account.bluesky,
            text: draft.text,
            screenshot,
            metadata
          })
          blueskyUri = result?.uri || null

          console.log(`✓ Posted to Bluesky`)
          postedTo.push('bluesky')
          results.push({ platform: 'bluesky', success: true })
        } catch (error) {
          console.error(`✗ Bluesky failed:`, error.message)
          results.push({ platform: 'bluesky', success: false, error: error.message })
        }
      } else if (postedTo.includes('bluesky')) {
        results.push({ platform: 'bluesky', success: true, skipped: true })
      }

      // Post to Mastodon if configured and not already posted
      if (account.mastodon && !postedTo.includes('mastodon')) {
        try {
          const result = await mastodon.post({
            account: account.mastodon,
            text: draft.text,
            screenshot,
            metadata
          })
          mastodonId = result?.data?.id || null

          console.log(`✓ Posted to Mastodon`)
          postedTo.push('mastodon')
          results.push({ platform: 'mastodon', success: true })
        } catch (error) {
          console.error(`✗ Mastodon failed:`, error.message)
          results.push({ platform: 'mastodon', success: false, error: error.message })
        }
      } else if (postedTo.includes('mastodon')) {
        results.push({ platform: 'mastodon', success: true, skipped: true })
      }
    } finally {
      // Always clean up screenshot, even if posting fails
      if (screenshot && fs.existsSync(screenshot)) {
        fs.unlinkSync(screenshot)
      }
    }

    // Record what was posted so the bot's revdel sweeper can delete
    // these posts if the revision is later hidden on-wiki
    if (blueskyUri || mastodonId) {
      recordPost({ diffUrl: draft.diff_url, page: draft.article, blueskyUri, mastodonId })
    }

    // Update draft with posted platforms
    draft.posted_to = postedTo
    const draftPath = path.join(DRAFTS_DIR, `${draft.id}.json`)
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2))

    // Only delete draft if ALL configured platforms succeeded
    const allPosted = (!account.bluesky || postedTo.includes('bluesky')) &&
                      (!account.mastodon || postedTo.includes('mastodon'))

    if (allPosted) {
      deleteDraft(draft.id)
      res.json({ success: true, complete: true, results })
    } else {
      // Build detailed error message
      const failures = results.filter(r => !r.success && !r.skipped)
      const failureDetails = failures.map(f => `${f.platform}: ${f.error}`).join('; ')
      res.json({
        success: true,
        complete: false,
        results,
        message: `Posted to some platforms. Failed: ${failureDetails}. Click Post to retry.`
      })
    }
  } catch (error) {
    console.error('Error posting draft:', error)
    res.status(500).json({ error: 'Failed to post', details: error.message })
  }
})

/**
 * DELETE /api/drafts/:id
 * Delete a draft without posting
 */
app.delete('/api/drafts/:id', requireAuth, (req, res) => {
  try {
    const draft = getDraft(req.params.id)
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' })
    }

    deleteDraft(req.params.id)
    res.json({ success: true, message: 'Draft deleted' })
  } catch (error) {
    console.error('Error deleting draft:', error)
    res.status(500).json({ error: 'Failed to delete draft' })
  }
})

/**
 * POST /api/drafts/bulk-delete
 * Delete multiple drafts at once
 */
app.post('/api/drafts/bulk-delete', requireAuth, (req, res) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' })
    }

    let deleted = 0
    let failed = 0

    for (const id of ids) {
      try {
        const draft = getDraft(id)
        if (draft) {
          deleteDraft(id)
          deleted++
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }

    res.json({ success: true, deleted, failed })
  } catch (error) {
    console.error('Error bulk deleting drafts:', error)
    res.status(500).json({ error: 'Failed to delete drafts' })
  }
})

/**
 * GET /screenshots/:filename
 * Serve screenshots (requires auth)
 */
app.get('/screenshots/:filename', requireAuth, (req, res) => {
  const screenshotPath = path.join(SCREENSHOTS_DIR, req.params.filename)
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath)
  } else {
    res.status(404).json({ error: 'Screenshot not found' })
  }
})


/**
 * Resolve a place QID for the create flow, normalizing articlesForRegion's
 * result into a console-friendly shape. A region with no boundary of its own
 * comes back as `needs_confirmation` carrying the container suggestion, so the
 * UI can ask "no boundary for X - use Y?" rather than the resolver silently
 * substituting. See docs/design-plans/2026-07-24-boundary-resolution.md.
 */
async function resolveForConsole(qid, options = {}) {
  try {
    const result = await articlesForRegion(qid, options)
    if (result.needsConfirmation) {
      return {
        status: 'needs_confirmation',
        region: { qid: result.region.qid, label: result.region.label },
        suggestion: result.suggestion
      }
    }
    return {
      status: 'resolved',
      region: {
        qid: result.region.qid,
        label: result.region.label,
        strategy: result.region.strategy
      },
      count: result.articles.length,
      approximate: result.approximate === true
    }
  } catch (error) {
    return { status: 'error', error: error.message }
  }
}

/**
 * POST /api/region/resolve
 * Resolve a place QID, surfacing a container suggestion when it has no boundary.
 */
app.post('/api/region/resolve', requireAuth, async (req, res) => {
  const { qid, languages } = req.body || {}
  if (!qid) {
    return res.status(400).json({ error: 'qid required' })
  }
  const result = await resolveForConsole(qid, { languages })
  res.json(result)
})

// Expose the resolver for unit tests without starting a server.
app.resolveForConsole = resolveForConsole

// Start server only if run directly (not when imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Admin server running on port ${PORT}`)
    console.log(`Passwordless authentication via Bluesky DM enabled`)
  })
}

module.exports = app
