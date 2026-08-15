const { assert } = require('chai')
const { describe, it } = require('mocha')

const { candidateQuery, PROPERTIES } = require('../scripts/reassess-untagged')
const { memberPattern } = require('../lib/region')

describe('reassess-untagged', function() {
  describe('candidateQuery', function() {
    it('composes the located-in query from the shared membership pattern', function() {
      const query = candidateQuery('P131', 'Q62')
      assert.include(query, memberPattern('P131', 'Q62'))
      assert.include(query, 'SELECT DISTINCT ?item ?title')
      assert.include(query, 'schema:isPartOf <https://en.wikipedia.org/>')
    })

    it('composes pointer-property queries from the shared membership pattern', function() {
      const query = candidateQuery('P937', 'Q62')
      assert.include(query, memberPattern('P937', 'Q62'))
    })

    it('composes the office-holder query from the shared membership pattern', function() {
      const query = candidateQuery('P39', 'Q62')
      assert.include(query, memberPattern('P39', 'Q62'))
    })

    it('rejects an invalid county QID before querying', function() {
      assert.throws(() => candidateQuery('P131', 'Q0abc'), /QID/)
    })

    it('keeps the deliberately wider tagging-candidate property set', function() {
      // Born/died/worked-here are excluded from watchlist membership
      // (lib/region IS_HERE_PROPERTIES) but kept here: as a one-time
      // tagging-candidate list, noise just means a human skims past.
      assert.deepEqual(PROPERTIES, ['P19', 'P20', 'P159', 'P276', 'P937'])
    })
  })
})
