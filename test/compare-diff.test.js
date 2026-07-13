const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const {
  parseDiffParams,
  splitHighlights,
  buildAltText,
  blpFromClaims,
  renderDiffHtml
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
      const html = renderDiffHtml(diff, 'SF')
      assert.notInclude(html, '[[')
      assert.include(html, '<del>second</del>')
      assert.include(html, '<ins>third</ins>')
    })

    it('collapses a wholly-added ref to a highlighted [ref]', function() {
      const diff = [{
        type: 3,
        text: 'in 2025.<ref>{{Cite web |title=IPUMS |url=https://x.org}}</ref> Some',
        highlightRanges: [{ start: 8, length: 55, type: 0 }]
      }]
      assert.include(renderDiffHtml(diff, 'SF'), '<ins>[ref]</ins>')
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
      const html = renderDiffHtml(diff, 'SF')
      assert.include(html, '<del>2024</del>')
      assert.include(html, '<ins>2025</ins>')
    })

    it('strips templates, links, and quote markup from context lines', function() {
      const diff = [{ type: 0, text: "'''SF''',{{Efn|{{IPA|en|x}} audio}} is a [[city]]" }]
      const html = renderDiffHtml(diff, 'SF')
      assert.include(html, 'SF,{{Efn}} is a city')
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
      const html = renderDiffHtml(diff, 'SF')
      assert.include(html, '[ref: <del>2024</del> <ins>2025</ins>]')
      assert.notInclude(html, 'example.com')
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
      const html = renderDiffHtml(diff, 'SF')
      assert.include(html, '<ins>[[</ins>')
      assert.include(html, '<ins>]]</ins>')
    })

    it('omits whitespace-only changed lines from image and summary', function() {
      const wsLine = {
        type: 3,
        text: '|founded   = 1850s',
        highlightRanges: [{ start: 8, length: 2, type: 0 }] // added spaces only
      }
      const realLine = { type: 1, text: 'Real new sentence.' }
      const html = renderDiffHtml([wsLine, realLine], 'Cat')
      assert.notInclude(html, 'founded')
      assert.include(html, 'Real new sentence.')

      const alt = buildAltText([wsLine], 'Cat')
      assert.include(alt, 'whitespace and formatting changes only')
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
  })

  describe('article meta in output', function() {
    it('renders description and thumbnail when provided', function() {
      const diff = [{ type: 1, text: 'new text' }]
      const html = renderDiffHtml(diff, 'Gavin Newsom', {
        description: 'Governor of California since 2019',
        imageDataUri: 'data:image/png;base64,AAAA'
      })
      assert.include(html, 'Governor of California since 2019')
      assert.include(html, 'src="data:image/png;base64,AAAA"')
    })

    it('renders cleanly with no meta (backward compatible)', function() {
      const html = renderDiffHtml([{ type: 1, text: 'x' }], 'Cat')
      assert.notInclude(html, 'class="description"')
      assert.notInclude(html, 'class="thumb"')
      assert.include(html, '<h1>Cat</h1>')
    })

    it('escapes HTML in the description', function() {
      const html = renderDiffHtml([{ type: 1, text: 'x' }], 'Cat', {
        description: '<script>alert(1)</script>'
      })
      assert.notInclude(html, '<script>')
    })

    it('includes the description in alt text', function() {
      const alt = buildAltText([{ type: 1, text: 'New.' }], 'Gavin Newsom', 'Governor of California since 2019')
      assert.include(alt, 'Diff of Wikipedia article "Gavin Newsom" (Governor of California since 2019):')
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

  describe('renderDiffHtml', function() {
    it('renders the fixture with word-level highlights', function() {
      const html = renderDiffHtml(fixture.diff, 'Test Article')
      assert.include(html, 'id="diff"')
      assert.include(html, '<h1>Test Article</h1>')
      assert.include(html, '<ins>')
      assert.include(html, '<del>')
    })

    it('escapes HTML in page titles and diff text', function() {
      const diff = [{ type: 1, text: '<script>alert(1)</script>' }]
      const html = renderDiffHtml(diff, '<b>Page</b>')
      assert.notInclude(html, '<script>')
      assert.notInclude(html, '<b>Page</b>')
      assert.include(html, '&lt;script&gt;')
    })

    it('caps rendered lines and reports omissions', function() {
      const diff = Array.from({ length: 80 }, (_, i) => ({ type: 1, text: `line ${i}`, lineNumber: i + 1 }))
      const html = renderDiffHtml(diff, 'Big Edit')
      assert.include(html, 'more changed line')
      assert.notInclude(html, 'line 79')
    })

    it('clips long context lines and windows long changed lines', function() {
      const long = 'a'.repeat(2000)
      const diff = [
        { type: 0, text: long },
        { type: 3, text: long + 'CHANGED' + long, highlightRanges: [{ start: 2000, length: 7, type: 0 }] }
      ]
      const html = renderDiffHtml(diff, 'Cat')
      assert.notInclude(html, long)
      assert.include(html, '<ins>CHANGED</ins>')
      assert.include(html, '[…]')
    })

    it('does not highlight whitespace-only segments', function() {
      const diff = [{
        type: 3,
        text: 'foo   bar',
        highlightRanges: [{ start: 3, length: 3, type: 0 }]
      }]
      const html = renderDiffHtml(diff, 'Cat')
      assert.notInclude(html, '<ins>')
    })

    it('renders full added and deleted lines with gutters', function() {
      const diff = [
        { type: 1, text: 'added line' },
        { type: 2, text: 'deleted line' }
      ]
      const html = renderDiffHtml(diff, 'Cat')
      assert.include(html, 'class="row add"')
      assert.include(html, 'class="row delete"')
    })
  })
})
