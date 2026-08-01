const { assert } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

const { authorizeUrl, exchangeCode, fetchProfile } = require('../lib/mw-oauth')

const META = 'https://meta.wikimedia.org'

describe('mw-oauth', function() {
  beforeEach(function() { nock.disableNetConnect() })
  afterEach(function() { nock.cleanAll(); nock.enableNetConnect() })

  describe('authorizeUrl', function() {
    it('builds the OAuth2 authorize URL with the required params', function() {
      const url = authorizeUrl({
        clientId: 'cid',
        redirectUri: 'http://localhost:3000/oauth/callback',
        state: 'xyz'
      })
      const u = new URL(url)
      assert.equal(u.origin + u.pathname, 'https://meta.wikimedia.org/w/rest.php/oauth2/authorize')
      assert.equal(u.searchParams.get('response_type'), 'code')
      assert.equal(u.searchParams.get('client_id'), 'cid')
      assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/oauth/callback')
      assert.equal(u.searchParams.get('state'), 'xyz')
    })
  })

  describe('exchangeCode', function() {
    it('POSTs the authorization code and returns the token payload', async function() {
      nock(META).post('/w/rest.php/oauth2/access_token', body =>
        body.grant_type === 'authorization_code' &&
        body.code === 'abc' &&
        body.client_id === 'cid' &&
        body.client_secret === 'secret' &&
        body.redirect_uri === 'http://localhost:3000/oauth/callback'
      ).reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 14400 })

      const token = await exchangeCode({
        clientId: 'cid', clientSecret: 'secret', code: 'abc',
        redirectUri: 'http://localhost:3000/oauth/callback'
      })
      assert.equal(token.access_token, 'tok')
    })

    it('throws with the status on a non-200 token response', async function() {
      nock(META).post('/w/rest.php/oauth2/access_token').reply(400, { error: 'invalid_grant' })
      const err = await exchangeCode({
        clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'x'
      }).then(() => null, e => e)
      assert.isNotNull(err, 'expected exchangeCode to reject')
      assert.equal(err.status, 400)
    })
  })

  describe('fetchProfile', function() {
    it('GETs the profile with a Bearer token and returns the username', async function() {
      nock(META, { reqheaders: { authorization: 'Bearer tok' } })
        .get('/w/rest.php/oauth2/resource/profile')
        .reply(200, { username: 'Tieguy', sub: '123' })

      const profile = await fetchProfile('tok')
      assert.equal(profile.username, 'Tieguy')
    })

    it('throws with the status on a non-200 profile response', async function() {
      nock(META).get('/w/rest.php/oauth2/resource/profile').reply(401, { error: 'invalid_token' })
      const err = await fetchProfile('bad').then(() => null, e => e)
      assert.isNotNull(err, 'expected fetchProfile to reject')
      assert.equal(err.status, 401)
    })
  })
})
