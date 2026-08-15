const { assert } = require('chai')
const { describe, it, before, after, afterEach } = require('mocha')
const nock = require('nock')

const { app, renderCreatePage } = require('../public/server')

const WDQS = 'https://query.wikidata.org'

/** POST a form the way the create page's fetch() does. */
function postForm(base, path, fields) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  })
}

describe('create web flow', function() {
  this.timeout(5000)

  describe('renderCreatePage', function() {
    it('says so plainly when creation is not configured', function() {
      const html = renderCreatePage({ enabled: false })
      assert.include(html, 'not enabled here')
      assert.include(html, 'disabled')
    })

    it('renders an enabled form with the fields the API expects', function() {
      const html = renderCreatePage({ enabled: true })
      for (const field of
        ['invite_code', 'region_qid', 'languages', 'webhook_url', 'owner_user']) {
        assert.include(html, `name="${field}"`, `form is missing ${field}`)
      }
      assert.notInclude(html, 'not enabled here')
    })
  })

  describe('HTTP routes', function() {
    let server, base

    before(function(done) {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${server.address().port}`
        done()
      })
    })

    after(function(done) {
      server.close(done)
    })

    afterEach(function() {
      nock.cleanAll()
      delete app.locals.topicStore
      delete app.locals.webConfig
    })

    function enableCreation(store) {
      app.locals.topicStore = store
      app.locals.webConfig = { invite_codes: ['alpha'] }
    }

    it('GET /create serves the form', async function() {
      const res = await fetch(`${base}/create`)
      assert.equal(res.status, 200)
      assert.include(await res.text(), 'Make a place bot')
    })

    it('refuses creation when the deployment has no store configured',
      async function() {
        const res = await postForm(base, '/api/create', { invite_code: 'alpha' })

        assert.equal(res.status, 503)
        assert.include((await res.json()).error, 'not enabled')
      })

    it('reports a bad invite code as a 400 with the field named', async function() {
      enableCreation({})

      const res = await postForm(base, '/api/create',
        { invite_code: 'wrong', region_qid: 'Q62' })

      assert.equal(res.status, 400)
      assert.equal((await res.json()).field, 'invite_code')
    })

    it('creates through the store and returns what to tell the user',
      async function() {
        const calls = []
        enableCreation({
          upsertTopic: async (qid) => {
            calls.push('upsertTopic')
            return { id: 7, regionQid: qid, created: true }
          },
          addSubscription: async (topicId) => {
            calls.push('addSubscription')
            return { id: 11, topicId }
          },
          setTopicArticles: async () => {
            calls.push('setTopicArticles')
            return { added: [], removed: [], unchanged: 0, renamed: 0 }
          }
        })

        // resolveRegion, then articlesByAdmin. Stubbing WDQS keeps this a test
        // of the route rather than of Wikidata.
        nock(WDQS).post('/sparql').reply(200, {
          results: {
            bindings: [{
              cls: { value: 'http://www.wikidata.org/entity/Q515' },
              label: { value: 'Testville' },
              coord: { value: 'Point(-122.4 37.8)' }
            }]
          }
        })
        nock(WDQS).post('/sparql').reply(200, {
          results: {
            bindings: [{
              item: { value: 'http://www.wikidata.org/entity/Q10' },
              cls: { value: 'http://www.wikidata.org/entity/Q515' },
              article: { value: 'https://en.wikipedia.org/wiki/Alpha' },
              lang: { value: 'en' }
            }]
          }
        })
        // ...and the P159/P276/P39 membership queries come back empty.
        nock(WDQS).post('/sparql').times(3).reply(200, { results: { bindings: [] } })

        const res = await postForm(base, '/api/create', {
          invite_code: 'alpha',
          region_qid: 'Q62',
          languages: 'en',
          owner_user: 'Tester',
          webhook_url: 'https://discord.com/api/webhooks/1/abc'
        })

        const body = await res.json()
        assert.equal(res.status, 200, JSON.stringify(body))
        assert.equal(body.topicId, 7)
        assert.equal(body.subscriptionId, 11)
        assert.isTrue(body.created)

        assert.deepEqual(calls, ['upsertTopic', 'addSubscription', 'setTopicArticles'],
          'a bot is not finished until its articles are written')
      })

    it('refuses a non-Discord webhook before any store call', async function() {
      let touched = false
      enableCreation({
        upsertTopic: async () => { touched = true; return { id: 1, created: true } }
      })

      const res = await postForm(base, '/api/create', {
        invite_code: 'alpha',
        region_qid: 'Q62',
        owner_user: 'Tester',
        webhook_url: 'https://evil.test/api/webhooks/1/abc'
      })

      assert.equal(res.status, 400)
      assert.equal((await res.json()).field, 'webhook_url')
      assert.isFalse(touched, 'the store must not be touched for a refused webhook')
    })

    it('returns nothing for a place query too short to be meaningful',
      async function() {
        const res = await fetch(`${base}/api/places.json?q=a`)

        assert.equal(res.status, 200)
        assert.deepEqual((await res.json()).places, [])
      })

    it('maps Wikidata search hits to what the form needs', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          search: [
            { id: 'Q7469', label: 'Mission District', description: 'neighborhood' },
            { id: 'Q62', label: 'San Francisco' }
          ]
        })

      const res = await fetch(`${base}/api/places.json?q=mission`)

      assert.deepEqual((await res.json()).places, [
        { qid: 'Q7469', label: 'Mission District', description: 'neighborhood' },
        { qid: 'Q62', label: 'San Francisco', description: '' }
      ])
    })

    it('reports an upstream search failure as a 502 rather than crashing',
      async function() {
        nock('https://www.wikidata.org').get('/w/api.php').query(true).reply(500, 'nope')

        const res = await fetch(`${base}/api/places.json?q=mission`)
        assert.equal(res.status, 502)
      })
  })
})
