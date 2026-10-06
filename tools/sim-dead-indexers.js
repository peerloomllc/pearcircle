// Simulate dead indexers in a circle Autobase (TODO "Dead phones stay
// Autobase indexers", 2026-10-06).
//
// Every writer PearCircle admits is an indexer (addWriter defaults to
// indexer: true), and Autobase confirms a node only once a majority of
// indexers has seen it (lib/consensus.js: majority = floor(n/2) + 1). A phone
// that is wiped or repaired keeps its old writer core in the indexer set
// forever. This builds an N-writer base in one process, lets every writer
// write and sync, then "kills" DEAD of them (they never replicate again) and
// keeps appending from the survivors. It reports, per round, how far the
// confirmed (indexed) length lags behind the total, and how long a cold
// reopen of a survivor takes.
//
// Usage: node tools/sim-dead-indexers.js
//   env: WRITERS (default 3), DEAD (default 2), ROUNDS (default 5),
//        OPS (default 200 appends per round), SETTLE_MS (default 12000)
const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Autobase = require('autobase')

const WRITERS = Number(process.env.WRITERS || 3)
const DEAD = Number(process.env.DEAD || 2)
const ROUNDS = Number(process.env.ROUNDS || 5)
const OPS = Number(process.env.OPS || 200)
const SETTLE_MS = Number(process.env.SETTLE_MS || 12000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-dead-idx-'))

function open (store, bootstrap) {
  return new Autobase(store, bootstrap, {
    valueEncoding: 'json',
    open: (s) => s.get('view', { valueEncoding: 'json' }),
    apply: async (nodes, view, host) => {
      for (const { value } of nodes) {
        if (value.addWriter) { await host.addWriter(b4a.from(value.addWriter, 'hex'), { indexer: true }); continue }
        await view.append(value)
      }
    },
  })
}

// Replicate every pair of live stores; returns a stop function.
function link (stores) {
  const streams = []
  for (let i = 0; i < stores.length; i++) {
    for (let j = i + 1; j < stores.length; j++) {
      const a = stores[i].replicate(true)
      const b = stores[j].replicate(false)
      a.pipe(b).pipe(a)
      streams.push(a, b)
    }
  }
  return () => { for (const s of streams) s.destroy() }
}

async function settle (bases, ms = 1500) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await Promise.all(bases.map((b) => b.update()))
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main () {
  const stores = []
  const bases = []
  for (let i = 0; i < WRITERS; i++) stores.push(new Corestore(path.join(dir, 'w' + i)))
  bases.push(open(stores[0], null))
  await bases[0].ready()
  for (let i = 1; i < WRITERS; i++) {
    bases.push(open(stores[i], bases[0].key))
    await bases[i].ready()
  }
  let unlink = link(stores)
  for (let i = 1; i < WRITERS; i++) await bases[0].append({ addWriter: b4a.toString(bases[i].local.key, 'hex') })
  await settle(bases, 3000)
  for (const b of bases) await b.append({ hello: true })
  await settle(bases, 3000)
  const idx = bases[0].system ? (await bases[0].system.getIndexers?.() ?? null) : null
  console.log(`writers ${WRITERS}, all writable: ${bases.every((b) => b.writable)}, indexers ${bases[0].linearizer?.indexers?.length ?? idx?.length ?? '?'}`)
  console.log(`before deaths: length ${bases[0].length}, indexed ${bases[0].indexedLength}, signed ${bases[0].signedLength}`)

  // Kill the last DEAD writers: stop all replication, close them, relink survivors.
  unlink()
  const live = WRITERS - DEAD
  for (let i = live; i < WRITERS; i++) { await bases[i].close(); await stores[i].close() }
  unlink = link(stores.slice(0, live))
  const survivors = bases.slice(0, live)

  for (let r = 1; r <= ROUNDS; r++) {
    for (let k = 0; k < OPS; k++) await survivors[k % live].append({ r, k })
    // Give acks a fair chance: explicit ack rounds plus the background timer.
    for (let a = 0; a < 3; a++) {
      for (const b of survivors) await b.ack().catch(() => {})
      await settle(survivors, SETTLE_MS / 3)
    }
    const b = survivors[0]
    console.log(`round ${r}: length ${b.length}, indexed ${b.indexedLength}, signed ${b.signedLength}, unconfirmed ${b.length - b.indexedLength}`)
  }

  // Cold reopen of survivor 0, to see what a restart costs with the backlog.
  unlink()
  for (const b of survivors) await b.close()
  const key = bases[0].key
  await stores[0].close()
  const t0 = Date.now()
  const store = new Corestore(path.join(dir, 'w0'))
  const reopened = open(store, key)
  await reopened.ready()
  await reopened.update()
  console.log(`cold reopen + update: ${Date.now() - t0} ms, length ${reopened.length}, indexed ${reopened.indexedLength}`)
  await reopened.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
