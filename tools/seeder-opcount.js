// Read-only op-count inspector for a seeder's on-disk corestore.
// Confirms oplog bloat: sums writer-core lengths (unencrypted metadata) so
// it works on a BLIND seeder that lacks the autobase encryption key.
//
// Phase 1 (no key): reads the local 'local' Hyperbee for seeder:enrolled:*
// rows, then opens each circle's bootstrap core (the founder's writer input
// core) read-only and reports its length + on-disk bytes.
//
// Phase 2 (optional): if ENC_KEYS env is a JSON map {circleId: encHex},
// mounts the Autobase for those circles and tallies applied ops by key
// prefix (lastSeen vs transition vs other) + the deduped view key count.
//
// Usage: node tools/seeder-opcount.js <storePath>
//   env: ENC_KEYS='{"<circleId>":"<encHex>"}'  UPDATE_MS=20000
//
// Never appends. Point it at a COPY of a live seeder's store.

const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Autobase = require('autobase')

const STORE = process.argv[2]
if (!STORE) { console.error('usage: node tools/seeder-opcount.js <storePath>'); process.exit(1) }
const ENC_KEYS = process.env.ENC_KEYS ? JSON.parse(process.env.ENC_KEYS) : {}
const UPDATE_MS = Number(process.env.UPDATE_MS || 20000)

function prefixOf (key) {
  const k = String(key)
  const i = k.indexOf(':')
  return i < 0 ? k : k.slice(0, i)
}

async function main () {
  const store = new Corestore(STORE)
  await store.ready()

  // ---- enrolled circles from the local (unencrypted) bee ----
  const localCore = store.get({ name: 'local' })
  await localCore.ready()
  const bee = new Hyperbee(localCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  const circles = []
  for await (const { value } of bee.createReadStream({ gt: 'seeder:enrolled:', lt: 'seeder:enrolled:~' })) {
    if (value && value.circleId) circles.push(value)
  }
  console.log(`\nenrolled circles: ${circles.length}`)

  for (const c of circles) {
    console.log(`\n=== ${c.name || '(unnamed)'}  [${c.circleId}] ===`)
    // bootstrap core == founder's writer input core (length = founder ops)
    try {
      const boot = store.get({ key: b4a.from(c.bootstrap, 'hex'), active: false })
      await boot.ready()
      console.log(`  bootstrap/founder writer core: length=${boot.length}  contiguous=${boot.contiguousLength}  bytes=${boot.byteLength}`)
    } catch (e) { console.log('  bootstrap open failed:', e.message) }

    const encHex = ENC_KEYS[c.circleId]
    if (!encHex) { console.log('  (no enc key supplied -> skipping full mount/breakdown)'); continue }

    // ---- Phase 2: full mount + op tally (needs the autobase enc key) ----
    const tally = {}           // prefix -> total op count (with overwrites)
    const distinct = {}        // prefix -> Set of full keys (deduped)
    const addWriterKeys = new Set() // any 64-hex key seen in op values (writer candidates)
    let applied = 0
    // Fresh namespace so update() linearizes from scratch and apply sees every
    // historical op. Reads (bootstrap + writer + view cores) are by key, so
    // namespace choice doesn't affect what we can read.
    const ns = store.namespace('opcount-inspect:' + Date.now() + ':' + c.circleId)
    const base = new Autobase(ns, b4a.from(c.bootstrap, 'hex'), {
      valueEncoding: 'json',
      encryptionKey: b4a.from(encHex, 'hex'),
      open: (viewStore) => new Hyperbee(viewStore.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
      apply: async (nodes, view, b) => {
        for (const node of nodes) {
          applied++
          const v = node.value
          const key = String(v && (v.key != null ? v.key : (v.type ? v.type : '?')))
          const p = prefixOf(key)
          tally[p] = (tally[p] || 0) + 1
          ;(distinct[p] || (distinct[p] = new Set())).add(key)
          // capture added-writer keys so we can sum every member's core length
          // even if linearization stalls before activating them
          try {
            const blob = JSON.stringify(v)
            for (const m of blob.matchAll(/\b([0-9a-f]{64})\b/g)) addWriterKeys.add(m[1])
          } catch (_) {}
        }
      },
    })
    await base.ready()

    // sum across all writer input cores = total raw ops in the circle
    let writerTotal = 0
    const writers = base.activeWriters ? [...base.activeWriters] : []
    for (const w of writers) {
      const len = w.core ? w.core.length : w.length
      writerTotal += len || 0
      console.log(`  writer ${b4a.toString(w.core.key, 'hex').slice(0, 8)} length=${len}`)
    }
    console.log(`  >>> total raw ops across ${writers.length} writers: ${writerTotal}`)

    // linearize to tally op types (timeout-guarded; update() may stall on a wedge)
    let updateResolved = false
    await Promise.race([
      base.update().then(() => { updateResolved = true }),
      new Promise((r) => setTimeout(r, UPDATE_MS)),
    ])
    console.log(`  base.update() resolved: ${updateResolved}  (false = stalled/timed out at ${UPDATE_MS}ms)`)
    console.log(`  applied (linearized) ops: ${applied}`)

    // Robust total: sum the length of EVERY writer core we can identify,
    // independent of whether the linearizer activated them. Core length is
    // unencrypted metadata, so a stall can't hide ops here.
    let allWriterTotal = 0
    const seen = new Set()
    const candidates = [c.bootstrap, ...addWriterKeys]
    for (const hex of candidates) {
      if (seen.has(hex)) continue
      seen.add(hex)
      try {
        const core = store.get({ key: b4a.from(hex, 'hex'), active: false })
        await core.ready()
        if (core.length > 0 || hex === c.bootstrap) {
          allWriterTotal += core.length
          console.log(`  member core ${hex.slice(0, 8)} length=${core.length} bytes=${core.byteLength}`)
        }
      } catch (e) { /* not a core */ }
    }
    console.log(`  >>> TRUE total raw ops across all member cores: ${allWriterTotal}`)
    // Read the DEDUPED current state straight from the indexed view core
    // (update() fast-forwards to it, so apply may see 0 this run).
    const viewTally = {}
    try {
      let viewTotal = 0
      for await (const { key } of base.view.createReadStream()) {
        viewTally[prefixOf(key)] = (viewTally[prefixOf(key)] || 0) + 1
        viewTotal++
      }
      const vsorted = Object.entries(viewTally).sort((a, b) => b[1] - a[1])
      console.log(`  deduped view contents (current circle state):`)
      for (const [k, n] of vsorted) console.log(`    ${k}: ${n}`)
      console.log(`  view keys total: ${viewTotal}`)
      console.log(`  founder ops ${allWriterTotal} vs view keys ${viewTotal} -> overwrite ~${(allWriterTotal / Math.max(1, viewTotal)).toFixed(1)}x`)
    } catch (e) { console.log('  view scan failed:', e.message) }

    await base.close()
  }

  await store.close()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
