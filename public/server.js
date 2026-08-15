#!/usr/bin/env node

/**
 * Public topics page - what this bot watches, at a glance
 *
 * A deliberately tiny, read-only web server for the Toolforge webservice
 * (Procfile `web:` process). Serves a human-readable page and a JSON API
 * describing everything the bot covers: the static watchlist, the dynamic
 * task-force article list, and the Wikidata claim-watch configuration.
 *
 * The bot process keeps its lists in its own container, so this server
 * computes its own copy from the same sources with the same lib modules -
 * config from config.base.json + env vars, articles from PageAssessments, claim targets
 * from WDQS - refreshed daily. A refresh failure keeps the last good data.
 *
 * The admin console (admin/server.js) is intentionally NOT part of the web
 * process: its Bluesky-DM login cannot function on a Discord-only account,
 * so exposing it would just ship dead, auth-gated code.
 */

const express = require('express')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig } = require('../lib/config')
const { fetchSourceTitles } = require('../lib/watchlist-sync')
const { refreshTargetSets, DEFAULT_PROPERTIES } = require('../lib/wikidata-claim-watch')
const { createTopicStore } = require('../lib/topic-store')
const { createBot, estimateRegion, CreateError } = require('../lib/topic-create')
const { wmFetchJson } = require('../lib/mw-api')

const PORT = process.env.PORT || 8000
const DATA_DIR = path.join(__dirname, '..', 'data')
const REFRESH_HOURS = 24

// Display names for the claim-watch properties; anything unlisted falls
// back to its P-id (the page is a summary, not a Wikidata mirror)
const PROPERTY_LABELS = {
  P19: 'place of birth',
  P20: 'place of death',
  P39: 'position held',
  P131: 'located in',
  P159: 'headquarters location',
  P276: 'location',
  P937: 'work location'
}

const app = express()

/**
 * Assemble the topics data structure from live sources. Uses the first
 * account (matching the sweeper's convention for this single-account bot).
 */
async function buildTopics(config, { dataDir }) {
  const account = (config.accounts || [])[0] || {}

  const staticWatchlist = {}
  for (const [wiki, pages] of Object.entries(account.watchlist || {})) {
    staticWatchlist[wiki] = Object.keys(pages).sort()
  }

  let dynamic = null
  if (account.watchlist_source) {
    const source = account.watchlist_source
    let articles = []
    let fetchError = null
    try {
      articles = (await fetchSourceTitles(source)).sort()
    } catch (error) {
      console.error('Topics: dynamic list fetch failed:', error.message)
      fetchError = error.message
    }
    dynamic = {
      // A published title list has no project name and no importance filter;
      // describe it by where it came from instead.
      project: source.project || null,
      titles_url: source.titles_url || null,
      importance: source.importance || null,
      articles,
      ...(fetchError ? { error: fetchError } : {})
    }
  }

  let claims = null
  if (account.wikidata_claims) {
    const sets = await refreshTargetSets(account.wikidata_claims, { dataDir })
    const propertyIds = account.wikidata_claims.properties || DEFAULT_PROPERTIES
    claims = {
      properties: [...propertyIds, 'P39'].map(id => ({
        id,
        label: PROPERTY_LABELS[id] || id
      })),
      placeCount: sets.places.size,
      positionCount: sets.positions.size
    }
  }

  return { staticWatchlist, dynamic, claims, updated_at: new Date().toISOString() }
}

// Where scripts/record-deploy.js (run by the autoupdate job) appends deploy
// records. Both processes see the same tool home because job and webservice
// run with mount=all — reached via $TOOL_DATA_DIR, since $HOME does not point
// at the NFS home in build-service containers. Resolved per request so the
// page always reflects the file and tests can point it elsewhere.
const REPO_WEB = (process.env.SFEDITS_DEPLOY_REPO || 'https://github.com/tieguy/sfedits.git')
  .replace(/\.git$/, '')

function readChangelog() {
  const stateDir = process.env.SFEDITS_STATE_DIR ||
    path.join(process.env.TOOL_DATA_DIR || os.homedir(), 'data')
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'changelog.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function articleLink(title) {
  const href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
  return `<a href="${href}">${escapeHtml(title)}</a>`
}

