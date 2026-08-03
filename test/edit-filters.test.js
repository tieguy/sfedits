const { describe, it } = require('mocha')
const { assert } = require('chai')
const { normalizeEditFilters, passesMetadata, needsContentCheck } = require('../lib/edit-filters')

describe('edit-filters', function() {

  describe('normalizeEditFilters', function() {
    it('fills defaults for null/undefined/empty filters', function() {
      assert.deepEqual(normalizeEditFilters(null), { bots: true, minor: true, min_delta: 0, cosmetic_only: false })
      assert.deepEqual(normalizeEditFilters(undefined), { bots: true, minor: true, min_delta: 0, cosmetic_only: false })
      assert.deepEqual(normalizeEditFilters({}), { bots: true, minor: true, min_delta: 0, cosmetic_only: false })
    })

    it('ignores unknown keys', function() {
      const result = normalizeEditFilters({ bots: true, unknown_key: 'ignored', min_delta: 50 })
      assert.deepEqual(result, { bots: true, minor: true, min_delta: 50, cosmetic_only: false })
    })

    it('respects bots: false to drop bots', function() {
      assert.isFalse(normalizeEditFilters({ bots: false }).bots)
      assert.isTrue(normalizeEditFilters({ bots: true }).bots)
      assert.isTrue(normalizeEditFilters({}).bots)
    })

    it('respects minor: false to drop minor edits', function() {
      assert.isFalse(normalizeEditFilters({ minor: false }).minor)
      assert.isTrue(normalizeEditFilters({ minor: true }).minor)
      assert.isTrue(normalizeEditFilters({}).minor)
    })

    it('normalizes min_delta as a non-negative number', function() {
      assert.equal(normalizeEditFilters({ min_delta: 100 }).min_delta, 100)
      assert.equal(normalizeEditFilters({ min_delta: 0 }).min_delta, 0)
      assert.equal(normalizeEditFilters({ min_delta: -50 }).min_delta, 0)
      assert.equal(normalizeEditFilters({ min_delta: null }).min_delta, 0)
      assert.equal(normalizeEditFilters({ min_delta: 'not a number' }).min_delta, 0)
      assert.equal(normalizeEditFilters({}).min_delta, 0)
    })

    it('respects cosmetic_only: true to opt in', function() {
      assert.isTrue(normalizeEditFilters({ cosmetic_only: true }).cosmetic_only)
      assert.isFalse(normalizeEditFilters({ cosmetic_only: false }).cosmetic_only)
      assert.isFalse(normalizeEditFilters({}).cosmetic_only)
    })
  })

  describe('passesMetadata', function() {
    const baseEdit = {
      page: 'Test',
      user: 'TestUser',
      robot: false,
      minor: false,
      delta: 100
    }

    it('passes null/undefined/empty filters', function() {
      assert.isTrue(passesMetadata(baseEdit, null))
      assert.isTrue(passesMetadata(baseEdit, undefined))
      assert.isTrue(passesMetadata(baseEdit, {}))
    })

    it('drops robot edits when bots: false', function() {
      assert.isFalse(passesMetadata({ ...baseEdit, robot: true }, { bots: false }))
      assert.isTrue(passesMetadata({ ...baseEdit, robot: false }, { bots: false }))
      assert.isTrue(passesMetadata({ ...baseEdit, robot: true }, { bots: true }))
    })

    it('drops minor edits when minor: false', function() {
      assert.isFalse(passesMetadata({ ...baseEdit, minor: true }, { minor: false }))
      assert.isTrue(passesMetadata({ ...baseEdit, minor: false }, { minor: false }))
      assert.isTrue(passesMetadata({ ...baseEdit, minor: true }, { minor: true }))
    })

    it('drops small deltas when min_delta is set', function() {
      assert.isFalse(passesMetadata({ ...baseEdit, delta: 50 }, { min_delta: 100 }))
      assert.isFalse(passesMetadata({ ...baseEdit, delta: -50 }, { min_delta: 100 }))
      assert.isTrue(passesMetadata({ ...baseEdit, delta: 100 }, { min_delta: 100 }))
      assert.isTrue(passesMetadata({ ...baseEdit, delta: 150 }, { min_delta: 100 }))
      assert.isTrue(passesMetadata({ ...baseEdit, delta: -150 }, { min_delta: 100 }))
    })

    it('passes unknown delta sizes (null/undefined)', function() {
      assert.isTrue(passesMetadata({ ...baseEdit, delta: null }, { min_delta: 100 }))
      assert.isTrue(passesMetadata({ ...baseEdit, delta: undefined }, { min_delta: 100 }))
    })

    it('combines filters with AND logic', function() {
      const filters = { bots: false, minor: false, min_delta: 50 }
      assert.isFalse(passesMetadata({ ...baseEdit, robot: true, minor: false, delta: 100 }, filters))
      assert.isFalse(passesMetadata({ ...baseEdit, robot: false, minor: true, delta: 100 }, filters))
      assert.isFalse(passesMetadata({ ...baseEdit, robot: false, minor: false, delta: 25 }, filters))
      assert.isTrue(passesMetadata({ ...baseEdit, robot: false, minor: false, delta: 100 }, filters))
    })
  })

  describe('needsContentCheck', function() {
    it('returns true when cosmetic_only is true', function() {
      assert.isTrue(needsContentCheck({ cosmetic_only: true }))
    })

    it('returns false when cosmetic_only is false or absent', function() {
      assert.isFalse(needsContentCheck({ cosmetic_only: false }))
      assert.isFalse(needsContentCheck({}))
      assert.isFalse(needsContentCheck(null))
    })
  })

  describe('isCosmeticOnly', function() {
    const fs = require('fs')
    const path = require('path')

    function loadFixture(filename) {
      const filepath = path.join(__dirname, 'fixtures/diff-html', filename)
      return fs.readFileSync(filepath, 'utf-8')
    }

    it('returns true for template-only changes', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = loadFixture('template-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns true for category-only changes', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = loadFixture('category-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns true for ref-only changes', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = loadFixture('ref-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns true for whitespace-only changes', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = loadFixture('whitespace-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns false for prose changes', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = loadFixture('prose.html')
      assert.isFalse(isCosmeticOnly(html))
    })

    it('returns false for mixed template+prose changes', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = loadFixture('mixed.html')
      assert.isFalse(isCosmeticOnly(html))
    })

    it('returns false for empty string', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      assert.isFalse(isCosmeticOnly(''))
    })

    it('returns false for malformed HTML', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      assert.isFalse(isCosmeticOnly('<div>not a diff table</div>'))
    })

    it('returns false for HTML with no recognizable diff rows', function() {
      const { isCosmeticOnly } = require('../lib/edit-filters')
      const html = '<table class="diff"><tr><td>no diff markers</td></tr></table>'
      assert.isFalse(isCosmeticOnly(html))
    })
  })

  describe('passesContent', function() {
    const fs = require('fs')
    const path = require('path')

    function loadFixture(filename) {
      const filepath = path.join(__dirname, 'fixtures/diff-html', filename)
      return fs.readFileSync(filepath, 'utf-8')
    }

    it('always passes when cosmetic_only is false or absent', function() {
      const { passesContent } = require('../lib/edit-filters')
      const html = loadFixture('prose.html')
      assert.isTrue(passesContent(html, { cosmetic_only: false }))
      assert.isTrue(passesContent(html, {}))
      assert.isTrue(passesContent(html, null))
    })

    it('does not parse HTML when cosmetic_only is false', function() {
      const { passesContent } = require('../lib/edit-filters')
      // Pass null to prove it doesn't try to parse
      assert.isTrue(passesContent(null, { cosmetic_only: false }))
      assert.isTrue(passesContent(null, {}))
    })

    it('drops cosmetic-only diffs when cosmetic_only: true', function() {
      const { passesContent } = require('../lib/edit-filters')
      const templateHtml = loadFixture('template-only.html')
      const categoryHtml = loadFixture('category-only.html')
      assert.isFalse(passesContent(templateHtml, { cosmetic_only: true }))
      assert.isFalse(passesContent(categoryHtml, { cosmetic_only: true }))
    })

    it('passes prose diffs when cosmetic_only: true', function() {
      const { passesContent } = require('../lib/edit-filters')
      const proseHtml = loadFixture('prose.html')
      assert.isTrue(passesContent(proseHtml, { cosmetic_only: true }))
    })
  })
})
