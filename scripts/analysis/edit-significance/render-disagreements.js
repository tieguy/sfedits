#!/usr/bin/env node
/**
 * Render disagreement entries for documentation.
 * Generates markdown blocks with machine-emitted diff hunks for:
 * - missed-prose: mwedittypes says prose, classifier says not substantive
 * - carry-neither: classifier says substantive, mwedittypes has no prose/mapped/Template keys
 *
 * Usage: node render-disagreements.js <cohort> [lang]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')
const PROSE_KEYS = new Set(['Word', 'Sentence', 'Paragraph', 'Character'])
const MAPPED_KEYS = new Set(['Reference', 'Media', 'Heading', 'Table'])

// For a pair of changed lines, return the divergence window: the region from
// the first differing character to the last, with context on each side. This
// is emitted whenever a hunk line had to be truncated, so a reviewer can
// never judge an entry from a clipped prefix alone.
function divergenceWindow(before, after, context = 60) {
  let p = 0
  while (p < before.length && p < after.length && before[p] === after[p]) p++
  let s = 0
  while (s < before.length - p && s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  const cut = str => {
    const start = Math.max(0, p - context)
    let body = str.slice(start, str.length - s + context)
    if (body.length > 480) {
      body = body.slice(0, 220) + ' …[window truncated]… ' + body.slice(-220)
    }
    return (start > 0 ? '…' : '') + body + (str.length - s + context < str.length ? '…' : '')
  }
  return { before: cut(before), after: cut(after) }
}

function getDiffHunks(prev, curr, maxLinesPerHunk = 12) {
  // Generate unified diff and extract hunks with limited context
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-render-'))
  const prevFile = path.join(tmpDir, 'prev.txt')
  const currFile = path.join(tmpDir, 'curr.txt')

  try {
    fs.writeFileSync(prevFile, prev)
    fs.writeFileSync(currFile, curr)

    let diffOutput = ''
    try {
      execFileSync('diff', ['-u', prevFile, currFile], { encoding: 'utf-8' })
    } catch (err) {
      if (err.status === 1 && err.stdout) {
        diffOutput = err.stdout
      } else {
        throw err
      }
    }

    if (!diffOutput) return ''

    // Parse hunks and format them. Long wikitext lines are truncated
    // mid-line so entries stay readable; the marker makes the cut visible.
    const MAX_LINE_CHARS = 220
    const clip = line => line.length > MAX_LINE_CHARS
      ? line.slice(0, MAX_LINE_CHARS) + ' …[line truncated]'
      : line
    const lines = diffOutput.split('\n')
    let output = ''
    let hunkLines = 0
    let skippedInHunk = 0
    let inHunk = false
    let anyClipped = false
    const dels = []
    const adds = []

    const flushSkipMarker = () => {
      if (skippedInHunk > 0) {
        output += `… (${skippedInHunk} more lines in this hunk)\n`
        skippedInHunk = 0
      }
    }

    for (const line of lines) {
      if (line.startsWith('@@')) {
        flushSkipMarker()
        inHunk = true
        hunkLines = 0
        output += line + '\n'
      } else if (inHunk && !line.startsWith('---') && !line.startsWith('+++')) {
        if (line.startsWith('-')) dels.push(line.slice(1))
        else if (line.startsWith('+')) adds.push(line.slice(1))
        if (hunkLines >= maxLinesPerHunk) {
          skippedInHunk++
        } else {
          if (line.length > MAX_LINE_CHARS) anyClipped = true
          output += clip(line) + '\n'
          hunkLines++
        }
      }
    }
    flushSkipMarker()

    // When any line was clipped, append divergence windows for each changed
    // line pair so the truncated region cannot hide the actual change.
    if (anyClipped) {
      output += '\ndivergence windows (full first-to-last difference per changed line pair):\n'
      const n = Math.max(dels.length, adds.length)
      for (let i = 0; i < n; i++) {
        const w = divergenceWindow(dels[i] ?? '', adds[i] ?? '')
        output += `  pair ${i + 1}:\n  - ${w.before}\n  + ${w.after}\n`
      }
    }

    return output
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) {}
  }
}

function main() {
  const cohort = process.argv[2]
  const lang = process.argv[3] || 'en'

  if (!cohort) {
    console.error('usage: render-disagreements.js <cohort> [lang]')
    process.exit(1)
  }

  const dir = path.join(DATA_ROOT, cohort)
  const cache = path.join(dir, 'pairs-cache')

  const edits = JSON.parse(fs.readFileSync(path.join(dir, 'edits.json')))
  const labels = new Map()
  for (const line of fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf-8').trim().split('\n')) {
    const rec = JSON.parse(line)
    labels.set(rec.revid, rec)
  }

  const verdictMap = new Map()
  if (fs.existsSync(path.join(dir, 'verdicts.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf-8').trim().split('\n')) {
      const rec = JSON.parse(line)
      verdictMap.set(rec.revid, rec)
    }
  }

  const missedProse = []
  const carryNeither = []

  for (const e of edits) {
    const label = labels.get(e.revid)
    if (!label || label.error || !label.types) continue

    const verdict = verdictMap.get(e.revid)
    if (!verdict) continue

    const prose = Object.keys(label.types).some(k => PROSE_KEYS.has(k))
    if (prose && !verdict.substantive) {
      // missed-prose: mwedittypes says prose, we say not substantive
      missedProse.push({ revid: e.revid, title: e.title, parentid: e.parentid, label, verdict })
    } else if (verdict.substantive && !prose) {
      // Check for carry-neither: no prose AND no mapped AND no Template keys
      const keys = Object.keys(label.types)
      const hasMapped = keys.some(k => MAPPED_KEYS.has(k))
      const hasTemplate = keys.includes('Template')
      if (!hasMapped && !hasTemplate) {
        carryNeither.push({ revid: e.revid, title: e.title, parentid: e.parentid, label, verdict })
      }
    }
  }

  // Render missed-prose entries
  if (missedProse.length > 0) {
    console.log(`## Missed prose (${missedProse.length})\n`)
    for (const item of missedProse) {
      console.log(`#### ${cohort} ${item.revid} — ${item.title}\n`)
      const labelKeys = Object.keys(item.label.types).sort().join(', ')
      console.log(`label keys: ${labelKeys} | verdict: substantive=${item.verdict.substantive} reasons=[${item.verdict.reasons.join(', ')}] ignored=[${item.verdict.ignored.join(', ')}]\n`)

      try {
        const prev = fs.readFileSync(path.join(cache, `${item.parentid}.txt`), 'utf-8')
        const curr = fs.readFileSync(path.join(cache, `${item.revid}.txt`), 'utf-8')
        const hunks = getDiffHunks(prev, curr)
        if (hunks) {
          console.log('```diff')
          console.log(hunks.trim())
          console.log('```\n')
        }
      } catch (err) {
        console.log(`(could not load wikitext: ${err.message})\n`)
      }

      console.log('Diagnosis: TODO\n')
    }
  }

  // Render carry-neither entries
  if (carryNeither.length > 0) {
    console.log(`## Carry-neither (${carryNeither.length})\n`)
    for (const item of carryNeither) {
      console.log(`#### ${cohort} ${item.revid} — ${item.title}\n`)
      const labelKeys = Object.keys(item.label.types).sort().join(', ')
      console.log(`label keys: ${labelKeys} | verdict: substantive=${item.verdict.substantive} reasons=[${item.verdict.reasons.join(', ')}] ignored=[${item.verdict.ignored.join(', ')}]\n`)

      try {
        const prev = fs.readFileSync(path.join(cache, `${item.parentid}.txt`), 'utf-8')
        const curr = fs.readFileSync(path.join(cache, `${item.revid}.txt`), 'utf-8')
        const hunks = getDiffHunks(prev, curr)
        if (hunks) {
          console.log('```diff')
          console.log(hunks.trim())
          console.log('```\n')
        }
      } catch (err) {
        console.log(`(could not load wikitext: ${err.message})\n`)
      }

      console.log('Diagnosis: TODO\n')
    }
  }

  if (missedProse.length === 0 && carryNeither.length === 0) {
    console.log('No disagreements found.')
  }
}

main()