function renderPage(topics) {
  const n = x => x.toLocaleString('en-US')

  const staticSections = Object.entries(topics.staticWatchlist)
    .map(([wiki, titles]) =>
      `<h3>${escapeHtml(wiki)}</h3>
       <ul class="cols">${titles.map(t => `<li>${articleLink(t)}</li>`).join('')}</ul>`)
    .join('')

  // Two source types, two very different provenance stories: a WikiProject
  // listing changes as editors re-assess, a published ranking changes when the
  // ranking is regenerated. Saying "WikiProject listing" for both would be a lie.
  const dynamicProvenance = topics.dynamic && topics.dynamic.titles_url
    ? `<p>${n(topics.dynamic.articles.length)} articles from a published ranking:
        <a href="${escapeHtml(topics.dynamic.titles_url)}">${escapeHtml(topics.dynamic.titles_url)}</a>.
        Ranked by how many other Bay Area articles link to each one from prose
        - see the
        <a href="https://github.com/tieguy/sfedits/blob/integration/docs/importance-ranking-methodology.md">method</a>.
        Refreshed daily; the list changes when the ranking is regenerated.</p>`
    : topics.dynamic ? `<p>${n(topics.dynamic.articles.length)} articles from the
        <strong>${escapeHtml(topics.dynamic.project)}</strong> WikiProject listing${
          topics.dynamic.importance
            ? `, importance ${topics.dynamic.importance.map(escapeHtml).join(' / ')}`
            : ''}.
        Refreshed daily - articles enter and leave as Wikipedia editors
        re-tag and re-assess them.</p>` : ''

  const dynamicSection = topics.dynamic ? `
    <h2>Dynamic watchlist</h2>
    ${dynamicProvenance}
    <details>
      <summary>Show all ${n(topics.dynamic.articles.length)} articles</summary>
      <ul class="cols">${topics.dynamic.articles.map(t => `<li>${articleLink(t)}</li>`).join('')}</ul>
    </details>` : ''

  const claimsSection = topics.claims ? `
    <h2>Wikidata claim notices</h2>
    <p>Beyond article edits, the bot announces when a
      <a href="https://www.wikidata.org">Wikidata</a> statement connects an
      entity to the Bay Area - or removes that connection. Watched
      properties: ${topics.claims.properties.map(p =>
        `<a href="https://www.wikidata.org/wiki/Property:${p.id}">${escapeHtml(p.label)}</a>`
      ).join(', ')}.</p>
    <p>Values match against ${n(topics.claims.placeCount)} Bay Area places
      (anything whose located-in chain reaches one of the nine counties) and
      ${n(topics.claims.positionCount)} offices with Bay Area jurisdiction.</p>` : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>San Francisco Edit Stream - coverage</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; background: #fff; }
  a { color: #0645ad; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: .3rem; }
  .cols { columns: 3 14rem; padding-left: 1.2rem; }
  details summary { cursor: pointer; margin: .5rem 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: .85rem; color: #555; }
  @media (prefers-color-scheme: dark) {
    body { color: #ddd; background: #121212; }
    a { color: #8ab4f8; }
    footer { color: #999; }
  }
</style>
</head>
<body>
<h1>San Francisco Edit Stream</h1>
<p>A bot that watches Wikipedia and Wikidata for changes to San Francisco
   Bay Area topics and posts them to Discord. This page lists everything
   currently covered.</p>

<h2>Always-watched articles</h2>
${staticSections}
${dynamicSection}
${claimsSection}

<footer>
  <p>Updated ${escapeHtml(topics.updated_at)} ·
     <a href="/api/topics.json">JSON</a> ·
     <a href="/matrix">untagged-article matrix</a> ·
     <a href="/changelog">changelog</a> ·
     <a href="https://github.com/tieguy/sfedits">source</a> ·
     a fork of <a href="https://github.com/mrfinnsmith/sfedits">mrfinnsmith/sfedits</a> ·
     runs on <a href="https://toolforge.org">Toolforge</a></p>
</footer>
</body>
</html>`
}

/**
 * The deploy changelog: what the autoupdater has shipped to this
 * instance, newest first, so "is my PR live yet?" is answerable from a
 * browser instead of a bastion shell.
 */
function renderChangelog(deploys) {
  const entries = deploys.slice().reverse().map((d, i) => {
    const sha = String(d.sha || '')
    const when = d.deployed_at
      ? escapeHtml(String(d.deployed_at).replace('T', ' ').replace(/(\.\d+)?Z?$/, '') + ' UTC')
      : 'unknown time'
    const live = i === 0 ? ' <span class="live">live</span>' : ''
    const changes = (d.changes || []).map(c => {
      const pr = Number(c.pr)
      const link = pr
        ? ` <a href="${REPO_WEB}/pull/${pr}">#${pr}</a>`
        : ''
      return `<li>${escapeHtml(c.title || '')}${link}</li>`
    }).join('')
    return `<section>
      <h2>${when}${live}</h2>
      <p class="hint">deployed <a href="${REPO_WEB}/commit/${escapeHtml(sha)}"><code>${escapeHtml(sha.slice(0, 8))}</code></a></p>
      ${changes ? `<ul>${changes}</ul>` : '<p class="hint">change list unavailable for this deploy</p>'}
    </section>`
  }).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>San Francisco Edit Stream - changelog</title>
<style>${PAGE_STYLE}
  .live { font-size: .7em; font-weight: 600; vertical-align: middle; padding: .1rem .45rem; border-radius: 1rem; background: #22863a; color: #fff; }
  section h2 { margin-bottom: .1rem; }
  section .hint { margin-top: 0; }
</style>
</head>
<body>
<h1>Changelog</h1>
<p>Each entry is one automatic deploy of this instance: the autoupdater
   polls the <a href="${REPO_WEB}/tree/integration">integration branch</a>
   every 15 minutes and redeploys when it moves, then records what went
   live here.</p>
${entries || '<p>No deploys recorded yet - entries appear with the first autoupdate after this page shipped.</p>'}
<footer>
  <p><a href="/changelog.json">JSON</a> ·
     <a href="/">coverage page</a> ·
     <a href="${REPO_WEB}">source</a></p>
</footer>
</body>
</html>`
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; background: #fff; }
  a { color: #0645ad; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: .3rem; }
  .cols { columns: 3 14rem; padding-left: 1.2rem; }
  details summary { cursor: pointer; margin: .5rem 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: .85rem; color: #555; }
  label { display: block; margin: 1.2rem 0 .3rem; font-weight: 600; }
  input[type=text] { width: 100%; padding: .5rem; font: inherit; border: 1px solid #bbb; border-radius: 4px; background: #fff; color: inherit; }
  button { font: inherit; padding: .6rem 1.2rem; margin-top: 1.5rem; border: 0; border-radius: 4px; background: #0645ad; color: #fff; cursor: pointer; }
  button[disabled] { background: #999; cursor: default; }
  .hint { font-size: .85rem; color: #555; margin: .25rem 0 0; }
  .results { list-style: none; padding: 0; margin: .4rem 0 0; border: 1px solid #ddd; border-radius: 4px; }
  .results:empty { border: 0; }
  .results li { padding: .5rem; cursor: pointer; border-bottom: 1px solid #eee; }
  .results li:last-child { border-bottom: 0; }
  .results li:hover, .results li[aria-selected=true] { background: #eef3fb; }
  .chosen { margin-top: .5rem; padding: .6rem; border-left: 3px solid #0645ad; background: #f6f8fc; }
  .error { border-left-color: #c00; background: #fdf0f0; }
  .ok { border-left-color: #22863a; background: #f0f8f2; }
  @media (prefers-color-scheme: dark) {
    body { color: #ddd; background: #121212; }
    a { color: #8ab4f8; }
    footer { color: #999; }
    input[type=text] { background: #1e1e1e; border-color: #444; }
    .hint { color: #aaa; }
    .results { border-color: #333; }
    .results li { border-color: #262626; }
    .results li:hover, .results li[aria-selected=true] { background: #1c2733; }
    .chosen { background: #172029; }
    .error { background: #2a1616; }
    .ok { background: #16241a; }
  }`

/**
 * The create form.
 *
 * One page, no build step, no framework - the same shape as the rest of this
 * server. The client-side script does three things: search places, show what a
 * place would cost before anything is written, and submit.
 */
function renderCreatePage({ enabled }) {
  const disabledNotice = enabled ? '' : `
    <div class="chosen error">
      <strong>Bot creation is not enabled here.</strong>
      This deployment has no <code>topic_store</code> or no
      <code>web.invite_codes</code> configured.
    </div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Make a place bot</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>Make a place bot</h1>
<p>Pick a place. Every time someone edits a Wikipedia article about something
   in it, the bot posts the diff to your Discord channel.</p>
${disabledNotice}

<form id="create">
  <label for="invite">Invite code</label>
  <input type="text" id="invite" name="invite_code" autocomplete="off" required>
  <p class="hint">This is an alpha. If you do not have a code, you are early.</p>

  <label for="place">Place</label>
  <input type="text" id="place" autocomplete="off"
         placeholder="Mission District, San Mateo County, Aotearoa…">
  <ul class="results" id="results"></ul>
  <input type="hidden" name="region_qid" id="qid">
  <div id="chosen"></div>

  <label for="languages">Language editions</label>
  <input type="text" id="languages" name="languages" value="en">
  <p class="hint">Wiki codes, comma separated. <code>en</code>, or
     <code>en, es</code> for both.</p>

  <label for="webhook">Discord webhook URL</label>
  <input type="text" id="webhook" name="webhook_url" autocomplete="off"
         placeholder="https://discord.com/api/webhooks/…" required>
  <p class="hint">Channel settings → Integrations → Webhooks → New Webhook →
     Copy Webhook URL. Anyone with this URL can post to that channel, so treat
     it like a password.</p>

  <label for="owner">Your name</label>
  <input type="text" id="owner" name="owner_user" autocomplete="off" required>
  <p class="hint">Shown as the bot's owner. A Wikipedia username is ideal.</p>

  <button type="submit" id="submit"${enabled ? '' : ' disabled'}>Make the bot</button>
</form>

<div id="outcome"></div>

<footer>
  <p><a href="/">what this bot already watches</a> ·
     <a href="https://github.com/tieguy/sfedits">source</a> ·
     runs on <a href="https://toolforge.org">Toolforge</a></p>
</footer>

<script>
const $ = id => document.getElementById(id)
const show = (el, cls, html) => { el.innerHTML = '<div class="chosen ' + cls + '">' + html + '</div>' }
const escape = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let searchTimer = null

$('place').addEventListener('input', () => {
  clearTimeout(searchTimer)
  $('qid').value = ''
  $('chosen').innerHTML = ''
  const q = $('place').value.trim()
  if (q.length < 2) { $('results').innerHTML = ''; return }

  // Debounced: one request per pause, not one per keystroke. Wikidata's
  // search endpoint is a shared resource and this form is public.
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/places.json?q=' + encodeURIComponent(q))
      const data = await res.json()
      $('results').innerHTML = (data.places || []).map(p =>
        '<li data-qid="' + p.qid + '" data-label="' + escape(p.label) + '">' +
        '<strong>' + escape(p.label) + '</strong> ' +
        '<span class="hint">' + escape(p.description) + '</span></li>').join('')
    } catch (e) {
      $('results').innerHTML = ''
    }
  }, 250)
})

$('results').addEventListener('click', async event => {
  const li = event.target.closest('li')
  if (!li) return

  $('qid').value = li.dataset.qid
  $('place').value = li.dataset.label
  $('results').innerHTML = ''
  show($('chosen'), '', 'Checking how big ' + escape(li.dataset.label) + ' is…')

  try {
    const res = await fetch('/api/estimate.json?qid=' + li.dataset.qid +
      '&languages=' + encodeURIComponent($('languages').value))
    const data = await res.json()

    if (data.error) { show($('chosen'), 'error', escape(data.error)); return }

    const count = data.count === null
      ? 'an unknown number of'
      : data.count.toLocaleString('en-US')
    let html = '<strong>' + escape(data.label) + '</strong> (' + data.qid + ') — ' +
      count + ' articles, matched by ' +
      (data.strategy === 'admin' ? 'what they are located in' : 'where they are') + '.'
    if (data.note) html += '<br><span class="hint">' + escape(data.note) + '</span>'
    if (data.partial) html += '<br><span class="hint">The count is partial.</span>'
    show($('chosen'), data.count !== null && data.count > 5000 ? 'error' : 'ok', html)
  } catch (e) {
    show($('chosen'), 'error', 'Could not size that place: ' + escape(e.message))
  }
})

$('create').addEventListener('submit', async event => {
  event.preventDefault()
  if (!$('qid').value) {
    show($('outcome'), 'error', 'Pick a place from the search results first.')
    return
  }

  $('submit').disabled = true
  show($('outcome'), '', 'Working out what is in that place. This can take a few seconds…')

  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData($('create')))
    })
    const data = await res.json()

    if (data.error) {
      show($('outcome'), 'error', escape(data.error))
    } else {
      show($('outcome'), 'ok',
        '<strong>Done.</strong> Watching ' + data.articleCount.toLocaleString('en-US') +
        ' articles in ' + escape(data.label) + '. ' +
        (data.created
          ? 'This is a new bot (topic ' + data.topicId + ').'
          : 'Someone had already made this one, so you have joined it (topic ' +
            data.topicId + ') — you both get the same posts.') +
        '<br>Edits show up in your channel as they happen.')
    }
  } catch (e) {
    show($('outcome'), 'error', 'Request failed: ' + escape(e.message))
  } finally {
    $('submit').disabled = false
  }
})
</script>
</body>
</html>`
}

app.get('/', (req, res) => {
  if (!app.locals.topics) {
    return res.status(503).send('Topics are still loading - try again shortly.')
  }
  res.type('html').send(renderPage(app.locals.topics))
})

// Static snapshot of the untagged-article triage matrix, generated locally
// by scripts/matrix-untagged.js and committed - see the page's own header
app.get('/matrix', (req, res) => {
  res.sendFile(path.join(__dirname, 'matrix-untagged.html'))
})

// Deploy history, written by the autoupdate job via scripts/record-deploy.js
app.get('/changelog', (req, res) => {
  res.type('html').send(renderChangelog(readChangelog()))
})

app.get('/changelog.json', (req, res) => {
  res.json({ deploys: readChangelog() })
})

// The published article ranking, generated locally by scripts/rank.js and
// committed. Two cuts of one ranking: -500 is what the bot watches (it fetches
// this URL through watchlist_source.titles_url), -2500 is published for
// anyone wanting fuller coverage than the bot posts.
//
// Serving the bot's own watchlist from the bot's own webservice is a little
// circular, but the alternative - an on-wiki page - adds a parse step and a
// second failure mode, and watchlist-sync already falls back to its last-good
// cache if this 404s or goes away.
for (const cut of ['500', '2500']) {
  app.get(`/watchlist-${cut}.json`, (req, res) => {
    res.sendFile(path.join(__dirname, `watchlist-${cut}.json`))
  })
}

// The full ranking behind both watchlist cuts - every article in the universe
// with its current on-wiki importance and its link count, so anyone can check
// the numbers in the on-wiki proposal rather than take them on faith. Nothing
// on the runtime path reads this; it exists to be linked from the discussion.
app.get('/ranking.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'ranking.json'))
})

app.get('/api/topics.json', (req, res) => {
  if (!app.locals.topics) {
    return res.status(503).json({ error: 'Topics are still loading' })
  }
  res.json(app.locals.topics)
})

// ---------------------------------------------------------------------------
// Self-serve bot creation (Phase 7, alpha)
//
// Gated by an invite code from config rather than by Wikimedia OAuth: the
// OAuth consumer needs registration and approval, and waiting on that would
// keep the whole flow off the internet where nobody can find its bugs. The
// form's shape does not change when real identity lands - only where
// owner_user comes from.
//
// These routes no-op unless BOTH a topic_store and a web.invite_codes stanza
// are configured, so the existing read-only deployment is unaffected.
// ---------------------------------------------------------------------------

/** Search Wikidata for a place, so nobody has to know what a QID is. */
async function searchPlaces(query) {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    uselang: 'en',
    type: 'item',
    limit: '8',
    format: 'json',
    formatversion: '2'
  })

  const data = await wmFetchJson(`https://www.wikidata.org/w/api.php?${params}`, {
    component: 'web', timeoutMs: 10000, tries: 1
  })
  return (data.search || []).map(hit => ({
    qid: hit.id,
    label: hit.label || hit.id,
    description: hit.description || ''
  }))
}

