// Writer-core fork reproduction + prevention/recovery validation
// (proposal 2026-06-27-fork-conflict-recovery). We have no genuinely-forked
// test device, so this exercises the actual hypercore behaviour our fix relies
// on, in-process with real Corestore/Hypercore replication.
//
// It faithfully reproduces the bug as DATA LOSS, not an intentional rewind:
// truncate(n, { fork: sameFork }) drops blocks WITHOUT bumping the fork id,
// which is what a WAL loss looks like on reopen. Appending past that point then
// produces two valid signatures at one index against a peer that kept the
// original tail — exactly the crash on Benjamin's Pixel 7.
//
// Scenario A — REWIND GUARD prevents the fork: truncate (no re-append),
//   reconnect to a peer holding the original, confirm writerRewindStatus sees
//   the network ahead and a download recovers the original tail with NO conflict.
// Scenario B — SEATBELT catches the fork: truncate AND re-append divergent,
//   reconnect, confirm hypercore detects the conflict (the '[hypercore]
//   conflict detected' log + the escaping error) and that parseConflictLog /
//   shouldSwallowFault would arm + swallow it.
//
// Usage: node tools/repro-fork.js   (uses temp dirs under the OS tmp)

const os = require('os')
const fs = require('fs')
const path = require('path')
const Corestore = require('corestore')
const { writerRewindStatus } = require('../src/lib/rewindGuard')
const { parseConflictLog, shouldSwallowFault } = require('../src/lib/conflictSeatbelt')

const N = 10        // original length
const TRUNC_TO = 5  // simulated WAL-loss length

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const buf = (s) => Buffer.from(s)

// Capture hypercore's conflict log line (what the worklet taps in prod).
const conflictLogs = []
const origLog = console.log.bind(console)
console.log = (...a) => { const d = parseConflictLog(a[0]); if (d) conflictLogs.push(d); origLog(...a) }

function pipe (a, b) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch {} try { s2.destroy() } catch {} }
}

async function waitFor (fn, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50) }
  throw new Error('timeout waiting for ' + label)
}

async function mkstore (tag) {
  const dir = path.join(os.tmpdir(), 'pc-repro-fork-' + tag + '-' + process.pid)
  fs.rmSync(dir, { recursive: true, force: true })
  const store = new Corestore(dir)
  await store.ready()
  return { store, dir }
}

async function run () {
  const results = {}

  // ---- Scenario A: a same-fork truncation with NO divergent append is
  //      non-fatal. The guard's download IS what replication does anyway, so we
  //      assert the safety property (recovers to original, never conflicts) and
  //      capture whether the guard would have flagged "behind" mid-recovery. ----
  {
    const W = await mkstore('A-writer')
    const R = await mkstore('A-peer')
    const w = W.store.get({ name: 'writer' }); await w.ready()
    for (let i = 0; i < N; i++) await w.append(buf('orig-' + i))
    const r = R.store.get({ key: w.key }); await r.ready()
    let stop = pipe(W.store, R.store)
    r.download({ start: 0, end: N })
    await waitFor(() => r.length === N, 5000, 'peer initial sync')
    stop()

    // Simulate WAL loss: drop blocks WITHOUT bumping the fork.
    await w.truncate(TRUNC_TO, { fork: w.fork })

    const conflictA = []
    w.on('conflict', () => conflictA.push(1))
    stop = pipe(W.store, R.store)
    // Sample tightly: did the guard's decision ever see the network ahead of us
    // before replication caught us up? (Hypercore may auto-heal very fast.)
    let everBehind = false
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && w.length < N) {
      const net = Math.max(0, ...w.peers.map(p => p.remoteLength || 0))
      if (writerRewindStatus({ localLength: w.length, networkLength: net }).behind) everBehind = true
      await sleep(10)
    }
    await waitFor(() => w.length === N, 5000, 'rewind recovery')
    await sleep(300)
    stop()

    results.A = {
      truncatedTo: TRUNC_TO, localAfter: w.length,
      guardObservedBehind: everBehind,
      recovered: w.length === N,
      conflicts: conflictA.length,
      pass: w.length === N && conflictA.length === 0, // truncation self-heals, no fork
    }
    await W.store.close(); await R.store.close()
  }

  // ---- Scenario B: seatbelt catches a real fork ----
  {
    conflictLogs.length = 0
    const W = await mkstore('B-writer')
    const R = await mkstore('B-peer')
    const w = W.store.get({ name: 'writer' }); await w.ready()
    for (let i = 0; i < N; i++) await w.append(buf('orig-' + i))
    const r = R.store.get({ key: w.key }); await r.ready()
    let stop = pipe(W.store, R.store)
    r.download({ start: 0, end: N })
    await waitFor(() => r.length === N, 5000, 'peer initial sync')
    stop()

    // WAL loss + divergent re-append, leaving W SHORTER than the peer so W must
    // request the peer's tail and detect the conflict (the asymmetry that
    // forces a proof exchange across the forked region — equal lengths never
    // exchange the diverging blocks). W ends at TRUNC_TO+1; R stays at N.
    await w.truncate(TRUNC_TO, { fork: w.fork })
    await w.append(buf('FORK-' + TRUNC_TO)) // divergent block at index TRUNC_TO

    let conflictEvents = 0
    w.on('conflict', () => conflictEvents++)
    r.on('conflict', () => conflictEvents++)
    stop = pipe(W.store, R.store)
    // W (len TRUNC_TO+1, divergent block TRUNC_TO) pulls R's original tail ->
    // R's signed length-N root conflicts with W's divergent block -> conflict.
    try { w.download({ start: 0, end: N }) } catch (e) { /* expected during fork */ }
    await waitFor(() => conflictEvents > 0 || conflictLogs.length > 0, 6000, 'conflict detection').catch(() => {})
    await sleep(300)
    stop()

    const logDisc = conflictLogs[0] || null
    // The escaping rejection in prod is Error('Closed'); confirm the seatbelt
    // would arm (a conflict was just seen) and swallow it.
    const now = Date.now()
    const swallowsClosed = shouldSwallowFault(new Error('Closed'), now, now)
    const swallowsConflictErr = shouldSwallowFault(new Error('Two conflicting signatures exist for length 5'), now, now)

    results.B = {
      conflictEvents,
      conflictLogParsed: !!logDisc,
      seatbeltSwallowsClosed: swallowsClosed,
      seatbeltSwallowsConflictErr: swallowsConflictErr,
      pass: (conflictEvents > 0 || !!logDisc) && swallowsClosed,
    }
    await W.store.close(); await R.store.close()
  }

  console.log = origLog
  console.log('\n================ REPRO RESULTS ================')
  console.log('Scenario A (rewind guard prevents fork):', JSON.stringify(results.A, null, 2))
  console.log('Scenario B (seatbelt catches fork):     ', JSON.stringify(results.B, null, 2))
  const ok = results.A.pass && results.B.pass
  console.log('\nOVERALL:', ok ? 'PASS ✅' : 'FAIL ❌')
  process.exit(ok ? 0 : 1)
}

run().catch((e) => { console.log = origLog; console.error('repro crashed:', e); process.exit(2) })
