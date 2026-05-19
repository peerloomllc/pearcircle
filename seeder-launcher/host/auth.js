const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// Localhost-bound services are not zero-risk: any process on the same
// machine can hit 127.0.0.1. The token model is a 32-byte random hex
// string written to <dataDir>/auth.token on first launch with 0600
// permissions, accepted via ?t=<token> query or Authorization: Bearer.
// Browser opens the URL with ?t= baked in; the UI persists the token
// to sessionStorage and uses it for subsequent fetches.
function loadOrCreateToken (dataDir) {
  const tokenPath = path.join(dataDir, 'auth.token')
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing.length === 64) return { token: existing, path: tokenPath, fresh: false }
  } catch {}
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
  return { token, path: tokenPath, fresh: true }
}

function extractToken (req) {
  const auth = req.headers['authorization']
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const url = new URL(req.url, 'http://localhost')
  return url.searchParams.get('t')
}

function verify (req, token) {
  const provided = extractToken(req)
  if (!provided || provided.length !== token.length) return false
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))
}

module.exports = { loadOrCreateToken, verify, extractToken }
