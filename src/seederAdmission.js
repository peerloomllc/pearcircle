// Per-circle seeder admission protomux channel.
// Runs over the same Hyperswarm connection that carries corestore replication
// and the existing pair channel; protomux multiplexes them by protocol name.
//
// Wire: protocol 'pearcircle/seeder-admission/1', id = utf-8(circleId).
// Two messages, added in the same order on both sides so protomux indexes
// line up: [0] announce (seed -> member), [1] revoked (member -> seed).
//
// Roles:
//   'seed'   — opened by a seed-mode worklet that has enrolled in this circle.
//              Sends one announce message on channel open carrying
//              { pubkey: seederPubkey, label?: string }. The channel stays
//              open so the member can later push a revocation notice; the
//              seed receives 'revoked' notices and calls onRevoked.
//   'member' — opened by a member-mode worklet on a circle it participates in.
//              Receives announce, validates shape, calls onAnnounce with
//              { circleId, pubkey, label } so the host can dedupe against
//              existing seeder rows and auto-admit the seeder. When the
//              caller passes revokedNotice (the circle has revoked this
//              seeder), sends one { type:'revoked', circleId, revokedAt }
//              message on channel open.
//
// Proposal 2026-05-19-blind-seeder-peers slice 3d;
// revocation notice added by proposal 2026-05-21-seeder-revocation-signal.

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const SEEDER_ADMISSION_PROTOCOL = 'pearcircle/seeder-admission/1'
const HEX_64 = /^[0-9a-f]{64}$/i

function setupSeederAdmissionChannel ({ conn, role, circleId, seederPubkey, label, onAnnounce, onRevoked, revokedNotice, mark }) {
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

  channel.open()
  trace('admission:channel-opened')
  return { channel, sendRevoked }
}

module.exports = { SEEDER_ADMISSION_PROTOCOL, setupSeederAdmissionChannel }
