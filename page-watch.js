#!/usr/bin/env node

const fs = require('fs')
const async = require('async')
const minimist = require('minimist')
const Mastodon = require('mastodon')
const Mustache = require('mustache')
const { EditStream } = require('./lib/edit-stream')
const { saveDraft } = require('./lib/draft-manager')
const { enrichIPsInText, initializeReader } = require('./lib/geolocation')
const { captureDiffImage } = require('./lib/diff-image')
const { buildFacets } = require('./lib/bluesky-utils')
const { createAuthenticatedAgent } = require('./lib/bluesky-client')
const bluesky = require('./lib/bluesky-platform')
const mastodon = require('./lib/mastodon-platform')
const discord = require('./lib/discord-platform')
const { startWatchlistSync, isWatched } = require('./lib/watchlist-sync')
const { verifyPIIWithGemini } = require('./lib/gemini-pii-check')
const { fetchDiffHtml, verifyDiffPage } = require('./lib/diff-page')
const { recordPost } = require('./lib/post-log')
const { startSweeper } = require('./lib/revdel-check')
const { loadConfig } = require('./lib/config')

const path = require('path')

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false,
    config: './config.json'
  }
})

const HEARTBEAT_DIR = path.join(__dirname, 'data')
function writeHeartbeat(name) {
  try {
    fs.writeFileSync(path.join(HEARTBEAT_DIR, `heartbeat-${name}`), Date.now().toString())
  } catch (e) {
    // Non-fatal: data dir may not exist in test
  }
}

function getConfig(configPath) {
  // The minimist default is './config.json'; only a non-default value is
  // an explicit request for a file. Otherwise lib/config.js may take the
  // config from the SFEDITS_CONFIG environment variable (e.g. Toolforge).
  const explicit = configPath && configPath !== './config.json' ? configPath : null
  return loadConfig({ path: explicit })
}

// Builds Wikipedia article URL from edit URL. Returns null if URL is malformed.
function getArticleUrl(editUrl, pageName) {
  try {
    const url = new URL(editUrl)
    const lang = url.hostname.split('.')[0]
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pageName)}`
  } catch {
    return null
  }
}

// Builds Wikipedia contributions URL from edit URL. Returns null if URL is malformed.
function getUserContributionsUrl(editUrl, username) {
  try {
    const url = new URL(editUrl)
    const lang = url.hostname.split('.')[0]
    return `https://${lang}.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(username)}`
  } catch {
    return null
  }
}


/**
 * Extract text content from Wikipedia diff HTML
 * @param {string} html - Diff page HTML
 * @returns {string} - Concatenated diff cell text
 */
function extractDiffText(html) {
  // Extract text from diff table cells
  const diffMatches = (html || '').match(/<td[^>]*class="[^"]*diff-[^"]*"[^>]*>(.*?)<\/td>/gs)

  if (!diffMatches) {
    return ''
  }

  let diffText = ''
  for (const match of diffMatches) {
    // Remove HTML tags and decode entities
    let text = match
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()

    diffText += text + ' '
  }

  return diffText.trim()
}

/**
 * Analyze diff text for PII using PII microservice
 */
async function analyzeForPII(text, blockedEntityTypes = null) {
  try {
    const body = { text }
    if (blockedEntityTypes) {
      body.blocked_entity_types = blockedEntityTypes
    }

    const response = await fetch('http://pii-service:5000/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    })

    if (!response.ok) {
      throw new Error(`PII service returned ${response.status}`)
    }

    return await response.json()
  } catch (error) {
    // On timeout/error, log but allow post through
    // Blocking every post on infrastructure issues defeats the purpose
    console.error('PII analysis error:', error.message)
    console.error('⚠ Allowing post through - PII screening unavailable')
    return {
      has_pii: false,
      entities: []
    }
  }
}

/**
 * Log blocked edit to file for manual review
 */
function logBlockedEdit(edit, statusData, piiResult) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    article: edit.page,
    editor: statusData.name,
    diff_url: edit.url,
    post_text: statusData.text,
    detected_pii: piiResult.entities
  }

  const logLine = JSON.stringify(logEntry) + '\n'
  fs.appendFileSync('pii-blocks.log', logLine)
}

/**
 * Send DM alert via Bluesky
 * Uses api.bsky.chat service directly (not routed through bsky.social PDS)
 */
