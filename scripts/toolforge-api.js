#!/usr/bin/env node

/**
 * Minimal Toolforge API client for environments without the toolforge CLI.
 *
 * Build-service job containers ship no toolforge CLI, no kubectl, and no
 * python (verified 2026-08-02 via `webservice shell`) — but they do have
 * node, and mount=all exposes the tool's TLS client certs at
 * $TOOL_DATA_DIR/.toolskube. This speaks to the same API gateway the CLI
 * uses (client-cert auth, tool identity from the cert), covering only the
 * five operations toolforge-autoupdate.sh needs.
 *
 * Endpoints and payload shapes mirror toolforge-jobs-framework-cli 16.x and
 * toolforge-builds-cli 0.0.24 (both on PyPI). TLS verification is disabled
 * to match toolforge_weld's own behavior against the gateway (T253412).
 *
 * Usage: toolforge-api.js <command> [args]
 *   build-start <source_url> <ref>       start a build, print its name
 *   build-status                         print the latest build's status
 *   job-restart <name>                   restart a job
 *   job-delete <name>                    delete a job (error if absent)
 *   job-run-wait <name> <cmd> <image> [timeout-seconds]
 *                                        create a one-off job, poll to completion
 *   job-logs <name>                      print a job's logs
 *   webservice-restart                   recycle webservice pods via the k8s API
 *
 * Overrides (all optional): TOOL_TOOLFORGE_API_URL (gateway),
 * TOOL_DATA_DIR/HOME (tool home), TF_API_POLL_MS (job poll interval).
 */

const fs = require('fs')
const path = require('path')

const GATEWAY = process.env.TOOL_TOOLFORGE_API_URL ||
  'https://api.svc.tools.eqiad1.wikimedia.cloud:30003'
const POLL_MS = Number(process.env.TF_API_POLL_MS) || 5000

function toolHome() {
  const home = process.env.TOOL_DATA_DIR || process.env.HOME
  if (!home) throw new Error('neither TOOL_DATA_DIR nor HOME is set')
  return home
}

/**
 * The kubeconfig is YAML, but the generated tool kubeconfig is flat enough
 * that the two fields we need are safe to pull out with regexes: the k8s
 * API server URL and the tool namespace.
 */
function kubeconfig() {
  let text = ''
  try {
    text = fs.readFileSync(path.join(toolHome(), '.kube', 'config'), 'utf8')
  } catch (e) {
    return { server: null, namespace: null }
  }
  const server = (text.match(/^\s*server:\s*(\S+)/m) || [])[1] || null
  const namespace = (text.match(/^\s*namespace:\s*(\S+)/m) || [])[1] || null
  return { server, namespace }
}

function toolName() {
  const ns = kubeconfig().namespace
  if (ns && ns.startsWith('tool-')) return ns.slice('tool-'.length)
  return path.basename(toolHome())
}

function certOptions(url) {
  if (!url.startsWith('https:')) return {} // plain http only in tests
  const dir = path.join(toolHome(), '.toolskube')
  return {
    cert: fs.readFileSync(path.join(dir, 'client.crt')),
    key: fs.readFileSync(path.join(dir, 'client.key')),
    rejectUnauthorized: false
  }
}

