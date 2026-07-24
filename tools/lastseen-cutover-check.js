// Why hasn't a circle's phase-2 lastSeen cutover engaged? Mounts the circle
// from an invite, rebuilds the view, and reports visible members vs who has
// announced a lastknownCore: row (the cutover requires ALL visible members to
// have one). Also tallies lastSeen vs transition vs lastknownCore in the view.
//
// Usage: node tools/lastseen-cutover-check.js "<invite-url>"
//   env: SYNC_MS (default 35000)
// Read-only.

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

const INVITE = process.argv[2]
const SYNC_MS = Number(process.env.SYNC_MS || 35000)
if (!INVITE) { console.error('usage: node tools/lastseen-cutover-check.js "<invite>"'); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main () {
  const parsed = parseInvite(INVITE)
  if (!parsed.ok) { console.error('bad invite:', parsed.error); process.exit(1) }
  const { circleId, name, circleKey, bootstrap, encryptionKey } = parsed
  console.log('circle:', name, circleId.slice(0, 12))

  const raw = {} // raw applied-op counts by key prefix (before dedup)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pccut-'))
  const store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  const opts = {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: async (nodes, view) => {
      for (const node of nodes) {
        const op = node.value
        if (!op || typeof op.key !== 'string') continue
        const rp = op.key.indexOf(':') < 0 ? op.key : op.key.slice(0, op.key.indexOf(':'))
        raw[rp] = (raw[rp] || 0) + 1
        if (op.type === 'del') { await view.del(op.key) } else { await view.put(op.key, op.value) }
      }
    },
  }
  if (encryptionKey) opts.encryptionKey = b4a.from(encryptionKey, 'hex')
  const base = new Autobase(store.namespace('cut:' + Date.now() + ':' + circleId), b4a.from(bootstrap, 'hex'), opts)
  await base.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(topicForCircleKey(circleKey), { server: false, client: true })
  await swarm.flush().catch(() => {})
  console.log(`replicating ${SYNC_MS}ms...`)
  await sleep(SYNC_MS)
  await base.update().catch((e) => console.log('update err', e.message))

  // membership (apply left:/removed: filtering like circleVisibleMemberPubkeys)
  const left = new Map(); const removed = new Map(); const joined = new Map()
  const announced = new Set()
  const counts = { lastSeen: 0, transition: 0, lastknownCore: 0, place: 0, member: 0, other: 0 }
  for await (const { key, value } of base.view.createReadStream()) {
    const p = key.indexOf(':') < 0 ? key : key.slice(0, key.indexOf(':'))
    if (p in counts) counts[p]++; else counts.other++
    if (key.startsWith('member:')) joined.set(key.slice(7), value?.joinedAt ?? 0)
    else if (key.startsWith('left:')) left.set(key.slice(5), value?.leftAt ?? 0)
    else if (key.startsWith('removed:')) removed.set(key.slice(8), value?.ts ?? 0)
    else if (key.startsWith('lastknownCore:')) announced.add(key.slice(14))
  }
  const visible = [...joined.entries()].filter(([pk, jat]) =>
    !((left.get(pk) ?? -1) > jat) && !((removed.get(pk) ?? -1) > jat)).map(([pk]) => pk)

  console.log('\n=== RAW applied-op counts (oplog composition, with overwrites) ===', JSON.stringify(raw))
  console.log('=== view op-kind counts (deduped current rows) ===', JSON.stringify(counts))
  console.log('\n=== membership / cutover convergence ===')
  console.log('visible members:', visible.length)
  console.log('announced lastknownCore:', announced.size)
  const missing = visible.filter((pk) => !announced.has(pk))
  console.log('MISSING announce (blocks cutover):', missing.length)
  for (const pk of missing) console.log('   no lastknownCore from', pk.slice(0, 12), '(displayName:', (joined.has(pk) ? '' : '?') + ')')
  console.log(missing.length === 0
    ? '\n=> cutover CAN engage (all visible members announced). Durable lastSeen writes should stop.'
    : `\n=> cutover BLOCKED by ${missing.length} member(s) without a last-known-core announce (old build / not converged).`)

  await swarm.destroy(); await base.close(); await store.close(); process.exit(0)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
