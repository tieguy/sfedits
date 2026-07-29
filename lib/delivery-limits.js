/**
 * Post-rate limiting.
 *
 * RateCap is moved here verbatim from lib/wikidata-claim-watch.js, where it
 * was written to stop a QuickStatements bulk import from firing a hundred
 * Discord posts in a minute. The same shape solves the self-serve problem:
 * a subscriber who picks a region far bigger than they meant to should get a
 * notice, not a firehose.
 *
 * SubscriptionLimiter is the per-subscription fleet of caps. Each subscription
 * gets its own window, so one oversized bot cannot silence a well-sized one
 * that happens to share the process.
 */

/**
 * Sliding-window rate cap. Posts beyond `max` per window are suppressed and
 * counted; drainSuppressed() returns and resets the count once the window
 * has rolled over (the caller turns it into a "+N more" summary post).
 */
class RateCap {
  constructor({ max, windowMs, now = Date.now } = {}) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
    this.stamps = []
    this.suppressed = 0
  }

  _prune() {
    const cutoff = this.now() - this.windowMs
    this.stamps = this.stamps.filter(t => t > cutoff)
  }

  tryTake() {
    this._prune()
    if (this.stamps.length >= this.max) {
      this.suppressed++
      return false
    }
    this.stamps.push(this.now())
    return true
  }

  /** Suppressed count if the window has rolled over, resetting it; else 0 */
  drainSuppressed() {
    this._prune()
    if (this.stamps.length === 0 && this.suppressed > 0) {
      const n = this.suppressed
      this.suppressed = 0
      return n
    }
    return 0
  }

  /** True when this cap holds no state worth keeping. */
  isIdle() {
    this._prune()
    return this.stamps.length === 0 && this.suppressed === 0
  }
}

const DEFAULT_MAX = 20
const DEFAULT_WINDOW_MS = 60 * 60 * 1000

/**
 * One RateCap per subscription id.
 *
 * Caps are created lazily and pruned when idle - subscriptions come and go on
 * a self-serve platform, and a map that only ever grows is a slow leak in a
 * process meant to run for months.
 */
class SubscriptionLimiter {
  constructor({ max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
    this.caps = new Map()
  }

  _capFor(subscriptionId) {
    let cap = this.caps.get(subscriptionId)
    if (!cap) {
      cap = new RateCap({ max: this.max, windowMs: this.windowMs, now: this.now })
      this.caps.set(subscriptionId, cap)
    }
    return cap
  }

  tryTake(subscriptionId) {
    return this._capFor(subscriptionId).tryTake()
  }

  drainSuppressed(subscriptionId) {
    const cap = this.caps.get(subscriptionId)
    return cap ? cap.drainSuppressed() : 0
  }

  /** Drop caps holding no state. */
  prune() {
    for (const [id, cap] of this.caps) {
      if (cap.isIdle()) this.caps.delete(id)
    }
  }

  size() {
    return this.caps.size
  }
}

module.exports = {
  RateCap,
  SubscriptionLimiter,
  DEFAULT_MAX,
  DEFAULT_WINDOW_MS
}