function request(method, url, body) {
  const transport = url.startsWith('https:') ? require('https') : require('http')
  const payload = body === undefined ? null : JSON.stringify(body)
  const options = {
    method,
    headers: {
      'User-Agent': `${toolName()}:sfedits-autoupdate`,
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json' } : {})
    },
    ...certOptions(url)
  }
  return new Promise((resolve, reject) => {
    const req = transport.request(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${url} returned ${res.statusCode}: ${data.slice(0, 500)}`))
          return
        }
        resolve({ status: res.statusCode, text: data })
      })
    })
    req.setTimeout(60000, () => req.destroy(new Error(`${method} ${url} timed out`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function api(method, pathname, body) {
  const { text } = await request(method, `${GATEWAY}${pathname}`, body)
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    parsed = null // some endpoints (logs) return raw lines
  }
  // The gateway wraps responses with user-facing messages; surface them.
  const messages = (parsed && parsed.messages) || {}
  for (const level of ['warning', 'error']) {
    for (const m of messages[level] || []) console.error(`[gateway ${level}] ${m}`)
  }
  return { parsed, text }
}

const jobsBase = () => `/jobs/v1/tool/${toolName()}/jobs`
const buildsBase = () => `/builds/v1/tool/${toolName()}/builds`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function buildStart(sourceUrl, ref) {
  if (!sourceUrl || !ref) throw new Error('usage: build-start <source_url> <ref>')
  const { parsed } = await api('POST', buildsBase(), { source_url: sourceUrl, ref })
  console.log((parsed && parsed.new_build && parsed.new_build.name) || '')
}

async function buildStatus() {
  const { parsed } = await api('GET', `${buildsBase()}/latest`)
  console.log((parsed && parsed.build && parsed.build.status) || 'unknown')
}

async function jobRestart(name) {
  if (!name) throw new Error('usage: job-restart <name>')
  await api('POST', `${jobsBase()}/${encodeURIComponent(name)}/restart`)
}

async function jobDelete(name) {
  if (!name) throw new Error('usage: job-delete <name>')
  await api('DELETE', `${jobsBase()}/${encodeURIComponent(name)}`)
}

/** Mirrors the CLI payload for `jobs run` of a buildservice image (mount
 * defaults to none there; the migrate job needs no NFS). */
async function jobRunWait(name, cmd, image, timeoutSeconds) {
  if (!name || !cmd || !image) throw new Error('usage: job-run-wait <name> <cmd> <image> [timeout]')
  const timeout = Number(timeoutSeconds) || 600
  await api('POST', `${jobsBase()}/`, {
    name,
    imagename: image,
    cmd,
    filelog: false,
    filelog_stdout: null,
    filelog_stderr: null,
    memory: null,
    cpu: null,
    emails: 'none',
    retry: 0,
    continuous: false,
    schedule: null,
    replicas: null,
    port: null,
    health_check: null,
    mount: 'none'
  })
  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    let job = null
    try {
      const { parsed } = await api('GET', `${jobsBase()}/${encodeURIComponent(name)}`)
      job = parsed && parsed.job
    } catch (e) {
      // A 404 means the job finished and was reaped — the CLI treats that
      // as success too.
      if (/returned 404/.test(e.message)) return
      throw e
    }
    const status = (job && job.status_short) || ''
    if (status === 'Completed') return
    if (status === 'Failed') {
      throw new Error(`job '${name}' failed: ${(job && job.status_long) || 'no detail'}`)
    }
  }
  throw new Error(`timed out after ${timeout}s waiting for job '${name}'`)
}

async function jobLogs(name) {
  if (!name) throw new Error('usage: job-logs <name>')
  const { text } = await api('GET', `${jobsBase()}/${encodeURIComponent(name)}/logs?follow=false`)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch (e) { /* raw line */ }
    if (parsed && parsed.message !== undefined) {
      console.log(`${parsed.datetime} [${parsed.pod}] ${parsed.message}`)
    } else {
      console.log(line)
    }
  }
}

/**
 * There is no webservice API on the gateway — `toolforge webservice` drives
 * Kubernetes directly. Deleting the webservice pods (labeled name=<tool> by
 * tools-webservice) makes the deployment recreate them on the current
 * :latest image, which is what `webservice restart` amounts to.
 */
async function webserviceRestart() {
  const { server, namespace } = kubeconfig()
  if (!server || !namespace) throw new Error('no usable kubeconfig for webservice restart')
  const selector = encodeURIComponent(`name=${toolName()}`)
  const url = `${server}/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`
  const { text } = await request('DELETE', url)
  let count = 0
  try {
    count = (JSON.parse(text).items || []).length
  } catch (e) { /* non-JSON reply; count stays 0 */ }
  console.log(`deleted ${count} webservice pod(s)`)
  if (count === 0) console.error('warning: no pods matched the webservice selector')
}

const COMMANDS = {
  'build-start': buildStart,
  'build-status': buildStatus,
  'job-restart': jobRestart,
  'job-delete': jobDelete,
  'job-run-wait': jobRunWait,
  'job-logs': jobLogs,
  'webservice-restart': webserviceRestart
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`unknown command '${command || ''}'; one of: ${Object.keys(COMMANDS).join(', ')}`)
    process.exit(2)
  }
  await handler(...args)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = { kubeconfig, toolName, jobRunWait }
