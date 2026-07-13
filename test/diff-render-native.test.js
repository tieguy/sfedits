const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const { buildDiffModel } = require('../lib/compare-diff')
const { renderDiffModelPng } = require('../lib/diff-render-native')

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'compare-api-response.json'), 'utf8')
)

describe('diff-render-native', function() {
  this.timeout(15000)

  it('renders the fixture diff to a PNG without a browser', async function() {
    const model = buildDiffModel(fixture.diff, 'Test Article', { description: 'A test subject' })
    const png = await renderDiffModelPng(model)
    assert.instanceOf(png, Buffer)
    assert.isAbove(png.length, 5000)
    // PNG magic bytes
    assert.equal(png.subarray(0, 4).toString('hex'), '89504e47')
  })

  it('renders highlight, add, and delete rows', async function() {
    const model = buildDiffModel([
      { type: 1, text: 'added line' },
      { type: 2, text: 'deleted line' },
      {
        type: 3,
        text: 'ranked secondthird by density',
        highlightRanges: [
          { start: 7, length: 6, type: 1 },
          { start: 13, length: 5, type: 0 }
        ]
      }
    ], 'Cat', {})
    const png = await renderDiffModelPng(model)
    assert.isAbove(png.length, 3000)
  })

  it('renders with a header image data URI', async function() {
    // 1x1 red PNG
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    const model = buildDiffModel([{ type: 1, text: 'x' }], 'Cat', { imageDataUri: px, description: 'a cat' })
    const png = await renderDiffModelPng(model)
    assert.isAbove(png.length, 1000)
  })
})
