const { assert } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

const app = require('../admin/server')
const { resolveForConsole } = app

const WDQS = 'https://query.wikidata.org'
function bindings(rows) { return { results: { bindings: rows } } }
function entity(qid) { return { value: `http://www.wikidata.org/entity/${qid}` } }

describe('resolveForConsole', function() {
  beforeEach(function() { nock.disableNetConnect() })
  afterEach(function() { nock.cleanAll(); nock.enableNetConnect() })

  it('surfaces a container suggestion for a boundaryless region (needs_confirmation)', async function() {
    // resolveRegion: neighborhood (geo), has a coord, no P402
    nock(WDQS).post('/sparql').reply(200, bindings([
      { cls: entity('Q123705'), label: { value: 'Mission District' },
        coord: { value: 'Point(-122.42 37.76)' } }
    ]))
    // resolveBoundary tier 2: P131 parent Q62 carries a boundary
    nock(WDQS).post('/sparql', body => body.query.includes('wd:Q7469')).reply(200, bindings([
      { parent: entity('Q62'), parentLabel: { value: 'San Francisco' },
        osm: { value: '111968' }, cls: entity('Q1093829') }
    ]))

    const result = await resolveForConsole('Q7469', { languages: ['en'] })

    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.region.label, 'Mission District')
    assert.deepEqual(result.suggestion,
      { qid: 'Q62', label: 'San Francisco', class: 'Q1093829', via: 'p131' })
  })

  it('returns a resolved count for an administrative region', async function() {
    nock(WDQS).post('/sparql').reply(200, bindings([
      { cls: entity('Q62049'), label: { value: 'San Francisco' } }
    ]))
    nock(WDQS).post('/sparql').reply(200, bindings([
      { item: entity('Q10'), cls: entity('Q515'),
        article: { value: 'https://en.wikipedia.org/wiki/Alpha' }, lang: { value: 'en' } }
    ]))

    const result = await resolveForConsole('Q62', { languages: ['en'] })

    assert.equal(result.status, 'resolved')
    assert.equal(result.region.label, 'San Francisco')
    assert.equal(result.count, 1)
    assert.isNotTrue(result.approximate)
  })

  it('flags approximate for the radius fallback', async function() {
    nock(WDQS).post('/sparql').reply(200, bindings([
      { cls: entity('Q123705'), label: { value: 'Orphan' }, coord: { value: 'Point(0 0)' } }
    ]))
    nock(WDQS).post('/sparql', body => body.query.includes('wd:Q999')).reply(200, bindings([
      { parent: entity('Q100'), parentLabel: { value: 'Unbounded' }, cls: entity('Q1') }
    ]))
    nock(WDQS).post('/sparql', body => body.query.includes('wd:Q100')).reply(200, bindings([]))
    nock(WDQS).post('/sparql').reply(200, bindings([
      { item: entity('Q10'), cls: entity('Q515'), coord: { value: 'Point(0 0)' },
        article: { value: 'https://en.wikipedia.org/wiki/X' }, lang: { value: 'en' } }
    ]))

    const result = await resolveForConsole('Q999', { languages: ['en'] })

    assert.equal(result.status, 'resolved')
    assert.isTrue(result.approximate)
    assert.equal(result.count, 1)
  })

  it('returns an error result for an invalid QID', async function() {
    const result = await resolveForConsole('62', {})
    assert.equal(result.status, 'error')
    assert.isOk(result.error)
  })
})

describe('POST /api/region/resolve', function() {
  let server, base

  before(function(done) {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      done()
    })
  })

  after(function(done) { server.close(done) })

  it('requires authentication', async function() {
    const res = await fetch(`${base}/api/region/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qid: 'Q7469' })
    })
    assert.equal(res.status, 401)
  })
})
