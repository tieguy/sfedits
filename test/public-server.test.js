const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildTopics, renderPage, topicsNeedRetry, app, shutdownCleanly } = require('../public/server')

describe('public-server', function() {

  describe('buildTopics', function() {
    let tmpDir

    beforeEach(function() {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-server-test-'))
      nock.cleanAll()
    })

    afterEach(function() {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      nock.cleanAll()
    })

    const config = {
      accounts: [{
        watchlist: {
          'English Wikipedia': { 'Daniel Lurie': true, 'London Breed': true }
        },
        watchlist_source: {
          project: 'California/San Francisco Bay Area task force',
          importance: ['Top', 'High']
        },
        wikidata_claims: {
          properties: ['P19', 'P131']
        }
      }]
    }

    function mockProjectPages(titles) {
      nock('https://en.wikipedia.org')
        .get('/w/api.php')
        .query(q => q.list === 'projectpages')
        .reply(200, {
          query: {
            projects: {
              'California/San Francisco Bay Area task force': titles.map(t => ({
                title: t, ns: 0, assessment: { importance: 'Top' }
              }))
            }
          }
        })
    }

    function mockSparql() {
      nock('https://query.wikidata.org')
        .post('/sparql')
        .times(9)
        .reply(200, { results: { bindings: [
          { p: { value: 'http://www.wikidata.org/entity/Q62' } },
          { p: { value: 'http://www.wikidata.org/entity/Q17042' } }
        ] } })
      nock('https://query.wikidata.org')
        .post('/sparql')
        .times(9)
        .reply(200, { results: { bindings: [
          { pos: { value: 'http://www.wikidata.org/entity/Q795295' } }
        ] } })
    }

    it('assembles static, dynamic, and claim-watch topic data', async function() {
      mockProjectPages(['Golden Gate Bridge', 'Alcatraz Island'])
      mockSparql()

      const topics = await buildTopics(config, { dataDir: tmpDir })

      assert.deepEqual(topics.staticWatchlist['English Wikipedia'],
        ['Daniel Lurie', 'London Breed'])
      assert.equal(topics.dynamic.project, 'California/San Francisco Bay Area task force')
      assert.sameMembers(topics.dynamic.articles, ['Golden Gate Bridge', 'Alcatraz Island'])
      assert.deepEqual(topics.dynamic.importance, ['Top', 'High'])
      assert.equal(topics.claims.placeCount, 10) // 9 counties + Q17042 (Q62 is a county)
      assert.equal(topics.claims.positionCount, 1)
      assert.include(topics.claims.properties.map(p => p.id), 'P19')
      assert.isOk(topics.updated_at)
    })

    it('survives a PageAssessments failure with empty dynamic list', async function() {
      nock('https://en.wikipedia.org')
        .get('/w/api.php')
        .query(true)
        .reply(500)
      mockSparql()

      const topics = await buildTopics(config, { dataDir: tmpDir })
      assert.deepEqual(topics.dynamic.articles, [])
      assert.equal(topics.claims.placeCount, 10)
    })

    // The coverage page has to describe whatever source the bot is actually
    // using. Under a titles_url config it was querying PageAssessments with an
    // undefined project name and rendering "undefined WikiProject listing".
    it('describes a titles_url source without touching PageAssessments', async function() {
      nock('https://san-francisco-edit-stream.toolforge.org')
        .get('/watchlist-500.json')
        .reply(200, { count: 2, titles: ['Ohlone', 'Golden Gate Bridge'] })
      mockSparql()

      const listConfig = {
        accounts: [{
          watchlist_source: {
            titles_url: 'https://san-francisco-edit-stream.toolforge.org/watchlist-500.json'
          },
          wikidata_claims: { properties: ['P19'] }
        }]
      }
      const topics = await buildTopics(listConfig, { dataDir: tmpDir })

      assert.deepEqual(topics.dynamic.articles, ['Golden Gate Bridge', 'Ohlone'])
      assert.isNull(topics.dynamic.importance)
      assert.notInclude(String(topics.dynamic.project), 'undefined')
      assert.include(renderPage(topics), 'Golden Gate Bridge')
      assert.notInclude(renderPage(topics), 'undefined')
    })

    it('handles accounts with no claim watch or dynamic source', async function() {
      const bare = { accounts: [{ watchlist: { 'English Wikipedia': { 'Cat': true } } }] }
      const topics = await buildTopics(bare, { dataDir: tmpDir })
      assert.deepEqual(topics.staticWatchlist['English Wikipedia'], ['Cat'])
      assert.isNull(topics.dynamic)
      assert.isNull(topics.claims)
    })

    it('marks dynamic.error when the title list fetch fails', async function() {
      nock('https://san-francisco-edit-stream.toolforge.org')
        .get('/watchlist-500.json')
        .reply(503)
      mockSparql()

      const listConfig = {
        accounts: [{
          watchlist_source: {
            titles_url: 'https://san-francisco-edit-stream.toolforge.org/watchlist-500.json'
          },
          wikidata_claims: { properties: ['P19'] }
        }]
      }
      const topics = await buildTopics(listConfig, { dataDir: tmpDir })

      assert.deepEqual(topics.dynamic.articles, [])
      assert.include(topics.dynamic.error, '503')
    })

    it('leaves dynamic.error unset when the fetch succeeds', async function() {
      nock('https://san-francisco-edit-stream.toolforge.org')
        .get('/watchlist-500.json')
        .reply(200, { count: 1, titles: ['Ohlone'] })
      mockSparql()

      const listConfig = {
        accounts: [{
          watchlist_source: {
            titles_url: 'https://san-francisco-edit-stream.toolforge.org/watchlist-500.json'
          },
          wikidata_claims: { properties: ['P19'] }
        }]
      }
      const topics = await buildTopics(listConfig, { dataDir: tmpDir })

      assert.notProperty(topics.dynamic, 'error')
    })
  })

  // A deploy rollout can beat the front proxy: the fresh pod's startup
  // refresh fetches its own public URL, gets a 503, and without a retry the
  // coverage page shows zero articles until the daily refresh.
  describe('topicsNeedRetry', function() {
    it('wants a retry when no snapshot was ever built', function() {
      assert.isTrue(topicsNeedRetry(null))
      assert.isTrue(topicsNeedRetry(undefined))
    })

    it('wants a retry when the dynamic fetch failed', function() {
      assert.isTrue(topicsNeedRetry({
        dynamic: { titles_url: 'https://example.org/x.json', articles: [], error: 'Title list fetch returned 503' }
      }))
    })

    it('is satisfied by a healthy snapshot', function() {
      assert.isFalse(topicsNeedRetry({
        dynamic: { titles_url: 'https://example.org/x.json', articles: ['Ohlone'] }
      }))
    })

    it('is satisfied when there is no dynamic source at all', function() {
      assert.isFalse(topicsNeedRetry({ dynamic: null }))
    })
  })

  describe('renderPage', function() {
    const topics = {
      staticWatchlist: { 'English Wikipedia': ['Daniel Lurie'] },
      dynamic: {
        project: 'California/San Francisco Bay Area task force',
        importance: ['Top', 'High'],
        articles: ['Golden Gate Bridge', 'A <script>alert(1)</script> title']
      },
      claims: {
        properties: [{ id: 'P19', label: 'place of birth' }],
        placeCount: 11603,
        positionCount: 249
      },
      updated_at: '2026-07-22T12:00:00Z'
    }

    it('renders article links and claim-watch summary', function() {
      const html = renderPage(topics)
      assert.include(html, 'Golden Gate Bridge')
      assert.include(html, 'https://en.wikipedia.org/wiki/Golden_Gate_Bridge')
      assert.include(html, 'place of birth')
      assert.include(html, '11,603')
      assert.include(html, '249')
      assert.include(html, 'Daniel Lurie')
    })

    it('escapes HTML in article titles', function() {
      const html = renderPage(topics)
      assert.notInclude(html, '<script>alert(1)</script>')
      assert.include(html, '&lt;script&gt;')
    })
  })

  describe('HTTP routes', function() {
    let server, base

    before(function(done) {
      // Seed the app with topics directly - no network needed
      app.locals.topics = {
        staticWatchlist: { 'English Wikipedia': ['Daniel Lurie'] },
        dynamic: { project: 'Test', importance: [], articles: ['Golden Gate Bridge'] },
        claims: { properties: [{ id: 'P19', label: 'place of birth' }], placeCount: 5, positionCount: 2 },
        updated_at: '2026-07-22T12:00:00Z'
      }
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${server.address().port}`
        done()
      })
    })

    after(function(done) {
      server.close(done)
    })

    it('GET / returns the topics page', async function() {
      const res = await fetch(`${base}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.include(html, 'Golden Gate Bridge')
    })

    it('GET /api/topics.json returns the raw data', async function() {
      const res = await fetch(`${base}/api/topics.json`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.deepEqual(data.dynamic.articles, ['Golden Gate Bridge'])
    })

    it('GET /toolinfo.json returns tool metadata', async function() {
      const res = await fetch(`${base}/toolinfo.json`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.name, 'san-francisco-edit-stream')
      assert.isOk(data.repository)
    })

    it('GET /matrix serves the committed triage-matrix snapshot', async function() {
      const res = await fetch(`${base}/matrix`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.include(html, 'triage matrix')
      assert.include(html, 'Data snapshot:')
    })

    // The bot fetches its own watchlist from here, so these two routes are a
    // runtime dependency of the deployment, not just a transparency page.
    it('GET /watchlist-500.json serves the published bot watchlist', async function() {
      const res = await fetch(`${base}/watchlist-500.json`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.count, 500)
      assert.lengthOf(data.titles, 500)
      assert.isOk(data.generated_at)
      assert.isOk(data.method)
    })

    it('GET /watchlist-2500.json serves the published wide list', async function() {
      const res = await fetch(`${base}/watchlist-2500.json`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.count, 2500)
      assert.lengthOf(data.titles, 2500)
    })

    it('GET /ranking.json serves the full published ranking', async function() {
      const res = await fetch(`${base}/ranking.json`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.isOk(data.generated_at)
      assert.isOk(data.method)
      assert.equal(data.count, data.articles.length)
      assert.equal(data.universe, data.articles.length)
      const first = data.articles[0]
      assert.containsAllKeys(first, ['title', 'importance', 'inlinks', 'tier'])
    })

    it('publishes the bot list as a strict prefix of the wide list', async function() {
      const narrow = await (await fetch(`${base}/watchlist-500.json`)).json()
      const wide = await (await fetch(`${base}/watchlist-2500.json`)).json()
      assert.deepEqual(narrow.titles, wide.titles.slice(0, narrow.titles.length))
    })

    it('GET / returns 503 when topics have not loaded yet', async function() {
      const saved = app.locals.topics
      app.locals.topics = null
      const res = await fetch(`${base}/`)
      assert.equal(res.status, 503)
      app.locals.topics = saved
    })
  })

  describe('shutdownCleanly', function() {
    // A deploy restarts the webservice with SIGTERM. Stopping has to close the
    // listener and drain the ToolsDB pool, rather than leaving both for the
    // SIGKILL that follows.
    it('closes the listener and the topic store', async function() {
      const server = app.listen(0)
      await new Promise(resolve => server.once('listening', resolve))
      const port = server.address().port

      let closed = false
      app.locals.topicStore = { close: async () => { closed = true } }

      await shutdownCleanly(server)

      assert.isTrue(closed, 'the pool was left open')
      assert.isNull(app.locals.topicStore)
      assert.isFalse(server.listening)
      let refused = false
      try {
        await fetch(`http://127.0.0.1:${port}/`)
      } catch {
        refused = true
      }
      assert.isTrue(refused, 'still accepting connections after shutdown')
    })

    it('stops cleanly when there is no topic store', async function() {
      const server = app.listen(0)
      await new Promise(resolve => server.once('listening', resolve))
      app.locals.topicStore = null

      await shutdownCleanly(server)
      assert.isFalse(server.listening)
    })
  })
})
