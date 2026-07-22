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
 * config from SFEDITS_CONFIG, articles from PageAssessments, claim targets
 * from WDQS - refreshed daily. A refresh failure keeps the last good data.
 *
 * The admin console (admin/server.js) is intentionally NOT part of the web
 * process: its Bluesky-DM login cannot function on a Discord-only account,
 * so exposing it would just ship dead, auth-gated code.
 */

const express = require('express')
const path = require('path')
const { loadConfig } = require('../lib/config')
const { fetchProjectArticles } = require('../lib/watchlist-sync')
const { refreshTargetSets, DEFAULT_PROPERTIES } = require('../lib/wikidata-claim-watch')

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
    try {
      articles = (await fetchProjectArticles(source)).sort()
    } catch (error) {
      console.error('Topics: dynamic list fetch failed:', error.message)
    }
    dynamic = {
      project: source.project,
      importance: source.importance || null,
      articles
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

  const dynamicSection = topics.dynamic ? `
    <h2>Dynamic watchlist</h2>
    <p>${n(topics.dynamic.articles.length)} articles from the
      <strong>${escapeHtml(topics.dynamic.project)}</strong> WikiProject listing${
        topics.dynamic.importance
          ? `, importance ${topics.dynamic.importance.map(escapeHtml).join(' / ')}`
          : ''}.
      Refreshed daily - articles enter and leave as Wikipedia editors
      re-tag and re-assess them.</p>
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
     <a href="https://github.com/tieguy/sfedits">source</a> ·
     a fork of <a href="https://github.com/mrfinnsmith/sfedits">mrfinnsmith/sfedits</a> ·
     runs on <a href="https://toolforge.org">Toolforge</a></p>
</footer>
</body>
</html>`
}

app.get('/', (req, res) => {
  if (!app.locals.topics) {
    return res.status(503).send('Topics are still loading - try again shortly.')
  }
  res.type('html').send(renderPage(app.locals.topics))
})

app.get('/api/topics.json', (req, res) => {
  if (!app.locals.topics) {
    return res.status(503).json({ error: 'Topics are still loading' })
  }
  res.json(app.locals.topics)
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

async function refresh() {
  try {
    const config = loadConfig()
    app.locals.topics = await buildTopics(config, { dataDir: DATA_DIR })
    console.log(`✓ Topics refreshed: ${app.locals.topics.dynamic?.articles.length ?? 0} dynamic articles`)
  } catch (error) {
    console.error('Topics refresh failed (keeping previous data):', error.message)
  }
}

if (require.main === module) {
  refresh()
  const timer = setInterval(refresh, REFRESH_HOURS * 60 * 60 * 1000)
  timer.unref()
  app.listen(PORT, () => {
    console.log(`Public topics server on port ${PORT}`)
  })
}

module.exports = { app, buildTopics, renderPage }
