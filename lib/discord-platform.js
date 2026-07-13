/**
 * Discord Platform Posting
 *
 * High-level posting abstraction for Discord via incoming webhooks. Webhooks
 * are per-channel URLs created in Discord's channel settings — no bot user,
 * OAuth flow, or gateway connection required. This matches the same
 * post({ account, text, screenshot, metadata }) interface as the Bluesky and
 * Mastodon platform modules.
 *
 * Text is formatted with Discord markdown: the article name and editor become
 * masked links, and bare URLs are wrapped in <> to suppress Discord's link
 * preview embeds (the screenshot attachment is the visual).
 *
 * @see https://discord.com/developers/docs/resources/webhook#execute-webhook
 */

const fs = require('fs')
const path = require('path')

/**
 * Format post text with Discord markdown links
 *
 * Wraps bare URLs (the diff URL) in <> to suppress embeds, then converts the
 * article name and editor name into masked links. Name replacement searches
 * after the article name's position, mirroring buildFacets, so an editor name
 * that happens to appear inside the article title isn't mislinked.
 *
 * @param {string} text - Plain post text (after IP enrichment)
 * @param {string} page - Wikipedia article name
 * @param {string} name - Editor username/IP
 * @param {string} pageUrl - Wikipedia article URL
 * @param {string} userUrl - Editor contributions URL
 * @returns {string} Discord-flavored markdown text
 */
function buildDiscordText(text, page, name, pageUrl, userUrl) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  // Suppress link previews for bare URLs (e.g. the diff URL)
  let result = text.replace(/https?:\/\/[^\s<>]+/g, '<$&>')

  let searchOffset = 0

  if (page && pageUrl) {
    const idx = result.indexOf(page, searchOffset)
    if (idx !== -1) {
      const link = `[${page}](<${pageUrl}>)`
      result = result.slice(0, idx) + link + result.slice(idx + page.length)
      searchOffset = idx + link.length
    }
  }

  if (name && userUrl) {
    const idx = result.indexOf(name, searchOffset)
    if (idx !== -1) {
      const link = `[${name}](<${userUrl}>)`
      result = result.slice(0, idx) + link + result.slice(idx + name.length)
    }
  }

  return result
}

// Discord embed limits
const EMBED_TITLE_MAX = 256
const EMBED_DESCRIPTION_MAX = 4096
const EMBED_FIELD_MAX = 1024

// Wikipedia-diff palette for the embed accent stripe
const COLOR_ADDED = 0x14866d
const COLOR_REMOVED = 0xd73333
const COLOR_MIXED = 0x3366cc

