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
    const out = [...base]
    for (let i = 0; i < overlay.length; i++) {
      out[i] = deepMerge(base[i], overlay[i])
    }
    return out
  }
  if (Array.isArray(base)) base = {}
  const out = { ...base }
  for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(base[k], v)
  return out
}

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

function loadConfig({ baseDir = process.cwd(), env = process.env } = {}) {
  if (env.SFEDITS_CONFIG) {
    throw new Error('SFEDITS_CONFIG is no longer supported. Config now comes from ' +
      'config.base.json plus the SFEDITS_* secret env vars — see docs/deploy-toolforge.md.')
  }
  const basePath = path.join(baseDir, 'config.base.json')
  if (!fs.existsSync(basePath)) throw new Error(`missing ${basePath}`)
  let config = JSON.parse(fs.readFileSync(basePath, 'utf8'))

  const localPath = path.join(baseDir, 'config.json')
  if (fs.existsSync(localPath)) {
    config = deepMerge(config, JSON.parse(fs.readFileSync(localPath, 'utf8')))
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
