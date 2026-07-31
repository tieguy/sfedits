const { assert } = require('chai')
const { parseArgs, DEFAULTS } = require('../scripts/rank')

describe('rank', function() {
  describe('parseArgs', function() {
    it('defaults to the proposed tier cuts', function() {
      assert.deepEqual(parseArgs([]), DEFAULTS)
    })

    it('overrides a single option', function() {
      assert.equal(parseArgs(['--watchlist', '2500']).watchlist, 2500)
      assert.equal(parseArgs(['--top', '0.005']).top, 0.005)
    })

    it('rejects an unknown option rather than silently ignoring it', function() {
      assert.throws(() => parseArgs(['--nope', '1']), /unknown option/)
    })

    it('rejects a non-numeric value', function() {
      assert.throws(() => parseArgs(['--watchlist', 'lots']), /bad value/)
    })
  })
})