function clip(text, max) {
  if (!text || text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * Make a URL safe for use inside Discord markdown [label](url): unescaped
 * parentheses (common in article titles like "Connie Chan (politician)")
 * terminate the link early.
 */
function mdUrl(url) {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/**
 * Build on-wiki action links for an edit. All are plain URLs - the click
 * lands on Wikipedia where the user acts with their own account. Undo is
 * MediaWiki's standard preloaded-revert link. (Rollback and Thanks need
 * tokens, so they can't be linked directly.)
 *
 * @param {Object} metadata - Needs diffUrl (with diff= and oldid=) and page
 * @returns {string|null} Markdown action row, or null if the diff URL
 *   can't be parsed
 */
function buildActionLinks(metadata) {
  let host, newRev, oldRev
  try {
    const url = new URL(metadata.diffUrl)
    host = url.host
    newRev = url.searchParams.get('diff')
    oldRev = url.searchParams.get('oldid')
  } catch (e) {
    return null
  }
  if (!host || !newRev) return null

  const title = encodeURIComponent(metadata.page.replace(/ /g, '_'))
  const base = `https://${host}/w/index.php`
  const links = []

  if (oldRev) {
    links.push(`[↩ Undo](${mdUrl(`${base}?title=${title}&action=edit&undo=${newRev}&undoafter=${oldRev}`)})`)
  }
  links.push(`[🕘 History](${mdUrl(`${base}?title=${title}&action=history`)})`)
  links.push(`[💬 Editor talk](${mdUrl(`https://${host}/wiki/User_talk:${encodeURIComponent(metadata.name.replace(/ /g, '_'))}`)})`)
  links.push(`[👁 Watch](${mdUrl(`${base}?title=${title}&action=watch`)})`)
  if (metadata.article?.blp?.isBlp && host === 'en.wikipedia.org') {
    links.push(`[🛡 BLP/N](${mdUrl(`https://${host}/wiki/Wikipedia:Biographies_of_living_persons/Noticeboard`)})`)
  }

  return links.join(' · ')
}

/**
 * Format change fragments as a Discord quote block, one per line.
 */
function formatFragments(fragments, max = EMBED_FIELD_MAX) {
  const joined = fragments
    .map(f => `> ${f.replace(/\n+/g, ' ')}`)
    .join('\n')
  return clip(joined, max)
}

/**
 * Build a rich embed from the structured diff data. Unlike the Bluesky
 * post (300 graphemes), Discord gives us ~4k of description and fields,
 * so the embed carries the change excerpts, the Wikidata description of
 * the subject, and the article's lead image - not just a screenshot.
 *
 * @param {Object} metadata - Extended post metadata (see page-watch.js):
 *   page, name, pageUrl, userUrl, diffUrl, wiki, altText,
 *   summary ({counts, sentence, added, removed}), article
 *   ({description, thumbnailUrl})
 * @param {string} filename - Screenshot attachment filename
 * @returns {Object} Discord embed object
 */
function buildDiscordEmbed(metadata, filename) {
  const { summary, article } = metadata

  const descriptionParts = []
  if (article?.blp?.isBlp) {
    // The Wikidata link doubles as the fix path for false flags: a dead
    // person showing as BLP means the item is missing its death date
    const wd = article.blp.qid
      ? ` · [Wikidata](${mdUrl(`https://www.wikidata.org/wiki/${article.blp.qid}`)})`
      : ''
    descriptionParts.push((article.blp.reason === 'recently-deceased'
      ? '🛡 **BLP** — recently deceased, biographies policy still applies'
      : '🛡 **BLP** — biography of a living person') + wd)
  } else if (article?.blp?.missingItem) {
    // No item means BLP status is unknowable - surface the gap so someone
    // can fix it
    const createUrl = mdUrl(`https://www.wikidata.org/wiki/Special:NewItem?label=${encodeURIComponent(metadata.page)}`)
    descriptionParts.push(`◇ No Wikidata item — BLP status unknown · [create item](${createUrl})`)
  }
  if (article?.description) {
    descriptionParts.push(`*${clip(article.description, 200)}*`)
  }
  descriptionParts.push(
    `**${clip(summary.sentence.charAt(0).toUpperCase() + summary.sentence.slice(1), 300)}** · [view diff](${mdUrl(metadata.diffUrl)})`
  )

  const fields = []
  const actions = buildActionLinks(metadata)
  if (actions) {
    fields.push({ name: 'Actions', value: actions, inline: false })
  }
  if (summary.added?.length) {
    fields.push({ name: 'Added', value: formatFragments(summary.added), inline: false })
  }
  if (summary.removed?.length) {
    fields.push({ name: 'Removed', value: formatFragments(summary.removed), inline: false })
  }

  let color = COLOR_MIXED
  const { counts } = summary
  if (counts.added > 0 && counts.removed === 0 && counts.changed === 0) color = COLOR_ADDED
  else if (counts.removed > 0 && counts.added === 0 && counts.changed === 0) color = COLOR_REMOVED

  const embed = {
    title: clip(metadata.page, EMBED_TITLE_MAX),
    url: metadata.pageUrl || metadata.diffUrl,
    description: clip(descriptionParts.join('\n\n'), EMBED_DESCRIPTION_MAX),
    color,
    author: {
      name: clip(`Edited by ${metadata.name}`, EMBED_TITLE_MAX),
      url: metadata.userUrl
    },
    fields,
    image: { url: `attachment://${filename}` },
    footer: { text: metadata.wiki || 'Wikipedia' },
    timestamp: new Date().toISOString()
  }
  if (article?.thumbnailUrl) {
    embed.thumbnail = { url: article.thumbnailUrl }
  }
  return embed
}

/**
 * Posts to a Discord channel via incoming webhook
 *
 * Sends a multipart request with the screenshot as an image attachment.
 * When structured diff data is available (metadata.summary), the post is a
 * rich embed: article title + Wikidata description, editor, change counts,
 * added/removed excerpts, lead-image thumbnail, and the diff screenshot.
 * Without it (fallback screenshot path), posts the legacy markdown text.
 * Uses ?wait=true so Discord returns the created message (and a real HTTP
 * error on failure) instead of a fire-and-forget 204.
 *
 * @param {Object} options - Posting options
 * @param {Object} options.account - Discord config ({ webhook_url })
 * @param {string} options.text - Post text (should be enriched with IP flags)
 * @param {string} options.screenshot - Path to screenshot PNG file
 * @param {Object} options.metadata - Post metadata (see buildDiscordEmbed)
 * @returns {Promise<Object>} Discord message object
 * @throws {Error} If the webhook request fails
 */
async function post({ account, text, screenshot, metadata }) {
  const url = new URL(account.webhook_url)
  url.searchParams.set('wait', 'true')

  const filename = path.basename(screenshot)
  const payload = {
    // Never ping anyone even if an editor name looks like a mention
    allowed_mentions: { parse: [] },
    attachments: [{
      id: 0,
      filename,
      description: metadata.altText || `Screenshot of edit to ${metadata.page}`
    }]
  }

  if (metadata.summary) {
    payload.embeds = [buildDiscordEmbed(metadata, filename)]
  } else {
    payload.content = buildDiscordText(
      text,
      metadata.page,
      metadata.name,
      metadata.pageUrl,
      metadata.userUrl
    )
  }

  const form = new FormData()
  form.append('payload_json', JSON.stringify(payload))
  const imageData = fs.readFileSync(screenshot)
  form.append('files[0]', new Blob([imageData], { type: 'image/png' }), filename)

  const response = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Discord webhook returned ${response.status}: ${body}`)
  }

  return await response.json()
}

module.exports = { post, buildDiscordText, buildDiscordEmbed, buildActionLinks }
