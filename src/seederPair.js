// One-time seeder-pairing channel (proposal 2026-06-22-seeder-qr-pairing).
//
// Rides a connection over the one-time rendezvous topic from the QR. The phone
// (member) pushes its seed bundle; the seeder (seed) enrolls it and acks back so
// the phone can show "paired - now seeding N circles". Distinct from the
// steady-state seeder-sync channel: it runs only during an open pairing session,
// is keyed by the rendezvous key (so only the two endpoints of THIS session
// match), and the seed side's trust is "a pairing session is open on this topic"
// rather than isKnownInviter (which a first-time seeder cannot satisfy).
//
// Wire: protocol 'pearcircle/seeder-pair/1', id = the 32-byte rendezvous key.
// Messages, in this order on both sides (so indices line up):
//   0 bundle: { invites: string[] }   member -> seed
//   1 ack:    { enrolled: number, names: string[] }   seed -> member
//
// SECURITY: the member must verify the connection's authenticated remote pubkey
// equals the QR's seeder pubkey BEFORE calling this (the caller does), so circle
// secrets never go to an impostor who merely knows the rendezvous topic.

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const SEEDER_PAIR_PROTOCOL = 'pearcircle/seeder-pair/1'
const RV_B64URL_43 = /^[A-Za-z0-9_-]{43}$/

function setupSeederPairChannel ({ conn, role, rv, getBundle, onBundle, onAck, onPeer, mark }) {
  if (role !== 'member' && role !== 'seed') {
    throw new Error('role must be "member" or "seed"')
  }
  if (typeof rv !== 'string' || !RV_B64URL_43.test(rv)) {
    throw new Error('rv must be a 43-char base64url string (32 bytes)')
  }
  const id = b4a.from(rv + '=', 'base64') // 43 base64url chars -> 32 bytes
  const mux = Protomux.from(conn)
  const trace = (name, extra) => {
    if (typeof mark === 'function') { try { mark(name, { role, ...(extra || {}) }) } catch {} }
  }

  let bundleMessage = null
  let ackMessage = null

  async function sendBundle () {
    if (role !== 'member' || !bundleMessage) return
    let invites = []
    try {
      invites = (await (typeof getBundle === 'function' ? getBundle() : [])) || []
    } catch (e) {
      trace('seederpair:getbundle-failed', { err: e?.message ?? String(e) })
      return
    }
    if (!Array.isArray(invites) || invites.length === 0) {
      trace('seederpair:empty-bundle')
      return
    }
    try {
      bundleMessage.send({ invites })
      trace('seederpair:bundle-sent', { count: invites.length })
    } catch (e) {
      trace('seederpair:bundle-send-failed', { err: e?.message ?? String(e) })
    }
  }

  const channel = mux.createChannel({
    protocol: SEEDER_PAIR_PROTOCOL,
    id,
    onopen () {
      trace('seederpair:onopen')
      if (role === 'member') sendBundle()
      // Seed side: the scanning phone is now on the wire. The dashboard shows
      // this so a pairing that is genuinely progressing does not look dead
      // while the bundle transfers (issue #179).
      if (role === 'seed' && typeof onPeer === 'function') {
        try { onPeer() } catch (e) { trace('seederpair:onpeer-failed', { err: e?.message ?? String(e) }) }
      }
    },
    onclose () { trace('seederpair:onclose') },
  })
  if (!channel) {
    trace('seederpair:create-failed')
    return null
  }

  // Message 0: the bundle (member -> seed).
  bundleMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.invites)) {
        trace('seederpair:bundle-rejected', { reason: 'shape' })
        return
      }
      const invites = msg.invites.filter((x) => typeof x === 'string' && x.length > 0)
      trace('seederpair:bundle-received', { count: invites.length })
      let result = { enrolled: 0, names: [] }
      try {
        if (typeof onBundle === 'function') result = (await onBundle({ invites })) || result
      } catch (e) {
        trace('seederpair:onbundle-failed', { err: e?.message ?? String(e) })
      }
      try {
        ackMessage.send({ enrolled: result.enrolled || 0, names: Array.isArray(result.names) ? result.names : [] })
        trace('seederpair:ack-sent', { enrolled: result.enrolled || 0 })
      } catch (e) {
        trace('seederpair:ack-send-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // Message 1: the ack (seed -> member).
  ackMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'member') return
      if (!msg || typeof msg !== 'object') return
      trace('seederpair:ack-received', { enrolled: msg.enrolled })
      try {
        if (typeof onAck === 'function') {
          await onAck({ enrolled: msg.enrolled || 0, names: Array.isArray(msg.names) ? msg.names : [] })
        }
      } catch (e) {
        trace('seederpair:onack-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  channel.open()
  trace('seederpair:channel-opened')
  return { channel }
}

module.exports = { SEEDER_PAIR_PROTOCOL, setupSeederPairChannel }
