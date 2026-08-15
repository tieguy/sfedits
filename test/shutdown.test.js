/**
 * Shutdown accounting
 *
 * These cover the two things that make a job-failure email readable: SIGTERM
 * has to be handled (so `toolforge jobs restart bot` exits 0 instead of being
 * SIGKILLed), and a run that ends without one has to be recognisable as a hard
 * kill on the next start.
 */

const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  describeExitCode,
  explainPreviousRun,
  formatDuration,
  installStopHandlers,
  runRecordPath,
  startRun,
  stopRun,
  touchRun,
  STOP_SIGNALS
} = require('../lib/shutdown')

describe('shutdown', function() {
  let stateDir, savedEnv

  beforeEach(function() {
    // Never let a test write the real run record into the tool home.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-shutdown-'))
    savedEnv = process.env.SFEDITS_STATE_DIR
    process.env.SFEDITS_STATE_DIR = stateDir
  })

  afterEach(function() {
    if (savedEnv === undefined) delete process.env.SFEDITS_STATE_DIR
    else process.env.SFEDITS_STATE_DIR = savedEnv
    fs.rmSync(stateDir, { recursive: true, force: true })
    sinon.restore()
  })

  describe('describeExitCode', function() {
    it('explains 137 as SIGKILL rather than a bare number', function() {
      assert.include(describeExitCode(137), 'SIGKILL')
      assert.include(describeExitCode(137), 'out of memory')
    })

    it('explains a clean exit', function() {
      assert.include(describeExitCode(0), 'clean exit')
    })

    it('says so when a code has no known meaning', function() {
      assert.include(describeExitCode(42), 'no known meaning')
    })
  })

  describe('formatDuration', function() {
    it('formats hours, minutes and seconds', function() {
      assert.equal(formatDuration(10800), '3h0m')
      assert.equal(formatDuration(125), '2m5s')
      assert.equal(formatDuration(9), '9s')
    })

    it('does not invent a duration it does not have', function() {
      assert.equal(formatDuration(undefined), 'unknown')
    })
  })

  describe('runRecordPath', function() {
    it('follows SFEDITS_STATE_DIR', function() {
      assert.equal(runRecordPath(), path.join(stateDir, 'last-run-bot.json'))
    })

    it('keeps one record per process, not one they overwrite in turn', function() {
      assert.notEqual(runRecordPath('bot'), runRecordPath('web'))
      assert.equal(runRecordPath('web'), path.join(stateDir, 'last-run-web.json'))
    })

    it('uses the tool home when the build service provides one', function() {
      delete process.env.SFEDITS_STATE_DIR
      const saved = process.env.TOOL_DATA_DIR
      process.env.TOOL_DATA_DIR = '/data/project/san-francisco-edit-stream'
      try {
        assert.equal(
          runRecordPath(),
          '/data/project/san-francisco-edit-stream/data/last-run-bot.json')
      } finally {
        if (saved === undefined) delete process.env.TOOL_DATA_DIR
        else process.env.TOOL_DATA_DIR = saved
      }
    })
  })

  describe('explainPreviousRun', function() {
    it('handles a first start', function() {
      assert.include(explainPreviousRun(null), 'no record of a previous run')
    })

    it('reports a clean stop with the signal that caused it', function() {
      const message = explainPreviousRun({
        status: 'stopped',
        reason: 'SIGTERM',
        exitCode: 0,
        uptimeSeconds: 3600,
        stoppedAt: '2026-08-15T01:02:35.000Z'
      })

      assert.include(message, 'stopped on SIGTERM')
      assert.include(message, '1h0m')
      assert.include(message, 'clean exit')
    })

    it('reports a crash as a crash, not a kill', function() {
      const message = explainPreviousRun({
        status: 'stopped',
        reason: 'exit 1',
        exitCode: 1,
        uptimeSeconds: 12,
        stoppedAt: '2026-08-15T01:02:35.000Z'
      })

      assert.include(message, 'unhandled fatal error')
      assert.notInclude(message, 'SIGKILL')
    })

    it('reports a record still marked running as a hard kill, with memory', function() {
      const message = explainPreviousRun({
        status: 'running',
        pid: 1,
        startedAt: '2026-08-14T22:02:15.000Z',
        lastSeenAt: '2026-08-15T01:01:00.000Z',
        uptimeSeconds: 10725,
        memoryRssMb: 987
      })

      assert.include(message, 'SIGKILL')
      assert.include(message, '137')
      assert.include(message, '987MB')
      assert.include(message, '2h58m')
    })
  })

  describe('the run record', function() {
    it('returns the previous run and marks this one running', function() {
      assert.isNull(startRun(), 'nothing recorded yet')

      const record = JSON.parse(fs.readFileSync(runRecordPath(), 'utf8'))
      assert.equal(record.status, 'running')
      assert.equal(record.pid, process.pid)

      stopRun('SIGTERM')
      const previous = startRun()
      assert.equal(previous.status, 'stopped')
      assert.equal(previous.reason, 'SIGTERM')
      assert.include(explainPreviousRun(previous), 'stopped on SIGTERM')
    })

    it('refreshes uptime and memory at most once a minute', function() {
      // Far enough ahead that the throttle cannot still be holding a timestamp
      // from another test in this process.
      const clock = sinon.useFakeTimers(new Date('2030-01-01T00:00:00Z'))
      try {
        startRun()
        touchRun()
        const first = JSON.parse(fs.readFileSync(runRecordPath(), 'utf8'))

        clock.tick(30 * 1000)
        touchRun()
        assert.deepEqual(
          JSON.parse(fs.readFileSync(runRecordPath(), 'utf8')), first,
          'a refresh per edit would be a write per edit')

        clock.tick(31 * 1000)
        touchRun()
        assert.notEqual(
          JSON.parse(fs.readFileSync(runRecordPath(), 'utf8')).lastSeenAt,
          first.lastSeenAt,
          'the record should not go stale while the bot runs')
      } finally {
        clock.restore()
      }
    })

    it('survives a state dir it cannot write', function() {
      // A plain file standing where the state dir should be: mkdir fails, and
      // the bot has to keep running anyway.
      const blocked = path.join(stateDir, 'not-a-dir')
      fs.writeFileSync(blocked, '')
      process.env.SFEDITS_STATE_DIR = path.join(blocked, 'state')
      sinon.stub(console, 'error')

      assert.doesNotThrow(() => startRun())
    })
  })

  describe('installStopHandlers', function() {
    it('listens for every signal a supervisor might send', function() {
      const uninstall = installStopHandlers()
      try {
        for (const signal of STOP_SIGNALS) {
          assert.isAbove(process.listenerCount(signal), 0, `no handler for ${signal}`)
        }
      } finally {
        uninstall()
      }
    })

    it('records exits that never saw a signal, so only a hard kill looks like one', function() {
      const uninstall = installStopHandlers()
      try {
        assert.isAbove(process.listenerCount('exit'), 0, 'no exit handler installed')
      } finally {
        uninstall()
      }
    })

    it('runs cleanup and exits 0 on SIGTERM', async function() {
      const exit = sinon.stub(process, 'exit')
      sinon.stub(console, 'log')
      const cleanup = sinon.stub().resolves()

      const uninstall = installStopHandlers({ cleanup })
      try {
        process.emit('SIGTERM')
        // Let the cleanup promise chain settle.
        await new Promise(resolve => setImmediate(resolve))

        assert.isTrue(cleanup.calledOnce, 'cleanup should run')
        assert.isTrue(exit.calledWith(0), 'a handled stop signal is not a failure')

        const record = JSON.parse(fs.readFileSync(runRecordPath(), 'utf8'))
        assert.equal(record.status, 'stopped')
        assert.equal(record.reason, 'SIGTERM')
      } finally {
        uninstall()
      }
    })

    it('writes the shutdown under the process name it was given', async function() {
      sinon.stub(process, 'exit')
      sinon.stub(console, 'log')

      const uninstall = installStopHandlers({ name: 'web' })
      try {
        process.emit('SIGTERM')
        await new Promise(resolve => setImmediate(resolve))

        assert.isTrue(fs.existsSync(runRecordPath('web')), 'no web record')
        assert.isFalse(fs.existsSync(runRecordPath('bot')), 'the web stop overwrote the bot record')
      } finally {
        uninstall()
      }
    })

    it('still exits 0 when cleanup throws', async function() {
      const exit = sinon.stub(process, 'exit')
      sinon.stub(console, 'log')
      sinon.stub(console, 'error')
      const cleanup = sinon.stub().rejects(new Error('stream already closed'))

      const uninstall = installStopHandlers({ cleanup })
      try {
        process.emit('SIGTERM')
        await new Promise(resolve => setImmediate(resolve))

        assert.isTrue(exit.calledWith(0))
      } finally {
        uninstall()
      }
    })

    it('exits without waiting when cleanup outlasts the grace period', function() {
      const clock = sinon.useFakeTimers()
      const exit = sinon.stub(process, 'exit')
      sinon.stub(console, 'log')
      sinon.stub(console, 'error')
      // Cleanup that never settles - e.g. a pool draining a stuck connection.
      const cleanup = sinon.stub().returns(new Promise(() => {}))

      const uninstall = installStopHandlers({ cleanup, graceMs: 5000 })
      try {
        process.emit('SIGTERM')
        assert.isFalse(exit.called, 'should give cleanup a chance first')

        clock.tick(5000)
        assert.isTrue(exit.calledWith(0), 'must leave before the SIGKILL arrives')
      } finally {
        uninstall()
        clock.restore()
      }
    })
  })
})
