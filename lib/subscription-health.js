/**
 * Consecutive-failure tracking for subscription delivery.
 *
 * A webhook a subscriber deleted will fail on every single matching edit,
 * forever, and each failure costs a network round trip and a log line. After
 * enough consecutive permanent failures the subscription is quarantined so the
 * bot stops asking.
 *
 * Only PERMANENT failures count. Discord returning 500 for an hour is not the
 * subscriber's fault and must not disable a working bot; neither is being rate
 * capped, which is a deliberate outcome rather than a fault at all.
 *
 * Telling the subscriber their bot went quiet is deliberately NOT handled here
 * - see "Credential death" in the design plan's deferred section. Quarantine
 * stops the waste; notification needs its own thinking, because a bot that
 * edits user talk pages is itself subject to bot-editing norms.
 */

const { FAILURES_BEFORE_BROKEN } = require('./subscription-delivery')

function createHealthTracker({ threshold = FAILURES_BEFORE_BROKEN } = {}) {
  const streaks = new Map()

  /**
   * Record a delivery result.
   * @returns {boolean} true when this result crosses the quarantine threshold
   */
  function record(subscriptionId, result) {
    if (result.capped) return false

    if (result.ok) {
      streaks.delete(subscriptionId)
      return false
    }

    if (!result.permanent) return false

    const streak = (streaks.get(subscriptionId) || 0) + 1
    streaks.set(subscriptionId, streak)

    if (streak >= threshold) {
      streaks.delete(subscriptionId)
      return true
    }
    return false
  }

  function reset(subscriptionId) {
    streaks.delete(subscriptionId)
  }

  return { record, reset, size: () => streaks.size }
}

module.exports = { createHealthTracker }
