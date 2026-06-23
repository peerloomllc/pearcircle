// Invite link builder and parser for PearCircle.
// Wire format per proposals/2026-05-03-wire-protocol.md §2 (amended 2026-05-04,
// 2026-05-19):
//   https://peerloomllc.com/circle/join?circle={base64url(32)}&name={name}&key={hex(32)}&bootstrap={hex(32)}&inviter={hex(32)}[&enc={hex(32)}]
// Legacy custom scheme also accepted: pear://pearcircle/join?...
//
// Path prefix is /circle/ (not /join/) so the link never collides with
// PearCal's invites on the shared peerloomllc.com host.
// `bootstrap` is the per-circle Autobase bootstrap writer core public key;
// distinct from `inviter` because the inviter need not be the original owner.
// `enc` is the per-circle Hypercore block-encryption key; required for
// circles created post 2026-05-19-blind-seeder-peers and absent on legacy
// invites. Deliberately separate from `key` (the swarm topic seed) so a
// blind seeder holding `key` cannot derive `enc`.

const HTTPS_HOST_PATH = 'https://peerloomllc.com/circle/join'
const PEAR_HOST_PATH = 'pear://pearcircle/join'
// Seed-invite path. Proposal 2026-05-19-blind-seeder-peers.
// Same field grammar as the join path; the path itself is the
// permission flag (consumed only by seed-mode worklets).
const HTTPS_SEED_HOST_PATH = 'https://peerloomllc.com/circle/seed'
const PEAR_SEED_HOST_PATH = 'pear://pearcircle/seed'
// Seeder-pairing rendezvous link (QR shown by the seeder dashboard). Carries a
// one-time rendezvous key + the seeder pubkey, NOT a circle invite. v1 ships the
// pear:// scheme only. Seeder QR pairing proposal 2026-06-22.
const PEAR_PAIR_HOST_PATH = 'pear://pearcircle/seeder-pair'

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
 * @param {string} [args.encryptionKey] - 64-char hex (32 bytes), block-encryption
 *   key. Required for circles created post 2026-05-19; omit for legacy
 *   unencrypted circles.
 * @param {'https'|'pear'} [args.scheme='https']
 * @returns {string}
 */
function buildInvite ({ circleId, name, circleKey, bootstrap, inviterPublicKey, encryptionKey, scheme = 'https' }) {
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
  if (encryptionKey !== undefined && encryptionKey !== null) {
    if (typeof encryptionKey !== 'string' || !HEX_64.test(encryptionKey)) {
      throw new Error('encryptionKey must be a 64-char hex string (32 bytes)')
    }
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
  ]
  if (encryptionKey) params.push(`enc=${encryptionKey}`)
  return `${base}?${params.join('&')}`
}

/**
 * Parse an invite link.
 * @param {string} url
 * @returns {{ ok: boolean, scheme?: 'https'|'pear', circleId?: string, name?: string, circleKey?: string, bootstrap?: string, inviterPublicKey?: string, encryptionKey?: string|null, error?: string }}
 */
// Tolerate a trailing slash before the query (e.g. ".../circle/join/?circle=..."),
// which the app's own share links and some browsers/share sheets emit. The
// deep-link path normalizes it; pasted links hit parse directly, so do it here. Pure.
function stripPathTrailingSlash (url) {
  for (const base of [HTTPS_HOST_PATH, PEAR_HOST_PATH, HTTPS_SEED_HOST_PATH, PEAR_SEED_HOST_PATH, PEAR_PAIR_HOST_PATH]) {
    if (url.startsWith(base + '/?')) return base + '?' + url.slice((base + '/?').length)
  }
  return url
}

