const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { extractRevisionInfo, recordPost, loadActive, updateEntries } = require('../lib/post-log')
const { classifyRevisions, decideActions } = require('../lib/revdel-check')

describe('post-log', function() {
  let logFile

  beforeEach(function() {
    logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'postlog-')), 'posted-log.jsonl')
  })

  afterEach(function() {
    fs.rmSync(path.dirname(logFile), { recursive: true, force: true })
  })

  describe('extractRevisionInfo', function() {
    it('extracts host and revision id from a diff URL', function() {
      assert.deepEqual(
        extractRevisionInfo('https://en.wikipedia.org/w/index.php?diff=123&oldid=456'),
        { host: 'en.wikipedia.org', revId: 123 }
      )
    })

    it('returns null for URLs without a numeric diff', function() {
      assert.isNull(extractRevisionInfo('https://en.wikipedia.org/w/index.php?diff=prev&oldid=456'))
      assert.isNull(extractRevisionInfo('not a url'))
    })
  })

  describe('recordPost / loadActive', function() {
    it('round-trips a posted entry', function() {
      recordPost({
        diffUrl: 'https://en.wikipedia.org/w/index.php?diff=111&oldid=110',
        page: 'Cat',
        blueskyUri: 'at://did:plc:x/app.bsky.feed.post/abc',
        mastodonId: '42'
      }, logFile)

      const active = loadActive(30, logFile)
      assert.lengthOf(active, 1)
      assert.equal(active[0].revId, 111)
      assert.equal(active[0].host, 'en.wikipedia.org')
      assert.equal(active[0].blueskyUri, 'at://did:plc:x/app.bsky.feed.post/abc')
      assert.equal(active[0].mastodonId, '42')
      assert.equal(active[0].status, 'active')
      assert.equal(active[0].missingCount, 0)
    })

    it('returns null and records nothing for an unparseable URL', function() {
      const entry = recordPost({ diffUrl: 'garbage', page: 'Cat' }, logFile)
      assert.isNull(entry)
      assert.lengthOf(loadActive(30, logFile), 0)
    })

    it('excludes deleted entries and entries older than the window', function() {
      recordPost({ diffUrl: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=0', page: 'A' }, logFile)
      recordPost({ diffUrl: 'https://en.wikipedia.org/w/index.php?diff=2&oldid=1', page: 'B' }, logFile)

      const [first] = loadActive(30, logFile)
      updateEntries([{ ...first, status: 'deleted' }], logFile)

      const active = loadActive(30, logFile)
      assert.lengthOf(active, 1)
      assert.equal(active[0].revId, 2)

      // Age out the remaining entry
      updateEntries([{ ...active[0], postedAt: new Date(Date.now() - 40 * 86400000).toISOString() }], logFile)
      assert.lengthOf(loadActive(30, logFile), 0)
    })

    it('updateEntries modifies only matching entries', function() {
      recordPost({ diffUrl: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=0', page: 'A' }, logFile)
      recordPost({ diffUrl: 'https://fr.wikipedia.org/w/index.php?diff=1&oldid=0', page: 'A-fr' }, logFile)

      const entries = loadActive(30, logFile)
      const target = entries.find(e => e.host === 'fr.wikipedia.org')
      updateEntries([{ ...target, missingCount: 1 }], logFile)

      const after = loadActive(30, logFile)
      assert.equal(after.find(e => e.host === 'fr.wikipedia.org').missingCount, 1)
      assert.equal(after.find(e => e.host === 'en.wikipedia.org').missingCount, 0)
    })
  })
})

describe('revdel-check', function() {

  describe('classifyRevisions', function() {
    it('classifies visible, hidden, and missing revisions', function() {
      const response = {
        query: {
          pages: [{
            revisions: [
              { revid: 1, user: 'Alice', sha1: 'abc' },
              { revid: 2, texthidden: true, sha1hidden: true },
              { revid: 3, userhidden: true, user: undefined, sha1: 'def' }
            ]
          }],
          badrevids: { 4: { revid: 4 } }
        }
      }
      const result = classifyRevisions(response, [1, 2, 3, 4])
      assert.equal(result.get(1), 'visible')
      assert.equal(result.get(2), 'hidden')
      assert.equal(result.get(3), 'hidden')
      assert.equal(result.get(4), 'missing')
    })

    it('treats suppressed revisions as hidden', function() {
      const response = {
        query: { pages: [{ revisions: [{ revid: 7, suppressed: true }] }] }
      }
      assert.equal(classifyRevisions(response, [7]).get(7), 'hidden')
    })

    it('treats revisions absent from the response as missing', function() {
      const response = { query: { pages: [] } }
      assert.equal(classifyRevisions(response, [9]).get(9), 'missing')
    })
  })

  describe('decideActions', function() {
    const entry = (revId, missingCount = 0) => ({
      host: 'en.wikipedia.org', revId, page: 'Cat', status: 'active', missingCount
    })

    it('deletes immediately on the affirmative hidden signal', function() {
      const { toDelete, toUpdate } = decideActions(
        [entry(1)],
        new Map([[1, 'hidden']])
      )
      assert.lengthOf(toDelete, 1)
      assert.equal(toDelete[0].reason, 'hidden')
      assert.lengthOf(toUpdate, 0)
    })

    it('waits for a second consecutive missing before deleting', function() {
      const first = decideActions([entry(1)], new Map([[1, 'missing']]))
      assert.lengthOf(first.toDelete, 0)
      assert.equal(first.toUpdate[0].missingCount, 1)

      const second = decideActions([entry(1, 1)], new Map([[1, 'missing']]))
      assert.lengthOf(second.toDelete, 1)
      assert.equal(second.toDelete[0].reason, 'missing')
    })

    it('resets the missing counter when the revision reappears', function() {
      const { toDelete, toUpdate } = decideActions(
        [entry(1, 1)],
        new Map([[1, 'visible']])
      )
      assert.lengthOf(toDelete, 0)
      assert.equal(toUpdate[0].missingCount, 0)
    })

    it('makes no changes for unclassified entries (failed query batch)', function() {
      const { toDelete, toUpdate } = decideActions([entry(1, 1)], new Map())
      assert.lengthOf(toDelete, 0)
      assert.lengthOf(toUpdate, 0)
    })

    it('leaves untouched visible entries out of the update list', function() {
      const { toDelete, toUpdate } = decideActions(
        [entry(1, 0)],
        new Map([[1, 'visible']])
      )
      assert.lengthOf(toDelete, 0)
      assert.lengthOf(toUpdate, 0)
    })
  })
})
