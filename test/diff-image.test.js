const { describe, it } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const proxyquire = require('proxyquire')

describe('diff-image', function() {
  afterEach(function() {
    nock.cleanAll()
  })

  describe('captureDiffImage', function() {
    it('returns null when native renderer throws', async function() {
      // Stub renderDiffModelToFile to throw, simulating a native render failure.
      // Verifies the new contract: captureDiffImage throws or returns null on
      // renderer failure (no browser fallback path).
      const captureDiffImage = proxyquire('../lib/diff-image', {
        './diff-render-native': {
          renderDiffModelToFile: async () => {
            throw new Error('Render failed (simulated)')
          }
        }
      }).captureDiffImage

      // Mock the compare API to return a valid diff
      nock('https://en.wikipedia.org')
        .get('/w/rest.php/v1/compare/123/456')
        .reply(200, {
          diff: [
            { type: 1, text: 'added line', lineNumber: 1 }
          ]
        })

      // Mock page summary fetch (fail-soft)
      nock('https://en.wikipedia.org')
        .get('/w/rest.php/v1/page/San_Francisco')
        .reply(404)

      const result = await captureDiffImage(
        'https://en.wikipedia.org/w/index.php?diff=123&oldid=456',
        'San Francisco'
      )

      assert.isNull(result, 'Should return null when renderer throws')
    })
  })
})
