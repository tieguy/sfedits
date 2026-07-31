/**
 * The Wikimedia User-Agent, in one place.
 *
 * The User-Agent identifies the OPERATOR - whoever is actually running the code
 * and generating the traffic - not the author. This matters here because this
 * repo has an upstream lineage: two modules shipped a User-Agent pointing at
 * https://github.com/edsu/anon with "Contact via GitHub issues", which meant
 * traffic from anyone running this bot was attributed to a third party who could
 * not act on it.
 *
 * Operators set SFEDITS_CONTACT to their own reachable contact. The default
 * below is correct for this fork only; a different deployment must override it.
 *
 * Format required by policy: <client>/<version> (<contact>) <library>/<version>
 * Contact must be an email, a URL the operator controls, or "<project>; User:<name>".
 *
 * @see https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
 * @see https://www.mediawiki.org/wiki/API:Etiquette
 */

const VERSION = '1.0'
const DEFAULT_CONTACT = 'https://github.com/tieguy/sfedits; luis@lu.is'

/**
 * Build the User-Agent for one subsystem, so traffic can be attributed to the
 * part of the bot that produced it (diff rendering, claim watching, analysis).
 *
 * @param {string} component - e.g. 'bot', 'reassess', 'claim-watch'
 * @returns {string}
 */
function userAgent(component) {
  if (!component || typeof component !== 'string') {
    throw new Error('userAgent(component) requires a component name')
  }
  const contact = process.env.SFEDITS_CONTACT || DEFAULT_CONTACT
  return `sfedits-${component}/${VERSION} (${contact}) Node.js/${process.versions.node}`
}

module.exports = { userAgent, DEFAULT_CONTACT, VERSION }
