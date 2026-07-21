/**
 * Minimal Mastodon REST client (media upload, status post, status delete).
 *
 * Replaces the unmaintained `mastodon` npm package, which pulled in several
 * vulnerable transitive dependencies (request, form-data, qs, tough-cookie,
 * uuid) with no upstream fixes available.
 *
 * @see https://docs.joinmastodon.org/methods/statuses/
 * @see https://docs.joinmastodon.org/methods/media/
 */

const fs = require('fs')

function formBody(params) {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      value.forEach(v => usp.append(`${key}[]`, v))
    } else {
      usp.append(key, value)
    }
  }
  return usp
}

function client({ access_token, instance }) {
  const base = instance.replace(/\/$/, '') + '/api/v1'

  async function send(method, path, { headers = {}, body } = {}) {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${access_token}`, ...headers },
      body
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `Mastodon API error: ${res.status}`)
    }
    return { data }
  }

  return {
    async postMedia(filePath, description) {
      const form = new FormData()
      form.append('file', new Blob([fs.readFileSync(filePath)]), 'image.png')
      if (description) form.append('description', description)
      return send('POST', 'media', { body: form })
    },

    async postStatus(params) {
      const body = formBody(params)
      return send('POST', 'statuses', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
    },

    async deleteStatus(id) {
      return send('DELETE', `statuses/${id}`)
    }
  }
}

module.exports = { client }
