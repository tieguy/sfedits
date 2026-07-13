/**
 * Wikipedia edit feed via EventStreams (SSE)
 *
 * Drop-in replacement for the wikichanges IRC client: consumes
 * https://stream.wikimedia.org/v2/stream/recentchange and emits edit
 * objects in the same shape wikichanges produced, so downstream code
 * (watchlist matching, status templates) is unchanged.
 *
 * Why EventStreams over IRC: it is the supported public interface, one
 * connection covers every wiki, and reconnects resume from the last seen
 * event (Last-Event-ID) instead of dropping whatever happened while
 * disconnected.
 *
 * @see https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams
 */

const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange'
const USER_AGENT = 'sfedits-bot/1.0 (https://github.com/tieguy/sfedits)'
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30000

// server_name -> the feed names wikichanges used (config watchlist keys)
const WIKI_NAMES = {
  'ar.wikipedia.org': 'Arabic Wikipedia',
  'bg.wikipedia.org': 'Bulgarian Wikipedia',
  'ca.wikipedia.org': 'Catalan Wikipedia',
  'commons.wikimedia.org': 'Wikimedia Commons',
  'cs.wikipedia.org': 'Czech Wikipedia',
  'da.wikipedia.org': 'Danish Wikipedia',
  'de.wikipedia.org': 'German Wikipedia',
  'en.wikipedia.org': 'English Wikipedia',
  'el.wikipedia.org': 'Greek Wikipedia',
  'eo.wikipedia.org': 'Esperanto Wikipedia',
  'es.wikipedia.org': 'Spanish Wikipedia',
  'eu.wikipedia.org': 'Euskara Wikipedia',
  'fa.wikipedia.org': 'Farsi Wikipedia',
  'fi.wikipedia.org': 'Finnish Wikipedia',
  'fr.wikipedia.org': 'French Wikipedia',
  'hi.wikipedia.org': 'Hindi Wikipedia',
  'he.wikipedia.org': 'Hebrew Wikipedia',
  'hr.wikipedia.org': 'Croatian Wikipedia',
  'hu.wikipedia.org': 'Hungarian Wikipedia',
  'id.wikipedia.org': 'Indonesian Wikipedia',
  'it.wikipedia.org': 'Italian Wikipedia',
  'ja.wikipedia.org': 'Japanese Wikipedia',
  'ko.wikipedia.org': 'Korean Wikipedia',
  'lt.wikipedia.org': 'Lithuanian Wikipedia',
  'ms.wikipedia.org': 'Malaysian Wikipedia',
  'nl.wikipedia.org': 'Dutch Wikipedia',
  'no.wikipedia.org': 'Norwegian Wikipedia',
  'pl.wikipedia.org': 'Polish Wikipedia',
  'pt.wikipedia.org': 'Portuguese Wikipedia',
  'ro.wikipedia.org': 'Romanian Wikipedia',
  'ru.wikipedia.org': 'Russian Wikipedia',
  'simple.wikipedia.org': 'Simple Wikipedia',
  'sk.wikipedia.org': 'Slovak Wikipedia',
  'sl.wikipedia.org': 'Slovene Wikipedia',
  'sv.wikipedia.org': 'Swedish Wikipedia',
  'tr.wikipedia.org': 'Turkish Wikipedia',
  'uk.wikipedia.org': 'Ukrainian Wikipedia',
  'vi.wikipedia.org': 'Vietnamese Wikipedia',
  'vo.wikipedia.org': 'Volapük Wikipedia',
  'www.wikidata.org': 'Wikidata',
  'zh.wikipedia.org': 'Chinese Wikipedia'
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{0,4}){2,7}$/

/**
 * Map a recentchange EventStreams event to the wikichanges edit shape.
 * Returns null for events downstream code should never see (non-edits).
 */
function toEdit(event) {
  if (event.type !== 'edit' || !event.revision?.new) return null

  const host = event.server_name
  const wikipediaUrl = `https://${host}`
  const page = event.title
  const user = event.user || ''
  const url = event.revision.old
    ? `${wikipediaUrl}/w/index.php?diff=${event.revision.new}&oldid=${event.revision.old}`
    : `${wikipediaUrl}/w/index.php?diff=${event.revision.new}`

  return {
    page,
    pageUrl: `${wikipediaUrl}/wiki/${page.replace(/ /g, '_')}`,
    url,
    delta: (event.length?.new != null && event.length?.old != null)
      ? event.length.new - event.length.old
      : null,
    comment: event.comment || '',
    wikipedia: WIKI_NAMES[host] || host,
    wikipediaUrl,
    user,
    userUrl: `${wikipediaUrl}/wiki/User:${user}`,
    unpatrolled: event.patrolled === false,
    newPage: false,
    robot: Boolean(event.bot),
    anonymous: IPV4_RE.test(user) || IPV6_RE.test(user),
    namespace: event.namespace === 0 ? 'article' : String(event.namespace)
  }
}

/**
 * Minimal SSE line-protocol parser over fetch's byte stream.
 * Calls onEvent(parsedJson) for each data payload, and tracks event ids
 * so reconnects can resume.
 */
class EditStream {
  constructor(opts = {}) {
    this.streamUrl = opts.streamUrl || STREAM_URL
    this.lastEventId = null
    this.stopped = false
    this.backoff = RECONNECT_MIN_MS
  }

  /**
   * Start streaming; cb(edit) is called for every edit event, in the
   * wikichanges shape. Never returns; reconnects forever until stop().
   */
  async listen(cb) {
    while (!this.stopped) {
      try {
        await this._consume(cb)
      } catch (error) {
        if (this.stopped) break
        console.error(`[edit-stream] Disconnected: ${error.message} - reconnecting in ${this.backoff}ms`)
        await new Promise(r => setTimeout(r, this.backoff))
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS)
      }
    }
  }

  stop() {
    this.stopped = true
    this.controller?.abort()
  }

  async _consume(cb) {
    this.controller = new AbortController()
    const headers = { 'User-Agent': USER_AGENT, Accept: 'text/event-stream' }
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId

    const res = await fetch(this.streamUrl, { headers, signal: this.controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    this.backoff = RECONNECT_MIN_MS

    const decoder = new TextDecoder()
    let buffer = ''
    let dataLines = []
    let eventId = null

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)

        if (line === '') {
          // dispatch event
          if (dataLines.length) {
            if (eventId) this.lastEventId = eventId
            try {
              const event = JSON.parse(dataLines.join('\n'))
              const edit = toEdit(event)
              if (edit) cb(edit)
            } catch (e) {
              // Malformed event: skip
            }
          }
          dataLines = []
          eventId = null
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('id:')) {
          eventId = line.slice(3).replace(/^ /, '')
        }
        // 'event:' and comment lines are irrelevant here
      }
    }
    throw new Error('stream ended')
  }
}

module.exports = { EditStream, toEdit, WIKI_NAMES }
