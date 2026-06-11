// Seeder coverage check: which writer cores does the seeder actually hold?
//
// 1. Replicate the circle from the LIVE swarm into a fresh store, mount the
//    autobase, and enumerate every writer core + its authoritative length.
// 2. Open those same core keys against a COPY of the seeder's own store and
//    report the length the seeder has locally.
//
// A writer that is long on the swarm but length 0 in the seeder store is a
// core the blind seeder never replicated -> a hole in its mirror.
//
// Usage: node tools/seeder-coverage.js <seederStoreCopyPath> "<invite-url>"
//   env: SYNC_MS (default 35000)

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

const SEEDER_STORE = process.argv[2]
const INVITE = process.argv[3]
const SYNC_MS = Number(process.env.SYNC_MS || 35000)
if (!SEEDER_STORE || !INVITE) { console.error('usage: node tools/seeder-coverage.js <seederStoreCopy> "<invite>"'); process.exit(1) }

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main () {
  const parsed = parseInvite(INVITE)
  if (!parsed.ok) { console.error('bad invite:', parsed.error); process.exit(1) }
  const { circleId, name, circleKey, bootstrap, encryptionKey } = parsed
  console.log('circle:', name, circleId.slice(0, 8))

  // ---- 1. live swarm mount to discover writers ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pccov-'))
  const liveStore = new Corestore(path.join(dir, 'store'))
  await liveStore.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (c) => liveStore.replicate(c))
  const baseOpts = {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: async () => {},
  }
  if (encryptionKey) baseOpts.encryptionKey = b4a.from(encryptionKey, 'hex')
  const base = new Autobase(liveStore.namespace('cov:' + circleId), b4a.from(bootstrap, 'hex'), baseOpts)
  await base.ready()
  swarm.join(topicForCircleKey(circleKey), { server: false, client: true })
  await swarm.flush().catch(() => {})
  console.log(`replicating from swarm for ${SYNC_MS}ms (peers will connect)...`)
  await sleep(SYNC_MS)
  await base.update().catch((e) => console.log('update err', e.message))

  const writers = base.activeWriters ? [...base.activeWriters] : []
  const keys = []
  for (const w of writers) {
    const hex = b4a.toString(w.core.key, 'hex')
    keys.push({ hex, swarmLen: w.core.length })
  }
  console.log(`\ndiscovered ${keys.length} writer cores via swarm`)
  await swarm.destroy()
  await base.close()
  await liveStore.close()

  // ---- 2. open same keys against the seeder store copy ----
  const seeder = new Corestore(SEEDER_STORE)
  await seeder.ready()
  console.log(`\n  writer        swarm_len   seeder_len   status`)
  let missing = 0, partial = 0, ok = 0
  for (const k of keys) {
    let seederLen = 0
    try {
      const core = seeder.get({ key: b4a.from(k.hex, 'hex'), active: false })
      await core.ready()
      seederLen = core.length
    } catch (e) { /* absent */ }
    let status
    if (k.swarmLen > 0 && seederLen === 0) { status = 'MISSING (seeder has none)'; missing++ }
    else if (seederLen < k.swarmLen) { status = `PARTIAL (${k.swarmLen - seederLen} behind)`; partial++ }
    else { status = 'ok'; ok++ }
    console.log(`  ${k.hex.slice(0, 8)}      ${String(k.swarmLen).padEnd(9)}   ${String(seederLen).padEnd(9)}   ${status}`)
  }
  console.log(`\n  summary: ${ok} complete, ${partial} partial, ${missing} missing  (of ${keys.length} writers)`)
  await seeder.close()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
