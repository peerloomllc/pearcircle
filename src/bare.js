// PearCircle — Bare worklet entry point.
//
// Wire protocol is unspecified pending proposals/2026-05-03-wire-protocol.md.
// This file currently only handles the IPC envelope and routes a small set of
// stub methods so the shell can boot end-to-end before P2P code lands.

const ipc = BareKit.IPC
const send = (msg) => ipc.write(Buffer.from(JSON.stringify(msg) + '\n'))

const handlers = {
  'ping': async () => ({ ok: true, ts: Date.now() }),
  'app:state': async ({ state }) => {
    // Worklet stays alive across RN background/foreground; nothing to do yet.
    return { state }
  },
  'identity:get': async () => {
    // Stub. Real impl will read `identity` from local Hyperbee, generating
    // a fresh sodium keypair on first launch.
    return { publicKey: null, ready: false }
  },
  'circles:list': async () => ({ circles: [] }),
  'members:list': async ({ circleId: _circleId }) => ({ members: [] }),
  'places:list': async ({ circleId: _circleId }) => ({ places: [] }),
  'lastSeen:list': async ({ circleId: _circleId }) => ({ entries: [] }),
  'location:update': async ({ lat: _lat, lon: _lon, ts: _ts }) => {
    // Native location module pushes here; stub accepts and ignores for now.
    return { accepted: true }
  },
  'geofence:transition': async ({ placeId: _placeId, kind: _kind, ts: _ts }) => {
    return { accepted: true }
  }
}

let buffer = ''
ipc.on('data', async (chunk) => {
  buffer += chunk.toString()
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    let msg
    try { msg = JSON.parse(line) } catch { continue }

    const handler = handlers[msg.method]
    if (!handler) {
      send({ id: msg.id, error: `unknown method: ${msg.method}` })
      continue
    }
    try {
      const result = await handler(msg.args ?? {})
      send({ id: msg.id, result })
    } catch (err) {
      send({ id: msg.id, error: err?.message ?? String(err) })
    }
  }
})

send({ event: 'ready' })