async function sendBlueskyAlert(account, edit, statusData, _piiResult) {
  if (!account.pii_alerts?.bluesky_recipient) return

  try {
    const agent = await createAuthenticatedAgent(account.bluesky)
    const accessJwt = agent.session.accessJwt

    // Build facets for clickable links (same as regular post)
    const alertText = `PII: ${statusData.text}`
    const facets = buildFacets(
      alertText,
      statusData.page,
      statusData.name,
      statusData.pageUrl,
      statusData.userUrl
    )

    // Get conversation - chat API is at api.bsky.chat
    const convoResponse = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=100', {
      headers: {
        'Authorization': `Bearer ${accessJwt}`
      }
    })

    const convosData = await convoResponse.json()

    if (convosData.error) {
      console.error('Failed to list Bluesky conversations:', convosData.error)
      return
    }

    const convo = convosData.convos.find(c =>
      c.members.some(m => m.handle === account.pii_alerts.bluesky_recipient)
    )

    if (!convo) {
      console.error(`No existing Bluesky conversation with ${account.pii_alerts.bluesky_recipient}`)
      return
    }

    // Send message - chat API is at api.bsky.chat
    await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessJwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        convoId: convo.id,
        message: {
          text: alertText,
          facets: facets
        }
      })
    })

    console.log('✓ Bluesky alert sent')
  } catch (error) {
    console.error('Bluesky alert failed:', error.message)
  }
}

/**
 * Send DM alert via Mastodon
 */
async function sendMastodonAlert(account, edit, statusData, _piiResult) {
  if (!account.pii_alerts?.mastodon_recipient) return

  try {
    const M = new Mastodon({
      access_token: account.mastodon.access_token,
      api_url: account.mastodon.instance + '/api/v1/'
    })

    // Same message as regular post, just prefixed with "PII: "
    const alertText = `PII: ${statusData.text}`

    await M.post('statuses', {
      status: `@${account.pii_alerts.mastodon_recipient} ${alertText}`,
      visibility: 'direct'
    })

    console.log('✓ Mastodon alert sent')
  } catch (error) {
    console.error('Mastodon alert failed:', error.message)
  }
}

/**
 * Screen edit for PII before posting
 */
async function screenForPII(account, edit, statusData, diffHtml) {
  try {
    // Check if PII blocking is enabled
    if (account.pii_blocking && !account.pii_blocking.enabled) {
      return { safe: true }
    }

    // Extract diff text from the already-fetched diff HTML
    const diffText = extractDiffText(diffHtml || '')

    if (!diffText) {
      console.error('⚠ Could not extract diff text - blocking as precaution')
      return { safe: false, reason: 'Could not extract diff text' }
    }

    // Get blocked entity types from config
    const blockedTypes = account.pii_blocking?.blocked_entity_types || null

    // Analyze for PII
    const piiResult = await analyzeForPII(diffText, blockedTypes)

    if (piiResult.has_pii) {
      console.error('⚠ Presidio flagged PII - verifying with Gemini...')
      console.error(`   Article: ${edit.page}`)
      console.error(`   Detected: ${piiResult.entities.map(e => e.type).join(', ')}`)

      // Second check: ask Gemini if this is real PII
      // 'false_positive' = safe to post, 'confirmed' = real PII, 'unavailable' = fall back to blocking
      const geminiVerdict = await verifyPIIWithGemini(diffText, piiResult.entities, edit.page)
      if (geminiVerdict === 'false_positive') {
        console.log('✓ Gemini says false positive - allowing post through')
        return { safe: true }
      }

      const reason = geminiVerdict === 'confirmed' ? 'PII confirmed by Gemini' : 'Gemini unavailable, blocking as precaution'
      console.error(`🚫 Blocking post - ${reason}`)

      // Get PII types and max confidence
      const piiTypes = [...new Set(piiResult.entities.map(e => e.type))]
      const maxConfidence = Math.max(...piiResult.entities.map(e => e.score))

      // Save draft (screenshot taken later if admin chooses to post)
      saveDraft({
        text: statusData.text,
        diffUrl: edit.url,
        article: edit.page,
        editor: statusData.name,
        piiDetected: piiTypes,
        piiConfidence: maxConfidence,
        statusData: statusData
      })

      // Log and send text-only alerts
      logBlockedEdit(edit, statusData, piiResult)
      await sendBlueskyAlert(account, edit, statusData, piiResult)
      await sendMastodonAlert(account, edit, statusData, piiResult)

      return { safe: false, reason: 'PII detected', piiResult }
    }

    return { safe: true }
  } catch (error) {
    // Fail-safe: block on any error
    console.error('⚠ PII screening error - blocking as precaution:', error.message)
    return { safe: false, reason: 'Screening error' }
  }
}

function getStatus(edit, name, template) {
  const pageUrl = getArticleUrl(edit.url, edit.page)
  const userUrl = getUserContributionsUrl(edit.url, name)

  const text = Mustache.render(template, {
    name,
    url: edit.url,
    page: edit.page
  })

  return {
    text,
    pageUrl,
    userUrl,
    page: edit.page,
    name
  }
}

