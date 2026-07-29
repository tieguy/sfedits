const { assert } = require('chai')
const { describe, it } = require('mocha')

const { RateCap, SubscriptionLimiter } = require('../lib/delivery-limits')

describe('delivery-limits', function() {
  this.timeout(5000)

  describe('RateCap', function() {
    it('allows up to max within the window', function() {
      let now = 1000
      const cap = new RateCap({ max: 2, windowMs: 60000, now: () => now })

      assert.isTrue(cap.tryTake())
      assert.isTrue(cap.tryTake())
      assert.isFalse(cap.tryTake())
    })

    it('allows again once the window rolls over', function() {
      let now = 1000
      const cap = new RateCap({ max: 1, windowMs: 60000, now: () => now })

      assert.isTrue(cap.tryTake())
      assert.isFalse(cap.tryTake())

      now += 60001
      assert.isTrue(cap.tryTake())
    })

    it('reports suppressed count only after the window rolls over', function() {
      let now = 1000
      const cap = new RateCap({ max: 1, windowMs: 60000, now: () => now })

      cap.tryTake()
      cap.tryTake()
      cap.tryTake()

      assert.equal(cap.drainSuppressed(), 0, 'window still open')

      now += 60001
      assert.equal(cap.drainSuppressed(), 2)
      assert.equal(cap.drainSuppressed(), 0, 'draining resets the counter')
    })
  })

  describe('SubscriptionLimiter', function() {
    it('caps each subscription independently', function() {
      let now = 1000
      const limiter = new SubscriptionLimiter({
        max: 1, windowMs: 60000, now: () => now
      })

      assert.isTrue(limiter.tryTake(1))
      assert.isFalse(limiter.tryTake(1))
      assert.isTrue(limiter.tryTake(2), 'a busy subscription must not cap a quiet one')
    })

    it('drains each subscription separately', function() {
      let now = 1000
      const limiter = new SubscriptionLimiter({ max: 1, windowMs: 60000, now: () => now })

      limiter.tryTake(1)
      limiter.tryTake(1)
      limiter.tryTake(1)
      limiter.tryTake(2)

      now += 60001

      assert.equal(limiter.drainSuppressed(1), 2)
      assert.equal(limiter.drainSuppressed(2), 0)
    })

    it('forgets subscriptions that have gone quiet', function() {
      let now = 1000
      const limiter = new SubscriptionLimiter({ max: 5, windowMs: 60000, now: () => now })

      limiter.tryTake(1)
      assert.equal(limiter.size(), 1)

      now += 60001 * 3
      limiter.prune()

      assert.equal(limiter.size(), 0,
        'a limiter that never forgets is a memory leak once bots come and go')
    })
  })
})
