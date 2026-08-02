const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  parseClaimEdit,
  matchClaim,
  RateCap,
  ClaimDedupe,
  refreshTargetSets,
  handleWikidataEdit
} = require('../lib/wikidata-claim-watch')

describe('wikidata-claim-watch', function() {

  describe('parseClaimEdit', function() {
    it('parses a claim creation (wbsetclaim-create)', function() {
      const parsed = parseClaimEdit('/* wbsetclaim-create:2||1 */ [[Property:P19]]: [[Q62]]')
      assert.deepEqual(parsed, { action: 'added', property: 'P19', value: 'Q62' })
    })

    it('parses a claim creation (wbcreateclaim-create) with trailing text', function() {
      const parsed = parseClaimEdit(
        '/* wbcreateclaim-create:1| */ [[Property:P31]]: [[Q2251745]], #quickstatements; #temporary_batch_123')
      assert.deepEqual(parsed, { action: 'added', property: 'P31', value: 'Q2251745' })
    })

    it('parses a claim removal', function() {
      const parsed = parseClaimEdit('/* wbremoveclaims-remove:1| */ [[Property:P19]]: [[Q62]]')
      assert.deepEqual(parsed, { action: 'removed', property: 'P19', value: 'Q62' })
    })

    it('parses a claim value update as changed', function() {
      const parsed = parseClaimEdit('/* wbsetclaim-update:2||1 */ [[Property:P159]]: [[Q17042]]')
      assert.deepEqual(parsed, { action: 'changed', property: 'P159', value: 'Q17042' })
    })

    it('ignores rank-only updates', function() {
      assert.isNull(parseClaimEdit(
        '/* wbsetclaim-update-rank:1||1 */ [[Property:P131]]: [[Q14559010]], remove preferred rank'))
    })

    it('ignores string-valued claims (no Q-id value)', function() {
      assert.isNull(parseClaimEdit(
        '/* wbremoveclaims-remove:1| */ [[Property:P435]]: f7594d37-2c54-4882-bbfb-8aa9293ef10b'))
    })

    it('ignores comments with no claim structure', function() {
      assert.isNull(parseClaimEdit('/* wbeditentity-update:0| */ bulk import'))
      assert.isNull(parseClaimEdit('reverted vandalism'))
      assert.isNull(parseClaimEdit(''))
      assert.isNull(parseClaimEdit(null))
    })
  })

  describe('matchClaim', function() {
    const sets = {
      places: new Set(['Q62', 'Q17042']),
      positions: new Set(['Q795295'])
    }
    const claimsConfig = { properties: ['P19', 'P20', 'P131', 'P159'] }

    it('matches a watched property with a Bay Area place value', function() {
      const hit = matchClaim({ action: 'added', property: 'P19', value: 'Q62' }, sets, claimsConfig)
      assert.deepEqual(hit, { kind: 'place' })
    })

    it('matches P39 with a Bay Area position value', function() {
      const hit = matchClaim({ action: 'added', property: 'P39', value: 'Q795295' }, sets, claimsConfig)
      assert.deepEqual(hit, { kind: 'position' })
    })

    it('rejects a watched property with a non-Bay-Area value', function() {
      assert.isNull(matchClaim({ action: 'added', property: 'P19', value: 'Q90' }, sets, claimsConfig))
    })

    it('rejects an unwatched property even with a Bay Area value', function() {
      assert.isNull(matchClaim({ action: 'added', property: 'P106', value: 'Q62' }, sets, claimsConfig))
    })

    it('rejects P39 with a position not in the positions set', function() {
      assert.isNull(matchClaim({ action: 'added', property: 'P39', value: 'Q30185' }, sets, claimsConfig))
    })
  })

  describe('RateCap', function() {
    it('allows up to max posts per window, then blocks', function() {
      let fakeNow = 1000000
      const cap = new RateCap({ max: 2, windowMs: 600000, now: () => fakeNow })
      assert.isTrue(cap.tryTake())
      assert.isTrue(cap.tryTake())
      assert.isFalse(cap.tryTake())
      assert.equal(cap.suppressed, 1)
    })

    it('resets after the window passes and reports suppressed count', function() {
      let fakeNow = 1000000
      const cap = new RateCap({ max: 1, windowMs: 600000, now: () => fakeNow })
      assert.isTrue(cap.tryTake())
      assert.isFalse(cap.tryTake())
      assert.isFalse(cap.tryTake())
      fakeNow += 600001
      const summary = cap.drainSuppressed()
      assert.equal(summary, 2)
      assert.isTrue(cap.tryTake())
      assert.equal(cap.suppressed, 0)
    })
  })

  describe('ClaimDedupe', function() {
    const claim = { page: 'Q1', property: 'P19', value: 'Q62' }

    it('suppresses a changed action repeating a recent post', function() {
      let fakeNow = 1000000
      const dedupe = new ClaimDedupe({ ttlMs: 45000, now: () => fakeNow })
      dedupe.record({ ...claim, action: 'added' })
      fakeNow += 5000
      assert.isTrue(dedupe.isDuplicate({ ...claim, action: 'changed' }))
    })

    it('suppresses an identical repeated action (stream replay)', function() {
      let fakeNow = 1000000
      const dedupe = new ClaimDedupe({ ttlMs: 45000, now: () => fakeNow })
      dedupe.record({ ...claim, action: 'added' })
      assert.isTrue(dedupe.isDuplicate({ ...claim, action: 'added' }))
    })

    it('lets a removal through right after an addition', function() {
      const dedupe = new ClaimDedupe({ ttlMs: 45000, now: () => 1000000 })
      dedupe.record({ ...claim, action: 'added' })
      assert.isFalse(dedupe.isDuplicate({ ...claim, action: 'removed' }))
    })

    it('forgets entries once the TTL passes', function() {
      let fakeNow = 1000000
      const dedupe = new ClaimDedupe({ ttlMs: 45000, now: () => fakeNow })
      dedupe.record({ ...claim, action: 'added' })
      fakeNow += 45001
      assert.isFalse(dedupe.isDuplicate({ ...claim, action: 'changed' }))
    })

    it('keys on page, property, and value independently', function() {
      const dedupe = new ClaimDedupe({ ttlMs: 45000, now: () => 1000000 })
      dedupe.record({ ...claim, action: 'added' })
      assert.isFalse(dedupe.isDuplicate({ ...claim, page: 'Q2', action: 'changed' }))
      assert.isFalse(dedupe.isDuplicate({ ...claim, property: 'P20', action: 'changed' }))
      assert.isFalse(dedupe.isDuplicate({ ...claim, value: 'Q17042', action: 'changed' }))
    })
  })

  describe('refreshTargetSets', function() {
    let tmpDir

    beforeEach(function() {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-claims-test-'))
      nock.cleanAll()
    })

    afterEach(function() {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      nock.cleanAll()
    })

    function sparqlReply(qids) {
      return {
        results: {
          bindings: qids.map(q => ({
            p: { value: `http://www.wikidata.org/entity/${q}` }
          }))
        }
      }
    }

    it('builds place and position sets from SPARQL and writes a cache', async function() {
      // 9 per-county place queries, then 9 per-county position queries
      nock('https://query.wikidata.org')
        .post('/sparql')
        .times(9)
        .reply(200, sparqlReply(['Q62', 'Q17042']))
      nock('https://query.wikidata.org')
        .post('/sparql')
        .times(9)
        .reply(200, sparqlReply(['Q795295']))

      const sets = await refreshTargetSets({}, { dataDir: tmpDir })
      assert.isTrue(sets.places.has('Q62'))
      assert.isTrue(sets.places.has('Q17042'))
      assert.isTrue(sets.positions.has('Q795295'))

      const cache = JSON.parse(fs.readFileSync(path.join(tmpDir, 'wikidata-claim-targets.json')))
      assert.include(cache.places, 'Q62')
      assert.include(cache.positions, 'Q795295')
    })

    it('falls back to the cache when SPARQL fails', async function() {
      fs.writeFileSync(path.join(tmpDir, 'wikidata-claim-targets.json'),
        JSON.stringify({ fetched_at: 'x', places: ['Q62'], positions: ['Q795295'] }))
      nock('https://query.wikidata.org')
        .post('/sparql')
        .times(18)
        .reply(500)

      const sets = await refreshTargetSets({}, { dataDir: tmpDir })
      assert.isTrue(sets.places.has('Q62'))
      assert.isTrue(sets.positions.has('Q795295'))
    })

    it('returns empty sets when SPARQL fails and no cache exists', async function() {
      nock('https://query.wikidata.org')
        .post('/sparql')
        .times(18)
        .reply(500)

      const sets = await refreshTargetSets({}, { dataDir: tmpDir })
      assert.equal(sets.places.size, 0)
      assert.equal(sets.positions.size, 0)
    })
  })

  describe('handleWikidataEdit', function() {
    const account = {
      discord: { webhook_url: 'https://discord.com/api/webhooks/123/abc' },
      wikidata_claims: { properties: ['P19'] }
    }
    const edit = {
      page: 'Q4910791',
      url: 'https://www.wikidata.org/w/index.php?diff=2&oldid=1',
      comment: '/* wbsetclaim-create:2||1 */ [[Property:P19]]: [[Q62]]',
      wikipedia: 'Wikidata',
      user: 'ExampleUser',
      userUrl: 'https://www.wikidata.org/wiki/User:ExampleUser'
    }
    const sets = { places: new Set(['Q62']), positions: new Set() }

    afterEach(function() {
      nock.cleanAll()
    })

    it('posts a Discord embed for a matching claim edit', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(q => q.action === 'wbgetentities')
        .reply(200, {
          entities: {
            Q4910791: { labels: { en: { value: 'Barry Zito' } } },
            Q62: { labels: { en: { value: 'San Francisco' } } },
            P19: { labels: { en: { value: 'place of birth' } } }
          }
        })

      let posted = null
      nock('https://discord.com')
        .post('/api/webhooks/123/abc', body => { posted = body; return true })
        .query(true)
        .reply(204)

      const result = await handleWikidataEdit(account, edit, { sets, noop: false })
      assert.isOk(result)
      assert.isOk(posted, 'webhook should have been called')
      const embed = posted.embeds[0]
      assert.include(embed.title, 'Barry Zito')
      assert.include(embed.description, 'place of birth')
      assert.include(embed.description, 'San Francisco')
      assert.include(embed.description, 'Added')
      assert.equal(embed.url, edit.url)
      // Wikidata branding: named author row with the logo as its icon
      assert.equal(embed.author.name, 'Wikidata')
      assert.match(embed.author.icon_url, /Wikidata-logo/)
    })

    it('does nothing for a non-matching claim edit', async function() {
      const result = await handleWikidataEdit(account,
        { ...edit, comment: '/* wbsetclaim-create:2||1 */ [[Property:P19]]: [[Q90]]' },
        { sets, noop: false })
      assert.isNull(result)
    })

    it('skips posting in noop mode but still reports the match', async function() {
      const result = await handleWikidataEdit(account, edit, { sets, noop: true })
      assert.isOk(result)
      assert.equal(result.noop, true)
    })

    it('respects the rate cap', async function() {
      let fakeNow = 5000000
      const cap = new RateCap({ max: 1, windowMs: 600000, now: () => fakeNow })

      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(q => q.action === 'wbgetentities')
        .reply(200, { entities: {} })
      nock('https://discord.com')
        .post('/api/webhooks/123/abc')
        .query(true)
        .reply(204)

      const first = await handleWikidataEdit(account, edit, { sets, noop: false, rateCap: cap })
      assert.isOk(first)
      const second = await handleWikidataEdit(account, edit, { sets, noop: false, rateCap: cap })
      assert.isNull(second)
      assert.equal(cap.suppressed, 1)
    })

    // Old revision 1 held P19 = Q18013 (Fresno) in these helpers
    function nockOldRevision(claims) {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(q => q.action === 'query')
        .reply(200, {
          query: {
            pages: [{
              revisions: [{
                slots: { main: { content: JSON.stringify({ claims }) } }
              }]
            }]
          }
        })
    }

    function nockLabels(entities) {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(q => q.action === 'wbgetentities')
        .reply(200, { entities })
    }

    function nockDiscord(capture) {
      nock('https://discord.com')
        .post('/api/webhooks/123/abc', body => { capture.body = body; return true })
        .query(true)
        .reply(204)
    }

    const changedEdit = {
      ...edit,
      comment: '/* wbsetclaim-update:2||1 */ [[Property:P19]]: [[Q62]]'
    }

    it('shows old → new when a changed claim had one prior value', async function() {
      nockOldRevision({ P19: [{ mainsnak: { datavalue: { value: { id: 'Q18013' } } } }] })
      nockLabels({
        Q4910791: { labels: { en: { value: 'Barry Zito' } } },
        Q62: { labels: { en: { value: 'San Francisco' } } },
        Q18013: { labels: { en: { value: 'Fresno' } } },
        P19: { labels: { en: { value: 'place of birth' } } }
      })
      const capture = {}
      nockDiscord(capture)

      const result = await handleWikidataEdit(account, changedEdit, { sets, noop: false })
      assert.isOk(result)
      assert.include(capture.body.embeds[0].description, 'Fresno → San Francisco')
      assert.include(capture.body.embeds[0].description, 'Changed')
      assert.notInclude(capture.body.embeds[0].description, 'Changed to')
    })

    it('labels a reference/qualifier-only edit as Edited, not Changed to', async function() {
      // Old revision already held the same value the autocomment carries
      nockOldRevision({ P19: [{ mainsnak: { datavalue: { value: { id: 'Q62' } } } }] })
      nockLabels({
        Q62: { labels: { en: { value: 'San Francisco' } } },
        P19: { labels: { en: { value: 'place of birth' } } }
      })
      const capture = {}
      nockDiscord(capture)

      const result = await handleWikidataEdit(account, changedEdit, { sets, noop: false })
      assert.isOk(result)
      assert.include(capture.body.embeds[0].description, 'Edited')
      assert.include(capture.body.embeds[0].description, 'reference or qualifier')
      assert.notInclude(capture.body.embeds[0].description, 'Changed to')
    })

    it('falls back to Changed to when the old revision is unreadable', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(q => q.action === 'query')
        .reply(500)
      nockLabels({
        Q62: { labels: { en: { value: 'San Francisco' } } },
        P19: { labels: { en: { value: 'place of birth' } } }
      })
      const capture = {}
      nockDiscord(capture)

      const result = await handleWikidataEdit(account, changedEdit, { sets, noop: false })
      assert.isOk(result)
      assert.include(capture.body.embeds[0].description, 'Changed to')
    })

    it('dedupes the create-then-refine burst into one post', async function() {
      const dedupe = new ClaimDedupe({ ttlMs: 45000 })
      nockLabels({})
      const capture = {}
      nockDiscord(capture)

      const first = await handleWikidataEdit(account, edit, { sets, noop: false, dedupe })
      assert.isOk(first)
      assert.isOk(capture.body, 'first edit should post')

      // Seconds later the same user attaches a reference: same claim,
      // wbsetclaim-update comment. No nocks armed - a second fetch would throw.
      const second = await handleWikidataEdit(account, changedEdit, { sets, noop: false, dedupe })
      assert.isNull(second)
    })

    it('still posts a removal that follows an addition', async function() {
      const dedupe = new ClaimDedupe({ ttlMs: 45000 })
      nockLabels({})
      const capture = {}
      nockDiscord(capture)

      const first = await handleWikidataEdit(account, edit, { sets, noop: false, dedupe })
      assert.isOk(first)

      nockLabels({})
      const capture2 = {}
      nockDiscord(capture2)
      const removal = await handleWikidataEdit(account,
        { ...edit, comment: '/* wbremoveclaims-remove:1| */ [[Property:P19]]: [[Q62]]' },
        { sets, noop: false, dedupe })
      assert.isOk(removal)
      assert.include(capture2.body.embeds[0].description, 'Removed')
    })

    it('falls back to Q-ids when labels are unavailable', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(q => q.action === 'wbgetentities')
        .reply(500)

      let posted = null
      nock('https://discord.com')
        .post('/api/webhooks/123/abc', body => { posted = body; return true })
        .query(true)
        .reply(204)

      const result = await handleWikidataEdit(account, edit, { sets, noop: false })
      assert.isOk(result)
      const embed = posted.embeds[0]
      assert.include(embed.title, 'Q4910791')
      assert.include(embed.description, 'P19')
    })
  })
})
