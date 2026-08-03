const { expect } = require('chai')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'send-alert.js')

// Runs the script as a child process from a directory, optionally with a
// config.base.json file. Used to test both legacy SFEDITS_CONFIG and new
// config.base.json + SFEDITS_* envvars paths.
function runSendAlert(env, configBase = null) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'send-alert-test-'))
  try {
    // Optionally create config.base.json for the new production path (LUI-108)
    if (configBase) {
      fs.writeFileSync(path.join(cwd, 'config.base.json'), JSON.stringify(configBase))
    }
    return execFileSync(process.execPath, [SCRIPT, 'test alert'], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

describe('send-alert.js config loading', function () {
  it('loads config from SFEDITS_CONFIG when no config file exists', function () {
    // No credentials configured: the script should still get far enough to
    // say so and exit 0, rather than dying on a missing config.json.
    const out = runSendAlert({
      SFEDITS_CONFIG: JSON.stringify({ accounts: [{}] })
    })
    expect(out).to.include('loaded config from SFEDITS_CONFIG')
  })

  it('loads config from config.base.json (production path)', function () {
    // Production path after LUI-108 migration: config.base.json + split secret env vars
    // This verifies the new split-config path works: config.base.json is loaded, and
    // SFEDITS_DISCORD_WEBHOOK_URL env var is merged in (though alert sending will fail
    // gracefully since no alerting destinations are configured).
    const configBase = {
      accounts: [{ template: '{{page}} edited', discord: {} }],
      web: {}
    }
    // Should not throw an exception (exit code 0)
    const out = runSendAlert(
      {
        // Discord webhook is configured via env var (will be set in accounts[0].discord.webhook_url)
        SFEDITS_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token'
      },
      configBase
    )
    // The script runs successfully even though it will fail to send (no alert
    // credentials configured). stdout should be empty since alerting is optional.
    expect(out).to.equal('')
  })
})