function parseInvite (url) {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' }
  url = stripPathTrailingSlash(url)

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
  const encRaw = params.enc

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
  let encryptionKey = null
  if (encRaw !== undefined) {
    if (typeof encRaw !== 'string' || !HEX_64.test(encRaw)) {
      return { ok: false, error: 'invalid encryptionKey' }
    }
    encryptionKey = encRaw
  }

  return { ok: true, scheme, circleId, name, circleKey, bootstrap, inviterPublicKey, encryptionKey }
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
  url = stripPathTrailingSlash(url)

  // Multi-invite-bundle guard. The all-circles seed bundle is several
  // /circle/seed URLs newline-joined (and the newlines may arrive URL-encoded
  // as %0A); callers must split it and parse each line. If a whole bundle is
  // parsed as one string, parseQuery's last-key-wins merges fields ACROSS
  // invites (circle A's id glued to circle B's bootstrap) into a single record
  // that passes every per-field check — a silent franken enrollment. A real
  // circle name can't contain "/seed?" (encodeURIComponent escapes / and ?),
  // so more than one marker is always a bundle (whether \n- or %0A-joined,
  // both carry two markers). Reject loudly rather than mangle.
  if ((url.match(/\/seed\?/g) || []).length > 1) {
    return { ok: false, error: 'looks like a multi-circle seed bundle — split on newlines and parse each invite' }
  }

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

/**
 * Build the seeder-pairing rendezvous link (rendered as a QR by the seeder
 * dashboard). NOT a circle invite: it carries a one-time rendezvous key and the
 * seeder's pubkey only. Seeder QR pairing proposal 2026-06-22.
 * @param {string} args.rv 43-char base64url rendezvous key (32 bytes)
 * @param {string} args.seeder 64-char hex seeder pubkey (32 bytes)
 */
function buildSeederPairLink ({ rv, seeder }) {
  if (typeof rv !== 'string' || !BASE64URL_43.test(rv)) {
    throw new Error('rv must be a 43-char base64url string (32 bytes)')
  }
  if (typeof seeder !== 'string' || !HEX_64.test(seeder)) {
    throw new Error('seeder must be a 64-char hex string (32 bytes)')
  }
  return `${PEAR_PAIR_HOST_PATH}?rv=${rv}&seeder=${seeder}&v=1`
}

/**
 * Parse a seeder-pairing link. Returns { ok, rv, seeder } or { ok:false, error }.
 * Rejects circle-shaped (/join, /seed) links so a member invite can never be
 * mistaken for a pairing handle.
 * @param {string} url
 * @returns {{ ok: boolean, rv?: string, seeder?: string, error?: string }}
 */
function parseSeederPairLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' }
  url = stripPathTrailingSlash(url)
  if (!url.startsWith(PEAR_PAIR_HOST_PATH + '?')) {
    return { ok: false, error: 'not a PearCircle seeder-pair link' }
  }
  const params = parseQuery(url.slice(PEAR_PAIR_HOST_PATH.length + 1))
  const rv = params.rv
  const seeder = params.seeder
  if (typeof rv !== 'string' || !BASE64URL_43.test(rv)) {
    return { ok: false, error: 'invalid or missing rendezvous key' }
  }
  if (typeof seeder !== 'string' || !HEX_64.test(seeder)) {
    return { ok: false, error: 'invalid or missing seeder pubkey' }
  }
  return { ok: true, rv, seeder }
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

// circleId-binding guard (proposal 2026-06-11-circleid-channel-binding). True
// when a mounted circle's canonical id (the `circle` row's `id`, written by the
// founder at creation) disproves the invite's circleId. An absent canonical id
// (row not yet replicated) returns false - we only reject on a POSITIVE
// mismatch, never block a join just because the view hasn't synced. Pure.
function inviteCircleIdMismatch (inviteCircleId, circleRowValue) {
  const canonical = circleRowValue && circleRowValue.id
  return typeof canonical === 'string' && canonical !== inviteCircleId
}

module.exports = { buildInvite, parseInvite, buildSeedInvite, parseSeedInvite, buildSeederPairLink, parseSeederPairLink, inviteCircleIdMismatch, NAME_MAX }
