const { assert } = require('chai')
const { describe, it } = require('mocha')

const { normalizeFilters, filtersHash } = require('../lib/topic-store')

describe('topic-store', function() {
  describe('normalizeFilters', function() {
    it('sorts and lowercases languages', function() {
      const normalized = normalizeFilters({ languages: ['ES', 'en', 'de'] })
      assert.deepEqual(normalized.languages, ['de', 'en', 'es'])
    })

    it('sorts entity filters', function() {
      const normalized = normalizeFilters({ entityFilters: ['Q5', 'Q515', 'Q43229'] })
      assert.deepEqual(normalized.entityFilters, ['Q43229', 'Q5', 'Q515'])
    })

    it('drops duplicates', function() {
      const normalized = normalizeFilters({
        languages: ['en', 'en', 'es'],
        entityFilters: ['Q5', 'Q5']
      })
      assert.deepEqual(normalized.languages, ['en', 'es'])
      assert.deepEqual(normalized.entityFilters, ['Q5'])
    })

    it('represents "no filter" as null, not an empty array', function() {
      const normalized = normalizeFilters({})
      assert.isNull(normalized.languages)
      assert.isNull(normalized.entityFilters)
    })

    it('treats an empty array as no filter', function() {
      const normalized = normalizeFilters({ languages: [], entityFilters: [] })
      assert.isNull(normalized.languages)
      assert.isNull(normalized.entityFilters)
    })

    it('defaults strategy to auto', function() {
      assert.equal(normalizeFilters({}).strategy, 'auto')
      assert.equal(normalizeFilters({ strategy: 'admin' }).strategy, 'admin')
    })
  })

  describe('filtersHash', function() {
    it('collides for the same selection in a different order', function() {
      const a = filtersHash({ languages: ['en', 'es'], entityFilters: ['Q5', 'Q515'] })
      const b = filtersHash({ languages: ['es', 'en'], entityFilters: ['Q515', 'Q5'] })
      assert.equal(a, b)
    })

    it('differs when the selection differs', function() {
      const a = filtersHash({ languages: ['en'] })
      const b = filtersHash({ languages: ['en', 'es'] })
      assert.notEqual(a, b)
    })

    it('differs when the strategy differs', function() {
      assert.notEqual(
        filtersHash({ languages: ['en'], strategy: 'admin' }),
        filtersHash({ languages: ['en'], strategy: 'geo' }))
    })

    it('is a 64-character hex digest', function() {
      assert.match(filtersHash({ languages: ['en'] }), /^[0-9a-f]{64}$/)
    })
  })
})
