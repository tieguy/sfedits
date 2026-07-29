/**
 * Deliver one already-rendered post to one subscription.
 *
 * The render happens once per edit, upstream of this. That is the entire
 * operational payoff of deduplicating on topic: 500 people subscribed to the
 * Mission means one diff render and 500 cheap posts, not 500 renders.
 *
 * Phase 4 supports Discord webhooks only, which need no OAuth plumbing - just
 * a POST to a URL the subscriber pasted in.
 */

const discord = require('./discord-platform')

/**
 * @param {Object} subscription - from store.subscriptionsForTopic()
 * @param {Object} payload
 * @param {string} payload.text
 * @param {string} payload.screenshot - path to the rendered PNG
 * @param {Object} payload.metadata
 * @returns {Promise<{ok: boolean, subscriptionId: number, messageId?: string, error?: string}>}
 */
async function deliver(subscription, payload) {
  if (subscription.deliveryType !== 'discord') {
    return {
      ok: false,
      subscriptionId: subscription.id,
      error: `unsupported delivery type "${subscription.deliveryType}"`
    }
  }

  const webhookUrl = subscription.deliveryConfig && subscription.deliveryConfig.webhook_url
  if (!webhookUrl) {
    return {
      ok: false,
      subscriptionId: subscription.id,
      error: 'subscription has no webhook_url'
    }
  }

  try {
    const result = await discord.post({
      account: { webhook_url: webhookUrl },
      text: payload.text,
      screenshot: payload.screenshot,
      metadata: payload.metadata
    })
    return { ok: true, subscriptionId: subscription.id, messageId: (result && result.id) || null }
  } catch (error) {
    return { ok: false, subscriptionId: subscription.id, error: error.message }
  }
}

/**
 * Deliver to every subscription. One failure never blocks the others - a dead
 * webhook belonging to one subscriber must not silence everyone else's bot.
 *
 * @returns {Promise<Array>} one result per subscription
 */
async function deliverAll(subscriptions, payload) {
  const results = []
  for (const subscription of subscriptions) {
    results.push(await deliver(subscription, payload))
  }
  return results
}

module.exports = { deliver, deliverAll }
