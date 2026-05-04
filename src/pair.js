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

function setupPairChannel ({ conn, circleId, base, onWriterAdded }) {
  const mux = Protomux.from(conn)
  let writerHello

  const channel = mux.createChannel({
    protocol: PAIR_PROTOCOL,
    id: b4a.from(circleId),
    onopen () {
      // Both sides matched. If we are not yet a writer, advertise our key.
      if (!base.writable && base.local && writerHello) {
        try {
          writerHello.send({ writerKey: b4a.toString(base.local.key, 'hex') })
        } catch {
          // peer torn down between open and send
        }
      }
    },
    onclose () { /* nothing to clean up */ },
  })
  if (!channel) return null

  writerHello = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      // Only writers can satisfy a writerHello.
      if (!base.writable) return
      if (!msg || typeof msg.writerKey !== 'string' || !HEX_64.test(msg.writerKey)) return
      try {
        await base.append({ type: 'addWriter', pubkey: msg.writerKey })
        if (onWriterAdded) onWriterAdded(msg.writerKey)
      } catch {
        // ignore: peer race, already a writer, base closed mid-flight, etc.
      }
    },
  })

  channel.open()
  return channel
}

module.exports = { setupPairChannel, PAIR_PROTOCOL }
