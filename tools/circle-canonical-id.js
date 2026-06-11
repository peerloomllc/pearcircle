// Read a circle's canonical id (the `circle` view row's `id`, baked in by the
// founder at creation) and its member rows, by mounting the autobase from the
// live swarm via an invite. Reveals whether the invite's circleId matches the
// id the founder actually wrote, i.e. whether members can diverge on circleId.
//
// Usage: node tools/circle-canonical-id.js "<invite-url>"
//   env: SYNC_MS (default 30000)
// Read-only: never appends.

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
const SYNC_MS = Number(process.env.SYNC_MS || 30000)
if (!INVITE) { console.error('usage: node tools/circle-canonical-id.js "<invite>"'); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main () {
  const parsed = parseInvite(INVITE)
  if (!parsed.ok) { console.error('bad invite:', parsed.error); process.exit(1) }
  const { circleId, name, circleKey, bootstrap, encryptionKey } = parsed
  console.log('invite circleId :', circleId)
  console.log('invite bootstrap:', bootstrap.slice(0, 16))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pccid-'))
  const store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (c) => store.replicate(c))
  const opts = {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    // Minimal view reconstruction: replay each op into the view bee so we can
    // read the circle/member rows. Not the real LWW apply, but enough to read.
    apply: async (nodes, view) => {
      for (const node of nodes) {
        const op = node.value
        if (!op || typeof op.key !== 'string') continue
        if (op.type === 'del') { await view.del(op.key) } else { await view.put(op.key, op.value) }
      }
    },
  }
  if (encryptionKey) opts.encryptionKey = b4a.from(encryptionKey, 'hex')
  const base = new Autobase(store.namespace('cid2:' + circleId + ':' + SYNC_MS), b4a.from(bootstrap, 'hex'), opts)
  await base.ready()
  swarm.join(topicForCircleKey(circleKey), { server: false, client: true })
  await swarm.flush().catch(() => {})
  console.log(`replicating ${SYNC_MS}ms...`)
  await sleep(SYNC_MS)
  await base.update().catch((e) => console.log('update err', e.message))

  const circleRow = await base.view.get('circle').catch(() => null)
  const canonical = circleRow?.value?.id ?? null
  console.log('\n=== canonical circle row (written by founder at creation) ===')
  console.log('  circle.id   :', canonical)
  console.log('  circle.name :', circleRow?.value?.name ?? '(none)')
  console.log('  circle.owner:', (circleRow?.value?.ownerKey || '').slice(0, 16))
  console.log('  invite id matches canonical:', canonical === circleId)

  let members = 0
  console.log('\n=== member rows ===')
  for await (const { key, value } of base.view.createReadStream({ gt: 'member:', lt: 'member:~' })) {
    members++
    console.log('  ', key.slice('member:'.length).slice(0, 16), value?.displayName ?? '')
  }
  console.log('  member count:', members)

  const writers = base.activeWriters ? [...base.activeWriters] : []
  console.log('\n=== active writer cores ===', writers.length)
  for (const w of writers) {
    console.log('  ', b4a.toString(w.core.key, 'hex').slice(0, 16), 'len', w.core.length)
  }

  await swarm.destroy()
  await base.close()
  await store.close()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
