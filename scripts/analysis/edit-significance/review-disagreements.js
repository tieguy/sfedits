#!/usr/bin/env node
/**
 * Review tool for edit-significance validation disagreements.
 * Loads both parent and current revision from pairs-cache, shows unified diff
 * hunks, mwedittypes label, classifier verdict, and per-channel divergence windows.
 *
 * Usage: node review-disagreements.js <cohort> <revid> [--lang en]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { extractChannels, DEFAULT_CHANNELS } = require('../../../lib/edit-significance')
const wtf = require('wtf_wikipedia')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')

function showDiff(prev, curr) {
  // Use unified diff to show the actual changes
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-review-'))
  const prevFile = path.join(tmpDir, 'prev.txt')
  const currFile = path.join(tmpDir, 'curr.txt')

  try {
    fs.writeFileSync(prevFile, prev)
    fs.writeFileSync(currFile, curr)

    try {
      execFileSync('diff', ['-u', prevFile, currFile], { encoding: 'utf-8' })
      // No differences (files identical)
      console.log('  [No differences]')
    } catch (err) {
      // diff returns exit code 1 when files differ, which is expected
      if (err.status === 1 && err.stdout) {
        const lines = err.stdout.split('\n').slice(0, 100) // Show first 100 lines of diff
        console.log(lines.map(l => '  ' + l).join('\n'))
        return
      }
      // On other errors, rethrow with context
      throw new Error(`diff failed: ${err.message}`)
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) {}
  }
}

function showChannelDiff(before, after) {
  // Show which channels changed and the first divergent character for each
  const all = new Set([...Object.keys(before), ...Object.keys(after)])
  let changed = false
  for (const name of all) {
    const b = before[name]
    const a = after[name]
    if (b === a) continue
    changed = true
    const policy = DEFAULT_CHANNELS[name] || 'unknown'
    console.log(`\n  ${name} [${policy}]:`)

    // Find first divergent character offset
    let divergeAt = 0
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      if ((b[i] || '') !== (a[i] || '')) {
        divergeAt = i
        break
      }
    }

    // Show ±120 character window around divergence
    const windowStart = Math.max(0, divergeAt - 120)
    const windowEnd = Math.min(Math.max(b.length, a.length), divergeAt + 120)

    const prevWindow = b.substring(windowStart, windowEnd)
    const currWindow = a.substring(windowStart, windowEnd)

    console.log(`    BEFORE: ...${prevWindow}...`)
    console.log(`    AFTER:  ...${currWindow}...`)
  }
  if (!changed) console.log('  (no channel changes detected)')
}

function main() {
  const args = process.argv.slice(2)
  const cohort = args[0]
  const revid = args[1]
  const langIdx = args.indexOf('--lang')
  const lang = langIdx > -1 ? args[langIdx + 1] : 'en'

  if (!cohort || !revid) {
    console.error('usage: node review-disagreements.js <cohort> <revid> [--lang en]')
    process.exit(1)
  }

  const dir = path.join(DATA_ROOT, cohort)
  const cache = path.join(dir, 'pairs-cache')

  // Load edits to find parentid
  const edits = JSON.parse(fs.readFileSync(path.join(dir, 'edits.json')))
  const edit = edits.find(e => e.revid.toString() === revid.toString())
  if (!edit) {
    console.error(`revid ${revid} not found in edits.json`)
    process.exit(1)
  }

  // Load labels
  const labels = new Map()
  for (const line of fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf-8').trim().split('\n')) {
    const rec = JSON.parse(line)
    labels.set(rec.revid, rec)
  }
  const label = labels.get(edit.revid)

  // Load verdict (verdicts.jsonl)
  const verdictMap = new Map()
  if (fs.existsSync(path.join(dir, 'verdicts.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf-8').trim().split('\n')) {
      const rec = JSON.parse(line)
      verdictMap.set(rec.revid, rec)
    }
  }
  const verdict = verdictMap.get(edit.revid)

  // Load wikitext
  const prev = fs.readFileSync(path.join(cache, `${edit.parentid}.txt`), 'utf-8')
  const curr = fs.readFileSync(path.join(cache, `${revid}.txt`), 'utf-8')

  if (!prev || !curr) {
    console.log(`Missing wikitext (prev=${prev.length} chars, curr=${curr.length} chars)`)
    process.exit(1)
  }

  // Extract channels
  let beforeChannels, afterChannels
  try {
    beforeChannels = extractChannels(wtf(prev))
    afterChannels = extractChannels(wtf(curr))
  } catch (err) {
    console.log(`Parse error: ${err.message}`)
    process.exit(1)
  }

  // Print report
  console.log(`\n=== REVIEW: ${edit.title} (revid ${revid}) ===`)
  console.log(`URL: https://${lang === 'es' ? 'es' : 'en'}.wikipedia.org/w/index.php?diff=${revid}&oldid=${edit.parentid}`)

  if (label) {
    console.log(`\nmwedittypes label: ${JSON.stringify(label.types)}`)
  }

  if (verdict) {
    console.log(`\nClassifier verdict: substantive=${verdict.substantive}`)
    console.log(`  reasons: [${verdict.reasons.join(', ')}]`)
    console.log(`  ignored: [${verdict.ignored.join(', ')}]`)
    if (verdict.fallback) console.log(`  fallback: ${verdict.fallback}`)
  }

  console.log(`\n  Wikitext diff (unified format):`)
  showDiff(prev, curr)

  console.log(`\nPer-channel changes:`)
  showChannelDiff(beforeChannels, afterChannels)

  console.log('\n')
}

main()