function creationEnabled() {
  return Boolean(app.locals.topicStore) &&
    ((app.locals.webConfig || {}).invite_codes || []).length > 0
}

function sendCreateError(res, error) {
  if (error instanceof CreateError) {
    return res.status(error.status).json({ error: error.message, field: error.field })
  }
  console.error('Create failed:', error)
  return res.status(500).json({ error: 'Something broke on our side. Try again.' })
}

app.get('/create', (req, res) => {
  res.type('html').send(renderCreatePage({ enabled: creationEnabled() }))
})

app.get('/api/places.json', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (query.length < 2) return res.json({ places: [] })

  try {
    res.json({ places: await searchPlaces(query) })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/estimate.json', async (req, res) => {
  try {
    const languages = String(req.query.languages || 'en')
      .split(/[\s,]+/).filter(Boolean)
    res.json(await estimateRegion(req.query.qid, { languages }))
  } catch (error) {
    sendCreateError(res, error)
  }
})

app.post('/api/create', express.urlencoded({ extended: false }), async (req, res) => {
  if (!creationEnabled()) {
    return res.status(503).json({ error: 'Bot creation is not enabled on this deployment.' })
  }

  try {
    const result = await createBot({
      store: app.locals.topicStore,
      config: app.locals.webConfig,
      params: req.body
    })
    res.json(result)
  } catch (error) {
    sendCreateError(res, error)
  }
})

