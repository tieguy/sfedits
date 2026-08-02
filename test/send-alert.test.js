const { expect } = require('chai')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'send-alert.js')

// Runs the script as a child process from a directory with no config.json,
// the way the autoupdate job container does — where config exists only in
// the SFEDITS_CONFIG environment variable.
function runSendAlert(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'send-alert-test-'))
  try {
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
})
