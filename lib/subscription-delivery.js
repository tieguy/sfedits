/**
 * Deliver one already-rendered post to one subscription.
 *
 * The render happens once per edit, upstream of this. That is the entire
 * operational payoff of deduplicating on topic: 500 people subscribed to the
 * Mission means one diff render and 500 cheap posts, not 500 renders.
 *
 * Two protections live here, both because delivery targets now belong to
 * strangers rather than to the maintainer:
 *
 *  - a per-subscription rate cap, so a region far bigger than the subscriber
 *    meant to pick becomes a notice rather than a firehose aimed at their
 *    Discord channel
 *  - consecutive-failure quarantine, so a webhook that has been deleted stops
 *    being retried on every matching edit forever
 */

const delivery = require('./delivery')

/** Consecutive hard failures before a subscription is quarantined. */
const FAILURES_BEFORE_BROKEN = 5

/** Discord's own grey, matching the claim watcher's summary embeds. */
const NOTICE_COLOR = 0x95a5a6

/**
 * A 4xx means the webhook is gone or malformed and will never succeed; a 5xx
 * or a transport error is Discord having a bad minute. Only the former should
 * count toward quarantine.
 */
function isPermanentFailure(error) {
  const match = /\b(4\d\d)\b/.exec(error.message || '')
  if (!match) return false
  const status = Number(match[1])
  return status !== 429
}

/**
 * Re-export validateWebhookUrl from delivery module for backward compatibility
 * (same pattern as delivery-limits re-exporting from wikidata-claim-watch).
 * @see lib/delivery.js
 */
const { validateWebhookUrl, ALLOWED_WEBHOOK_HOSTS } = delivery

async function postSummary(webhookUrl, missed) {
  const body = {
    embeds: [{
      description:
        `…and ${missed} more edit${missed === 1 ? '' : 's'} not shown (rate cap). ` +
        'If this keeps happening, the region this bot watches is probably too big.',
      color: NOTICE_COLOR
    }],
    // Matches lib/discord-platform.js. The text is static today so nothing
    // could ping - but Phase 9's auto-naming will make these messages carry
    // user-supplied region names, and a guard added only after that is a guard
    // added too late.
    allowed_mentions: { parse: [] }
  }

  // new URL rather than string concatenation, matching lib/discord-platform.js
  // - a stored webhook that already carries a query string would otherwise
  // produce "...?x=1?wait=true".
  const url = new URL(webhookUrl)
  url.searchParams.set('wait', 'true')

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
}

/**
 * @param {Object} subscription - from store.subscriptionsForTopic()
 * @param {Object} payload - {text, screenshot, metadata}
 * @param {Object} [options]
 * @param {Object} [options.limiter] - a SubscriptionLimiter
 * @returns {Promise<{ok, capped, subscriptionId, type?, postId?, messageId?, error?, permanent?}>}
 */
async function deliver(subscription, payload, options = {}) {
  const { limiter = null } = options

  if (subscription.deliveryType !== 'discord') {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: `unsupported delivery type "${subscription.deliveryType}"`,
      permanent: true
    }
  }

  const webhookUrl = subscription.deliveryConfig && subscription.deliveryConfig.webhook_url
  if (!webhookUrl) {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: 'subscription has no webhook_url',
      permanent: true
    }
  }

  // Re-validate at delivery, not only at insert. A row can be written by a
  // future code path, by a migration, or by hand; the process that actually
  // makes the request is the only place the check cannot be bypassed.
  const validation = validateWebhookUrl(webhookUrl)
  if (!validation.valid) {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: `refusing webhook: ${validation.reason}`,
      permanent: true
    }
  }

  if (limiter) {
    // Drain first: if the window just rolled over, the subscriber should learn
    // what they missed before the next post lands on top of it.
    const missed = limiter.drainSuppressed(subscription.id)
    if (missed > 0) {
      try {
        await postSummary(webhookUrl, missed)
      } catch (error) {
        console.error(
          `Rate-cap summary failed for subscription ${subscription.id}:`, error.message)
      }
    }

    if (!limiter.tryTake(subscription.id)) {
      // Capped is not an error. The subscriber asked for too much; they get a
      // summary when the window rolls over.
      return { ok: false, capped: true, subscriptionId: subscription.id }
    }
  }

  try {
    const result = await delivery.post(
      {
        type: 'discord',
        credentials: { webhook_url: webhookUrl },
        subscriptionId: subscription.id
      },
      payload
    )

    if (result === null) {
      // Defensive: webhook was already validated above, but delivery.post can also
      // validate and reject (e.g. if allowlist changes). Treat as permanent failure.
      return {
        ok: false,
        capped: false,
        subscriptionId: subscription.id,
        error: 'webhook validation failed during delivery',
        permanent: true
      }
    }

    return {
      ok: true,
      capped: false,
      subscriptionId: subscription.id,
      type: result.type,
      postId: result.postId,
      messageId: result.postId  // For backward compatibility
    }
  } catch (error) {
    return {
      ok: false,
      capped: false,
      subscriptionId: subscription.id,
      error: error.message,
      permanent: isPermanentFailure(error)
    }
  }
}

/**
 * Deliver to every subscription. One failure never blocks the others - a dead
 * webhook belonging to one subscriber must not silence everyone else's bot.
 *
 * @returns {Promise<Array>} one result per subscription
 */
async function deliverAll(subscriptions, payload, options = {}) {
  const results = []
  for (const subscription of subscriptions) {
    results.push(await deliver(subscription, payload, options))
  }
  return results
}

module.exports = {
  deliver,
  deliverAll,
  validateWebhookUrl,
  isPermanentFailure,
  ALLOWED_WEBHOOK_HOSTS,
  FAILURES_BEFORE_BROKEN
}
