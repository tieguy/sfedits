/**
 * Creating a bot from a web request.
 *
 * This is the self-serve path: a stranger names a place, pastes a Discord
 * webhook, and gets a bot. Everything here is about the gap between "a person
 * typed something" and "the topic store has a row" - validation, the size
 * refusal, and the dedup that makes two people asking for the same place share
 * one topic.
 *
 * Deliberately NOT here: rendering, routing, and sessions. Those live in
 * public/server.js so this module can be tested against a database without a
 * server.
 *
 * @see docs/design-plans/2026-07-23-place-bot-platform.md (Phase 7)
 */

const { resolveRegion, regionHistogram, countFromHistogram, articlesForRegion } =
  require('./region')
const { validateWebhookUrl } = require('./subscription-delivery')

/**
 * Default ceiling on a region's article count.
 *
 * Measured 2026-07-29: California resolves cleanly to 211,590 articles in 16
 * seconds. Nothing about that is slow enough to fail on its own, so without a
 * ceiling the first person to type "California" gets a firehose aimed at their
 * Discord channel and the per-subscription rate cap spends its whole budget in
 * the first minute of every hour. This is the Phase 9 guardrail, in its
 * cheapest useful form.
 */
const DEFAULT_MAX_ARTICLES = 5000

class CreateError extends Error {
  constructor(message, { status = 400, field = null } = {}) {
    super(message)
    this.name = 'CreateError'
    this.status = status
    this.field = field
  }
}

/**
 * An invite code gates creation for the alpha.
 *
 * Real Wikimedian identity is Phase 6 and needs an approved OAuth consumer;
 * this is what ships in the meantime. Codes live in config so revoking one is
 * an edit and a restart, not a deploy.
 */
function checkInvite(config, code) {
  const codes = (config && config.invite_codes) || []
  if (codes.length === 0) {
    throw new CreateError(
      'Bot creation is closed: no invite codes are configured.',
      { status: 503 })
  }
  if (!code || !codes.includes(code)) {
    throw new CreateError('That invite code is not valid.', { field: 'invite_code' })
  }
  return true
}

/** QIDs arrive from a search box, so they are user input until proven otherwise. */
function normalizeQid(value) {
  const qid = String(value || '').trim().toUpperCase()
  if (!/^Q[1-9]\d*$/.test(qid)) {
    throw new CreateError(`"${value}" is not a Wikidata item id (expected e.g. Q62).`,
      { field: 'region_qid' })
  }
  return qid
}

function normalizeLanguages(value) {
  const languages = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,]+/)

  const cleaned = languages.map(l => String(l).trim().toLowerCase()).filter(Boolean)
  if (cleaned.length === 0) return ['en']

  for (const code of cleaned) {
    if (!/^[a-z]{2,}(-[a-z0-9]+)*$/.test(code)) {
      throw new CreateError(`"${code}" is not a wiki language code.`, { field: 'languages' })
    }
  }
  return [...new Set(cleaned)]
}

/**
 * What would this bot watch? Runs before anything is written.
 *
 * Returns the strategy, an estimated article count, and - when the region has
 * no boundary of its own - the container the resolver would substitute, which
 * the form shows for confirmation rather than silently adopting.
 */
async function estimateRegion(regionQid, { languages = ['en'] } = {}) {
  const qid = normalizeQid(regionQid)
  const region = await resolveRegion(qid, { strategy: 'auto' })

  let count = null
  let partial = false
  try {
    const histogram = await regionHistogram(region, {})
    count = countFromHistogram(histogram, { languages })
    partial = Boolean(histogram.partial)
  } catch (error) {
    // A histogram needs a boundary for geo regions, and a geo region without
    // one is exactly the case resolveBoundary handles at build time. Report
    // the region rather than failing the whole preview.
    return {
      qid,
      label: region.label,
      strategy: region.strategy,
      count: null,
      partial: false,
      note: error.message
    }
  }

  return { qid, label: region.label, strategy: region.strategy, count, partial }
}

/**
 * Create (or join) a bot.
 *
 * The dedup is the point: two people who ask for the same place with the same
 * filters get one topic between them and two subscriptions, so the region is
 * resolved once and each edit is rendered once. `created` tells the caller
 * which of the two happened, because "you just joined 3 other people watching
 * this" is a better thing to show than "created".
 *
 * @returns {Promise<{topicId, subscriptionId, created, articleCount, label}>}
 */
async function createBot({ store, config = {}, params = {}, resolver = null }) {
  checkInvite(config, params.invite_code)

  const regionQid = normalizeQid(params.region_qid)
  const languages = normalizeLanguages(params.languages)

  const ownerUser = String(params.owner_user || '').trim()
  if (!ownerUser) {
    throw new CreateError('Tell us who to credit this bot to.', { field: 'owner_user' })
  }

  const webhookUrl = String(params.webhook_url || '').trim()
  const validation = validateWebhookUrl(webhookUrl)
  if (!validation.valid) {
    throw new CreateError(`That webhook will not work: ${validation.reason}.`,
      { field: 'webhook_url' })
  }

  const resolve = resolver || (qid => articlesForRegion(qid, { languages }))
  let resolved
  try {
    resolved = await resolve(regionQid, { languages })
  } catch (error) {
    throw new CreateError(`Could not work out what is in that place: ${error.message}`,
      { field: 'region_qid' })
  }

  if (resolved.needsConfirmation) {
    const suggestion = resolved.suggestion || {}
    throw new CreateError(
      `${regionQid} has no boundary of its own. The closest thing with one is ` +
      `${suggestion.label || suggestion.qid || 'a larger area'} — pick that ` +
      'instead if it is what you meant.',
      { field: 'region_qid' })
  }

  const articles = resolved.articles || []
  const maxArticles = config.max_articles || DEFAULT_MAX_ARTICLES
  if (articles.length > maxArticles) {
    throw new CreateError(
      `That place has ${articles.length.toLocaleString('en-US')} articles, over ` +
      `the ${maxArticles.toLocaleString('en-US')} limit. A bot that big posts ` +
      'faster than anyone can read. Try a smaller place.',
      { field: 'region_qid' })
  }

  const topic = await store.upsertTopic(regionQid, { languages })
  const subscription = await store.addSubscription(topic.id, {
    ownerUser,
    deliveryType: 'discord',
    deliveryConfig: { webhook_url: webhookUrl },
    displayName: params.display_name || null
  })

  // Populate immediately. The nightly rebuild would get there eventually, but
  // "your bot starts working tomorrow" is not a thing anyone wants to read
  // after filling in a form.
  await store.setTopicArticles(topic.id, articles)

  return {
    topicId: topic.id,
    subscriptionId: subscription.id,
    created: topic.created,
    articleCount: articles.length,
    label: resolved.region ? resolved.region.label : regionQid
  }
}

module.exports = {
  createBot,
  estimateRegion,
  checkInvite,
  normalizeQid,
  normalizeLanguages,
  CreateError,
  DEFAULT_MAX_ARTICLES
}
