/**
 * Unified delivery layer for accounts and subscriptions
 *
 * Provides a single typed interface to post to multiple platforms (Bluesky,
 * Mastodon, Discord) with consistent return values and threading support.
 * Dispatches to existing platform modules unmodified.
 */

const blueskyPlatform = require('./bluesky-platform')
const mastodonPlatform = require('./mastodon-platform')
const discordPlatform = require('./discord-platform')

/**
 * Discord webhook hosts. Anything else is refused.
 *
 * From Phase 5 on, the delivery URL is a string a stranger typed. Fetching an
 * arbitrary URL from a Toolforge-resident process is a server-side request
 * forgery primitive: http://127.0.0.1:..., link-local metadata endpoints, and
 * anything else reachable from inside Wikimedia Cloud but not from outside.
 *
 * An allowlist rather than a denylist, because denylists for this never hold -
 * DNS rebinding, IPv6 forms, decimal IP literals, and redirects all defeat
 * them. Plan A only supports Discord, so the allowlist costs nothing today,
 * and Phase 8 extends it deliberately when other platforms arrive.
 */
const ALLOWED_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com'
])

/**
 * Validate Discord webhook URL format and host
 * @param {string} url
 * @returns {{valid: boolean, reason?: string}}
 */
function validateWebhookUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, reason: 'not a valid URL' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: `protocol ${parsed.protocol} is not https` }
  }
  if (!ALLOWED_WEBHOOK_HOSTS.has(parsed.hostname)) {
    return { valid: false, reason: `host ${parsed.hostname} is not a Discord webhook host` }
  }
  if (!parsed.pathname.startsWith('/api/webhooks/')) {
    return { valid: false, reason: 'path is not a Discord webhook path' }
  }
  return { valid: true }
}

/**
 * Post to a single delivery target
 *
 * @param {Object} delivery - Delivery configuration
 * @param {string} delivery.type - Platform type: 'bluesky' | 'mastodon' | 'discord'
 * @param {Object} delivery.credentials - Platform-specific credentials
 * @param {Object} payload - Post content
 * @param {string} payload.text - Post text
 * @param {string} payload.screenshot - Path to screenshot file
 * @param {Object} payload.metadata - Post metadata
 * @param {Object} [payload.replyTo] - Thread refs (platform-specific)
 * @returns {Promise<{type, postId, ref} | null>} Result or null on handled failure
 * @throws {Error} For unknown platform types
 */
async function post(delivery, payload) {
  const { type, credentials } = delivery

  if (!type) {
    throw new Error('delivery.type is required')
  }

  try {
    switch (type) {
      case 'bluesky':
        return await postBluesky(delivery, payload)
      case 'mastodon':
        return await postMastodon(delivery, payload)
      case 'discord':
        return await postDiscord(delivery, payload)
      default:
        throw new Error(`Unknown or unsupported delivery type: ${type}`)
    }
  } catch (error) {
    // Unknown type throws; handled failures (like webhook validation) return null
    if (error.message.includes('Unknown or unsupported')) {
      throw error
    }
    // If it's a handled validation error, return null
    if (error.message.includes('refusing webhook')) {
      return null
    }
    throw error
  }
}

/**
 * Post to Bluesky
 */
async function postBluesky(delivery, payload) {
  const result = await blueskyPlatform.post({
    account: delivery.credentials,
    text: payload.text,
    screenshot: payload.screenshot,
    metadata: payload.metadata,
    replyTo: payload.replyTo
  })

  return {
    type: 'bluesky',
    postId: result.uri,
    ref: {
      uri: result.uri,
      cid: result.cid
    }
  }
}

/**
 * Post to Mastodon
 */
async function postMastodon(delivery, payload) {
  const result = await mastodonPlatform.post({
    account: delivery.credentials,
    text: payload.text,
    screenshot: payload.screenshot,
    metadata: payload.metadata,
    replyTo: payload.replyTo
  })

  return {
    type: 'mastodon',
    postId: result.id,
    ref: result.id
  }
}

/**
 * Post to Discord
 */
async function postDiscord(delivery, payload) {
  const { webhook_url } = delivery.credentials

  // Validate webhook URL - prevents SSRF
  const validation = validateWebhookUrl(webhook_url)
  if (!validation.valid) {
    throw new Error(`refusing webhook: ${validation.reason}`)
  }

  const result = await discordPlatform.post({
    account: { webhook_url },
    text: payload.text,
    screenshot: payload.screenshot,
    metadata: payload.metadata
  })

  return {
    type: 'discord',
    postId: result.id,
    ref: result.id
  }
}

/**
 * Resolve a delivery entry against account config
 *
 * Maps a delivery entry (from accounts[].deliveries) to its credentials
 * by resolving the credential_ref (defaults to the delivery type).
 *
 * @param {Object} account - Account config object
 * @param {Object} entry - Delivery entry { type, credential_ref?, template?, edit_filters? }
 * @returns {Object} Resolved delivery with credentials
 * @throws {Error} When credentials stanza is missing
 */
function resolveConfigDeliveries(account, entry) {
  const { type, credential_ref = type, template, edit_filters } = entry

  // Resolve credential_ref to the actual stanza
  if (!account[credential_ref]) {
    throw new Error(
      `Delivery entry for type "${type}" references missing credentials stanza "${credential_ref}"`
    )
  }

  const resolved = {
    type,
    credentials: account[credential_ref]
  }

  if (template) {
    resolved.template = template
  }
  if (edit_filters) {
    resolved.edit_filters = edit_filters
  }

  return resolved
}

module.exports = {
  post,
  resolveConfigDeliveries,
  validateWebhookUrl,
  ALLOWED_WEBHOOK_HOSTS
}
