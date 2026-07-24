// Append-stall tracing (investigation 2026-07-24, Hudgins circle).
//
// `safeAppend` bounds a writer append at APPEND_TIMEOUT_MS and flags the circle
// degraded when it blows, which keeps the dispatcher alive but says nothing
// about WHY the append never landed. On the Hudgins circle that timeout fires
// 9 seconds after a clean repair settle, every time, and the read-side repro
// (tools/repro-vlrwuprk.js) could not reproduce it: a fresh reader linearizes
// all ~8k ops with zero stuck reads, so the cause is specific to the write path
// on a real device. Nothing short of the device itself can tell us what that
// append is waiting on.
//
// So: record Hypercore reads while an append is in flight, and on a timeout
// report the ones still pending. If the append is blocked fetching a block, the
// block is named. If nothing is pending, it is blocked somewhere else entirely
// and that is just as informative a result.
//
// The selection rules live here, pure, so they are testable without a device.

// A read pending longer than this when the append times out is a suspect. Well
// under APPEND_TIMEOUT_MS (10s): a read that started late in the append window
// has not had time to prove itself stuck.
const MIN_PENDING_MS = 4000

// Cap on reported reads. A wedge implicates one or two blocks; anything past a
// handful is noise in a log line.
const REPORT_LIMIT = 8

// Cap on tracked reads. An append that never settles leaks its reads forever,
// and replication can issue a great many while it hangs, so the map is bounded
// and further reads go untracked rather than growing without limit.
const TRACK_LIMIT = 500

// The reads still outstanding when the append gave up, worst first. `entries`
// is whatever the tracker holds: { core, index, ts, coreLength }.
function stalledGets (entries, now, { minPendingMs = MIN_PENDING_MS, limit = REPORT_LIMIT } = {}) {
  const out = []
  for (const e of entries) {
    if (!e || typeof e.ts !== 'number') continue
    const pendingMs = now - e.ts
    if (pendingMs < minPendingMs) continue
    out.push({ core: e.core, index: e.index, coreLength: e.coreLength, pendingMs })
  }
  out.sort((a, b) => b.pendingMs - a.pendingMs)
  return out.slice(0, limit)
}

// Per-writer coverage at the moment of the stall. `contig` is the interesting
// column: a writer whose core.length runs far ahead of its contiguousLength has
// history this device cannot fetch, which is the shape the seeder's retention
// sweeps leave behind. Tolerates a half-built writer (no core yet) because this
// runs on a base that is by definition misbehaving.
function writerSummary (writers, limit = 12) {
  const out = []
  for (const w of writers || []) {
    if (out.length >= limit) break
    try {
      const core = w && w.core
      out.push({
        core: core && core.key ? keyPrefix(core.key) : '?',
        length: core ? core.length : null,
        contig: core ? core.contiguousLength : null,
      })
    } catch {
      // A writer that throws on property access is itself worth counting, but
      // it must not take the whole report down with it.
      out.push({ core: '?', length: null, contig: null })
    }
  }
  return out
}

// Writers whose fetchable prefix falls short of their length: the ones holding
// history that is gone from the network. Summarised as a count so the stall
// line stays readable, with the worst offender named.
function unfetchableWriters (summary) {
  const gaps = (summary || []).filter((w) => typeof w.length === 'number' && typeof w.contig === 'number' && w.contig < w.length)
  if (gaps.length === 0) return { count: 0, worst: null }
  let worst = gaps[0]
  for (const g of gaps) if ((g.length - g.contig) > (worst.length - worst.contig)) worst = g
  return { count: gaps.length, worst: worst.core + ':' + worst.contig + '/' + worst.length }
}

function keyPrefix (key) {
  try {
    return typeof key === 'string' ? key.slice(0, 8) : Buffer.from(key).toString('hex').slice(0, 8)
  } catch {
    return '?'
  }
}

module.exports = { stalledGets, writerSummary, unfetchableWriters, keyPrefix, MIN_PENDING_MS, REPORT_LIMIT, TRACK_LIMIT }
