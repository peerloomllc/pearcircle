// Per-circle seeder admission protomux channel.
// Runs over the same Hyperswarm connection that carries corestore replication
// and the existing pair channel; protomux multiplexes them by protocol name.
//
// Wire: protocol 'pearcircle/seeder-admission/1', id = utf-8(circleId).
// Three messages, added in the same order on both sides so protomux indexes
// line up: [0] announce (seed -> member), [1] revoked (member -> seed),
// [2] lastknownCores (member -> seed).
//
// Roles:
//   'seed'   — opened by a seed-mode worklet that has enrolled in this circle.
//              Sends one announce message on channel open carrying
//              { pubkey: seederPubkey, label?: string }. The channel stays
//              open so the member can later push a revocation notice; the
//              seed receives 'revoked' notices and calls onRevoked, and
//              'lastknownCores' lists and calls onLastknownCores.
//   'member' — opened by a member-mode worklet on a circle it participates in.
//              Receives announce, validates shape, calls onAnnounce with
//              { circleId, pubkey, label } so the host can dedupe against
//              existing seeder rows and auto-admit the seeder. When the
//              caller passes revokedNotice (the circle has revoked this
//              seeder), sends one { type:'revoked', circleId, revokedAt }
//              message on channel open. Pushes the circle's per-member
//              last-known core keys to the (blind) seeder so it can replicate
//              + serve them for offline last-known; the seeder cannot read
//              these from the encrypted view, so they travel out-of-band here.
//
// Proposal 2026-05-19-blind-seeder-peers slice 3d;
// revocation notice added by proposal 2026-05-21-seeder-revocation-signal;
// lastknownCores added by proposal 2026-06-04-lastseen-ephemeral slice 2b.

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const SEEDER_ADMISSION_PROTOCOL = 'pearcircle/seeder-admission/1'
const HEX_64 = /^[0-9a-f]{64}$/i

// Validate + normalize a lastknownCores payload into a clean
// [{ pubkey, coreKey }] array (both hex64). Drops malformed entries and caps
// the count so a peer can't push an unbounded list. Pure.
const LASTKNOWN_CORES_MAX = 256
function normalizeLastknownCores (msg) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.cores)) return null
  const out = []
  for (const entry of msg.cores) {
    if (out.length >= LASTKNOWN_CORES_MAX) break
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.pubkey !== 'string' || !HEX_64.test(entry.pubkey)) continue
    if (typeof entry.coreKey !== 'string' || !HEX_64.test(entry.coreKey)) continue
    out.push({ pubkey: entry.pubkey, coreKey: entry.coreKey })
  }
  return out
}

