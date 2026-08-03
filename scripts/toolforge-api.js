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
 *   webservice-restart-wait [timeout]    recycle pods, wait for a NEW Ready pod
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

/** One-off job for the migrate step (mount defaults to none in the CLI too;
 * the migrate job needs no NFS).
 *
 * The payload is the minimal NewOneOffJob, not a mirror of every CLI field:
 * the API validator rejects null where it expects a string (memory, cpu) and
 * forbids fields belonging to other job types (schedule, continuous, replicas,
 * port, health_check) — sending them all cost the 2026-08-02 16:45Z deploy a
 * 422 at the migrate step. Absent means "default"; null does not. */
async function jobRunWait(name, cmd, image, timeoutSeconds) {
  if (!name || !cmd || !image) throw new Error('usage: job-run-wait <name> <cmd> <image> [timeout]')
  const timeout = Number(timeoutSeconds) || 600
  await api('POST', `${jobsBase()}/`, {
    name,
    imagename: image,
    cmd,
    filelog: false,
    emails: 'none',
    retry: 0,
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

function listWebservicePods() {
  const { server, namespace } = kubeconfig()
  if (!server || !namespace) throw new Error('no usable kubeconfig for pod listing')
  const selector = encodeURIComponent(`name=${toolName()}`)
  const url = `${server}/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`
  return request('GET', url).then(({ text }) => JSON.parse(text).items || [])
}

function podIsReady(pod) {
  if (pod.metadata && pod.metadata.deletionTimestamp) return false
  if (!pod.status || pod.status.phase !== 'Running') return false
  return (pod.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True')
}

/**
 * Restart the webservice and wait for a genuinely NEW pod to become Ready.
 *
 * The plain restart is an async pod DELETE: it returns while the old pod is
 * still Terminating and still answering HTTP, so a URL probe right after it
 * can green-light the *dying* pod (LUI-115). Distinguishing by pod UID makes
 * the wait deterministic: success means a pod that did not exist before the
 * delete is Running and Ready.
 */
async function webserviceRestartWait(timeoutSecArg) {
  const parsed = Number(timeoutSecArg)
  const timeoutSec = Number.isFinite(parsed) && parsed >= 0 ? parsed : 120

  // If the pre-delete listing fails we cannot build the UID gate, but a
  // restart without a wait still beats no restart at all: fall back to the
  // plain delete rather than leaving the webservice on the previous image.
  let before
  try {
    before = new Set((await listWebservicePods()).map((p) => p.metadata.uid))
  } catch (e) {
    console.error(`pod listing failed (${e.message}); restarting without the readiness wait`)
    await webserviceRestart()
    return
  }

  await webserviceRestart()
  if (timeoutSec === 0) return // explicit "don't wait"

  const deadline = Date.now() + timeoutSec * 1000
  let lastListError = null
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    let pods
    try {
      pods = await listWebservicePods()
    } catch (e) {
      // Transient blips mid-rollout are expected; a persistent error (e.g. an
      // expired client cert) must not masquerade as a pod that never came up.
      if (!lastListError) console.error(`pod listing failed while waiting: ${e.message}`)
      lastListError = e
      continue
    }
    lastListError = null
    const fresh = pods.find((p) => !before.has(p.metadata.uid) && podIsReady(p))
    if (fresh) {
      console.log(`new webservice pod ready: ${fresh.metadata.name}`)
      return
    }
  }
  if (lastListError) {
    throw new Error(`pod listing failing at deadline (${lastListError.message}); pod state unknown`)
  }
  throw new Error(`no new Ready webservice pod within ${timeoutSec}s`)
}

const COMMANDS = {
  'build-start': buildStart,
  'build-status': buildStatus,
  'job-restart': jobRestart,
  'job-delete': jobDelete,
  'job-run-wait': jobRunWait,
  'job-logs': jobLogs,
  'webservice-restart': webserviceRestart,
  'webservice-restart-wait': webserviceRestartWait
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