app.get('/toolinfo.json', (req, res) => {
  res.json({
    name: 'san-francisco-edit-stream',
    title: 'San Francisco Edit Stream',
    description: 'Watches Wikipedia and Wikidata for changes to San Francisco Bay Area topics and posts them to Discord.',
    url: 'https://san-francisco-edit-stream.toolforge.org',
    keywords: 'bot, recent changes, san francisco, wikidata',
    author: 'Luis Villa',
    repository: 'https://github.com/tieguy/sfedits',
    license: 'CC0-1.0'
  })
})

/**
 * True when the snapshot is missing or its dynamic list fetch failed — the
 * state a deploy rollout leaves behind when the fresh pod fetches its own
 * public URL before the front proxy routes to it.
 */
function topicsNeedRetry(topics) {
  return !topics || Boolean(topics.dynamic && topics.dynamic.error)
}

// An incomplete snapshot retries on a short backoff rather than waiting out
// the daily refresh timer.
const RETRY_INITIAL_MS = 30 * 1000
const RETRY_MAX_MS = 15 * 60 * 1000
let retryDelayMs = RETRY_INITIAL_MS
let retryTimer = null

async function refresh() {
  try {
    const config = loadConfig()
    app.locals.topics = await buildTopics(config, { dataDir: DATA_DIR })
    console.log(`✓ Topics refreshed: ${app.locals.topics.dynamic?.articles.length ?? 0} dynamic articles`)
  } catch (error) {
    console.error('Topics refresh failed (keeping previous data):', error.message)
  }
  if (topicsNeedRetry(app.locals.topics)) {
    if (!retryTimer) {
      console.log(`Topics incomplete; retrying in ${Math.round(retryDelayMs / 1000)}s`)
      retryTimer = setTimeout(() => {
        retryTimer = null
        refresh()
      }, retryDelayMs)
      retryTimer.unref()
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS)
    }
  } else {
    retryDelayMs = RETRY_INITIAL_MS
  }
}

/**
 * Attach the topic store, if this deployment has one. Creation stays off
 * without it, so the read-only coverage page runs exactly as it did before.
 */
function startCreation(config) {
  app.locals.webConfig = config.web || {}

  if (!config.topic_store) {
    console.log('No topic_store stanza: bot creation is off, coverage page only')
    return
  }

  app.locals.topicStore = createTopicStore({ config: config.topic_store })

  const codes = (app.locals.webConfig.invite_codes || []).length
  console.log(codes > 0
    ? `Bot creation enabled at /create (${codes} invite code(s))`
    : 'topic_store configured but no web.invite_codes: /create stays closed')
}

if (require.main === module) {
  refresh()
  try {
    startCreation(loadConfig())
  } catch (error) {
    console.error('Bot creation unavailable:', error.message)
  }
  const timer = setInterval(refresh, REFRESH_HOURS * 60 * 60 * 1000)
  timer.unref()
  app.listen(PORT, () => {
    console.log(`Public topics server on port ${PORT}`)
  })
}

module.exports = { app, buildTopics, renderPage, renderCreatePage, renderChangelog, startCreation, searchPlaces, topicsNeedRetry }
