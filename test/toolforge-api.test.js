/**
 * scripts/toolforge-api.js against a local stand-in for the Toolforge API
 * gateway (and the k8s API for webservice-restart). Plain http: the client
 * only loads client certs for https URLs, so tests need no TLS fixtures.
 */

const { expect } = require('chai')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'toolforge-api.js')

describe('toolforge-api.js', function () {
  this.timeout(10000)

  let server
  let requests
  let responders
  let baseUrl
  let homeDir

  function respond (matcher, handler) {
    responders.push({ matcher, handler })
  }

  before(function (done) {
    requests = []
    responders = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const record = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null }
        requests.push(record)
        const match = responders.find((r) => r.matcher(record))
        if (!match) {
          res.statusCode = 404
          res.end(JSON.stringify({ messages: { error: ['no such route'] } }))
          return
        }
        const { status = 200, json = {} } = match.handler(record)
        res.statusCode = status
        res.end(typeof json === 'string' ? json : JSON.stringify(json))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      // Tool home with a kubeconfig pointing k8s calls at the same server.
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-api-test-'))
      fs.mkdirSync(path.join(homeDir, '.kube'))
      fs.writeFileSync(path.join(homeDir, '.kube', 'config'), [
        'apiVersion: v1',
        'clusters:',
        '- cluster:',
        `    server: ${baseUrl}`,
        '  name: toolforge',
        'contexts:',
        '- context:',
        '    namespace: tool-testtool',
        '  name: default',
        ''
      ].join('\n'))
      done()
    })
  })

  after(function () {
    server.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  beforeEach(function () {
    requests.length = 0
    responders.length = 0
  })

  function run (args) {
    return new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, ...args], {
        env: {
          ...process.env,
          TOOL_TOOLFORGE_API_URL: baseUrl,
          TOOL_DATA_DIR: homeDir,
          TF_API_POLL_MS: '20'
        }
      }, (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr })
      })
    })
  }

  it('derives the tool name from the kubeconfig namespace', async function () {
    respond((r) => r.url.startsWith('/builds/'), () => ({ json: { build: { status: 'BUILD_RUNNING' } } }))
    await run(['build-status'])
    expect(requests[0].url).to.equal('/builds/v1/tool/testtool/builds/latest')
  })

  it('build-start posts source_url and ref, prints the build name', async function () {
    respond((r) => r.method === 'POST' && r.url === '/builds/v1/tool/testtool/builds',
      () => ({ json: { new_build: { name: 'testtool-buildpacks-pipelinerun-x1' } } }))
    const result = await run(['build-start', 'https://github.com/tieguy/sfedits.git', 'integration'])
    expect(result.code).to.equal(0)
    expect(result.stdout.trim()).to.equal('testtool-buildpacks-pipelinerun-x1')
    expect(requests[0].body).to.deep.equal({
      source_url: 'https://github.com/tieguy/sfedits.git',
      ref: 'integration'
    })
  })

  it('build-status prints the raw gateway status', async function () {
    respond(() => true, () => ({ json: { build: { status: 'BUILD_SUCCESS' } } }))
    const result = await run(['build-status'])
    expect(result.stdout.trim()).to.equal('BUILD_SUCCESS')
  })

  it('job-restart posts to the restart route', async function () {
    respond(() => true, () => ({ json: {} }))
    const result = await run(['job-restart', 'bot'])
    expect(result.code).to.equal(0)
    expect(requests[0]).to.include({ method: 'POST', url: '/jobs/v1/tool/testtool/jobs/bot/restart' })
  })

  it('job-run-wait creates the job and polls until Completed', async function () {
    let polls = 0
    respond((r) => r.method === 'POST' && r.url === '/jobs/v1/tool/testtool/jobs/', () => ({ json: {} }))
    respond((r) => r.method === 'GET' && r.url === '/jobs/v1/tool/testtool/jobs/migrate', () => {
      polls += 1
      return { json: { job: { status_short: polls < 3 ? 'Running' : 'Completed' } } }
    })
    const result = await run(['job-run-wait', 'migrate', 'migrate', 'tool-testtool/tool-testtool:latest', '5'])
    expect(result.code).to.equal(0)
    expect(polls).to.be.at.least(3)
    const created = requests[0].body
    expect(created).to.include({
      name: 'migrate',
      cmd: 'migrate',
      imagename: 'tool-testtool/tool-testtool:latest',
      mount: 'none'
    })
    // The API 422s on nulls where it expects strings, and forbids fields
    // from other job types on a one-off — absent means default, null does not.
    expect(created).to.not.have.any.keys(
      'memory', 'cpu', 'schedule', 'continuous', 'replicas', 'port', 'health_check')
  })

  it('job-run-wait fails when the job fails, with the long status', async function () {
    respond((r) => r.method === 'POST', () => ({ json: {} }))
    respond((r) => r.method === 'GET',
      () => ({ json: { job: { status_short: 'Failed', status_long: 'exit code 3' } } }))
    const result = await run(['job-run-wait', 'migrate', 'migrate', 'img', '5'])
    expect(result.code).to.equal(1)
    expect(result.stderr).to.include('exit code 3')
  })

  it('job-run-wait treats a reaped job (404 on poll) as success', async function () {
    respond((r) => r.method === 'POST', () => ({ json: {} }))
    respond((r) => r.method === 'GET', () => ({ status: 404, json: {} }))
    const result = await run(['job-run-wait', 'migrate', 'migrate', 'img', '5'])
    expect(result.code).to.equal(0)
  })

  it('webservice-restart deletes pods by the tool name selector', async function () {
    respond((r) => r.method === 'DELETE', () => ({ json: { items: [{}, {}] } }))
    const result = await run(['webservice-restart'])
    expect(result.code).to.equal(0)
    expect(result.stdout).to.include('deleted 2 webservice pod(s)')
    expect(requests[0].url).to.equal(
      '/api/v1/namespaces/tool-testtool/pods?labelSelector=name%3Dtesttool')
  })

  it('surfaces gateway warning messages on stderr', async function () {
    respond(() => true,
      () => ({ json: { build: { status: 'BUILD_RUNNING' }, messages: { warning: ['quota nearly reached'] } } }))
    const result = await run(['build-status'])
    expect(result.stderr).to.include('quota nearly reached')
  })

  it('exits non-zero with usage for an unknown command', async function () {
    const result = await run(['frobnicate'])
    expect(result.code).to.equal(2)
  })
})
