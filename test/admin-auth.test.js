/**
 * Admin server import and auth endpoint verification
 *
 * Verifies that the admin server loads without import errors and that
 * the request-code endpoint properly returns 501 with a disabled message.
 */

const { describe, it, before, after } = require('mocha')
const { assert } = require('chai')

describe('Admin Server - Import Verification', function() {
  it('loads without ReferenceError (catches missing imports)', function() {
    // This verifies all imports resolve correctly
    // Would have caught: "createAuthenticatedAgent is not defined"

    let app
    try {
      app = require('../admin/server.js')
    } catch (error) {
      if (error.message.includes('is not defined')) {
        assert.fail(`Missing import detected: ${error.message}`)
      }
      throw error
    }

    assert.ok(app, 'Admin server should load successfully')
    assert.equal(typeof app, 'function', 'Should export Express app')
  })
})

describe('Admin Server - Auth Endpoint', function() {
  let app, server, base

  before(function(done) {
    app = require('../admin/server.js')
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      done()
    })
  })

  after(function(done) {
    server.close(done)
  })

  it('POST /api/auth/request-code returns 501 with disabled message', async function() {
    const res = await fetch(`${base}/api/auth/request-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })

    assert.equal(res.status, 501, 'Should return 501 Not Implemented')

    const body = await res.json()
    assert.equal(body.error, 'Admin DM login is not configured',
      'Should indicate the endpoint is disabled')
  })
})
