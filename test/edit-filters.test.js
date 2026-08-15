const { describe, it } = require('mocha')
const { assert } = require('chai')
const { normalizeEditFilters, passesMetadata, needsContentCheck, isCosmeticOnly, passesContent, needsSignificanceCheck, significanceDropReason } = require('../lib/edit-filters')

describe('edit-filters', function() {

  describe('normalizeEditFilters', function() {
    it('fills defaults for null/undefined/empty filters', function() {
      assert.deepEqual(normalizeEditFilters(null), { bots: true, minor: true, min_delta: 0, cosmetic_only: false, substantive_only: false, substantive_channels: null })
      assert.deepEqual(normalizeEditFilters(undefined), { bots: true, minor: true, min_delta: 0, cosmetic_only: false, substantive_only: false, substantive_channels: null })
      assert.deepEqual(normalizeEditFilters({}), { bots: true, minor: true, min_delta: 0, cosmetic_only: false, substantive_only: false, substantive_channels: null })
    })

    it('ignores unknown keys', function() {
      const result = normalizeEditFilters({ bots: true, unknown_key: 'ignored', min_delta: 50 })
      assert.deepEqual(result, { bots: true, minor: true, min_delta: 50, cosmetic_only: false, substantive_only: false, substantive_channels: null })
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

    it('coerces min_delta from string numbers (JSON/DB)', function() {
      assert.equal(normalizeEditFilters({ min_delta: '100' }).min_delta, 100)
      assert.equal(normalizeEditFilters({ min_delta: '50' }).min_delta, 50)
      assert.equal(normalizeEditFilters({ min_delta: '0' }).min_delta, 0)
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
      const html = loadFixture('template-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns true for category-only changes', function() {
      const html = loadFixture('category-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns true for ref-only changes', function() {
      const html = loadFixture('ref-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns true for whitespace-only changes', function() {
      const html = loadFixture('whitespace-only.html')
      assert.isTrue(isCosmeticOnly(html))
    })

    it('returns false for prose changes', function() {
      const html = loadFixture('prose.html')
      assert.isFalse(isCosmeticOnly(html))
    })

    it('returns false for mixed template+prose changes', function() {
      const html = loadFixture('mixed.html')
      assert.isFalse(isCosmeticOnly(html))
    })

    it('returns false for empty string', function() {
      assert.isFalse(isCosmeticOnly(''))
    })

    it('returns false for malformed HTML', function() {
      assert.isFalse(isCosmeticOnly('<div>not a diff table</div>'))
    })

    it('returns false for HTML with no recognizable diff rows', function() {
      const html = '<table class="diff"><tr><td>no diff markers</td></tr></table>'
      assert.isFalse(isCosmeticOnly(html))
    })

    it('returns false when del-prose + template residue (regression: CRITICAL fix)', function() {
      // e.g. <del>He was widely criticised…</del>{{reflist}}
      // After unwrapping del (not discarding), should be: "He was widely criticised…{{reflist}}" NOT cosmetic
      const html = '<table class="diff"><tr><td class="diff-deletedline"><div><del class="diffchange diffchange-inline">He was widely criticised…</del>{{reflist}}</div></td></tr></table>'
      assert.isFalse(isCosmeticOnly(html), 'Should not be cosmetic: has prose + template')
    })

    it('returns false when del-prose + category link residue (regression: CRITICAL fix)', function() {
      // e.g. <del>Some description</del>[[Category:People]]
      // After unwrapping del, should be: "Some description[[Category:People]]" NOT cosmetic
      const html = '<table class="diff"><tr><td class="diff-deletedline"><div><del class="diffchange">Some description</del>[[Category:People]]</div></td></tr></table>'
      assert.isFalse(isCosmeticOnly(html), 'Should not be cosmetic: has prose + category')
    })

    it('returns false when cell content is entirely del-wrapped prose (regression: CRITICAL fix)', function() {
      // Entire line is prose wrapped in del: <del>Full sentence deleted.</del>
      // After unwrapping, should be: "Full sentence deleted." NOT cosmetic
      const html = '<table class="diff"><tr><td class="diff-deletedline"><div><del class="diffchange diffchange-inline">Full sentence deleted.</del></div></td></tr></table>'
      assert.isFalse(isCosmeticOnly(html), 'Should not be cosmetic: has prose content')
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
      const html = loadFixture('prose.html')
      assert.isTrue(passesContent(html, { cosmetic_only: false }))
      assert.isTrue(passesContent(html, {}))
      assert.isTrue(passesContent(html, null))
    })

    it('short-circuits without parsing when cosmetic_only is false', function() {
      // When cosmetic_only is false, passesContent should return true immediately
      // without calling isCosmeticOnly. Use template-only.html: if short-circuit
      // is removed, isCosmeticOnly(template) returns true, making passesContent false (test fails).
      const templateHtml = loadFixture('template-only.html')
      assert.isTrue(passesContent(templateHtml, { cosmetic_only: false }))
    })

    it('drops cosmetic-only diffs when cosmetic_only: true', function() {
      const templateHtml = loadFixture('template-only.html')
      const categoryHtml = loadFixture('category-only.html')
      assert.isFalse(passesContent(templateHtml, { cosmetic_only: true }))
      assert.isFalse(passesContent(categoryHtml, { cosmetic_only: true }))
    })

    it('passes prose diffs when cosmetic_only: true', function() {
      const proseHtml = loadFixture('prose.html')
      assert.isTrue(passesContent(proseHtml, { cosmetic_only: true }))
    })
  })

  describe('metadataDropReason', function() {
    const { metadataDropReason } = require('../lib/edit-filters')

    it('returns "bot" when bots: false and robot: true', function() {
      const edit = { robot: true, minor: false, delta: 100 }
      const filters = { bots: false }
      assert.equal(metadataDropReason(edit, filters), 'bot')
    })

    it('returns "min_delta" when min_delta exceeds delta (robot is irrelevant)', function() {
      const edit = { robot: true, minor: false, delta: 12 }
      const filters = { min_delta: 500 }
      assert.equal(metadataDropReason(edit, filters), 'min_delta')
    })

    it('returns "minor" when minor: false and minor: true', function() {
      const edit = { robot: false, minor: true, delta: 100 }
      const filters = { minor: false }
      assert.equal(metadataDropReason(edit, filters), 'minor')
    })

    it('returns null when edit passes all filters', function() {
      const edit = { robot: false, minor: false, delta: 100 }
      const filters = { bots: true, minor: true, min_delta: 50 }
      assert.isNull(metadataDropReason(edit, filters))
    })
  })

  describe('substantive_only normalization and decisions', function () {
    it('defaults substantive_only to false and substantive_channels to null', function () {
      const f = normalizeEditFilters({})
      assert.equal(f.substantive_only, false)
      assert.isNull(f.substantive_channels)
    })

    it('normalizes the three states and rejects junk values', function () {
      assert.equal(normalizeEditFilters({ substantive_only: true }).substantive_only, true)
      assert.equal(normalizeEditFilters({ substantive_only: 'log' }).substantive_only, 'log')
      assert.equal(normalizeEditFilters({ substantive_only: 'yes' }).substantive_only, false)
      assert.equal(normalizeEditFilters({ substantive_only: 1 }).substantive_only, false)
    })

    it('passes substantive_channels through as an object, else null', function () {
      const f = normalizeEditFilters({ substantive_channels: { references: 'ignored' } })
      assert.deepEqual(f.substantive_channels, { references: 'ignored' })
      assert.isNull(normalizeEditFilters({ substantive_channels: 'prose' }).substantive_channels)
    })

    it('drops invalid channel policy values during normalization', function () {
      const f = normalizeEditFilters({ substantive_channels: { prose: 'subtantive', references: 'ignored' } })
      assert.deepEqual(f.substantive_channels, { references: 'ignored' })
      assert.isNull(normalizeEditFilters({ substantive_channels: { prose: 'junk' } }).substantive_channels)
    })

    it('needsSignificanceCheck is true for log and true, false otherwise', function () {
      assert.isFalse(needsSignificanceCheck(null))
      assert.isFalse(needsSignificanceCheck({ substantive_only: false }))
      assert.isTrue(needsSignificanceCheck({ substantive_only: 'log' }))
      assert.isTrue(needsSignificanceCheck({ substantive_only: true }))
    })

    it('significanceDropReason drops only enforcing consumers on a non-substantive verdict', function () {
      const verdict = { substantive: false, reasons: [], ignored: ['template-bag'] }
      assert.isNull(significanceDropReason(verdict, { substantive_only: false }))
      assert.isNull(significanceDropReason(verdict, { substantive_only: 'log' }))
      assert.equal(significanceDropReason(verdict, { substantive_only: true }),
        'substantive_only: template-bag')
    })

    it('significanceDropReason never drops on substantive, fallback, or missing verdicts', function () {
      assert.isNull(significanceDropReason({ substantive: true, reasons: ['prose'], ignored: [] },
        { substantive_only: true }))
      assert.isNull(significanceDropReason(
        { substantive: true, reasons: [], ignored: [], fallback: 'missing-content' },
        { substantive_only: true }))
      // Defense-in-depth clause, tested non-vacuously: a (contract-violating)
      // fallback verdict with substantive:false must STILL never drop — the
      // fallback check cannot be absorbed by the substantive check.
      assert.isNull(significanceDropReason(
        { substantive: false, reasons: [], ignored: ['template-bag'], fallback: 'parse-error' },
        { substantive_only: true }))
      assert.isNull(significanceDropReason(null, { substantive_only: true }))
    })

    it('significanceDropReason is robust when verdict lacks ignored field', function () {
      // Malformed verdict missing the ignored field should not throw
      const malformedVerdict = { substantive: false, reasons: ['template-bag'] }
      assert.equal(significanceDropReason(malformedVerdict, { substantive_only: true }),
        'substantive_only: no-change')
    })
  })
})
