#!/usr/bin/env node
/**
 * Send an alert message via Bluesky DM and Mastodon DM.
 * Used by healthcheck.sh when the bot container is down.
 *
 * Usage: node send-alert.js "your alert message"
 *
 * Reads credentials the same way the bot does (lib/config.js): an explicit
 * CONFIG_PATH wins, then the SFEDITS_CONFIG environment variable — the only
 * source that exists inside Toolforge job containers — then ./config.json.
 */

var https = require('https')
var loadConfig = require('../lib/config.js').loadConfig

var message = process.argv[2]

if (!message) {
  console.error('Usage: node send-alert.js "message"')
  process.exit(1)
}

var rawConfig
try {
  rawConfig = loadConfig({ path: process.env.CONFIG_PATH || null })
} catch (err) {
  console.error('Failed to read config:', err.message)
  process.exit(1)
}

// Config may have credentials at top level or nested under accounts[0]
var config
if (rawConfig.bluesky) {
  config = rawConfig
} else if (rawConfig.accounts && rawConfig.accounts[0]) {
  config = rawConfig.accounts[0]
} else {
  console.error('No bluesky/mastodon credentials found in config')
  process.exit(1)
}

function httpsRequest(url, options, body) {
  return new Promise(function (resolve, reject) {
    var parsed = new URL(url)
    var opts = Object.assign({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    })

    var req = https.request(opts, function (res) {
      var chunks = []
      res.on('data', function (chunk) { chunks.push(chunk) })
      res.on('end', function () {
        var data = Buffer.concat(chunks).toString()
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          resolve({ raw: data })
        }
      })
    })

    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function sendBlueskyDM(message) {
  if (!config.bluesky || !config.bluesky.identifier || !config.bluesky.password) {
    console.error('Bluesky credentials not configured')
    return Promise.resolve()
  }
  if (!config.pii_alerts || !config.pii_alerts.bluesky_recipient) {
    console.error('No bluesky_recipient in pii_alerts config')
    return Promise.resolve()
  }

  return httpsRequest('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({
    identifier: config.bluesky.identifier,
    password: config.bluesky.password
  }))
  .then(function (session) {
    if (session.error) {
      console.error('Bluesky login failed:', session.error)
      return
    }

    return httpsRequest('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=100', {
      headers: { 'Authorization': 'Bearer ' + session.accessJwt }
    })
    .then(function (convosData) {
      if (convosData.error) {
        console.error('Failed to list Bluesky conversations:', convosData.error)
        return
      }

      var recipient = config.pii_alerts.bluesky_recipient
      var convo = null
      for (var i = 0; i < convosData.convos.length; i++) {
        var c = convosData.convos[i]
        for (var j = 0; j < c.members.length; j++) {
          if (c.members[j].handle === recipient) {
            convo = c
            break
          }
        }
        if (convo) break
      }

      if (!convo) {
        console.error('No existing Bluesky conversation with ' + recipient)
        return
      }

      return httpsRequest('https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + session.accessJwt,
          'Content-Type': 'application/json'
        }
      }, JSON.stringify({
        convoId: convo.id,
        message: { text: message }
      }))
      .then(function () {
        console.log('Bluesky DM sent')
      })
    })
  })
  .catch(function (err) {
    console.error('Bluesky DM failed:', err.message)
  })
}

function sendMastodonDM(message) {
  if (!config.mastodon || !config.mastodon.instance || !config.mastodon.access_token) {
    console.error('Mastodon credentials not configured')
    return Promise.resolve()
  }
  if (!config.pii_alerts || !config.pii_alerts.mastodon_recipient) {
    console.error('No mastodon_recipient in pii_alerts config')
    return Promise.resolve()
  }

  var recipient = config.pii_alerts.mastodon_recipient
  var text = '@' + recipient + ' ' + message

  return httpsRequest(config.mastodon.instance + '/api/v1/statuses', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + config.mastodon.access_token,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({
    status: text,
    visibility: 'direct'
  }))
  .then(function (result) {
    if (result.error) {
      console.error('Mastodon DM failed:', result.error)
      return
    }
    console.log('Mastodon DM sent')
  })
  .catch(function (err) {
    console.error('Mastodon DM failed:', err.message)
  })
}

Promise.all([
  sendBlueskyDM(message),
  sendMastodonDM(message)
]).then(function () {
  process.exit(0)
})
