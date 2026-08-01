/**
 * Bluesky Platform Posting
 *
 * High-level posting abstraction for Bluesky. Handles authentication, media upload,
 * facet building, and post creation. This module centralizes all Bluesky posting logic
 * to ensure consistency across the bot and admin console.
 *
 * @see https://docs.bsky.app
 */

const fs = require('fs')
const { createAuthenticatedAgent } = require('./bluesky-client')
const { buildFacets } = require('./bluesky-utils')

/**
 * Posts to Bluesky with screenshot and rich text facets
 *
 * Handles the complete Bluesky posting flow:
 * 1. Authenticates with Bluesky service
 * 2. Uploads screenshot as image blob
 * 3. Builds rich text facets for clickable links
 * 4. Creates post with embedded image
 *
 * @param {Object} options - Posting options
 * @param {Object} options.account - Bluesky account config (identifier, password, service)
 * @param {string} options.text - Post text (should be enriched with IP flags)
 * @param {string} options.screenshot - Path to screenshot PNG file
 * @param {Object} options.metadata - Post metadata for links
 * @param {string} options.metadata.page - Article name (for alt text)
 * @param {string} options.metadata.name - Username/IP
 * @param {string} options.metadata.pageUrl - Wikipedia article URL
 * @param {string} options.metadata.userUrl - User contributions URL
 * @param {string} [options.metadata.altText] - Descriptive alt text for the image
 * @param {Object} [options.replyTo] - Thread refs to post as a reply:
 *   { root: {uri, cid}, parent: {uri, cid} }
 * @returns {Promise<Object>} Bluesky post response with URI and CID
 * @throws {Error} If authentication, upload, or posting fails
 *
 * @example
 * await post({
 *   account: { identifier: 'bot.bsky.social', password: 'app-pass' },
 *   text: 'Cat edited by 192.0.2.1 [🇺🇸] https://...',
 *   screenshot: '/tmp/screenshot-123.png',
 *   metadata: {
 *     page: 'Cat',
 *     name: '192.0.2.1',
 *     pageUrl: 'https://en.wikipedia.org/wiki/Cat',
 *     userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/192.0.2.1'
 *   }
 * })
 */
async function post({ account, text, screenshot, metadata, replyTo }) {
  // Authenticate
  const agent = await createAuthenticatedAgent(account)

  // Upload screenshot
  const imageData = fs.readFileSync(screenshot)
  const uploadResult = await agent.uploadBlob(imageData, {
    encoding: 'image/png'
  })

  // Build facets for clickable links
  const facets = buildFacets(
    text,
    metadata.page,
    metadata.name,
    metadata.pageUrl,
    metadata.userUrl
  )

  // Create post with embedded image
  const record = {
    text: text,
    facets: facets,
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{
        alt: metadata.altText || `Screenshot of edit to ${metadata.page}`,
        image: uploadResult.data.blob
      }]
    },
    createdAt: new Date().toISOString()
  }

  if (replyTo && replyTo.root && replyTo.parent) {
    record.reply = {
      root: { uri: replyTo.root.uri, cid: replyTo.root.cid },
      parent: { uri: replyTo.parent.uri, cid: replyTo.parent.cid }
    }
  }

  return await agent.post(record)
}

module.exports = { post }
