const { describe, it } = require('mocha')
const { assert } = require('chai')
const { toEdit, WIKI_NAMES } = require('../lib/edit-stream')

describe('edit-stream', function() {

  describe('toEdit', function() {
    const baseEvent = {
      type: 'edit',
      title: 'London Breed',
      user: 'AadamentAardvark',
      comment: 'fixed typo',
      server_name: 'en.wikipedia.org',
      namespace: 0,
      bot: false,
      revision: { new: 123, old: 456 },
      length: { new: 1050, old: 1000 }
    }

    it('maps a recentchange event to the wikichanges edit shape', function() {
      const edit = toEdit(baseEvent)
      assert.equal(edit.page, 'London Breed')
      assert.equal(edit.user, 'AadamentAardvark')
      assert.equal(edit.wikipedia, 'English Wikipedia')
      assert.equal(edit.url, 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456')
      assert.equal(edit.pageUrl, 'https://en.wikipedia.org/wiki/London_Breed')
      assert.equal(edit.delta, 50)
      assert.equal(edit.comment, 'fixed typo')
      assert.isFalse(edit.anonymous)
      assert.isFalse(edit.robot)
      assert.equal(edit.namespace, 'article')
    })

    it('detects anonymous editors by IP address', function() {
      assert.isTrue(toEdit({ ...baseEvent, user: '192.0.2.1' }).anonymous)
      assert.isTrue(toEdit({ ...baseEvent, user: '2001:db8::1' }).anonymous)
      assert.isFalse(toEdit({ ...baseEvent, user: 'NotAnIP' }).anonymous)
    })

    it('maps language wikis to wikichanges feed names', function() {
      assert.equal(toEdit({ ...baseEvent, server_name: 'ko.wikipedia.org' }).wikipedia, 'Korean Wikipedia')
      assert.equal(toEdit({ ...baseEvent, server_name: 'es.wikipedia.org' }).wikipedia, 'Spanish Wikipedia')
      // Unknown wikis fall back to the host so they are still matchable
      assert.equal(toEdit({ ...baseEvent, server_name: 'xx.wikisource.org' }).wikipedia, 'xx.wikisource.org')
    })

    it('ignores non-edit events', function() {
      assert.isNull(toEdit({ ...baseEvent, type: 'log' }))
      assert.isNull(toEdit({ ...baseEvent, type: 'categorize' }))
      assert.isNull(toEdit({ ...baseEvent, revision: undefined }))
    })

    it('covers the wikis the bot historically posted from', function() {
      for (const host of ['en.wikipedia.org', 'pl.wikipedia.org', 'fr.wikipedia.org', 'ko.wikipedia.org']) {
        assert.isString(WIKI_NAMES[host], host)
      }
    })
  })
})
