/**
 * Discord Platform Posting
 *
 * High-level posting abstraction for Discord via incoming webhooks. Webhooks
 * are per-channel URLs created in Discord's channel settings — no bot user,
 * OAuth flow, or gateway connection required. This matches the same
 * post({ account, text, screenshot, metadata }) interface as the Bluesky and
 * Mastodon platform modules.
 *
 * Text is formatted with Discord markdown: the article name and editor become
 * masked links, and bare URLs are wrapped in <> to suppress Discord's link
 * preview embeds (the screenshot attachment is the visual).
 *
 * @see https://discord.com/developers/docs/resources/webhook#execute-webhook
 */

const fs = require('fs')
const path = require('path')

/**
 * Format post text with Discord markdown links
 *
 * Wraps bare URLs (the diff URL) in <> to suppress embeds, then converts the
 * article name and editor name into masked links. Name replacement searches
 * after the article name's position, mirroring buildFacets, so an editor name
 * that happens to appear inside the article title isn't mislinked.
 *
 * @param {string} text - Plain post text (after IP enrichment)
 * @param {string} page - Wikipedia article name
 * @param {string} name - Editor username/IP
 * @param {string} pageUrl - Wikipedia article URL
 * @param {string} userUrl - Editor contributions URL
 * @returns {string} Discord-flavored markdown text
 */
function buildDiscordText(text, page, name, pageUrl, userUrl) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  // Suppress link previews for bare URLs (e.g. the diff URL)
  let result = text.replace(/https?:\/\/[^\s<>]+/g, '<$&>')

  let searchOffset = 0

  if (page && pageUrl) {
    const idx = result.indexOf(page, searchOffset)
    if (idx !== -1) {
      const link = `[${page}](<${pageUrl}>)`
      result = result.slice(0, idx) + link + result.slice(idx + page.length)
      searchOffset = idx + link.length
    }
  }

  if (name && userUrl) {
    const idx = result.indexOf(name, searchOffset)
    if (idx !== -1) {
      const link = `[${name}](<${userUrl}>)`
      result = result.slice(0, idx) + link + result.slice(idx + name.length)
    }
  }

  return result
}

/**
 * Posts to a Discord channel via incoming webhook
 *
 * Sends a multipart request with the formatted message and the screenshot as
 * an image attachment. Uses ?wait=true so Discord returns the created message
 * (and a real HTTP error on failure) instead of a fire-and-forget 204.
 *
 * @param {Object} options - Posting options
 * @param {Object} options.account - Discord config ({ webhook_url })
 * @param {string} options.text - Post text (should be enriched with IP flags)
 * @param {string} options.screenshot - Path to screenshot PNG file
 * @param {Object} options.metadata - Post metadata for links
 * @param {string} options.metadata.page - Article name (for alt text/links)
 * @param {string} options.metadata.name - Username/IP
 * @param {string} options.metadata.pageUrl - Wikipedia article URL
 * @param {string} options.metadata.userUrl - User contributions URL
 * @returns {Promise<Object>} Discord message object
 * @throws {Error} If the webhook request fails
 */
async function post({ account, text, screenshot, metadata }) {
  const url = new URL(account.webhook_url)
  url.searchParams.set('wait', 'true')

  const content = buildDiscordText(
    text,
    metadata.page,
    metadata.name,
    metadata.pageUrl,
    metadata.userUrl
  )

  const payload = {
    content,
    // Never ping anyone even if an editor name looks like a mention
    allowed_mentions: { parse: [] },
    attachments: [{
      id: 0,
      filename: 'screenshot.png',
      description: `Screenshot of edit to ${metadata.page}`
    }]
  }

  const form = new FormData()
  form.append('payload_json', JSON.stringify(payload))
  const imageData = fs.readFileSync(screenshot)
  form.append('files[0]', new Blob([imageData], { type: 'image/png' }), path.basename(screenshot))

  const response = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Discord webhook returned ${response.status}: ${body}`)
  }

  return await response.json()
}

module.exports = { post, buildDiscordText }
