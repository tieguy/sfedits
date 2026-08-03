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
const { fitBlueskyText } = require('./bluesky-utils')

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
 * @returns {Promise<{type, postId, ref} | null>} {type, postId, ref} on success, null if webhook validation rejects
 * @throws {Error} For unknown platform types, webhook validation failures, or platform errors (transient: missing id, permanent: auth)
 */
async function post(delivery, payload) {
  const { type } = delivery

  if (!type) {
    throw new Error('delivery.type is required')
  }

  // Validate Discord webhook early - prevents SSRF before platform code
  if (type === 'discord') {
    const { webhook_url } = delivery.credentials || {}
    const validation = validateWebhookUrl(webhook_url)
    if (!validation.valid) {
      return null
    }
  }

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
}

/**
 * Post to Bluesky
 */
async function postBluesky(delivery, payload) {
  // Bluesky caps posts at 300 graphemes (Mastodon's 500 never bites with this
  // template, so only this platform truncates). The shortened title goes into
  // metadata too: buildFacets finds the title by searching the text, so they
  // must match.
  const fitted = fitBlueskyText(payload.text, payload.metadata?.page)

  const result = await blueskyPlatform.post({
    account: delivery.credentials,
    text: fitted.text,
    screenshot: payload.screenshot,
    metadata: { ...payload.metadata, page: fitted.page },
    replyTo: payload.replyTo
  })

  // Throw if platform returned no uri (transient failure)
  if (!result?.uri) {
    throw new Error('bluesky: platform returned no uri')
  }

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

  // Mastodon client wraps responses in { data: ... }
  const id = result?.data?.id
  if (!id) {
    throw new Error('mastodon: platform returned no status id')
  }

  return {
    type: 'mastodon',
    postId: id,
    ref: id
  }
}

/**
 * Post to Discord
 */
async function postDiscord(delivery, payload) {
  const { webhook_url } = delivery.credentials

  const result = await discordPlatform.post({
    account: { webhook_url },
    text: payload.text,
    screenshot: payload.screenshot,
    metadata: payload.metadata
  })

  // Throw if platform returned no id (transient failure)
  if (!result?.id) {
    throw new Error('discord: platform returned no message id')
  }

  return {
    type: 'discord',
    postId: result.id,
    ref: result.id
  }
}

/**
 * Resolve a single delivery entry against account credentials
 * @private
 * @param {Object} account - Account config object
 * @param {Object} entry - Delivery entry { type, credential_ref?, template?, edit_filters? }
 * @returns {Object} Resolved delivery with credentials
 * @throws {Error} When credentials stanza is missing
 */
function _resolveDeliveryEntry(account, entry) {
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

/**
 * Resolve all delivery entries for an account
 *
 * Maps delivery entries (from account.deliveries) to their credentials
 * by resolving credential_ref (defaults to the delivery type).
 *
 * IMPORTANT: absent deliveries → [] is silent; Task 3 must warn or fall back
 * to legacy per-stanza behavior, since a miscomposed production config would
 * make the bot go quiet with no error.
 *
 * @param {Object} account - Account config object
 * @returns {Array} Array of resolved deliveries with credentials
 * @throws {Error} When credentials stanza is missing for an entry
 */
function resolveConfigDeliveries(account) {
  if (!account.deliveries || !Array.isArray(account.deliveries)) {
    return []
  }

  return account.deliveries.map(entry => _resolveDeliveryEntry(account, entry))
}

module.exports = {
  post,
  resolveConfigDeliveries,
  validateWebhookUrl,
  ALLOWED_WEBHOOK_HOSTS
}
