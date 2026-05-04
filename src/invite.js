// PearCircle — Invite link build/parse.
//
// Format (current):
//   https://peerloomllc.com/circle/join?circle={base64(circleId)}&name={name}&key={hex}&inviter={hex}
//
// Legacy custom scheme also accepted:
//   pear://pearcircle/join?circle=...&name=...&key=...&inviter=...
//
// Per-app `/circle/` path prefix avoids collision with PearCal's `/join` on
// the same shared host.

const HOST_PATH = 'https://peerloomllc.com/circle/join'
const LEGACY_SCHEME = 'pear://pearcircle/join'

const MAX_NAME = 64
const KEY_LEN = 64

function buildInvite({ circleId, name, key, inviter }) {
  if (!circleId || !key || !inviter) throw new Error('missing required field')
  if (name && name.length > MAX_NAME) throw new Error('name too long')
  if (key.length !== KEY_LEN) throw new Error('bad key length')
  const params = new URLSearchParams({
    circle: Buffer.from(circleId).toString('base64'),
    name: name ?? '',
    key,
    inviter
  })
  return `${HOST_PATH}?${params}`
}

function parseInvite(url) {
  const trimmed = String(url ?? '').trim()
  let qIndex = trimmed.indexOf('?')
  if (qIndex === -1) throw new Error('no query string')

  const path = trimmed.slice(0, qIndex)
  const isHttps = path === HOST_PATH
  const isLegacy = path === LEGACY_SCHEME
  if (!isHttps && !isLegacy) throw new Error('unrecognized invite host/path')

  const params = new URLSearchParams(trimmed.slice(qIndex + 1))
  const circleB64 = params.get('circle')
  const key = params.get('key')
  const inviter = params.get('inviter')
  if (!circleB64 || !key || !inviter) throw new Error('missing required param')
  if (key.length !== KEY_LEN) throw new Error('bad key length')

  return {
    circleId: Buffer.from(circleB64, 'base64').toString('utf8'),
    name: params.get('name') ?? '',
    key,
    inviter
  }
}

module.exports = { buildInvite, parseInvite, HOST_PATH, LEGACY_SCHEME }