async function sendStatus(account, statusData, edit) {
  try {
    console.log(statusData.text)

    if (!argv.noop) {
      // Fetch the diff once; reused for page verification and PII screening
      const diffHtml = await fetchDiffHtml(edit.url)

      // Guard against the IRC feed parser splicing a stale page title onto a
      // different edit's URL. Confirm the diff actually belongs to edit.page.
      const verification = verifyDiffPage(diffHtml, edit.page)
      if (!verification.match) {
        console.error(`Post blocked: diff is for "${verification.actualPage}", not "${edit.page}"`)
        return
      }

      // PII screening before posting
      const screeningResult = await screenForPII(account, edit, statusData, diffHtml)

      if (!screeningResult.safe) {
        console.error(`Post blocked: ${screeningResult.reason}`)
        return
      }

      // Enrich IP addresses with country flags
      const enrichedText = await enrichIPsInText(statusData.text)

      // Render diff via compare API (falls back to page screenshot)
      const capture = await captureDiffImage(edit.url, edit.page)

      if (!capture) {
        throw new Error('Failed to capture screenshot')
      }
      const screenshot = capture.screenshot

      try {
        // Prepare metadata for posting
        const metadata = {
          page: edit.page,
          name: statusData.name,
          pageUrl: statusData.pageUrl,
          userUrl: statusData.userUrl,
          diffUrl: edit.url,
          wiki: edit.wikipedia,
          altText: capture.altText,
          summary: capture.summary,
          article: capture.article
        }

        // Post to Bluesky
        let blueskyUri = null
        if (account.bluesky) {
          const result = await bluesky.post({
            account: account.bluesky,
            text: enrichedText,
            screenshot,
            metadata
          })
          blueskyUri = result?.uri || null
        }

        // Post to Mastodon
        let mastodonId = null
        if (account.mastodon) {
          const result = await mastodon.post({
            account: account.mastodon,
            text: enrichedText,
            screenshot,
            metadata
          })
          mastodonId = result?.data?.id || null
        }

        // Post to Discord
        let discordMessageId = null
        if (account.discord) {
          const result = await discord.post({
            account: account.discord,
            text: enrichedText,
            screenshot,
            metadata
          })
          discordMessageId = result?.id || null
        }

        // Record what was posted so the revdel sweeper can delete these
        // posts if the revision is later hidden on-wiki
        recordPost({ diffUrl: edit.url, page: edit.page, blueskyUri, mastodonId, discordMessageId })

        writeHeartbeat('post')
      } finally {
        // Always clean up screenshot, even if posting fails
        if (screenshot && fs.existsSync(screenshot)) {
          fs.unlinkSync(screenshot)
        }
      }
    }
  } catch (error) {
    console.error('Posting failed:', error)
  }
}

async function inspect(account, edit) {
  if (edit.url) {
    if (isWatched(account, edit)) {
      const statusData = getStatus(edit, edit.user, account.template)
      try {
        await sendStatus(account, statusData, edit)
      } catch (error) {
        console.error('Failed to process edit:', edit.page, error.message)
      }
    }
  }
}

function checkConfig(config, error) {
  if (config.accounts) {
    return async.each(config.accounts, (account, callback) => callback(), error)
  } else {
    return error("missing accounts stanza in config")
  }
}

async function main() {
  const config = getConfig(argv.config)

  // Initialize geolocation database before listening for edits
  await initializeReader()

  // Fetch dynamic article lists (WikiProject task forces) before listening
  await startWatchlistSync(config, { dataDir: HEARTBEAT_DIR })

  return checkConfig(config, function (err) {
    if (!err) {
      // Periodically check posted revisions and delete posts whose
      // revision has been hidden/suppressed on-wiki
      if (!argv.noop && config.accounts.length > 0) {
        startSweeper(config.accounts[0])
      }

      const wikipedia = new EditStream()
      return wikipedia.listen(edit => {
        // Filename kept as 'irc' for healthcheck compatibility; the feed
        // is EventStreams now
        writeHeartbeat('irc')
        if (argv.verbose) {
          console.log(JSON.stringify(edit))
        }
        Array.from(config.accounts).forEach((account) => {
          inspect(account, edit).catch(error => console.error('Inspect error:', error))
        })
      })
    } else {
      return console.log(err)
    }
  })
}

if (require.main === module) {
  // Prevent unhandled errors from crashing the process
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception (continuing):', error)
  })
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection (continuing):', error)
  })

  main().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

module.exports = {
  main,
  getConfig,
  getStatus,
  getArticleUrl,
  getUserContributionsUrl,
  buildFacets,
  inspect,
  sendStatus,
  extractDiffText,
  analyzeForPII,
  screenForPII
}