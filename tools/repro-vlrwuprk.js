// Autobase wedge reproduction + linearizer instrumentation (investigation
// 2026-06-04, circle VLRwUprk). Joins a circle's swarm topic from an invite
// link, re-replicates the autobase from live peers/seeder into a FRESH local
// corestore, mounts the base, and runs base.update(). If update() wedges, it
// dumps the in-flight Hypercore reads (the block the linearizer is blocked
// on) plus the writer/system lengths, which pinpoints the poisoned op.
//
// Read-only: never appends, so the live circle is untouched.
//
// Usage: node tools/repro-vlrwuprk.js "<invite-url>"
//   env: SYNC_MS (default 45000) wait before update; UPDATE_MS (default 30000)

const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const Autobase = require('autobase')
const Hypercore = require('hypercore')
const { parseInvite } = require('../src/invite')
const { topicForCircleKey } = require('../src/swarm')

let applied = 0
const opTally = {}
const SYNC_MS = Number(process.env.SYNC_MS || 45000)
const UPDATE_MS = Number(process.env.UPDATE_MS || 30000)
const STALL_MS = 4000 // a get pending longer than this is "stuck"

// ---- instrument Hypercore.get to track in-flight reads ----
const inflight = new Map() // id -> { key, index, ts }
let seq = 0
const origGet = Hypercore.prototype.get
Hypercore.prototype.get = function (index, ...rest) {
  const id = ++seq
  const keyHex = this.key ? b4a.toString(this.key, 'hex') : '(no-key)'
  const rec = { key: keyHex.slice(0, 8), index, ts: Date.now(), len: this.length }
  inflight.set(id, rec)
  let p
  try { p = origGet.call(this, index, ...rest) } catch (e) { inflight.delete(id); throw e }
  return Promise.resolve(p).finally(() => inflight.delete(id))
}

function dumpInflight (label) {
  const now = Date.now()
  const stuck = [...inflight.values()].filter((r) => now - r.ts > STALL_MS)
    .sort((a, b) => (now - b.ts) - (now - a.ts))
  console.log(`\n[${label}] in-flight gets: ${inflight.size} total, ${stuck.length} stuck >${STALL_MS}ms`)
  for (const r of stuck.slice(0, 20)) {
    console.log(`  core ${r.key} index=${r.index} (core.length was ${r.len}) pending ${now - r.ts}ms`)
  }
}

async function dumpBaseState (base) {
  try {
    console.log('\n=== base state ===')
    console.log('writable:', base.writable, 'opened:', base.opened)
    const sys = base.system
    if (sys) {
      console.log('system.indexers:', (sys.indexers || []).map((w) => ({
        key: b4a.toString(w.key, 'hex').slice(0, 8), length: w.length,
      })))
      console.log('system core length:', sys.core ? sys.core.length : '(n/a)')
    }
    const writers = base.activeWriters ? [...base.activeWriters] : []
    console.log('activeWriters:', writers.length)
    for (const w of writers) {
      const c = w.core
      console.log('  writer', b4a.toString(w.core.key, 'hex').slice(0, 8),
        'node.length=', w.length,
        'core.length=', c ? c.length : '?',
        'contig=', c ? c.contiguousLength : '?')
    }
    const lin = base.linearizer
    if (lin) {
      console.log('linearizer indexers:', (lin.indexers || []).length,
        'heads:', lin.heads ? lin.heads.size : '?',
        'tails:', lin.tails ? lin.tails.size : '?')
    }
  } catch (e) { console.log('dumpBaseState err', e.message) }
}

// Opt-in deep trace (DRAIN_TRACE=1): count invocations of the inner _drain
// branches to reveal a livelock (a branch that keeps `continue`-ing without
// the linearizer frontier advancing). Patches Autobase.prototype so it must
// run before any base is constructed.
const traceCounts = {}
function installDrainTrace () {
  const methods = ['_catchupApplyState', '_addRemoteHeads', '_applyFastForward', '_runForceFastForward', '_drainWakeup', '_drain']
  for (const m of methods) {
    const orig = Autobase.prototype[m]
    if (typeof orig !== 'function') continue
    traceCounts[m] = 0
    Autobase.prototype[m] = function (...args) {
      traceCounts[m]++
      if (traceCounts[m] <= 3) console.log(`  [trace] ${m} call #${traceCounts[m]}`)
      const r = orig.apply(this, args)
      return r
    }
  }
}
function dumpTrace (base) {
  console.log('\n[trace] branch invocation counts:', JSON.stringify(traceCounts))
  if (base) {
    console.log('[trace] flags: _draining=%s _caughtup=%s fastForwardTo=%s fastForwarding=%s updating=%s',
      base._draining, base._caughtup, base.fastForwardTo, base.fastForwarding, base.updating)
  }
}

