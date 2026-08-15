/**
 * Shutdown accounting.
 *
 * Why this exists: every deploy ends with `toolforge jobs restart bot`, which
 * deletes the pod — SIGTERM, then SIGKILL when the grace period expires. Node
 * inherits no default signal disposition when it runs as PID 1 in a container,
 * so with no explicit handler SIGTERM is ignored and the job's `emails:
 * onfailure` setting mails out:
 *
 *   Pod 'bot-...'. Phase: 'failed'. Exit code was '137'. With reason 'Error'.
 *
 * That message is identical for a routine redeploy and for an out-of-memory
 * kill, which makes it useless. Handling the signal fixes both halves:
 *
 *   - a stop we were told about exits 0 and logs why, so redeploys stop
 *     reporting as failures at all
 *   - a stop we were *not* told about (OOM, runtime crash, node drain) leaves
 *     the run record in 'running' state, so the next start logs that the
 *     previous run was killed without warning, along with how long it had been
 *     up and how much memory it was using when it died
 *
 * The record lives in the state directory on the tool's NFS home, the same
 * place the deploy changelog goes, so it survives the pod that wrote it. It is
 * strictly best effort: stdout is the channel that always works (`toolforge
 * jobs logs bot`), and every message recorded here is logged there too.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

// Signals a supervisor uses to ask for a clean stop. SIGKILL is absent on
// purpose: it cannot be caught, which is exactly why an unexplained 137 needs
// the run record to be diagnosed after the fact.
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP']

// A stop signal that arrives mid-post should still let the process leave
// promptly. Kubernetes' default grace period is 30s; finish well inside it.
const DEFAULT_GRACE_MS = 5000

// Refresh the on-disk record at most this often, so its uptime and memory
// figures stay current without writing on every edit.
const TOUCH_INTERVAL_MS = 60 * 1000

// Exit codes a job failure email can report, and what they mean here.
const EXIT_CODES = {
  0: 'clean exit (the bot handled a stop signal, or finished normally)',
  1: 'unhandled fatal error - check the log lines just before the exit',
  137: 'SIGKILL - out of memory, or a stop signal went unhandled for the whole grace period',
  143: 'SIGTERM the process did not handle'
}

function describeExitCode(code) {
  return EXIT_CODES[code] || `exit code ${code} (no known meaning)`
}

/**
 * Where the run record lives. $TOOL_DATA_DIR is the tool's NFS home in
 * build-service containers, where $HOME does not point at it; the homedir
 * fallback covers bastion and local runs. Resolved per call so tests (and
 * SFEDITS_STATE_DIR) can point it elsewhere, matching public/server.js and
 * scripts/record-deploy.js.
 */
function runRecordPath() {
  const stateDir = process.env.SFEDITS_STATE_DIR ||
    path.join(process.env.TOOL_DATA_DIR || os.homedir(), 'data')
  return path.join(stateDir, 'last-run.json')
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024)
}

function writeRecord(record) {
  const file = runRecordPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
  } catch (e) {
    // Non-fatal: the state dir may be missing or read-only (tests, ad-hoc runs).
    console.error('Could not write run record:', e.message)
  }
}

function readRecord() {
  try {
    return JSON.parse(fs.readFileSync(runRecordPath(), 'utf8'))
  } catch {
    // Missing or corrupt: treated the same as "no previous run".
    return null
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h) return `${h}h${m}m`
  if (m) return `${m}m${s}s`
  return `${s}s`
}

/**
 * Turn a previous run's record into a sentence explaining how that run ended.
 * @param {object|null} previous - record from startRun()
 * @returns {string}
 */
function explainPreviousRun(previous) {
  if (!previous) {
    return 'no record of a previous run (first start, or the state dir was reset)'
  }

  if (previous.status === 'stopped') {
    return `previous run stopped on ${previous.reason} ` +
      `after ${formatDuration(previous.uptimeSeconds)} (${previous.stoppedAt}) - ` +
      describeExitCode(previous.exitCode)
  }

  // Still marked running: nothing got a chance to record the ending, so the
  // process was killed outright rather than asked to stop.
  return `previous run (pid ${previous.pid}, started ${previous.startedAt}) was killed ` +
    "without a stop signal it could handle - SIGKILL, mailed out as exit code 137 / reason 'Error'. " +
    `It had been up ${formatDuration(previous.uptimeSeconds)} and was using ${previous.memoryRssMb}MB ` +
    `when last seen at ${previous.lastSeenAt}. ` +
    'If that memory figure is near the job\'s mem limit this was an out-of-memory kill; ' +
    'if it is low the platform killed it (node drain, or a restart whose grace period expired).'
}

