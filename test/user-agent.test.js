const { assert } = require('chai')
const { userAgent, DEFAULT_CONTACT } = require('../lib/user-agent')

describe('user-agent', function() {
  const saved = process.env.SFEDITS_CONTACT
  afterEach(() => {
    if (saved === undefined) delete process.env.SFEDITS_CONTACT
    else process.env.SFEDITS_CONTACT = saved
  })

  it('follows the required client/version (contact) library/version format', function() {
    delete process.env.SFEDITS_CONTACT
    assert.match(userAgent('bot'), /^sfedits-bot\/\d+\.\d+ \(.+\) Node\.js\/\S+$/)
  })

  it('names the component so traffic can be attributed to a subsystem', function() {
    assert.include(userAgent('reassess'), 'sfedits-reassess/')
    assert.include(userAgent('claim-watch'), 'sfedits-claim-watch/')
  })

  it('lets the operator supply their own contact', function() {
    process.env.SFEDITS_CONTACT = 'https://example.org/me; me@example.org'
    assert.include(userAgent('bot'), '(https://example.org/me; me@example.org)')
  })

  it('falls back to a contact that reaches this fork operator, not upstream', function() {
    delete process.env.SFEDITS_CONTACT
    const ua = userAgent('bot')
    assert.include(ua, DEFAULT_CONTACT)
    assert.notInclude(ua, 'edsu/anon', 'must not point at the upstream author')
  })

  it('rejects an empty component rather than emitting a malformed agent', function() {
    assert.throws(() => userAgent(''), /component/)
  })
})
