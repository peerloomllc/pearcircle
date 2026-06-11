// Slice-3d member harness: simulate an updated member that pushes the circle's
// writer-core keys to a seeder over the admission channel. Mounts the circle
// from an invite to enumerate writers (base.activeWriters), connects to the
// swarm, and on each seeder announce calls sendWriterCores. Lets us validate
// the seeder's slice-3d receive path without updating a real device.
//
// Usage: node tools/push-writercores.js "<invite-url>"
//   env: RUN_MS (default 40000)
// Read-only on the circle (never appends); only sends writerCores over wire.

const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const { parseInvite } = require('../src/invite')
const { topicForCircleKey } = require('../src/swarm')
const { setupSeederAdmissionChannel } = require('../src/seederAdmission')

const INVITE = process.argv[2]
const RUN_MS = Number(process.env.RUN_MS || 40000)
if (!INVITE) { console.error('usage: node tools/push-writercores.js "<invite>"'); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main () {
  const parsed = parseInvite(INVITE)
  if (!parsed.ok) { console.error('bad invite:', parsed.error); process.exit(1) }
  const { circleId, name, circleKey, bootstrap, encryptionKey } = parsed
  console.log('circle:', name, circleId.slice(0, 12))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcpush-'))
  const store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  const opts = {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: async () => {},
  }
  if (encryptionKey) opts.encryptionKey = b4a.from(encryptionKey, 'hex')
  const base = new Autobase(store.namespace('push:' + circleId), b4a.from(bootstrap, 'hex'), opts)
  await base.ready()

  const currentWriters = () => (base.activeWriters ? [...base.activeWriters] : [])
    .filter((w) => w?.core?.key)
    .map((w) => { const h = b4a.toString(w.core.key, 'hex'); return { pubkey: h, coreKey: h } })

  const apis = new Set()
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => {
    store.replicate(conn)
    let api = null
    api = setupSeederAdmissionChannel({
      conn,
      role: 'member',
      circleId,
      onAnnounce: () => { if (api) api.sendWriterCores(currentWriters()) },
      mark: () => {},
    })
    if (api) apis.add(api)
  })
  // Re-push the FULL writer set to every seeder periodically. The early
  // announce fires before the base fully linearizes, so a one-shot push misses
  // writers; the seeder dedups already-open cores.
  const pusher = setInterval(() => {
    const w = currentWriters()
    if (w.length === 0) return
    let sent = 0
    for (const api of apis) { if (api.sendWriterCores(w)) sent++ }
    if (sent > 0) console.log(`  re-pushed ${w.length} writers to ${sent} seeder channel(s)`)
  }, 5000)
  swarm.join(topicForCircleKey(circleKey), { server: false, client: true })
  await swarm.flush().catch(() => {})

  // Let the base linearize so activeWriters is populated before peers announce.
  console.log('replicating + waiting for writers...')
  await sleep(8000)
  await base.update().catch(() => {})
  const n = base.activeWriters ? [...base.activeWriters].length : 0
  console.log(`writers known: ${n}`)

  await sleep(RUN_MS)
  clearInterval(pusher)
  await swarm.destroy()
  await base.close()
  await store.close()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
