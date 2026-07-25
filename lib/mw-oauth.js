/**
 * Minimal MediaWiki (Wikimedia) OAuth 2.0 Authorization Code helper.
 *
 * Identify-only login: send the user to authorize, exchange the returned code
 * for an access token, then read their username from the profile endpoint. No
 * edit/read grants are requested. Hand-rolled on global fetch to avoid a
 * dependency and to keep the flow nock-testable.
 *
 * @see https://www.mediawiki.org/wiki/OAuth/For_Developers
 */

const AUTHORIZE = 'https://meta.wikimedia.org/w/rest.php/oauth2/authorize'
const TOKEN = 'https://meta.wikimedia.org/w/rest.php/oauth2/access_token'
const PROFILE = 'https://meta.wikimedia.org/w/rest.php/oauth2/resource/profile'

/**
 * Build the URL to send the user to for authorization.
 * @param {Object} opts
 * @param {string} opts.clientId
 * @param {string} opts.redirectUri - must match the registered callback
 * @param {string} opts.state - CSRF token the caller stores and re-checks
 * @param {string} [opts.scope]
 * @returns {string}
 */
function authorizeUrl({ clientId, redirectUri, state, scope }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state
  })
  if (scope) params.set('scope', scope)
  return `${AUTHORIZE}?${params.toString()}`
}

/**
 * Exchange an authorization code for an access token.
 * @returns {Promise<Object>} the token response ({ access_token, ... })
 * @throws {Error} with .status/.body on a non-200 response
 */
async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    })
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error = new Error(`OAuth token exchange failed: ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return response.json()
}

/**
 * Read the authenticated user's profile (username, etc.) with a bearer token.
 * @returns {Promise<Object>} ({ username, sub, ... })
 * @throws {Error} with .status on a non-200 response
 */
async function fetchProfile(accessToken) {
  const response = await fetch(PROFILE, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) {
    const error = new Error(`OAuth profile fetch failed: ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

module.exports = { authorizeUrl, exchangeCode, fetchProfile, AUTHORIZE, TOKEN, PROFILE }
