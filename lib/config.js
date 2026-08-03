const fs = require('fs')
const path = require('path')

const SECRETS = [
  { env: 'SFEDITS_BLUESKY_PASSWORD',       stanza: c => c.accounts?.[0]?.bluesky,  set: (c, v) => { c.accounts[0].bluesky.password = v } },
  { env: 'SFEDITS_MASTODON_ACCESS_TOKEN',  stanza: c => c.accounts?.[0]?.mastodon, set: (c, v) => { c.accounts[0].mastodon.access_token = v } },
  { env: 'SFEDITS_DISCORD_WEBHOOK_URL',    stanza: c => c.accounts?.[0]?.discord,  set: (c, v) => { c.accounts[0].discord.webhook_url = v } },
  { env: 'SFEDITS_INVITE_CODES',           stanza: c => c.web,                     set: (c, v) => { c.web.invite_codes = v.split(',').map(s => s.trim()).filter(Boolean) } }
]

function deepMerge(base, overlay) {
  if (typeof overlay !== 'object' || overlay === null) return overlay
  if (Array.isArray(overlay)) {
    if (!Array.isArray(base)) base = []
    const out = []
    for (let i = 0; i < overlay.length; i++) {
      // Only recurse if BOTH base[i] and overlay[i] are plain objects
      if (base[i] && typeof base[i] === 'object' && !Array.isArray(base[i]) &&
          overlay[i] && typeof overlay[i] === 'object' && !Array.isArray(overlay[i])) {
        out[i] = deepMerge(base[i], overlay[i])
      } else {
        out[i] = overlay[i]
      }
    }
    // Truncate to overlay length so overlay can shorten/replace an array.
    // Note: an `accounts` array in the overlay replaces the base array wholesale —
    // any account not listed in the overlay is dropped, even if it was in the base.
    return out
  }
  if (Array.isArray(base)) base = {}
  if (typeof base !== 'object' || base === null) base = {}
  const out = { ...base }
  for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(base[k], v)
  return out
}

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  try {
    return JSON.parse(content)
  } catch (e) {
    throw new Error(`${filePath} is not valid JSON: ${e.message}`)
  }
}

function resolveRanges(config, baseDir) {
  for (const account of config.accounts || []) {
    if (typeof account.ranges === 'string') {
      account.ranges = readJsonFile(path.resolve(baseDir, account.ranges))
    }
  }
  return config
}

function loadConfig({ baseDir = process.cwd(), env = process.env } = {}) {
  const basePath = path.join(baseDir, 'config.base.json')
  const baseExists = fs.existsSync(basePath)

  // If config.base.json exists, reject SFEDITS_CONFIG (deprecated, new system uses base + env vars)
  if (baseExists && env.SFEDITS_CONFIG) {
    throw new Error('SFEDITS_CONFIG is no longer supported. Config now comes from ' +
      'config.base.json plus the SFEDITS_* secret env vars — see docs/deploy-toolforge.md.')
  }

  // Toolforge still uses SFEDITS_CONFIG as a fallback until LUI-108 migration completes
  let config
  if (baseExists) {
    config = readJsonFile(basePath)
  } else if (env.SFEDITS_CONFIG) {
    console.log('loaded config from SFEDITS_CONFIG environment variable')
    try {
      config = JSON.parse(env.SFEDITS_CONFIG)
    } catch (e) {
      throw new Error(`SFEDITS_CONFIG is not valid JSON: ${e.message}`)
    }
    return resolveRanges(config, process.cwd())
  } else {
    throw new Error(`missing ${basePath} and SFEDITS_CONFIG not set`)
  }

  const localPath = path.join(baseDir, 'config.json')
  if (fs.existsSync(localPath)) {
    config = deepMerge(config, readJsonFile(localPath))
  }

  for (const s of SECRETS) {
    const value = env[s.env]
    if (value === undefined || value === '') continue
    if (!s.stanza(config)) throw new Error(`${s.env} is set but the config has no stanza for it`)
    s.set(config, value)
  }
  return resolveRanges(config, baseDir)
}

module.exports = { loadConfig }
