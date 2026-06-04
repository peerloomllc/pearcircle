// Per-circle ephemeral live-location protomux channel (proposal
// 2026-06-04-lastseen-ephemeral, phase 1 slice 1).
//
// Live position is broadcast peer-to-peer over the same Hyperswarm connection
// that already carries corestore replication and the pair/admission channels.
// It is NOT persisted to the Autobase, so it adds zero oplog growth - the cure
// for the lastSeen bloat wedge (rca/2026-06-04-lastseen-oplog-bloat.md).
//
// Wire: protocol 'pearcircle/live/1', id = utf-8(circleId). One json message
// type carrying a signed lastSeen value (the exact shape signValue produces in
// bare.js: { pubkey, lat, lon, accuracy, ts, speed, battery, isCharging, v }).
// The receiver verifies the signature and gates on circle membership, so a peer
// on the topic cannot forge another member's position or inject a non-member.
//
// This channel is unauthenticated at the transport layer by design: the signed
// value is the trust boundary, mirroring how Autobase lastSeen values are
// signed. Ephemeral by nature - nothing is stored on close.

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const LIVE_PROTOCOL = 'pearcircle/live/1'

// Open a live-location channel on `conn` for `circleId`.
//   getOutgoing() -> the local signed value to send on open (or null to skip)
//   onPosition(value) -> called with each received value (caller verifies+gates)
// Returns { channel, send(value): boolean } or null if the channel can't open.
function setupLiveChannel ({ conn, circleId, getOutgoing, onPosition, mark }) {
  const mux = Protomux.from(conn)
  const cidShort = circleId.slice(0, 8)
  const trace = (name, extra) => { if (typeof mark === 'function') try { mark(name, { cid: cidShort, ...(extra || {}) }) } catch {} }
  let posMsg

  const channel = mux.createChannel({
    protocol: LIVE_PROTOCOL,
    id: b4a.from(circleId),
    onopen () {
      trace('live:onopen')
      // Send our current fix immediately so a freshly-connected peer sees us
      // without waiting for the next location:update.
      const cur = typeof getOutgoing === 'function' ? getOutgoing() : null
      if (cur) { try { posMsg.send(cur) } catch (e) { trace('live:open-send-failed', { err: e?.message }) } }
    },
    onclose () { trace('live:onclose') },
  })
  if (!channel) { trace('live:create-failed'); return null }

  posMsg = channel.addMessage({
    encoding: c.json,
    onmessage: (msg) => { if (msg && typeof onPosition === 'function') onPosition(msg) },
  })

  channel.open()
  trace('live:channel-opened')
  return {
    channel,
    send: (value) => {
      if (!value) return false
      try { posMsg.send(value); return true } catch (e) { trace('live:send-failed', { err: e?.message }); return false }
    },
  }
}

module.exports = { setupLiveChannel, LIVE_PROTOCOL }
