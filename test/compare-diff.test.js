const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const {
  parseDiffParams,
  splitHighlights,
  summarizeDiff,
  buildAltText,
  blpFromClaims,
  buildDiffModel
} = require('../lib/compare-diff')

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'compare-api-response.json'), 'utf8')
)

describe('compare-diff', function() {

  describe('parseDiffParams', function() {
    it('extracts host and revision ids from a diff URL', function() {
      const result = parseDiffParams('https://en.wikipedia.org/w/index.php?diff=123&oldid=456')
      assert.deepEqual(result, { host: 'en.wikipedia.org', torev: 123, fromrev: 456 })
    })

    it('returns null fromrev when oldid is missing', function() {
      const result = parseDiffParams('https://en.wikipedia.org/w/index.php?diff=123')
      assert.deepEqual(result, { host: 'en.wikipedia.org', torev: 123, fromrev: null })
    })

    it('returns null for a non-numeric diff param', function() {
      assert.isNull(parseDiffParams('https://en.wikipedia.org/w/index.php?diff=prev&oldid=456'))
    })

    it('returns null for garbage input', function() {
      assert.isNull(parseDiffParams('not a url'))
    })
  })

  describe('splitHighlights', function() {
    it('splits text into add/delete/plain segments', function() {
      // "|pushpin_map_altpushpin_alt ..." from the fixture: bytes 1-15
      // deleted, bytes 16-34 added
      const line = fixture.diff.find(l => l.type === 3 && l.highlightRanges?.length === 2)
      const segments = splitHighlights(line.text, line.highlightRanges)
      const rebuilt = segments.map(s => s.text).join('')
      assert.equal(rebuilt, line.text)
      assert.isTrue(segments.some(s => s.highlight === 'delete'))
      assert.isTrue(segments.some(s => s.highlight === 'add'))
    })

    it('treats offsets as byte offsets in multibyte text', function() {
      // "café X" - 'café' is 5 bytes; highlight " X" (bytes 5-7)
      const segments = splitHighlights('café X', [{ start: 5, length: 2, type: 0 }])
      assert.deepEqual(segments, [
        { text: 'café', highlight: null },
        { text: ' X', highlight: 'add' }
      ])
    })

    it('handles no ranges', function() {
      assert.deepEqual(splitHighlights('plain', []), [{ text: 'plain', highlight: null }])
      assert.deepEqual(splitHighlights('plain', undefined), [{ text: 'plain', highlight: null }])
    })

    it('clamps out-of-bounds ranges', function() {
      const segments = splitHighlights('ab', [{ start: 1, length: 99, type: 1 }])
      assert.deepEqual(segments, [
        { text: 'a', highlight: null },
        { text: 'b', highlight: 'delete' }
      ])
    })
  })

  describe('summarizeDiff', function() {
    // One changed line with two separate added ranges and one removed range:
    // "since that continues to this day" -> "from but requiring AMD to develop"
    const twoRangeLine = [{
      type: 3,
      text: 'from since but requiring AMD to develop that continues to this day',
      highlightRanges: [
        { start: 0, length: 4, type: 0 },   // "from" added
        { start: 5, length: 5, type: 1 },   // "since" removed
        { start: 11, length: 28, type: 0 }, // "but requiring ... to develop" added
        { start: 40, length: 26, type: 1 }  // "that continues to this day" removed
      ]
    }]

    it('excerpts each side of a changed line as one readable span', function() {
      const summary = summarizeDiff(twoRangeLine)
      assert.deepEqual(summary.addedLines, ['from but requiring AMD to develop'])
      assert.deepEqual(summary.removedLines, ['since that continues to this day'])
    })

    it('keeps the flat per-highlight fragments for alt text', function() {
      const summary = summarizeDiff(twoRangeLine)
      assert.deepEqual(summary.added, ['from', 'but requiring AMD to develop'])
      assert.deepEqual(summary.removed, ['since', 'that continues to this day'])
    })

    // Build a type-3 change line from [text, 'add'|'del'|null] parts,
    // computing wikidiff2's byte-offset highlightRanges.
    function makeChangeLine(parts) {
      let text = ''
      const highlightRanges = []
      for (const [t, kind] of parts) {
        if (kind) {
          highlightRanges.push({
            start: Buffer.byteLength(text),
            length: Buffer.byteLength(t),
            type: kind === 'add' ? 0 : 1
          })
        }
        text += t
      }
      return { type: 3, text, highlightRanges }
    }

    it('keeps the words between changes instead of ellipsizing every range', function() {
      // Ryan Coogler link cleanup (diff=1367197915): five highlight ranges
      // across one sentence used to render as "director … finance … [[ …
      // |non-profit … organization"
      const line = makeChangeLine([
        ['His mother was a ', null],
        ['[[Non-Profit|Director', 'del'],
        ['director', 'add'],
        [' of ', null],
        ['Finance', 'del'],
        ['finance', 'add'],
        [' for a [[Non-Profit ', null],
        ['|non-profit ', 'add'],
        ['Organization', 'del'],
        ['organization', 'add'],
        [']], and his father was a counselor.', null]
      ])
      const summary = summarizeDiff([line])
      assert.deepEqual(summary.addedLines,
        ['director of finance for a [[Non-Profit |non-profit organization'])
      assert.deepEqual(summary.removedLines,
        ['[[Non-Profit|Director of Finance for a Non-Profit Organization'])
    })

    it('strips a link that spans several highlight ranges', function() {
      // "[[Mayor]] of Oakland" -> "[[Governor]] of California": full-line
      // stripping sees balanced [[..]] even though ranges split it
      const line = makeChangeLine([
        ['She became [[', null],
        ['Mayor', 'del'],
        ['Governor', 'add'],
        [']] of ', null],
        ['Oakland', 'del'],
        ['California', 'add'],
        [' that year.', null]
      ])
      const summary = summarizeDiff([line])
      assert.deepEqual(summary.addedLines, ['Governor of California'])
      assert.deepEqual(summary.removedLines, ['Mayor of Oakland'])
    })

    it('shortens only long unchanged stretches between changes', function() {
      const gap = 'w'.repeat(300)
      const line = makeChangeLine([
        ['first', 'add'],
        [` ${gap} `, null],
        ['second', 'add']
      ])
      const summary = summarizeDiff([line])
      assert.lengthOf(summary.addedLines, 1)
      const excerpt = summary.addedLines[0]
      assert.match(excerpt, /^first w+ … w+ second$/)
      assert.isBelow(excerpt.length, 150)
    })

    it('glosses an added ref with its title and publication', function() {
      // Johnny Mathis edit (diff-style): a citation added mid-sentence
      // used to excerpt as just "[ref]"
      const line = makeChangeLine([
        ['Helen Noga.', null],
        ['<ref>{{cite web |url=https://www.sfgate.com/music/mathis.html |title=Johnny Mathis looks back |work=[[San Francisco Chronicle]]}}</ref>', 'add'],
        [' She became his manager.', null]
      ])
      const summary = summarizeDiff([line])
      assert.deepEqual(summary.addedLines,
        ['[ref: "Johnny Mathis looks back" (San Francisco Chronicle)]'])
    })

    it('glosses a wholly-added ref line', function() {
      const summary = summarizeDiff([{
        type: 1,
        text: '<ref>{{cite news |title=A story |newspaper=The Examiner |url=https://www.sfexaminer.com/x}}</ref>'
      }])
      assert.deepEqual(summary.addedLines, ['[ref: "A story" (The Examiner)]'])
    })

    it('falls back to the cited hostname, external-link label, or prose', function() {
      const bare = summarizeDiff([{ type: 1, text: '<ref>https://www.nytimes.com/2024/story.html</ref>' }])
      assert.deepEqual(bare.addedLines, ['[ref: nytimes.com]'])

      const labeled = summarizeDiff([{ type: 1, text: '<ref>[https://kqed.org/x Mathis at the Black Hawk]</ref>' }])
      assert.deepEqual(labeled.addedLines, ['[ref: "Mathis at the Black Hawk" (kqed.org)]'])

      const prose = summarizeDiff([{ type: 1, text: "<ref>Smith, ''Jazz in SF'' (2001), p. 44</ref>" }])
      assert.deepEqual(prose.addedLines, ['[ref: Smith, Jazz in SF (2001), p. 44]'])
    })

    it('truncates long citation titles', function() {
      const summary = summarizeDiff([{
        type: 1,
        text: `<ref>{{cite web |title=${'t'.repeat(100)} |url=https://a.com}}</ref>`
      }])
      const excerpt = summary.addedLines[0]
      assert.include(excerpt, '…')
      assert.include(excerpt, '(a.com)')
      assert.isBelow(excerpt.length, 80)
    })

    it('excerpts nothing for a side with no visible change', function() {
      const line = makeChangeLine([
        ['Sentence with an ', null],
        ['inserted word', 'add'],
        [' only.', null]
      ])
      const summary = summarizeDiff([line])
      assert.deepEqual(summary.addedLines, ['inserted word'])
      assert.deepEqual(summary.removedLines, [])
    })

    it('keeps separate diff lines on separate display lines', function() {
      const summary = summarizeDiff([
        { type: 1, text: 'first added line' },
        { type: 1, text: 'second added line' },
        { type: 2, text: 'a removed line' }
      ])
      assert.deepEqual(summary.addedLines, ['first added line', 'second added line'])
      assert.deepEqual(summary.removedLines, ['a removed line'])
    })
  })

  describe('buildAltText', function() {
    it('summarizes counts and includes changed text excerpts', function() {
      const alt = buildAltText(fixture.diff, 'Test Article')
      assert.include(alt, 'Diff of Wikipedia article "Test Article"')
      // 31 changed lines in the fixture, but 28 are whitespace-only realignment
      assert.include(alt, '3 lines changed')
      assert.include(alt, 'Added text:')
    })

    it('reports added and removed lines', function() {
      const diff = [
        { type: 1, text: 'New sentence here.' },
        { type: 2, text: 'Old sentence gone.' }
      ]
      const alt = buildAltText(diff, 'Cat')
      assert.include(alt, '1 line added, 1 line removed')
      assert.include(alt, 'New sentence here.')
      assert.include(alt, 'Old sentence gone.')
    })

    it('stays within the length cap', function() {
      const diff = Array.from({ length: 200 }, () => ({ type: 1, text: 'x'.repeat(100) }))
      const alt = buildAltText(diff, 'Long Article')
      assert.isAtMost(alt.length, 1200)
    })

    it('handles a diff with no changes', function() {
      const alt = buildAltText([{ type: 0, text: 'context' }], 'Cat')
      assert.include(alt, 'no visible text changes')
    })

    it('describes markup-only fragments in alt text instead of quoting them', function() {
      // Wrapping a word in link brackets: fragments are [[ and ]]
      const diff = [{
        type: 3,
        text: 'confiscated by [[FEMA]] to be diverted',
        highlightRanges: [
          { start: 15, length: 2, type: 0 },
          { start: 21, length: 2, type: 0 }
        ]
      }]
      const alt = buildAltText(diff, 'London Breed')
      assert.notInclude(alt, '[[')
      assert.include(alt, 'Changes are to link markup only.')
    })

    it('mentions markup changes alongside quoted text changes', function() {
      const diff = [
        { type: 1, text: 'New sentence.' },
        {
          type: 3,
          text: 'a <br> b',
          highlightRanges: [{ start: 2, length: 4, type: 0 }]
        }
      ]
      const alt = buildAltText(diff, 'Cat')
      assert.include(alt, 'Added text: "New sentence."')
      assert.include(alt, 'Also changes to line breaks.')
      assert.notInclude(alt, '<br>')
    })

    it('strips wikitext from alt text', function() {
      const alt = buildAltText(
        [{ type: 1, text: 'He lived in [[San Francisco|SF]].<ref>{{cite web|url=x}}</ref>' }],
        'Cat'
      )
      assert.include(alt, 'He lived in SF.[ref]')
      assert.notInclude(alt, 'cite web')
    })

    it('includes the description in alt text', function() {
      const alt = buildAltText([{ type: 1, text: 'New.' }], 'Gavin Newsom', 'Governor of California since 2019')
      assert.include(alt, 'Diff of Wikipedia article "Gavin Newsom" (Governor of California since 2019):')
    })
  })

  describe('wikitext stripping', function() {
    it('unwraps piped links while keeping highlights on the label', function() {
      const diff = [{
        type: 3,
        text: 'ranked [[List of cities|secondthird]] by density',
        highlightRanges: [
          { start: 24, length: 6, type: 1 },
          { start: 30, length: 5, type: 0 }
        ]
      }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const row = model.rows[0]
      assert.equal(row.kind, 'change')
      assert.deepEqual(row.segments, [
        { text: 'ranked ', highlight: null },
        { text: 'second', highlight: 'delete' },
        { text: 'third', highlight: 'add' },
        { text: ' by density', highlight: null }
      ])
    })

    it('collapses a wholly-added ref to a highlighted citation gloss', function() {
      const diff = [{
        type: 3,
        text: 'in 2025.<ref>{{Cite web |title=IPUMS |url=https://x.org}}</ref> Some',
        highlightRanges: [{ start: 8, length: 55, type: 0 }]
      }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const segments = model.rows[0].segments
      // The ref should be collapsed to a gloss, with highlight preserved
      const glossSegment = segments.find(s => s.text.includes('ref:'))
      assert.isOk(glossSegment)
      assert.equal(glossSegment.highlight, 'add')
      assert.include(glossSegment.text, 'IPUMS')
      assert.include(glossSegment.text, 'x.org')
    })

    it('keeps context refs terse while glossing the changed one', function() {
      // Only the second ref is part of the edit; the first is context and
      // glossing it would crowd the render with an unrelated citation
      const text = 'Old claim.<ref>{{cite web |title=Old |url=https://a.com/1}}</ref> More.<ref>{{cite web |title=New source |url=https://b.com/2}}</ref>'
      const refStart = text.indexOf(' More.') + ' More.'.length
      const diff = [{
        type: 3,
        text,
        highlightRanges: [{ start: refStart, length: Buffer.byteLength(text) - refStart, type: 0 }]
      }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const textContent = model.rows[0].segments.map(s => s.text).join('')
      assert.include(textContent, 'Old claim.[ref] More.')
      const glossed = model.rows[0].segments.find(s => s.text.includes('New source'))
      assert.isOk(glossed)
      assert.equal(glossed.highlight, 'add')
    })

    it('keeps a ref raw when the change is inside it', function() {
      const diff = [{
        type: 3,
        text: '<ref>date=20242025</ref>',
        highlightRanges: [
          { start: 10, length: 4, type: 1 },
          { start: 14, length: 4, type: 0 }
        ]
      }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const segments = model.rows[0].segments
      // Should have the year parts as separate segments
      assert.isTrue(segments.some(s => s.text === '2024' && s.highlight === 'delete'))
      assert.isTrue(segments.some(s => s.text === '2025' && s.highlight === 'add'))
    })

    it('strips templates, links, and quote markup from context lines', function() {
      const diff = [{ type: 0, text: "'''SF''',{{Efn|{{IPA|en|x}} audio}} is a [[city]]" }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const text = model.rows[0].segments[0].text
      assert.include(text, 'SF')
      assert.include(text, '{{Efn}}')
      assert.include(text, 'is a city')
      assert.notInclude(text, "'''")
      assert.notInclude(text, '[[')
    })

    it('collapses a ref to its changed fragments when the edit is inside it', function() {
      // access-date changed inside an existing citation
      const text = '<ref>{{cite web |url=https://example.com/very/long/path |access-date=20242025 |title=X}}</ref>'
      const diff = [{
        type: 3,
        text,
        highlightRanges: [
          { start: 69, length: 4, type: 1 },
          { start: 73, length: 4, type: 0 }
        ]
      }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const textContent = model.rows[0].segments.map(s => s.text).join('')
      assert.include(textContent, '[ref:')
      assert.include(textContent, '2024')
      assert.include(textContent, '2025')
      assert.notInclude(textContent, 'example.com')
    })

    it('keeps markup-only changes visible instead of stripping them away', function() {
      // Edit wrapped "FEMA" in link brackets: only [[ and ]] are highlighted
      const diff = [{
        type: 3,
        text: 'confiscated by [[FEMA]] to be diverted',
        highlightRanges: [
          { start: 15, length: 2, type: 0 },
          { start: 21, length: 2, type: 0 }
        ]
      }]
      const model = buildDiffModel(diff, 'SF')
      assert.lengthOf(model.rows, 1)
      const segments = model.rows[0].segments
      // The [[ and ]] brackets should be marked as added
      assert.isTrue(segments.some(s => s.text === '[[' && s.highlight === 'add'))
      assert.isTrue(segments.some(s => s.text === ']]' && s.highlight === 'add'))
    })

    it('omits whitespace-only changed lines from rows', function() {
      const wsLine = {
        type: 3,
        text: '|founded   = 1850s',
        highlightRanges: [{ start: 8, length: 2, type: 0 }] // added spaces only
      }
      const realLine = { type: 1, text: 'Real new sentence.' }
      const model = buildDiffModel([wsLine, realLine], 'Cat')
      // Whitespace-only line should be omitted
      assert.lengthOf(model.rows, 1)
      assert.include(model.rows[0].segments[0].text, 'Real new sentence.')
    })
  })

  describe('line capping and gutters', function() {
    it('caps rendered lines and reports omissions', function() {
      const diff = Array.from({ length: 80 }, (_, i) => ({ type: 1, text: `line ${i}`, lineNumber: i + 1 }))
      const model = buildDiffModel(diff, 'Big Edit')
      // Should have 50 lines + footer
      const nonFooterRows = model.rows.filter(r => r.kind !== 'footer')
      assert.isAtMost(nonFooterRows.length, 50)
      const footer = model.rows.find(r => r.kind === 'footer')
      assert.isOk(footer)
      assert.include(footer.segments[0].text, 'more changed line')
    })

    it('clips long context lines and windows long changed lines', function() {
      const long = 'a'.repeat(2000)
      const diff = [
        { type: 0, text: long },
        { type: 3, text: long + 'CHANGED' + long, highlightRanges: [{ start: 2000, length: 7, type: 0 }] }
      ]
      const model = buildDiffModel(diff, 'Cat')
      // Context line should be clipped
      const contextText = model.rows[0].segments[0].text
      assert.isBelow(contextText.length, 2000)
      assert.include(contextText, '…')

      // Changed line should be windowed around the change
      const changedSegments = model.rows[1].segments
      const changedText = changedSegments.map(s => s.text).join('')
      // Should include […] elision for non-highlighted text
      assert.isTrue(changedSegments.some(s => s.text.includes('[…]')))
      assert.isTrue(changedSegments.some(s => s.text.includes('CHANGED')))
    })

    it('does not highlight whitespace-only segments', function() {
      // When ALL changes are whitespace, the line is skipped entirely
      const diff = [{
        type: 3,
        text: 'foo   bar',
        highlightRanges: [{ start: 3, length: 3, type: 0 }]
      }]
      const model = buildDiffModel(diff, 'Cat')
      // The line is omitted as whitespace-only
      assert.lengthOf(model.rows, 0)

      // But if there's a real change alongside whitespace, the whitespace
      // doesn't get highlighted
      const diff2 = [{
        type: 3,
        text: 'foo   bar WORD',
        highlightRanges: [
          { start: 3, length: 3, type: 0 },  // whitespace (not highlighted in output)
          { start: 10, length: 4, type: 0 }   // WORD (bytes 10-13, highlighted)
        ]
      }]
      const model2 = buildDiffModel(diff2, 'Cat')
      assert.lengthOf(model2.rows, 1)
      const segments = model2.rows[0].segments
      // Check that there's a real change and whitespace is not highlighted
      const hasAddedText = segments.some(s => s.highlight === 'add')
      assert.isTrue(hasAddedText, 'Should have added text')
      const whitespaceSegments = segments.filter(s => !s.text.trim())
      for (const seg of whitespaceSegments) {
        assert.isNull(seg.highlight, 'Whitespace should not be highlighted')
      }
    })

    it('renders full added and deleted lines with gutters', function() {
      const diff = [
        { type: 1, text: 'added line' },
        { type: 2, text: 'deleted line' }
      ]
      const model = buildDiffModel(diff, 'Cat')
      assert.lengthOf(model.rows, 2)

      const addRow = model.rows[0]
      assert.equal(addRow.kind, 'add')
      assert.equal(addRow.gutter, '+')
      assert.include(addRow.segments[0].text, 'added line')

      const delRow = model.rows[1]
      assert.equal(delRow.kind, 'delete')
      assert.equal(delRow.gutter, '−')
      assert.include(delRow.segments[0].text, 'deleted line')
    })

    it('includes gap rows between non-contiguous chunks', function() {
      const diff = [
        { type: 1, text: 'line 1', lineNumber: 1 },
        { type: 1, text: 'line 10', lineNumber: 10 }
      ]
      const model = buildDiffModel(diff, 'Cat')
      assert.lengthOf(model.rows, 3) // add, gap, add
      assert.equal(model.rows[1].kind, 'gap')
      assert.include(model.rows[1].segments[0].text, '⋯')
    })
  })

  describe('blpFromClaims', function() {
    it('flags a living human as BLP', function() {
      assert.deepEqual(blpFromClaims(['Q5'], null), { isBlp: true, reason: 'living' })
    })

    it('flags a recently deceased human (WP:BDP window)', function() {
      const now = new Date('2026-07-13T00:00:00Z')
      assert.deepEqual(
        blpFromClaims(['Q5'], '+2025-09-29T00:00:00Z', now),
        { isBlp: true, reason: 'recently-deceased' }
      )
    })

    it('does not flag a long-dead human', function() {
      const now = new Date('2026-07-13T00:00:00Z')
      assert.deepEqual(
        blpFromClaims(['Q5'], '+1978-11-27T00:00:00Z', now),
        { isBlp: false, reason: null }
      )
    })

    it('does not flag non-humans', function() {
      // e.g. San Francisco Board of Supervisors: instance of legislature
      assert.deepEqual(blpFromClaims(['Q11204'], null), { isBlp: false, reason: null })
      assert.deepEqual(blpFromClaims([], null), { isBlp: false, reason: null })
    })
  })
})
