// Invite link builder and parser for PearCircle.
// Wire format per proposals/2026-05-03-wire-protocol.md §2 (amended 2026-05-04):
//   https://peerloomllc.com/circle/join?circle={base64url(32)}&name={name}&key={hex(32)}&bootstrap={hex(32)}&inviter={hex(32)}
// Legacy custom scheme also accepted: pear://pearcircle/join?...
//
// Path prefix is /circle/ (not /join/) so the link never collides with
// PearCal's invites on the shared peerloomllc.com host.
// `bootstrap` is the per-circle Autobase bootstrap writer core public key;
// distinct from `inviter` because the inviter need not be the original owner.

const HTTPS_HOST_PATH = 'https://peerloomllc.com/circle/join'
const PEAR_HOST_PATH = 'pear://pearcircle/join'
// Seed-invite path. Proposal 2026-05-19-blind-seeder-peers.
// Same field grammar as the join path; the path itself is the
// permission flag (consumed only by seed-mode worklets).
const HTTPS_SEED_HOST_PATH = 'https://peerloomllc.com/circle/seed'
const PEAR_SEED_HOST_PATH = 'pear://pearcircle/seed'

const HEX_64 = /^[0-9a-f]{64}$/i
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/
const NAME_MAX = 64

/**
 * Build an invite link.
 * @param {object} args
 * @param {string} args.circleId - 43-char base64url (32 bytes, no padding)
 * @param {string} args.name - 1..64 char display name (raw, will be URL-encoded)
 * @param {string} args.circleKey - 64-char hex (32 bytes)
 * @param {string} args.bootstrap - 64-char hex (32 bytes), Autobase bootstrap pubkey
 * @param {string} args.inviterPublicKey - 64-char hex (32 bytes)
 * @param {'https'|'pear'} [args.scheme='https']
 * @returns {string}
 */
function buildInvite ({ circleId, name, circleKey, bootstrap, inviterPublicKey, scheme = 'https' }) {
  if (typeof circleId !== 'string' || !BASE64URL_43.test(circleId)) {
    throw new Error('circleId must be a 43-char base64url string (32 bytes)')
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    throw new Error(`name must be a non-empty string of at most ${NAME_MAX} chars`)
  }
  if (typeof circleKey !== 'string' || !HEX_64.test(circleKey)) {
    throw new Error('circleKey must be a 64-char hex string (32 bytes)')
  }
  if (typeof bootstrap !== 'string' || !HEX_64.test(bootstrap)) {
    throw new Error('bootstrap must be a 64-char hex string (32 bytes)')
  }
  if (typeof inviterPublicKey !== 'string' || !HEX_64.test(inviterPublicKey)) {
    throw new Error('inviterPublicKey must be a 64-char hex string (32 bytes)')
  }
  if (scheme !== 'https' && scheme !== 'pear') {
    throw new Error('scheme must be "https" or "pear"')
  }

  const base = scheme === 'pear' ? PEAR_HOST_PATH : HTTPS_HOST_PATH
  const params = [
    `circle=${circleId}`,
    `name=${encodeURIComponent(name)}`,
    `key=${circleKey}`,
    `bootstrap=${bootstrap}`,
    `inviter=${inviterPublicKey}`,
  ].join('&')
  return `${base}?${params}`
}

/**
 * Parse an invite link.
 * @param {string} url
 * @returns {{ ok: boolean, scheme?: 'https'|'pear', circleId?: string, name?: string, circleKey?: string, bootstrap?: string, inviterPublicKey?: string, error?: string }}
 */
function parseInvite (url) {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' }

  let scheme, qs
  if (url.startsWith(HTTPS_HOST_PATH + '?')) {
    scheme = 'https'
    qs = url.slice(HTTPS_HOST_PATH.length + 1)
  } else if (url.startsWith(PEAR_HOST_PATH + '?')) {
    scheme = 'pear'
    qs = url.slice(PEAR_HOST_PATH.length + 1)
  } else {
    return { ok: false, error: 'not a PearCircle invite link' }
  }

  const params = parseQuery(qs)
  const circleId = params.circle
  const name = params.name
  const circleKey = params.key
  const bootstrap = params.bootstrap
  const inviterPublicKey = params.inviter

  if (typeof circleId !== 'string' || !BASE64URL_43.test(circleId)) {
    return { ok: false, error: 'invalid or missing circleId' }
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    return { ok: false, error: 'invalid or missing name' }
  }
  if (typeof circleKey !== 'string' || !HEX_64.test(circleKey)) {
    return { ok: false, error: 'invalid or missing circleKey' }
  }
  if (typeof bootstrap !== 'string' || !HEX_64.test(bootstrap)) {
    return { ok: false, error: 'invalid or missing bootstrap' }
  }
  if (typeof inviterPublicKey !== 'string' || !HEX_64.test(inviterPublicKey)) {
    return { ok: false, error: 'invalid or missing inviterPublicKey' }
  }

  return { ok: true, scheme, circleId, name, circleKey, bootstrap, inviterPublicKey }
}

