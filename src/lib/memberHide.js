// Hide an inactive member for the whole circle (proposal
// 2026-10-06-hide-inactive-member). Any member can write a signed
// `hidden:{pubkey}` row for a member who hasn't been seen in 30 days. It
// only hides them from the member list: no kick, no writer change. A real
// member who was hidden rewrites their member row (autoAppendMemberRow) and
// shows again, so a dead identity is the only thing that stays hidden.
//
// Pure helpers, no sodium: the UI imports this file for the same eligibility
// rule the worklet enforces. Signature checking is injected by the caller.

const HIDE_INACTIVE_MS = 30 * 24 * 60 * 60 * 1000
// Debug builds pass a shorter threshold so the flow can be tested in minutes.
// Never below this, so a stray value can't make live members hideable.
const HIDE_INACTIVE_MIN_MS = 60 * 1000

// Same shape as memberHiddenByRemoved: hide while the hide is newer than the
// member row. A rewrite with a fresh joinedAt shows the member again.
//
//   hiddenAt non-number     - no hide, never hide
//   joinedAt non-number     - no member row, hide if a hide exists
//   hiddenAt > joinedAt     - hide is newer, hide
//   hiddenAt <= joinedAt    - member row is newer, show
function memberHiddenByHide (hiddenAt, joinedAt) {
  if (typeof hiddenAt !== 'number') return false
  if (typeof joinedAt !== 'number') return true
  return hiddenAt > joinedAt
}

// Newest sign of life for a member: their member-row joinedAt and any
// lastSeen ts we hold (view row, last-known core, live position).
function memberLastActiveAt ({ joinedAt, seenTs = [] } = {}) {
  let latest = typeof joinedAt === 'number' ? joinedAt : 0
  for (const ts of seenTs) {
    if (typeof ts === 'number' && ts > latest) latest = ts
  }
  return latest
}

function hideThresholdMs (inactiveMs) {
  if (typeof inactiveMs !== 'number' || !Number.isFinite(inactiveMs)) return HIDE_INACTIVE_MS
  return Math.max(HIDE_INACTIVE_MIN_MS, Math.min(HIDE_INACTIVE_MS, inactiveMs))
}

// Whether `pubkey` may be hidden by `ourKey` now. Returns { ok, reason }.
function canHideMember ({ pubkey, ourKey, hasMemberRow, lastActiveAt, now = Date.now(), inactiveMs } = {}) {
  if (typeof pubkey !== 'string' || pubkey.length !== 64) return { ok: false, reason: 'bad_pubkey' }
  if (pubkey === ourKey) return { ok: false, reason: 'self' }
  if (!hasMemberRow) return { ok: false, reason: 'not_member' }
  if (typeof lastActiveAt !== 'number' || now - lastActiveAt < hideThresholdMs(inactiveMs)) {
    return { ok: false, reason: 'recently_seen' }
  }
  return { ok: true }
}

// Apply-side admission for a `hidden:{pubkey}` row. Any writer may author
// it; the signature is checked against `hiddenBy`.
function shouldAcceptHiddenRow ({ keyPubkey, value, now = Date.now(), futureToleranceMs, verifySig }) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.pubkey !== 'string' || typeof value.hiddenBy !== 'string') return false
  if (keyPubkey !== value.pubkey) return false
  if (value.pubkey === value.hiddenBy) return false
  if (typeof value.ts !== 'number') return false
  if (typeof futureToleranceMs === 'number' && value.ts > now + futureToleranceMs) return false
  if (typeof verifySig !== 'function' || !verifySig(value)) return false
  return true
}

module.exports = {
  HIDE_INACTIVE_MS,
  HIDE_INACTIVE_MIN_MS,
  memberHiddenByHide,
  memberLastActiveAt,
  hideThresholdMs,
  canHideMember,
  shouldAcceptHiddenRow,
}