function setupSeederAdmissionChannel ({ conn, role, circleId, seederPubkey, label, onAnnounce, onRevoked, revokedNotice, onLastknownCores, mark }) {
  if (role !== 'seed' && role !== 'member') {
    throw new Error('role must be "seed" or "member"')
  }
  const mux = Protomux.from(conn)
  const cidShort = circleId.slice(0, 8)
  const trace = (name, extra) => {
    if (typeof mark === 'function') {
      try { mark(name, { cid: cidShort, role, ...(extra || {}) }) } catch {}
    }
  }

  let announceMessage = null
  let revokeMessage = null
  let lastknownMessage = null

  // Send a { cores: [{pubkey, coreKey}] } list on this channel (member role
  // only). Used for the on-open push and for re-pushes when the circle's known
  // last-known core keys change. Proposal 2026-06-04-lastseen-ephemeral 2b.
  function sendLastknownCores (cores) {
    if (role !== 'member' || !lastknownMessage) return false
    if (!Array.isArray(cores) || cores.length === 0) return false
    try {
      lastknownMessage.send({ cores })
      trace('admission:lastknown-sent', { count: cores.length })
      return true
    } catch (e) {
      trace('admission:lastknown-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  // Send a { type:'revoked' } notice on this channel (member role only).
  // Used both for the on-open send and for an immediate push when
  // circle:seeder:revoke fires on an already-open connection — proposal
  // 2026-05-21-seeder-revocation-signal amendment.
  function sendRevoked (revokedAt) {
    if (role !== 'member' || !revokeMessage) return false
    try {
      revokeMessage.send({
        type: 'revoked',
        circleId,
        revokedAt: typeof revokedAt === 'number' && Number.isFinite(revokedAt) ? revokedAt : null,
      })
      trace('admission:revoke-sent')
      return true
    } catch (e) {
      trace('admission:revoke-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  const channel = mux.createChannel({
    protocol: SEEDER_ADMISSION_PROTOCOL,
    id: b4a.from(circleId),
    onopen () {
      trace('admission:onopen')
      if (role === 'seed' && announceMessage) {
        try {
          const payload = { pubkey: seederPubkey }
          if (typeof label === 'string' && label.length > 0) payload.label = label
          announceMessage.send(payload)
          trace('admission:announce-sent')
        } catch (e) {
          trace('admission:announce-send-failed', { err: e?.message ?? String(e) })
        }
      }
      if (role === 'member' && revokedNotice) {
        sendRevoked(revokedNotice.revokedAt)
      }
      // The member pushes its last-known core keys only once the peer confirms
      // it is a seeder (its announce arrives), not blindly on open — see
      // handleSeederAnnounce in bare.js. Proposal 2026-06-04-lastseen-ephemeral 2b.
    },
    onclose () { trace('admission:onclose') },
  })
  if (!channel) {
    trace('admission:create-failed')
    return null
  }

  announceMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'member') return
      if (!msg || typeof msg !== 'object') {
        trace('admission:announce-rejected', { reason: 'not-object' })
        return
      }
      if (typeof msg.pubkey !== 'string' || !HEX_64.test(msg.pubkey)) {
        trace('admission:announce-rejected', { reason: 'bad-pubkey' })
        return
      }
      const label = typeof msg.label === 'string' ? msg.label.slice(0, 128) : null
      trace('admission:announce-received', { pubkey: msg.pubkey.slice(0, 8) })
      try {
        if (typeof onAnnounce === 'function') {
          await onAnnounce({ circleId, pubkey: msg.pubkey, label })
        }
      } catch (e) {
        trace('admission:onannounce-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // [1] revoked — member -> seed. Advisory, UI-only (proposal 2026-05-21
  // question 1): the seed records it for the dashboard and takes no
  // automatic or network action on it.
  revokeMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      if (!msg || typeof msg !== 'object' || msg.type !== 'revoked') {
        trace('admission:revoke-rejected', { reason: 'bad-shape' })
        return
      }
      const revokedAt = typeof msg.revokedAt === 'number' && Number.isFinite(msg.revokedAt)
        ? msg.revokedAt
        : null
      trace('admission:revoke-received')
      try {
        // circleId is the trusted channel id, never msg.circleId.
        if (typeof onRevoked === 'function') await onRevoked({ circleId, revokedAt })
      } catch (e) {
        trace('admission:onrevoked-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // [2] lastknownCores — member -> seed. The blind seeder can't read the
  // encrypted view, so members hand it the per-member last-known core keys to
  // replicate + serve for offline last-known. Validated at the wire boundary;
  // circleId is the trusted channel id, never carried in the body. Proposal
  // 2026-06-04-lastseen-ephemeral slice 2b.
  lastknownMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      const cores = normalizeLastknownCores(msg)
      if (!cores || cores.length === 0) {
        trace('admission:lastknown-rejected', { reason: 'bad-shape' })
        return
      }
      trace('admission:lastknown-received', { count: cores.length })
      try {
        if (typeof onLastknownCores === 'function') await onLastknownCores({ circleId, cores })
      } catch (e) {
        trace('admission:onlastknown-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  channel.open()
  trace('admission:channel-opened')
  return { channel, sendRevoked, sendLastknownCores }
}

module.exports = { SEEDER_ADMISSION_PROTOCOL, setupSeederAdmissionChannel, normalizeLastknownCores }