function withTimeout (p, ms, tag) {
  return Promise.race([
    p.then((v) => ({ ok: true, v })),
    new Promise((res) => setTimeout(() => res({ ok: false, tag }), ms)),
  ])
}

async function main () {
  const inviteArg = process.argv[2] || process.env.INVITE
  if (!inviteArg) { console.error('usage: node tools/repro-vlrwuprk.js "<invite-url>"'); process.exit(1) }
  const parsed = parseInvite(inviteArg)
  if (!parsed.ok) { console.error('bad invite:', parsed.error); process.exit(1) }
  const { circleId, name, circleKey, bootstrap, encryptionKey } = parsed
  console.log('circle:', name, circleId.slice(0, 8))
  console.log('bootstrap:', bootstrap.slice(0, 12), 'enc:', encryptionKey ? 'present' : 'NONE')

  if (process.env.DRAIN_TRACE) { installDrainTrace(); console.log('drain trace ON') }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcrepro-'))
  console.log('fresh store:', dir)
  const store = new Corestore(path.join(dir, 'store'))
  await store.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', (conn, info) => {
    console.log('peer connected:', b4a.toString(info.publicKey, 'hex').slice(0, 8))
    store.replicate(conn)
  })
  const topic = topicForCircleKey(circleKey)
  swarm.join(topic, { server: false, client: true })
  await swarm.flush()
  console.log('topic joined, discovering peers…')

  // Mount the autobase against the fresh namespace, replicating from bootstrap.
  const ns = store.namespace(circleId)
  const baseOpts = {
    valueEncoding: 'json',
    open: (viewStore) => new Hyperbee(viewStore.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
    // minimal apply that tallies op key-prefixes so we can attribute history bloat
    apply: async (nodes, view, base) => {
      for (const n of nodes) {
        const op = n.value
        applied++
        const k = (op && typeof op.key === 'string') ? op.key.split(':')[0] : '(none)'
        opTally[k] = (opTally[k] || 0) + 1
      }
    },
  }
  if (encryptionKey) baseOpts.encryptionKey = b4a.from(encryptionKey, 'hex')
  const base = new Autobase(ns, b4a.from(bootstrap, 'hex'), baseOpts)
  await base.ready()
  console.log('base ready, bootstrap core length:', base.bootstraps ? base.bootstraps.length : '?')

  // Let replication sync history from the seeder/peers.
  const t0 = Date.now()
  const tick = setInterval(() => {
    const w = base.activeWriters ? [...base.activeWriters] : []
    const lens = w.map((x) => `${b4a.toString(x.core.key, 'hex').slice(0, 6)}:${x.core.length}/${x.core.contiguousLength}`).join(' ')
    const tc = process.env.DRAIN_TRACE ? ' trace=' + JSON.stringify(traceCounts) + ' ff=' + base.fastForwardTo + ' caughtup=' + base._caughtup : ''
    console.log(`+${Date.now() - t0}ms peers=${swarm.connections.size} writers=[${lens}] inflight=${inflight.size}${tc}`)
  }, 3000)

  await new Promise((r) => setTimeout(r, SYNC_MS))

  console.log('\n>>> calling base.update() with', UPDATE_MS, 'ms timeout')
  const res = await withTimeout(base.update(), UPDATE_MS, 'update')
  if (res.ok) {
    console.log('\n*** update() RESOLVED - no wedge reproduced this run ***')
    await dumpBaseState(base)
  } else {
    console.log('\n*** update() WEDGED (timed out) - capturing stall ***')
    dumpInflight('WEDGE')
    await dumpBaseState(base)
    console.log('\nThe stuck get(s) above are the block(s) the linearizer waits on forever.')
    console.log('Compare index vs that core.length: index >= length + no peer has it = the poison.')
    if (process.env.DRAIN_TRACE) dumpTrace(base)
  }
  clearInterval(tick)
  console.log('\n(leaving process up 5s for final replication drain…)')
  await new Promise((r) => setTimeout(r, 5000))
  dumpInflight('FINAL')
  const sorted = Object.entries(opTally).sort((a, b) => b[1] - a[1])
  console.log(`\n=== op tally (linearized & applied: ${applied}) ===`)
  for (const [k, n] of sorted) console.log(`  ${k}: ${n}`)
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
