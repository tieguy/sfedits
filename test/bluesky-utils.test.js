/**
 * Direct unit tests for lib/bluesky-utils.js
 *
 * These tests import and test the module directly (not through page-watch.js)
 * to ensure the extracted code works independently.
 */

const { describe, it } = require('mocha')
const { assert } = require('chai')
const { buildFacets, fitBlueskyText } = require('../lib/bluesky-utils')

describe('lib/bluesky-utils', function() {
  describe('buildFacets() anchoring (LUI-85)', function() {
    const PAGE_URL = 'https://en.wikipedia.org/wiki/x'
    const USER_URL = 'https://en.wikipedia.org/wiki/Special:Contributions/x'

    it('finds the username when the template puts the name before the page', function() {
      // Sequential search offsets used to drop the name facet entirely here.
      const text = 'Alice edited Cat https://example.com/diff'
      const facets = buildFacets(text, 'Cat', 'Alice', PAGE_URL, USER_URL)

      assert.equal(facets.length, 3, 'page + name + url facets')
      const pageFacet = facets[0]
      const nameFacet = facets[1]
      assert.equal(pageFacet.index.byteStart, 13, 'page anchors on the standalone "Cat"')
      assert.equal(pageFacet.index.byteEnd, 16)
      assert.equal(nameFacet.index.byteStart, 0, 'name anchors on "Alice" at the start')
      assert.equal(nameFacet.index.byteEnd, 5)
    })

    it('does not anchor the page name inside a longer word', function() {
      // "Cat" must not match inside "Catherine".
      const text = 'Catherine edited Cat https://example.com/diff'
      const facets = buildFacets(text, 'Cat', 'Catherine', PAGE_URL, USER_URL)

      assert.equal(facets.length, 3)
      assert.equal(facets[0].index.byteStart, 17, 'page facet on the standalone "Cat"')
      assert.equal(facets[0].index.byteEnd, 20)
      assert.equal(facets[1].index.byteStart, 0, 'name facet on "Catherine"')
      assert.equal(facets[1].index.byteEnd, 9)
    })

    it('does not anchor a name that only appears inside the diff URL', function() {
      // "index" appears standalone-ish inside the URL path; a facet there
      // would overlap the URL facet.
      const text = 'Cat edited by someone https://en.wikipedia.org/w/index.php?diff=1'
      const facets = buildFacets(text, 'Cat', 'index', PAGE_URL, USER_URL)

      assert.equal(facets.length, 2, 'page + url only; no name facet inside the URL')
      assert.equal(facets[0].features[0].uri, PAGE_URL)
      assert.equal(facets[1].features[0].uri, 'https://en.wikipedia.org/w/index.php?diff=1')
    })

    it('does not anchor the name inside the page facet when name is a prefix of page', function() {
      const text = 'Union Square edited by Union https://example.com/diff'
      const facets = buildFacets(text, 'Union Square', 'Union', PAGE_URL, USER_URL)

      assert.equal(facets.length, 3)
      assert.equal(facets[0].index.byteStart, 0, 'page facet on "Union Square"')
      assert.equal(facets[0].index.byteEnd, 12)
      assert.equal(facets[1].index.byteStart, 23, 'name facet on the later standalone "Union"')
      assert.equal(facets[1].index.byteEnd, 28)
    })

    it('emits no name facet when the name never appears outside other anchors', function() {
      const text = 'Union Square edited https://example.com/diff'
      const facets = buildFacets(text, 'Union Square', 'Union', PAGE_URL, USER_URL)

      assert.equal(facets.length, 2, 'page + url; "Union" only exists inside the page facet')
    })
  })

  describe('buildFacets()', function() {
    it('creates facet for article name with correct byte offsets', function() {
      const text = 'Cat edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        'Cat',
        'User',
        'https://en.wikipedia.org/wiki/Cat',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have 3 facets: page name, username, diff URL
      assert.equal(facets.length, 3)

      // First facet should be for "Cat"
      const catFacet = facets[0]
      assert.equal(catFacet.index.byteStart, 0)
      assert.equal(catFacet.index.byteEnd, 3)
      assert.equal(catFacet.features[0].$type, 'app.bsky.richtext.facet#link')
      assert.equal(catFacet.features[0].uri, 'https://en.wikipedia.org/wiki/Cat')
    })

    it('creates facet for username with correct byte offsets', function() {
      const text = 'Article edited by TestUser https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        'TestUser',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/TestUser'
      )

      // Second facet should be for "TestUser"
      const userFacet = facets[1]
      const expectedStart = Buffer.byteLength('Article edited by ', 'utf8')
      const expectedEnd = expectedStart + Buffer.byteLength('TestUser', 'utf8')

      assert.equal(userFacet.index.byteStart, expectedStart)
      assert.equal(userFacet.index.byteEnd, expectedEnd)
      assert.equal(userFacet.features[0].uri, 'https://en.wikipedia.org/wiki/Special:Contributions/TestUser')
    })

    it('creates facet for diff URL with correct byte offsets', function() {
      const text = 'Article edited by User https://en.wikipedia.org/w/index.php?diff=123'
      const facets = buildFacets(
        text,
        'Article',
        'User',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Third facet should be for the diff URL
      const urlFacet = facets[2]
      const urlStart = text.indexOf('https://en.wikipedia.org/w/')
      const expectedStart = Buffer.byteLength(text.substring(0, urlStart), 'utf8')
      const expectedEnd = expectedStart + Buffer.byteLength('https://en.wikipedia.org/w/index.php?diff=123', 'utf8')

      assert.equal(urlFacet.index.byteStart, expectedStart)
      assert.equal(urlFacet.index.byteEnd, expectedEnd)
      assert.equal(urlFacet.features[0].uri, 'https://en.wikipedia.org/w/index.php?diff=123')
    })

    it('handles multi-byte UTF-8 characters correctly', function() {
      // Japanese article name: 日本
      const text = '日本 edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        '日本',
        'User',
        'https://ja.wikipedia.org/wiki/日本',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // First facet for 日本
      const pageFacet = facets[0]
      assert.equal(pageFacet.index.byteStart, 0)
      // 日本 is 6 bytes in UTF-8 (3 bytes per character)
      assert.equal(pageFacet.index.byteEnd, 6)
      assert.equal(pageFacet.features[0].uri, 'https://ja.wikipedia.org/wiki/日本')

      // Username facet should start after 日本 + " edited by "
      const userFacet = facets[1]
      const expectedUserStart = Buffer.byteLength('日本 edited by ', 'utf8')
      assert.equal(userFacet.index.byteStart, expectedUserStart)
    })

    it('handles emoji characters correctly in byte offsets', function() {
      // Flag emoji after IP address (geolocation enrichment case)
      const text = 'Article edited by 8.8.8.8 [🇺🇸] https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        '8.8.8.8 [🇺🇸]',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/8.8.8.8'
      )

      // Username facet should handle emoji correctly
      const userFacet = facets[1]
      const expectedStart = Buffer.byteLength('Article edited by ', 'utf8')
      // 🇺🇸 flag emoji is 8 bytes in UTF-8
      const expectedEnd = expectedStart + Buffer.byteLength('8.8.8.8 [🇺🇸]', 'utf8')

      assert.equal(userFacet.index.byteStart, expectedStart)
      assert.equal(userFacet.index.byteEnd, expectedEnd)
    })

    it('returns empty array when page URL is null', function() {
      const text = 'Article edited by User https://example.com/diff'
      const facets = buildFacets(text, 'Article', 'User', null, null)

      // Should only have URL facet (no page or user facets)
      assert.equal(facets.length, 1)
      assert.include(facets[0].features[0].uri, 'https://example.com/diff')
    })

    it('skips page facet if page name not found in text', function() {
      const text = 'Something edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article', // Not in text
        'User',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have user facet and URL facet, but not page facet
      assert.equal(facets.length, 2)
      assert.notEqual(facets[0].features[0].uri, 'https://en.wikipedia.org/wiki/Article')
    })

    it('skips user facet if username not found in text', function() {
      const text = 'Article edited by SomeoneElse https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        'User', // Not in text
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have page facet and URL facet, but not user facet
      assert.equal(facets.length, 2)
      const uris = facets.map(f => f.features[0].uri)
      assert.notInclude(uris, 'https://en.wikipedia.org/wiki/Special:Contributions/User')
    })

    it('handles multiple URLs in text', function() {
      const text = 'Article edited by User https://example.com/diff https://example.com/another'
      const facets = buildFacets(
        text,
        'Article',
        'User',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have page, user, and TWO URL facets
      assert.equal(facets.length, 4)
      assert.equal(facets[2].features[0].uri, 'https://example.com/diff')
      assert.equal(facets[3].features[0].uri, 'https://example.com/another')
    })

    it('preserves facet order: page, user, then URLs', function() {
      const text = 'TestPage edited by TestUser https://example.com/1 https://example.com/2'
      const facets = buildFacets(
        text,
        'TestPage',
        'TestUser',
        'https://en.wikipedia.org/wiki/TestPage',
        'https://en.wikipedia.org/wiki/Special:Contributions/TestUser'
      )

      assert.equal(facets.length, 4)
      assert.include(facets[0].features[0].uri, 'TestPage')
      assert.include(facets[1].features[0].uri, 'TestUser')
      assert.include(facets[2].features[0].uri, 'https://example.com/1')
      assert.include(facets[3].features[0].uri, 'https://example.com/2')
    })

    it('handles real Wikipedia diff URL format', function() {
      const text = 'Cat edited by User https://en.wikipedia.org/w/index.php?title=Cat&diff=123&oldid=456'
      const facets = buildFacets(
        text,
        'Cat',
        'User',
        'https://en.wikipedia.org/wiki/Cat',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      const urlFacet = facets.find(f => f.features[0].uri.includes('diff=123'))
      assert.exists(urlFacet)
      assert.equal(urlFacet.features[0].uri, 'https://en.wikipedia.org/w/index.php?title=Cat&diff=123&oldid=456')
    })

    it('returns correct facet structure with $type field', function() {
      const text = 'Article edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        'User',
        'https://en.wikipedia.org/wiki/Article',
        null
      )

      // Verify facet structure matches Bluesky spec
      const pageFacet = facets[0]
      assert.hasAllKeys(pageFacet, ['index', 'features'])
      assert.hasAllKeys(pageFacet.index, ['byteStart', 'byteEnd'])
      assert.isArray(pageFacet.features)
      assert.equal(pageFacet.features[0].$type, 'app.bsky.richtext.facet#link')
      assert.property(pageFacet.features[0], 'uri')
    })
  })

  describe('fitBlueskyText()', function() {
    // Count graphemes the way Bluesky does
    const graphemes = s => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length

    const DIFF_URL = 'https://en.wikipedia.org/w/index.php?diff=1310000000&oldid=1309999999'

    function makeText(page, name) {
      return `${page} Wikipedia article edited by ${name} ${DIFF_URL}`
    }

    it('returns text and page unchanged when within the limit', function() {
      const text = makeText('Cat', 'ExampleUser')
      const result = fitBlueskyText(text, 'Cat')
      assert.equal(result.text, text)
      assert.equal(result.page, 'Cat')
    })

    it('returns text unchanged at exactly the limit', function() {
      const page = 'x'.repeat(300 - graphemes(makeText('', 'User')))
      const text = makeText(page, 'User')
      assert.equal(graphemes(text), 300)
      const result = fitBlueskyText(text, page)
      assert.equal(result.text, text)
      assert.equal(result.page, page)
    })

    it('truncates the title with an ellipsis so the text fits, keeping the URL intact', function() {
      const page = 'A'.repeat(250)
      const text = makeText(page, 'ExampleUser')
      assert.isAbove(graphemes(text), 300)

      const result = fitBlueskyText(text, page)
      assert.isAtMost(graphemes(result.text), 300)
      assert.match(result.page, /…$/)
      assert.include(result.text, result.page)
      // The diff URL must survive whole at the end
      assert.isTrue(result.text.endsWith(DIFF_URL))
      // Everything after the title is untouched
      assert.include(result.text, ' Wikipedia article edited by ExampleUser ')
    })

    it('produces output buildFacets can still facet the title in', function() {
      const page = 'B'.repeat(250)
      const text = makeText(page, 'ExampleUser')
      const result = fitBlueskyText(text, page)

      const facets = buildFacets(
        result.text,
        result.page,
        'ExampleUser',
        'https://en.wikipedia.org/wiki/Foo',
        'https://en.wikipedia.org/wiki/Special:Contributions/ExampleUser'
      )
      const pageFacet = facets.find(f => f.features[0].uri === 'https://en.wikipedia.org/wiki/Foo')
      assert.exists(pageFacet)
      // Byte range covers exactly the truncated title at the start of the text
      assert.equal(pageFacet.index.byteStart, 0)
      assert.equal(pageFacet.index.byteEnd, Buffer.byteLength(result.page, 'utf8'))
    })

    it('counts graphemes, not code units: flag emoji do not trigger truncation', function() {
      // Each regional-indicator flag is 1 grapheme but 4 UTF-16 code units
      const name = '2001:db8::1 [🇺🇸]'
      const page = 'x'.repeat(300 - graphemes(makeText('', name)))
      const text = makeText(page, name)
      assert.equal(graphemes(text), 300)
      assert.isAbove(text.length, 300) // over the limit if you count code units

      const result = fitBlueskyText(text, page)
      assert.equal(result.text, text)
    })

    it('truncates multi-byte titles on grapheme boundaries', function() {
      const page = '金門公園'.repeat(70) // 280 graphemes, 840 bytes
      const text = makeText(page, 'ExampleUser')
      const result = fitBlueskyText(text, page)

      assert.isAtMost(graphemes(result.text), 300)
      assert.notInclude(result.text, '�')
      // Truncated title is a clean prefix of the original plus ellipsis
      const stem = result.page.slice(0, -1)
      assert.isTrue(page.startsWith(stem))
    })

    it('falls back to tail truncation when the title is not in the text', function() {
      const text = 'z'.repeat(400)
      const result = fitBlueskyText(text, 'Unrelated Title')
      assert.isAtMost(graphemes(result.text), 300)
      assert.match(result.text, /…$/)
    })

    it('falls back to tail truncation when the title cannot absorb the overflow', function() {
      // Title is short; the rest of the text alone exceeds the limit
      const text = makeText('Cat', 'u'.repeat(350))
      const result = fitBlueskyText(text, 'Cat')
      assert.isAtMost(graphemes(result.text), 300)
    })

    it('respects a custom limit argument', function() {
      const page = 'C'.repeat(80)
      const text = makeText(page, 'User')
      const result = fitBlueskyText(text, page, 100)
      assert.isAtMost(graphemes(result.text), 100)
      assert.isTrue(result.text.endsWith(DIFF_URL) || /…$/.test(result.text))
    })
  })
})
