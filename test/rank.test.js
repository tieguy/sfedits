const { assert } = require('chai')
const { parseArgs, DEFAULTS, LIVE_IMPORTANCE, cuts } = require('../scripts/rank')

describe('rank', function() {
  describe('LIVE_IMPORTANCE', function() {
    // The added/dropped diff in the report is only meaningful if it is measured
    // against what the bot actually watches. It ran Top+High+Mid (2,455
    // articles) while the report claimed a Top+High baseline of 506, which
    // understated the change by an order of magnitude.
    it('matches the importance filter the deployed bot uses', function() {
      assert.deepEqual(LIVE_IMPORTANCE, ['top', 'high', 'mid'])
    })
  })

  describe('cuts', function() {
    it('produces a narrow and a wide list from one ranking', function() {
      const ranked = Array.from({ length: 10 }, (_, i) => ({ title: `A${i}` }))

      const result = cuts(ranked, { watchlist: 3, wide: 6 })

      assert.deepEqual(result.narrow.map(r => r.title), ['A0', 'A1', 'A2'])
      assert.deepEqual(result.wide.map(r => r.title), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'])
    })

    it('makes the narrow list a strict prefix of the wide one', function() {
      const ranked = Array.from({ length: 10 }, (_, i) => ({ title: `A${i}` }))

      const { narrow, wide } = cuts(ranked, { watchlist: 3, wide: 6 })

      assert.deepEqual(narrow, wide.slice(0, narrow.length))
    })

    it('does not overrun a ranking shorter than the cut', function() {
      const ranked = [{ title: 'Only' }]

      const { narrow, wide } = cuts(ranked, { watchlist: 500, wide: 2500 })

      assert.equal(narrow.length, 1)
      assert.equal(wide.length, 1)
    })
  })

  describe('parseArgs', function() {
    it('accepts a --wide cut for the published wide list', function() {
      assert.equal(parseArgs([]).wide, 2500)
      assert.equal(parseArgs(['--wide', '1500']).wide, 1500)
    })

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
