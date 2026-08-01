/**
 * Config loading, shared by the bot (page-watch.js) and admin console
 *
 * Sources, in order:
 *  1. An explicit file path (--config flag / CONFIG_PATH env) when given
 *  2. The SFEDITS_CONFIG environment variable, containing the full config
 *     as a JSON string - for hosts where secrets live in env vars rather
 *     than files (e.g. Toolforge `toolforge envvars`)
 *  3. The default ./config.json
 *
 * Accounts may reference their `ranges` as a path to a separate JSON
 * file; those are resolved here regardless of where the config came from.
 */

const fs = require('fs')
const path = require('path')

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function resolveRanges(config, baseDir) {
  for (const account of config.accounts || []) {
    if (typeof account.ranges === 'string') {
      account.ranges = readJsonFile(path.resolve(baseDir, account.ranges))
    }
  }
  return config
}

/**
 * @param {Object} [opts]
 * @param {string|null} [opts.path] - Explicit config file path; wins over env
 * @param {Object} [opts.env] - Environment (injectable for tests)
 * @returns {Object} Parsed config with ranges resolved
 */
function loadConfig({ path: explicitPath = null, env = process.env } = {}) {
  if (explicitPath) {
    console.log('loaded config from', explicitPath)
    return resolveRanges(readJsonFile(explicitPath), path.dirname(path.resolve(explicitPath)))
  }

  if (env.SFEDITS_CONFIG) {
    console.log('loaded config from SFEDITS_CONFIG environment variable')
    let config
    try {
      config = JSON.parse(env.SFEDITS_CONFIG)
    } catch (e) {
      throw new Error(`SFEDITS_CONFIG is not valid JSON: ${e.message}`)
    }
    return resolveRanges(config, process.cwd())
  }

  const fallback = env.CONFIG_PATH || './config.json'
  console.log('loaded config from', fallback)
  return resolveRanges(readJsonFile(fallback), path.dirname(path.resolve(fallback)))
}

module.exports = { loadConfig }