/**
 * Mark the start of a run and report how the previous one ended.
 * @returns {object|null} the previous run's record, if there was one
 */
function startRun() {
  const previous = readRecord()
  const now = new Date().toISOString()

  writeRecord({
    status: 'running',
    pid: process.pid,
    node: process.version,
    startedAt: now,
    lastSeenAt: now,
    uptimeSeconds: 0,
    memoryRssMb: rssMb()
  })

  return previous
}

let lastTouch = 0

/**
 * Refresh the running record's uptime and memory figures. Cheap to call on
 * every edit: writes at most once per TOUCH_INTERVAL_MS.
 */
function touchRun() {
  const now = Date.now()
  if (now - lastTouch < TOUCH_INTERVAL_MS) return
  lastTouch = now

  const record = readRecord()
  if (!record || record.status !== 'running' || record.pid !== process.pid) return

  record.lastSeenAt = new Date(now).toISOString()
  record.uptimeSeconds = Math.round(process.uptime())
  record.memoryRssMb = rssMb()
  writeRecord(record)
}

let recorded = false

/**
 * Record how this run ended. First call wins: a signal handler's account of
 * the shutdown is more useful than the bare code seen on the way out.
 *
 * @param {string} reason - e.g. 'SIGTERM', 'exit 1'
 * @param {number} [exitCode]
 */
function stopRun(reason, exitCode = 0) {
  recorded = true
  writeRecord({
    status: 'stopped',
    pid: process.pid,
    node: process.version,
    reason,
    exitCode,
    stoppedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    memoryRssMb: rssMb()
  })
}

/**
 * Handle stop signals so a redeploy ends as a clean exit instead of a SIGKILL.
 *
 * @param {object} [options]
 * @param {function} [options.cleanup] - run before exiting; may return a promise
 * @param {number} [options.graceMs] - ms to wait for cleanup before exiting anyway
 * @returns {function} removes the handlers again (for tests)
 */
function installStopHandlers({ cleanup, graceMs = DEFAULT_GRACE_MS } = {}) {
  let stopping = false

  const handlers = STOP_SIGNALS.map((signal) => {
    const handler = () => {
      if (stopping) {
        // Second signal: the supervisor is impatient, so stop arguing.
        console.log(`Received ${signal} again during shutdown - exiting now`)
        process.exit(0)
      }
      stopping = true

      console.log(
        `Received ${signal} after ${formatDuration(process.uptime())} up ` +
        `(rss ${rssMb()}MB) - shutting down cleanly, exit code 0`)

      // Never let cleanup outlast the supervisor's grace period; a SIGKILL
      // here would be mailed out as exit 137 and undo the point of this
      // handler.
      const timer = setTimeout(() => {
        console.error(`Cleanup did not finish within ${graceMs}ms - exiting anyway`)
        stopRun(signal)
        process.exit(0)
      }, graceMs)
      timer.unref()

      Promise.resolve()
        .then(() => (cleanup ? cleanup(signal) : undefined))
        .catch(error => console.error('Cleanup failed:', error.message))
        .then(() => {
          clearTimeout(timer)
          stopRun(signal)
          process.exit(0)
        })
    }

    process.on(signal, handler)
    return { signal, handler }
  })

  // Catch every other way out - a fatal error, an explicit process.exit(), the
  // event loop emptying - so that a record still marked 'running' can only mean
  // the process was killed outright. That is what makes an unexplained exit 137
  // diagnosable on the next start.
  const exitHandler = (code) => {
    if (!recorded) stopRun(`exit ${code}`, code)
  }
  process.on('exit', exitHandler)

  return function uninstall() {
    for (const { signal, handler } of handlers) {
      process.removeListener(signal, handler)
    }
    process.removeListener('exit', exitHandler)
  }
}

module.exports = {
  STOP_SIGNALS,
  EXIT_CODES,
  runRecordPath,
  describeExitCode,
  explainPreviousRun,
  formatDuration,
  startRun,
  touchRun,
  stopRun,
  installStopHandlers
}
