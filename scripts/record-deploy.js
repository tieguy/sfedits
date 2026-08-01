#!/usr/bin/env node

/**
 * Record a successful deploy in the web-visible changelog.
 *
 * Called by toolforge-autoupdate.sh right after it records the deployed
 * SHA: appends an entry with the SHA, timestamp, and the PR titles that
 * just went live to $SFEDITS_STATE_DIR/changelog.json - the same shared
 * home mount the deployed SHA lives on, which the webservice (started
 * with --mount=all) serves at /changelog.
 *
 * The change list comes from the GitHub compare API (public repo, no
 * auth needed). Merge commits and squash merges yield PR numbers and
 * titles; a range with no PR-shaped commits falls back to plain commit
 * subjects. Recording is best-effort by design: if GitHub is
 * unreachable the entry still lands with an empty change list, because
 * visibility of "a deploy happened" must not depend on api.github.com.
 *
 * Usage: record-deploy.js <old-sha> <new-sha>   (old may be empty: first
 * deploy, no range to describe)
 */

const fs = require('fs')
const path = require('path')

const MAX_ENTRIES = 50
const MAX_CHANGES = 20
const FETCH_TIMEOUT_MS = 15000

/** "tieguy/sfedits" from any https/ssh GitHub remote URL. */
function repoSlug(repoUrl) {
  const m = (repoUrl || '').match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

/**
 * Turn the compare API's commit list into changelog lines.
 *
 * A PR lands as either a merge commit ("Merge pull request #6 from x/y"
 * with the PR title in the body) or a squash commit ("Title (#6)"). When
 * the range contains any PR-shaped commits, only those are kept - the
 * branch commits they carry are also in the list and would double-report.
 * A range with none (direct pushes) falls back to commit subjects.
 */
function changesFromCommits(commits) {
  const prs = []
  const plain = []
  for (const c of commits || []) {
    const message = c?.commit?.message || ''
    const lines = message.split('\n')
    const subject = lines[0].trim()
    if (!subject) continue

    const merge = subject.match(/^Merge pull request #(\d+)\b/)
    if (merge) {
      const title = lines.slice(1).map(l => l.trim()).find(l => l) || subject
      prs.push({ title, pr: Number(merge[1]) })
      continue
    }
    const squash = subject.match(/^(.+?)\s+\(#(\d+)\)$/)
    if (squash) {
      prs.push({ title: squash[1], pr: Number(squash[2]) })
      continue
    }
    plain.push({ title: subject, pr: null })
  }
  return (prs.length ? prs : plain).slice(0, MAX_CHANGES)
}

/**
 * Append a deploy entry to the changelog file, keeping the newest
 * MAX_ENTRIES. A missing or corrupt file starts fresh rather than
 * blocking the record. Written via rename so the webservice never reads
 * a half-written file.
 */
function appendDeploy(file, entry) {
  let deploys = []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) deploys = parsed
  } catch (e) { /* first deploy, or unreadable: start fresh */ }

  deploys.push(entry)
  deploys = deploys.slice(-MAX_ENTRIES)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(deploys, null, 1))
  fs.renameSync(tmp, file)
  return deploys
}

async function fetchChanges(repoUrl, oldSha, newSha) {
  const slug = repoSlug(repoUrl)
  if (!slug || !oldSha) return []
  const url = `https://api.github.com/repos/${slug}/compare/${oldSha}...${newSha}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'sfedits-record-deploy (https://github.com/tieguy/sfedits)',
      Accept: 'application/vnd.github+json'
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`GitHub compare returned ${res.status}`)
  const data = await res.json()
  return changesFromCommits(data.commits)
}

async function main() {
  const [oldSha, newSha] = process.argv.slice(2)
  if (!newSha) {
    console.error('usage: record-deploy.js <old-sha> <new-sha>')
    process.exit(1)
  }

  const repoUrl = process.env.SFEDITS_DEPLOY_REPO || 'https://github.com/tieguy/sfedits.git'
  const stateDir = process.env.SFEDITS_STATE_DIR ||
    path.join(process.env.HOME || '.', 'data')

  let changes = []
  try {
    changes = await fetchChanges(repoUrl, oldSha, newSha)
  } catch (error) {
    console.error(`change list unavailable (${error.message}); recording the deploy anyway`)
  }

  const file = path.join(stateDir, 'changelog.json')
  appendDeploy(file, {
    sha: newSha,
    deployed_at: new Date().toISOString(),
    changes
  })
  console.log(`recorded deploy ${newSha.slice(0, 8)} (${changes.length} change(s)) in ${file}`)
}

if (require.main === module) {
  main().catch(error => {
    console.error(`record-deploy failed: ${error.message}`)
    process.exit(1)
  })
}

module.exports = { repoSlug, changesFromCommits, appendDeploy }
