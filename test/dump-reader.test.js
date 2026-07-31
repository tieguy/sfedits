const { assert } = require('chai')
const { parseIndex, planBlocks, extractPages, decodeEntities } = require('../lib/dump-reader')

describe('dump-reader', function() {
  describe('parseIndex', function() {
    it('maps titles to their block offset', function() {
      const idx = parseIndex('608:10:AccessibleComputing\n608:12:Anarchism\n9182:25:Autism\n')
      assert.equal(idx.get('Anarchism'), 608)
      assert.equal(idx.get('Autism'), 9182)
    })

    it('keeps colons that belong to the title', function() {
      // "Wikipedia:Foo" and "Talk:Bar" are legitimate titles
      const idx = parseIndex('100:5:Wikipedia:Village pump\n')
      assert.equal(idx.get('Wikipedia:Village pump'), 100)
    })

    it('ignores blank and malformed lines', function() {
      const idx = parseIndex('\n608:10:Real\nnot-a-line\n\n')
      assert.equal(idx.size, 1)
      assert.equal(idx.get('Real'), 608)
    })
  })

  describe('planBlocks', function() {
    const offsets = new Map([['A', 100], ['B', 100], ['C', 500], ['D', 900]])
    const all = [100, 500, 900]

    it('groups titles that share a block into one request', function() {
      const { blocks } = planBlocks(['A', 'B'], offsets, all)
      assert.lengthOf(blocks, 1, 'A and B are in the same block')
      assert.deepEqual(blocks[0].titles.sort(), ['A', 'B'])
    })

    it('bounds each block by the start of the next one', function() {
      const { blocks } = planBlocks(['A', 'C'], offsets, all)
      assert.deepEqual(blocks.map(b => [b.start, b.end]), [[100, 499], [500, 899]])
    })

    it('leaves the final block unbounded', function() {
      const { blocks } = planBlocks(['D'], offsets, all)
      assert.equal(blocks[0].end, null)
    })

    it('reports titles absent from the index rather than silently dropping them', function() {
      const { blocks, missing } = planBlocks(['A', 'Nonexistent'], offsets, all)
      assert.deepEqual(missing, ['Nonexistent'])
      assert.lengthOf(blocks, 1)
    })

    it('returns blocks in file order so requests are sequential', function() {
      const { blocks } = planBlocks(['D', 'A', 'C'], offsets, all)
      assert.deepEqual(blocks.map(b => b.start), [100, 500, 900])
    })
  })

  describe('extractPages', function() {
    const xml = `<page><title>Oakland</title><revision><text bytes="9">Hello [[Berkeley]]</text></revision></page>
<page><title>Berkeley</title><revision><text>World</text></revision></page>`

    it('pulls every page in the fragment', function() {
      const pages = extractPages(xml)
      assert.deepEqual([...pages.keys()], ['Oakland', 'Berkeley'])
      assert.equal(pages.get('Oakland'), 'Hello [[Berkeley]]')
    })

    it('handles a page with no text element', function() {
      const pages = extractPages('<page><title>Empty</title></page>')
      assert.equal(pages.get('Empty'), '')
    })

    it('decodes the entities the dump escapes', function() {
      const pages = extractPages(
        '<page><title>A&amp;B</title><revision><text>&lt;ref&gt;x&lt;/ref&gt;</text></revision></page>')
      assert.equal(pages.get('A&B'), '<ref>x</ref>')
    })
  })

  describe('decodeEntities', function() {
    it('decodes ampersand last so &amp;lt; does not become <', function() {
      assert.equal(decodeEntities('&amp;lt;'), '&lt;')
    })
  })
})

describe('dump-reader readBlock', function() {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { readBlock } = require('../lib/dump-reader')

  // A two-stream file, the shape a multistream dump has: independent bzip2
  // streams concatenated, each decodable on its own.
  let file, fd, firstLen, total
  before(function() {
    const { execFileSync } = require('child_process')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumptest-'))
    file = path.join(tmp, 'two.bz2')
    const a = execFileSync('bzip2', ['-c'], { input: '<page><title>A</title><revision><text>alpha</text></revision></page>', maxBuffer: 1e7 })
    const b = execFileSync('bzip2', ['-c'], { input: '<page><title>B</title><revision><text>beta</text></revision></page>', maxBuffer: 1e7 })
    firstLen = a.length
    fs.writeFileSync(file, Buffer.concat([a, b]))
    total = a.length + b.length
    fd = fs.openSync(file, 'r')
  })
  after(function() { if (fd) fs.closeSync(fd) })

  it('decodes a bounded block from the middle of the file', function() {
    const xml = readBlock(fd, { start: 0, end: firstLen - 1 })
    assert.include(xml, '<title>A</title>')
    assert.notInclude(xml, '<title>B</title>', 'must not bleed into the next stream')
  })

  it('decodes the final unbounded block when given the file size', function() {
    const xml = readBlock(fd, { start: firstLen, end: null }, { fileSize: total })
    assert.include(xml, '<title>B</title>')
  })

  it('refuses an unbounded block without a file size rather than guessing', function() {
    assert.throws(() => readBlock(fd, { start: 0, end: null }), /fileSize/)
  })
})
