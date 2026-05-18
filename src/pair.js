// Per-circle pairing protomux channel.
// Runs over the same Hyperswarm connection that carries corestore replication;
// they coexist on one protomux because corestore reuses stream.userData.
//
// Wire: protocol 'pearcircle/pair/1', id = utf-8(circleId).
// Joiner-side (we are not yet a writer) sends a writerHello with our local
// Autobase writer-core public key. Any writer on the receiving side appends
// { type: 'addWriter', pubkey } to the per-circle Autobase, which the apply
// branch turns into a base.addWriter call. Replication then flips the
// joiner's base.writable to true.

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const PAIR_PROTOCOL = 'pearcircle/pair/1'
const HEX_64 = /^[0-9a-f]{64}$/i

function setupPairChannel ({ conn, circleId, base, onWriterAdded, mark }) {
  const mux = Protomux.from(conn)
  let writerHello
  const cidShort = circleId.slice(0, 8)
  const trace = (name, extra) => { if (typeof mark === 'function') try { mark(name, { cid: cidShort, ...(extra || {}) }) } catch {} }

  const channel = mux.createChannel({
    protocol: PAIR_PROTOCOL,
    id: b4a.from(circleId),
    onopen () {
      trace('pair:onopen', { writable: !!base.writable, hasLocal: !!base.local })
      // Both sides matched. If we are not yet a writer, advertise our key.
      if (!base.writable && base.local && writerHello) {
        try {
          writerHello.send({ writerKey: b4a.toString(base.local.key, 'hex') })
          trace('pair:hello-sent')
        } catch (e) {
          trace('pair:hello-send-failed', { err: e?.message ?? String(e) })
        }
      }
    },
    onclose () { trace('pair:onclose') },
  })
  if (!channel) {
    trace('pair:create-failed')
    return null
  }

  writerHello = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      trace('pair:hello-received', { writable: !!base.writable, valid: !!(msg && typeof msg.writerKey === 'string' && HEX_64.test(msg.writerKey)) })
      // Only writers can satisfy a writerHello.
      if (!base.writable) return
      if (!msg || typeof msg.writerKey !== 'string' || !HEX_64.test(msg.writerKey)) return
      try {
        await base.append({ type: 'addWriter', pubkey: msg.writerKey })
        trace('pair:addwriter-appended', { pubkey: msg.writerKey.slice(0, 8) })
        if (onWriterAdded) onWriterAdded(msg.writerKey)
      } catch (e) {
        trace('pair:addwriter-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  channel.open()
  trace('pair:channel-opened')
  return channel
}

module.exports = { setupPairChannel, PAIR_PROTOCOL }
