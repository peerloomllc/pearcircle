// PearCircle — Bare worklet entry point.
// Wire protocol v1 (proposals/2026-05-03-wire-protocol.md).
// Runs inside the Bare runtime launched by BareKit. No Node.js APIs.
//
// First slice: identity-only persistence. Hyperswarm, Autobase, and per-circle
// state come in subsequent slices.
//
// IPC envelope per CLAUDE.md:
//   shell → worklet: { id, method, args }
//   worklet → shell: { id, result } or { id, error }
//   worklet → shell (events): { event, data }
//
// Shell MUST send `init` with a writable dataDir before any other method.

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const { generateKeypair } = require('./identity')

let _store = null
let _localDb = null
let _identity = null
let _initialized = false

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

const handlers = {
  'ping': async () => ({ ok: true, ts: Date.now() }),

  'app:state': async ({ state }) => ({ state }),

  'identity:get': async () => {
    if (!_identity) return { publicKey: null, ready: false }
    return { publicKey: b4a.toString(_identity.publicKey, 'hex'), ready: true }
  },
}

async function init ({ dataDir } = {}, attempt = 0) {
  if (_initialized) {
    send({ event: 'ready', data: { publicKey: b4a.toString(_identity.publicKey, 'hex') } })
    return
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('init requires { dataDir: string }')
  }

  // Retry on lock errors: BareKit may restart the worklet before the prior
  // instance has released the corestore lock file.
  try {
    _store = new Corestore(dataDir + '/pearcircle/store')
    await _store.ready()
  } catch (e) {
    if (e?.message?.includes('lock') && attempt < 20) {
      await new Promise(r => setTimeout(r, 1000))
      return init({ dataDir }, attempt + 1)
    }
    throw e
  }

  const localCore = _store.get({ name: 'local' })
  await localCore.ready()
  _localDb = new Hyperbee(localCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await _localDb.ready()

  const stored = await _localDb.get('identity')
  if (stored) {
    _identity = {
      publicKey: b4a.from(stored.value.publicKey, 'hex'),
      secretKey: b4a.from(stored.value.secretKey, 'hex'),
    }
  } else {
    _identity = generateKeypair()
    await _localDb.put('identity', {
      publicKey: b4a.toString(_identity.publicKey, 'hex'),
      secretKey: b4a.toString(_identity.secretKey, 'hex'),
      createdAt: Date.now(),
    })
  }

  _initialized = true
  send({ event: 'ready', data: { publicKey: b4a.toString(_identity.publicKey, 'hex') } })
}

let buffer = ''
BareKit.IPC.on('data', async (chunk) => {
  buffer += chunk.toString()
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (!line.trim()) continue

    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg.method === 'init') {
      try {
        await init(msg.args ?? {})
        send({ id: msg.id, result: { ok: true } })
      } catch (err) {
        send({ id: msg.id, error: err?.message ?? String(err) })
      }
      continue
    }

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
