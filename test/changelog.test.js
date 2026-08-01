/**
 * Deploy changelog tests: the record-deploy script's parsing/persistence
 * and the webservice's /changelog routes.
 */

const { describe, it, before, after } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { repoSlug, changesFromCommits, appendDeploy } = require('../scripts/record-deploy')
const { app, renderChangelog } = require('../public/server')

const commit = message => ({ commit: { message } })

describe('deploy changelog', function() {

  describe('repoSlug', function() {
    it('extracts owner/repo from https and ssh remotes', function() {
      assert.equal(repoSlug('https://github.com/tieguy/sfedits.git'), 'tieguy/sfedits')
      assert.equal(repoSlug('https://github.com/tieguy/sfedits'), 'tieguy/sfedits')
      assert.equal(repoSlug('git@github.com:tieguy/sfedits.git'), 'tieguy/sfedits')
    })

    it('returns null for non-GitHub URLs', function() {
      assert.isNull(repoSlug('https://gitlab.com/x/y.git'))
      assert.isNull(repoSlug(''))
    })
  })

  describe('changesFromCommits', function() {
    it('takes the PR title from a merge commit body', function() {
      const changes = changesFromCommits([
        commit('Merge pull request #6 from tieguy/claude/discord-bot\n\nDenser Discord embeds and more readable change excerpts')
      ])
      assert.deepEqual(changes, [
        { title: 'Denser Discord embeds and more readable change excerpts', pr: 6 }
      ])
    })

    it('parses squash-merge subjects', function() {
      const changes = changesFromCommits([commit('Collapse edit bursts (#3)')])
      assert.deepEqual(changes, [{ title: 'Collapse edit bursts', pr: 3 }])
    })

    it('keeps only PR entries when a range has them', function() {
      // The compare API lists a PR's branch commits alongside its merge
      // commit; listing both would double-report every change
      const changes = changesFromCommits([
        commit('fix: the actual branch commit'),
        commit('Merge pull request #4 from tieguy/some-branch\n\nThe PR title')
      ])
      assert.deepEqual(changes, [{ title: 'The PR title', pr: 4 }])
    })

    it('falls back to commit subjects for direct pushes', function() {
      const changes = changesFromCommits([
        commit('fix: autoupdate home mount\n\nlong body'),
        commit('docs: record the ToolsDB prefix')
      ])
      assert.deepEqual(changes, [
        { title: 'fix: autoupdate home mount', pr: null },
        { title: 'docs: record the ToolsDB prefix', pr: null }
      ])
    })
  })

  describe('appendDeploy', function() {
    it('creates the file, appends, and trims to the newest 50', function() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-changelog-'))
      const file = path.join(dir, 'changelog.json')
      for (let i = 1; i <= 55; i++) {
        appendDeploy(file, { sha: `sha-${i}`, deployed_at: 't', changes: [] })
      }
      const deploys = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.lengthOf(deploys, 50)
      assert.equal(deploys[0].sha, 'sha-6')
      assert.equal(deploys[49].sha, 'sha-55')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('starts fresh over a corrupt file instead of failing', function() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-changelog-'))
      const file = path.join(dir, 'changelog.json')
      fs.writeFileSync(file, 'not json')
      const deploys = appendDeploy(file, { sha: 'abc', deployed_at: 't', changes: [] })
      assert.lengthOf(deploys, 1)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('renderChangelog', function() {
    it('renders deploys newest first with PR links and a live badge', function() {
      const html = renderChangelog([
        { sha: 'older000cafe', deployed_at: '2026-07-30T10:00:00.000Z', changes: [{ title: 'First change', pr: null }] },
        {
          sha: 'abcdef012345',
          deployed_at: '2026-08-01T12:34:56.000Z',
          changes: [{ title: 'Denser Discord embeds', pr: 6 }]
        }
      ])
      assert.include(html, 'Denser Discord embeds')
      assert.include(html, '/pull/6')
      assert.include(html, 'abcdef01')
      assert.include(html, '2026-08-01 12:34:56 UTC')
      // Newest entry carries the live badge and comes first
      assert.isBelow(html.indexOf('abcdef01'), html.indexOf('older000'))
      assert.isBelow(html.indexOf('live'), html.indexOf('older000'))
    })

    it('escapes HTML in titles', function() {
      const html = renderChangelog([
        { sha: 'x', deployed_at: 't', changes: [{ title: '<script>alert(1)</script>', pr: null }] }
      ])
      assert.notInclude(html, '<script>alert')
      assert.include(html, '&lt;script&gt;')
    })

    it('says so plainly when nothing is recorded yet', function() {
      assert.include(renderChangelog([]), 'No deploys recorded yet')
    })
  })

  describe('HTTP routes', function() {
    let server, base, stateDir, savedEnv

    before(function(done) {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-state-'))
      savedEnv = process.env.SFEDITS_STATE_DIR
      process.env.SFEDITS_STATE_DIR = stateDir
      fs.writeFileSync(path.join(stateDir, 'changelog.json'), JSON.stringify([
        { sha: 'abc123def456', deployed_at: '2026-08-01T00:00:00Z', changes: [{ title: 'A shipped PR', pr: 9 }] }
      ]))
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${server.address().port}`
        done()
      })
    })

    after(function(done) {
      if (savedEnv === undefined) delete process.env.SFEDITS_STATE_DIR
      else process.env.SFEDITS_STATE_DIR = savedEnv
      fs.rmSync(stateDir, { recursive: true, force: true })
      server.close(done)
    })

    it('serves the changelog page', async function() {
      const res = await fetch(`${base}/changelog`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.include(html, 'A shipped PR')
      assert.include(html, '/pull/9')
    })

    it('serves the raw JSON', async function() {
      const res = await fetch(`${base}/changelog.json`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.lengthOf(data.deploys, 1)
      assert.equal(data.deploys[0].sha, 'abc123def456')
    })

    it('serves an empty page when no deploys are recorded', async function() {
      fs.rmSync(path.join(stateDir, 'changelog.json'))
      const page = await (await fetch(`${base}/changelog`)).text()
      assert.include(page, 'No deploys recorded yet')
      const data = await (await fetch(`${base}/changelog.json`)).json()
      assert.deepEqual(data.deploys, [])
    })
  })
})