/**
 * Build a seed-invite link for the blind-seeder admission path. Same
 * fields as a member invite but on `/circle/seed`. Distinct path is the
 * permission flag — seed-mode worklets process /circle/seed only, member-
 * mode worklets ignore it.
 * @param {object} args
 * @param {string} args.circleId - 43-char base64url (32 bytes, no padding)
 * @param {string} args.name - 1..64 char display name
 * @param {string} args.circleKey - 64-char hex (32 bytes), swarm topic seed
 * @param {string} args.bootstrap - 64-char hex (32 bytes), Autobase bootstrap pubkey
 * @param {string} args.inviterPublicKey - 64-char hex (32 bytes), admitting member
 * @param {'https'|'pear'} [args.scheme='https']
 * @returns {string}
 */
function buildSeedInvite ({ circleId, name, circleKey, bootstrap, inviterPublicKey, scheme = 'https' }) {
  if (typeof circleId !== 'string' || !BASE64URL_43.test(circleId)) {
    throw new Error('circleId must be a 43-char base64url string (32 bytes)')
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    throw new Error(`name must be a non-empty string of at most ${NAME_MAX} chars`)
  }
  if (typeof circleKey !== 'string' || !HEX_64.test(circleKey)) {
    throw new Error('circleKey must be a 64-char hex string (32 bytes)')
  }
  if (typeof bootstrap !== 'string' || !HEX_64.test(bootstrap)) {
    throw new Error('bootstrap must be a 64-char hex string (32 bytes)')
  }
  if (typeof inviterPublicKey !== 'string' || !HEX_64.test(inviterPublicKey)) {
    throw new Error('inviterPublicKey must be a 64-char hex string (32 bytes)')
  }
  if (scheme !== 'https' && scheme !== 'pear') {
    throw new Error('scheme must be "https" or "pear"')
  }
  const base = scheme === 'pear' ? PEAR_SEED_HOST_PATH : HTTPS_SEED_HOST_PATH
  const params = [
    `circle=${circleId}`,
    `name=${encodeURIComponent(name)}`,
    `key=${circleKey}`,
    `bootstrap=${bootstrap}`,
    `inviter=${inviterPublicKey}`,
  ].join('&')
  return `${base}?${params}`
}

/**
 * Parse a seed-invite link. Returns the same shape as parseInvite minus
 * any member-only fields. Fails on join-path invites (`/circle/join`)
 * so the seed-mode worklet cannot accidentally enroll using a member
 * invite that would also embed the encryption key.
 * @param {string} url
 * @returns {{ ok: boolean, scheme?: 'https'|'pear', circleId?: string, name?: string, circleKey?: string, bootstrap?: string, inviterPublicKey?: string, error?: string }}
 */
function parseSeedInvite (url) {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' }

  let scheme, qs
  if (url.startsWith(HTTPS_SEED_HOST_PATH + '?')) {
    scheme = 'https'
    qs = url.slice(HTTPS_SEED_HOST_PATH.length + 1)
  } else if (url.startsWith(PEAR_SEED_HOST_PATH + '?')) {
    scheme = 'pear'
    qs = url.slice(PEAR_SEED_HOST_PATH.length + 1)
  } else {
    return { ok: false, error: 'not a PearCircle seed invite link' }
  }

  const params = parseQuery(qs)
  const circleId = params.circle
  const name = params.name
  const circleKey = params.key
  const bootstrap = params.bootstrap
  const inviterPublicKey = params.inviter

  if (typeof circleId !== 'string' || !BASE64URL_43.test(circleId)) {
    return { ok: false, error: 'invalid or missing circleId' }
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    return { ok: false, error: 'invalid or missing name' }
  }
  if (typeof circleKey !== 'string' || !HEX_64.test(circleKey)) {
    return { ok: false, error: 'invalid or missing circleKey' }
  }
  if (typeof bootstrap !== 'string' || !HEX_64.test(bootstrap)) {
    return { ok: false, error: 'invalid or missing bootstrap' }
  }
  if (typeof inviterPublicKey !== 'string' || !HEX_64.test(inviterPublicKey)) {
    return { ok: false, error: 'invalid or missing inviterPublicKey' }
  }

  return { ok: true, scheme, circleId, name, circleKey, bootstrap, inviterPublicKey }
}

function parseQuery (qs) {
  const params = {}
  if (!qs) return params
  for (const pair of qs.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    try {
      const k = decodeURIComponent(pair.slice(0, eq))
      const v = decodeURIComponent(pair.slice(eq + 1))
      params[k] = v
    } catch {
      // skip pairs with malformed percent-encoding
    }
  }
  return params
}

module.exports = { buildInvite, parseInvite, buildSeedInvite, parseSeedInvite, NAME_MAX }
