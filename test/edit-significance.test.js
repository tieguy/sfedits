const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')

const { classifyEdit, extractChannels, DEFAULT_CHANNELS, MAX_INPUT_CHARS } = require('../lib/edit-significance')

function loadPair(name, beforeName = 'base') {
  const dir = path.join(__dirname, 'fixtures/wikitext-pairs')
  return {
    before: fs.readFileSync(path.join(dir, `${beforeName}.before.txt`), 'utf-8'),
    after: fs.readFileSync(path.join(dir, `${name}.after.txt`), 'utf-8')
  }
}

describe('edit-significance classifyEdit', function () {
  it('flags a prose change as substantive with reason "prose"', function () {
    const { before, after } = loadPair('prose-change')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'prose')
  })

  it('treats a whitespace-only edit as not substantive with no changed channels', function () {
    const { before, after } = loadPair('whitespace-only')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
    assert.deepEqual(v.ignored, [])
  })

  it('treats template-only churn as not substantive, ignored as template-bag', function () {
    const { before, after } = loadPair('template-only')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'template-bag')
  })

  it('flags an infobox value change as substantive with reason "infobox-values"', function () {
    const { before, after } = loadPair('infobox-value')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'infobox-values')
    assert.notInclude(v.reasons, 'prose')
  })

  it('treats a category-only edit as not substantive, ignored as categories', function () {
    const { before, after } = loadPair('category-only')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'categories')
  })

  it('treats a link retarget with unchanged rendered text as not substantive', function () {
    const { before, after } = loadPair('link-retarget')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'links')
  })

  it('treats a table-cell link retarget with unchanged rendered text as not substantive', function () {
    const { before, after } = loadPair('table-cell-link-retarget', 'table-cell-link-retarget')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'links')
  })

  it('treats an infobox link retarget with unchanged rendered text as not substantive', function () {
    const { before, after } = loadPair('infobox-link-retarget', 'infobox-link-retarget')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'links')
  })

  it('flags a table-cell value change (rendered text differs) as substantive', function () {
    const { before, after } = loadPair('table-cell', 'table-cell')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'tables')
  })

  it('flags an infobox value change (rendered text differs) as substantive', function () {
    const infoboxWikitext1 = '{{Infobox|x=Old value}}'
    const infoboxWikitext2 = '{{Infobox|x=New value}}'
    const v = classifyEdit(infoboxWikitext1, infoboxWikitext2)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'infobox-values')
  })

  it('flags an added reference as substantive with reason "references"', function () {
    const { before, after } = loadPair('ref-added')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'references')
  })

  it('returns not-substantive for identical revisions', function () {
    const { before } = loadPair('prose-change')
    const v = classifyEdit(before, before)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('flags a Spanish infobox value change (Ficha) as substantive', function () {
    const { before, after } = loadPair('es-infobox', 'es-infobox')
    const v = classifyEdit(before, after, { lang: 'es' })
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'infobox-values')
  })

  it('conservative-passes when either side is missing', function () {
    const v = classifyEdit('', 'some text')
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'missing-content')
  })

  it('conservative-passes oversize input without parsing', function () {
    const big = 'x'.repeat(MAX_INPUT_CHARS + 1)
    const v = classifyEdit(big, big)
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'input-too-large')
  })

  it('honors channel policy overrides', function () {
    const { before, after } = loadPair('ref-added')
    const v = classifyEdit(before, after, { channels: { references: 'ignored' } })
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'references')
  })

  it('exports the documented default channel policy', function () {
    assert.equal(DEFAULT_CHANNELS.prose, 'substantive')
    assert.equal(DEFAULT_CHANNELS['template-bag'], 'ignored')
  })

  // Revert symmetry (design: "reverts get no special casing"): a revert of a
  // visible change is itself visible; a revert of gnoming is itself gnoming.
  // classifyEdit takes no tags argument, so revert tags CANNOT influence the
  // verdict — these tests pin the content-only behavior in both directions.
  it('classifies a revert of a prose change as substantive', function () {
    const { before, after } = loadPair('prose-change')
    const v = classifyEdit(after, before) // reverted direction
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'prose')
  })

  it('classifies a revert of template churn as not substantive', function () {
    const { before, after } = loadPair('template-only')
    const v = classifyEdit(after, before) // reverted direction
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'template-bag')
  })

  it('conservative-passes with fallback parse-error when parsing throws', function () {
    const proxyquire = require('proxyquire')
    const { classifyEdit: classifyWithBrokenParser } = proxyquire('../lib/edit-significance', {
      wtf_wikipedia: () => { throw new Error('simulated parser failure') }
    })
    const v = classifyWithBrokenParser('some text', 'other text')
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'parse-error')
  })

  it('flags a media caption change as substantive with reason "media"', function () {
    const { before, after } = loadPair('media-caption', 'media-caption')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'media')
  })

  it('includes parse error message in fallback for offline validation', function () {
    const proxyquire = require('proxyquire')
    const { classifyEdit: classifyWithBrokenParser } = proxyquire('../lib/edit-significance', {
      wtf_wikipedia: () => { throw new Error('Parser broke for testing') }
    })
    const v = classifyWithBrokenParser('text', 'text')
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'parse-error')
    assert.equal(v.error, 'Parser broke for testing')
  })

  it('lang option does not change verdict (contract: currently inert)', function () {
    const { before, after } = loadPair('es-infobox', 'es-infobox')
    const withoutLang = classifyEdit(before, after)
    const withLang = classifyEdit(before, after, { lang: 'es' })
    // lang is reserved for future use but currently inert; both verdicts must be identical
    assert.equal(withoutLang.substantive, withLang.substantive)
    assert.deepEqual(withoutLang.reasons, withLang.reasons)
    assert.deepEqual(withoutLang.ignored, withLang.ignored)
  })

  it('flags an infobox parameter literally named "links" value change as substantive with reason "infobox-values"', function () {
    const { before, after } = loadPair('infobox-links-param', 'infobox-links-param')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'infobox-values')
  })

  it('flags a table column literally named "links" value change as substantive with reason "tables"', function () {
    const { before, after } = loadPair('table-links-column', 'table-links-column')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'tables')
  })

  it('flags swapped table order as substantive with reason "tables"', function () {
    const { before, after } = loadPair('tables-swapped', 'tables-swapped')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'tables')
  })

  it('flags swapped heading order as substantive with reason "headings"', function () {
    const { before, after } = loadPair('headings-swapped', 'headings-swapped')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'headings')
  })

  it('flags a table caption change as substantive with reason "tables"', function () {
    const { before, after } = loadPair('table-caption', 'table-caption')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'tables')
  })

  it('flags a mid-table header change as substantive with reason "tables"', function () {
    const { before, after } = loadPair('table-mid-header', 'table-mid-header')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'tables')
  })

  it('flags a table header cell ref change as substantive with reason "references"', function () {
    const { before, after } = loadPair('table-header-ref', 'table-header-ref')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'references')
  })

  it('flags a Spanish citation title change as substantive with reason "references"', function () {
    const { before, after } = loadPair('es-citation', 'es-citation')
    const v = classifyEdit(before, after, { lang: 'es' })
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'references')
  })

  it('flags a redirect retarget as substantive with reason "redirect"', function () {
    const { before, after } = loadPair('redirect', 'redirect')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'redirect')
  })

  // Formatting-only edits that should NOT be substantive: verify whitespace
  // and markup noise do not count as changes.

  it('treats table cell-separator spacing change as not substantive', function () {
    const { before, after } = loadPair('table-cell-spacing', 'table-cell-spacing')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats table header-separator spacing change as not substantive', function () {
    const { before, after } = loadPair('table-header-spacing', 'table-header-spacing')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats reference template formatting change as not substantive', function () {
    const { before, after } = loadPair('ref-formatting', 'ref-formatting')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats reference template parameter reorder as not substantive', function () {
    const { before, after } = loadPair('ref-param-order', 'ref-param-order')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats table and cell attribute changes as not substantive', function () {
    const { before, after } = loadPair('table-attrs', 'table-attrs')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats row-separator attribute changes as not substantive', function () {
    const { before, after } = loadPair('table-rowsep-attrs', 'table-rowsep-attrs')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats an external-link retarget in a table cell as not substantive', function () {
    const { before, after } = loadPair('table-extlink-retarget', 'table-extlink-retarget')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'external-links')
  })

  // Regression: a stray {{ with no closing braces above a pipe-heavy table
  // must not trigger catastrophic regex backtracking in canonicalizeWikitext.
  // Before the fix this case ran for minutes; mocha's default timeout fails it.
  it('classifies a table containing a stray {{ without hanging', function () {
    const rows = Array.from({ length: 6 }, (_, i) => `|-\n| a${i} || b || c || d || e`).join('\n')
    const table = '{| class="wikitable"\n|-\n| {{ stray || x || y || z || w\n' + rows + '\n|}'
    const v = classifyEdit(table + '\nProse one.', table + '\nProse two.')
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'prose')
  })

  it('treats an unrecognized channel policy value as substantive, never ignored', function () {
    const { before, after } = loadPair('ref-added')
    const v = classifyEdit(before, after, { channels: { references: 'subtantive' } })
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'references')
  })

  it('treats header-cell attribute changes as not substantive', function () {
    const { before, after } = loadPair('table-headercell-attrs', 'table-headercell-attrs')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  // Routed through the references channel's empty-json wikitext fallback
  // (Cita-family templates parse to empty json), so this pins the named
  // parameter sort on the raw-wikitext path.
  it('treats a Spanish citation named-parameter reorder as not substantive', function () {
    const { before, after } = loadPair('es-cita-param-order', 'es-cita-param-order')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('treats reference name attribute change as not substantive', function () {
    const { before, after } = loadPair('ref-name-change', 'ref-name-change')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })
})

describe('edit-significance extractChannels', function () {
  it('exposes every documented channel', function () {
    const wtf = require('wtf_wikipedia')
    const doc = wtf('[[Link]] text')
    const channels = extractChannels(doc)
    // Verify all expected channels are present and match DEFAULT_CHANNELS exactly
    assert.deepEqual(Object.keys(channels).sort(), Object.keys(DEFAULT_CHANNELS).sort())
  })

  it('media channel includes caption and alt text, not just filenames', function () {
    const wtf = require('wtf_wikipedia')
    const doc = wtf('[[File:test.jpg|thumb|Test caption|alt=Test alt text]]')
    const channels = extractChannels(doc)
    // Media channel should contain structured objects with file, caption, alt
    assert.include(channels.media, 'caption')
    assert.include(channels.media, 'Test caption')
    assert.include(channels.media, 'alt')
    assert.include(channels.media, 'Test alt text')
  })

  it('tables channel extracts and stringifies table content', function () {
    const wtf = require('wtf_wikipedia')
    const doc = wtf('{| class="wikitable"\n|-\n| Cell content\n|}')
    const channels = extractChannels(doc)
    // Tables channel should be a string representation of table JSON
    assert.isString(channels.tables)
    // Should contain table content (wtf_wikipedia extracts cell values)
    assert.include(channels.tables, 'Cell content')
  })
})
