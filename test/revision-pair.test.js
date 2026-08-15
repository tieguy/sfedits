const { describe, it, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')

const { fetchRevisionPair } = require('../lib/revision-pair')

const DIFF_URL = 'https://en.wikipedia.org/w/index.php?diff=200&oldid=100'

function apiReply(pages) {
  return { query: { pages } }
}

describe('revision-pair', function () {
  afterEach(function () { nock.cleanAll() })

  it('fetches both revisions in one batched request and returns texts + tags', async function () {
    nock('https://en.wikipedia.org')
      .get('/w/api.php')
      .query(q => q.revids === '100|200' && q.prop === 'revisions')
      .reply(200, apiReply([{
        pageid: 1, title: 'X', revisions: [
          { revid: 200, tags: ['mw-undo'], slots: { main: { content: 'new text' } } },
          { revid: 100, tags: [], slots: { main: { content: 'old text' } } }
        ]
      }]))
    const pair = await fetchRevisionPair(DIFF_URL)
    assert.equal(pair.prev, 'old text')
    assert.equal(pair.curr, 'new text')
    assert.deepEqual(pair.tags, ['mw-undo'])
  })

  it('returns null for an unparseable or prev-less diff URL without fetching', async function () {
    assert.isNull(await fetchRevisionPair('https://en.wikipedia.org/wiki/Whatever'))
    assert.isNull(await fetchRevisionPair('https://en.wikipedia.org/w/index.php?diff=200'))
  })

  it('returns null content for a revision the API withholds (revdeleted)', async function () {
    nock('https://en.wikipedia.org')
      .get('/w/api.php')
      .query(q => q.revids === '100|200')
      .reply(200, apiReply([{
        pageid: 1, title: 'X', revisions: [
          { revid: 200, tags: [], slots: { main: { content: 'new text' } } },
          { revid: 100, texthidden: true, tags: [], slots: { main: {} } }
        ]
      }]))
    const pair = await fetchRevisionPair(DIFF_URL)
    assert.isNull(pair.prev)
    assert.equal(pair.curr, 'new text')
  })
})
