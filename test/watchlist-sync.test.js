/**
 * Watchlist sync module tests
 *
 * Tests dynamic article list fetching from the PageAssessments API,
 * importance filtering, cache fallback, and watchlist matching.
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  fetchProjectArticles,
  fetchTitlesList,
  refreshWatchlist,
  startWatchlistSync,
  isWatched,
  cachePath
} = require('../lib/watchlist-sync')

const API_HOST = 'https://en.wikipedia.org'
const API_PATH = '/w/api.php'

const LIST_HOST = 'https://san-francisco-edit-stream.toolforge.org'
const LIST_PATH = '/watchlist-500.json'
const LIST_URL = `${LIST_HOST}${LIST_PATH}`

function apiPage(title, ns = 0, importance = null) {
  const page = { pageid: Math.abs(title.length * 7919), ns, title }
  if (importance !== null) {
    page.assessment = { class: 'B', importance }
  }
  return page
}

describe('watchlist-sync', function() {
  this.timeout(5000)

  let dataDir

  beforeEach(function() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-test-'))
  })

  afterEach(function() {
    fs.rmSync(dataDir, { recursive: true, force: true })
    nock.cleanAll()
  })

  describe('fetchProjectArticles', function() {
    it('fetches article titles for a project', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(q => q.list === 'projectpages' && !q.wppcontinue)
        .reply(200, {
          query: {
            projects: {
              'San Francisco Bay Area': [
                apiPage('Golden Gate Bridge'),
                apiPage('Daniel Lurie')
              ]
            }
          }
        })

      const titles = await fetchProjectArticles({ project: 'San Francisco Bay Area' })
      assert.deepEqual(titles, ['Golden Gate Bridge', 'Daniel Lurie'])
    })

    it('follows continuation across multiple requests', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(q => !q.wppcontinue)
        .reply(200, {
          continue: { wppcontinue: 'page-2-token', continue: '-||' },
          query: { projects: { 'Test Project': [apiPage('Article One')] } }
        })
        .get(API_PATH)
        .query(q => q.wppcontinue === 'page-2-token')
        .reply(200, {
          query: { projects: { 'Test Project': [apiPage('Article Two')] } }
        })

      const titles = await fetchProjectArticles({ project: 'Test Project' })
      assert.deepEqual(titles, ['Article One', 'Article Two'])
    })

    it('filters by importance when configured', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(q => q.wppassessments === 'true')
        .reply(200, {
          query: {
            projects: {
              'Test Project': [
                apiPage('Top Article', 0, 'Top'),
                apiPage('High Article', 0, 'High'),
                apiPage('Low Article', 0, 'Low'),
                apiPage('Unrated Article', 0, null)
              ]
            }
          }
        })

      const titles = await fetchProjectArticles({
        project: 'Test Project',
        importance: ['Top', 'High']
      })
      assert.deepEqual(titles, ['Top Article', 'High Article'])
    })

    it('excludes non-mainspace pages', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(true)
        .reply(200, {
          query: {
            projects: {
              'Test Project': [
                apiPage('Real Article', 0),
                apiPage('Template:Bay Area', 10),
                apiPage('Category:Bay Area', 14)
              ]
            }
          }
        })

      const titles = await fetchProjectArticles({ project: 'Test Project' })
      assert.deepEqual(titles, ['Real Article'])
    })

    it('throws on API error responses', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(true)
        .reply(200, {
          error: { code: 'badproject', info: 'No such project' }
        })

      try {
        await fetchProjectArticles({ project: 'Nonexistent' })
        assert.fail('Should have thrown')
      } catch (error) {
        assert.include(error.message, 'badproject')
      }
    })

    it('throws on HTTP errors', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(true)
        .reply(503, 'Service Unavailable')

      try {
        await fetchProjectArticles({ project: 'Test Project' })
        assert.fail('Should have thrown')
      } catch (error) {
        assert.include(error.message, '503')
      }
    })
  })

  describe('refreshWatchlist', function() {
    it('populates the account dynamic watchlist and writes a cache file', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(true)
        .reply(200, {
          query: { projects: { 'Test Project': [apiPage('Cached Article')] } }
        })

      const account = { watchlist_source: { project: 'Test Project' } }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('Cached Article'))

      const cache = JSON.parse(fs.readFileSync(cachePath(dataDir, 'Test Project'), 'utf8'))
      assert.deepEqual(cache.titles, ['Cached Article'])
    })

    it('falls back to the cache file when the API fails', async function() {
      fs.writeFileSync(
        cachePath(dataDir, 'Test Project'),
        JSON.stringify({ titles: ['From Cache'] })
      )
      nock(API_HOST).get(API_PATH).query(true).reply(500)

      const account = { watchlist_source: { project: 'Test Project' } }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('From Cache'))
    })

    it('keeps the previous in-memory list when a later refresh fails', async function() {
      nock(API_HOST).get(API_PATH).query(true).reply(500)

      const account = {
        watchlist_source: { project: 'Test Project' },
        dynamicWatchlist: { 'English Wikipedia': new Set(['Existing Article']) }
      }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('Existing Article'))
    })

    it('results in an empty watchlist when API fails and no cache exists', async function() {
      nock(API_HOST).get(API_PATH).query(true).reply(500)

      const account = { watchlist_source: { project: 'Test Project' } }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 0)
      assert.equal(account.dynamicWatchlist['English Wikipedia'].size, 0)
    })

    it('treats a zero-article fetch as a failure (wrong project name guard)', async function() {
      // PageAssessments returns an empty result, not an error, for unknown
      // project names - this must never wipe a working watchlist
      nock(API_HOST)
        .get(API_PATH)
        .query(true)
        .reply(200, { query: { projects: {} } })

      const account = {
        watchlist_source: { project: 'Wrong Name' },
        dynamicWatchlist: { 'English Wikipedia': new Set(['Existing Article']) }
      }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('Existing Article'))
      // And the on-disk cache must not be overwritten with an empty list
      assert.isFalse(fs.existsSync(cachePath(dataDir, 'Wrong Name')))
    })

    it('respects a custom wikipedia feed name', async function() {
      nock(API_HOST)
        .get(API_PATH)
        .query(true)
        .reply(200, {
          query: { projects: { 'Test Project': [apiPage('Artikel')] } }
        })

      const account = {
        watchlist_source: { project: 'Test Project', wikipedia: 'German Wikipedia' }
      }
      await refreshWatchlist(account, { dataDir })
      assert.isTrue(account.dynamicWatchlist['German Wikipedia'].has('Artikel'))
    })
  })

  describe('fetchTitlesList', function() {
    it('fetches a bare JSON array of titles', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(200, ['Alpha', 'Beta'])

      const titles = await fetchTitlesList({ titles_url: LIST_URL })

      assert.deepEqual(titles, ['Alpha', 'Beta'])
    })

    it('fetches a { titles: [...] } envelope', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(200, {
        generated_at: '2026-08-01T00:00:00Z',
        titles: ['Alpha', 'Beta']
      })

      const titles = await fetchTitlesList({ titles_url: LIST_URL })

      assert.deepEqual(titles, ['Alpha', 'Beta'])
    })

    it('throws on HTTP errors', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(503)

      try {
        await fetchTitlesList({ titles_url: LIST_URL })
        assert.fail('should have thrown')
      } catch (e) {
        assert.include(e.message, '503')
      }
    })

    it('throws when the payload is not a list of titles', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(200, { unexpected: 'shape' })

      try {
        await fetchTitlesList({ titles_url: LIST_URL })
        assert.fail('should have thrown')
      } catch (e) {
        assert.include(e.message, 'title list')
      }
    })

    it('reads from a local file when titles_file is set', async function() {
      const file = path.join(dataDir, 'top500.json')
      fs.writeFileSync(file, JSON.stringify(['From Disk']))

      const titles = await fetchTitlesList({ titles_file: file })

      assert.deepEqual(titles, ['From Disk'])
    })
  })

  describe('refreshWatchlist with a titles_url source', function() {
    it('populates the dynamic watchlist and writes a cache file', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(200, ['Golden Gate Bridge'])

      const account = { watchlist_source: { titles_url: LIST_URL } }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('Golden Gate Bridge'))

      const cache = JSON.parse(fs.readFileSync(cachePath(dataDir, LIST_URL), 'utf8'))
      assert.deepEqual(cache.titles, ['Golden Gate Bridge'])
    })

    it('never calls the PageAssessments API', async function() {
      // Any request to the API host is an unmocked call and will throw.
      nock(LIST_HOST).get(LIST_PATH).reply(200, ['Only From The List'])

      const account = {
        watchlist_source: { titles_url: LIST_URL, project: 'Ignored Project' }
      }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('Only From The List'))
    })

    it('treats an empty list as a failure and falls back to cache', async function() {
      fs.writeFileSync(cachePath(dataDir, LIST_URL), JSON.stringify({ titles: ['From Cache'] }))
      nock(LIST_HOST).get(LIST_PATH).reply(200, [])

      const account = { watchlist_source: { titles_url: LIST_URL } }
      const count = await refreshWatchlist(account, { dataDir })

      assert.equal(count, 1)
      assert.isTrue(account.dynamicWatchlist['English Wikipedia'].has('From Cache'))
    })

    it('respects a custom wikipedia feed name', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(200, ['Artikel'])

      const account = {
        watchlist_source: { titles_url: LIST_URL, wikipedia: 'German Wikipedia' }
      }
      await refreshWatchlist(account, { dataDir })

      assert.isTrue(account.dynamicWatchlist['German Wikipedia'].has('Artikel'))
    })
  })

  describe('startWatchlistSync source validation', function() {
    it('starts a titles_url account that declares no project', async function() {
      nock(LIST_HOST).get(LIST_PATH).reply(200, ['Alpha'])

      const config = { accounts: [{ watchlist_source: { titles_url: LIST_URL } }] }
      const timers = await startWatchlistSync(config, { dataDir })
      timers.forEach(t => clearInterval(t))

      assert.equal(timers.length, 1)
      assert.isTrue(config.accounts[0].dynamicWatchlist['English Wikipedia'].has('Alpha'))
    })

    it('skips a source that declares neither project nor a title list', async function() {
      const config = { accounts: [{ watchlist_source: { refresh_hours: 24 } }] }
      const timers = await startWatchlistSync(config, { dataDir })
      timers.forEach(t => clearInterval(t))

      assert.equal(timers.length, 0)
      assert.isUndefined(config.accounts[0].dynamicWatchlist)
    })
  })

  describe('isWatched', function() {
    it('matches static watchlist entries', function() {
      const account = {
        watchlist: { 'English Wikipedia': { 'Daniel Lurie': true } }
      }
      assert.isTrue(isWatched(account, { wikipedia: 'English Wikipedia', page: 'Daniel Lurie' }))
      assert.isFalse(isWatched(account, { wikipedia: 'English Wikipedia', page: 'Other Page' }))
    })

    it('matches dynamic watchlist entries', function() {
      const account = {
        dynamicWatchlist: { 'English Wikipedia': new Set(['Golden Gate Bridge']) }
      }
      assert.isTrue(isWatched(account, { wikipedia: 'English Wikipedia', page: 'Golden Gate Bridge' }))
      assert.isFalse(isWatched(account, { wikipedia: 'German Wikipedia', page: 'Golden Gate Bridge' }))
    })

    it('merges static and dynamic lists', function() {
      const account = {
        watchlist: { 'English Wikipedia': { 'Static Page': true } },
        dynamicWatchlist: { 'English Wikipedia': new Set(['Dynamic Page']) }
      }
      assert.isTrue(isWatched(account, { wikipedia: 'English Wikipedia', page: 'Static Page' }))
      assert.isTrue(isWatched(account, { wikipedia: 'English Wikipedia', page: 'Dynamic Page' }))
      assert.isFalse(isWatched(account, { wikipedia: 'English Wikipedia', page: 'Unwatched Page' }))
    })

    it('handles accounts with neither list', function() {
      assert.isFalse(isWatched({}, { wikipedia: 'English Wikipedia', page: 'Anything' }))
    })
  })
})
