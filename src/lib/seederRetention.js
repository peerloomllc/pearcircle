// Per-block retention bookkeeping for the seed-mode worklet.
// Proposal 2026-05-19-blind-seeder-peers slice 5 (Q8 resolution: ship a
// TTL config knob in v1).
//
// The seeder cannot read block contents — it has no encryption key by
// design. So "drop blocks older than N ms" is interpreted as the time
// THIS SEEDER first received the block via replication, not the time the
// member wrote it. Close enough for disk-budgeting on a Pi, and the only
// thing we can measure without decryption.
//
// Sidecar storage (in the seeder's local Hyperbee):
//   seeder:blockTime:{circleId}:{paddedSeq} → { seq, receivedAt }
//
// `paddedSeq` is the block sequence number zero-padded to 13 digits so
// lexicographic prefix scans return chronological order — same trick as
// the trips wire format. Hypercore sequences fit in 13 digits for any
// circle that won't exceed 10^13 blocks (a long way off).
//
// Sweep: pickStaleBlocks lists seqs whose receivedAt is older than
// (now - pruneOlderThan). Caller is responsible for calling
// core.clear(seq, seq+1) and then removeBlockTracking to drop the
// sidecar. These steps are intentionally separated so the wiring layer
// can batch clears or skip them if the hypercore session has closed.

const PAD = 13

function padSeq (seq) {
  return String(seq).padStart(PAD, '0')
}

function blockTimeKey (circleId, seq) {
  return 'seeder:blockTime:' + circleId + ':' + padSeq(seq)
}

function rangeForCircle (circleId) {
  return {
    gt: 'seeder:blockTime:' + circleId + ':',
    lt: 'seeder:blockTime:' + circleId + ':~',
  }
}

async function recordBlockReceived (localDb, circleId, seq, receivedAt) {
  if (typeof circleId !== 'string' || circleId.length === 0) return false
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return false
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return false
  await localDb.put(blockTimeKey(circleId, seq), { seq, receivedAt })
  return true
}

async function removeBlockTracking (localDb, circleId, seq) {
  if (typeof circleId !== 'string' || circleId.length === 0) return false
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return false
  await localDb.del(blockTimeKey(circleId, seq)).catch(() => {})
  return true
}

// Return the list of block seqs whose receivedAt is strictly older than
// `now - pruneOlderThan`. Empty list when pruneOlderThan is null /
// undefined / non-positive — that's the "no pruning configured" signal
// from the seeder:retention:set IPC.
// Shared: list block seqs in `range` whose receivedAt is strictly older
// than the cutoff. Empty when pruneOlderThan is null / undefined /
// non-positive — the "no pruning configured" signal.
async function pickStaleInRange (localDb, range, now, pruneOlderThan) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return []
  if (typeof pruneOlderThan !== 'number' || !Number.isFinite(pruneOlderThan) || pruneOlderThan <= 0) return []
  const cutoff = now - pruneOlderThan
  const stale = []
  for await (const { value } of localDb.createReadStream(range)) {
    if (!value || typeof value.seq !== 'number') continue
    if (typeof value.receivedAt !== 'number') continue
    if (value.receivedAt < cutoff) stale.push(value.seq)
  }
  return stale
}

// Bootstrap (founder) core: list stale block seqs for a circle.
async function pickStaleBlocks (localDb, circleId, now, pruneOlderThan) {
  if (typeof circleId !== 'string' || circleId.length === 0) return []
  return pickStaleInRange(localDb, rangeForCircle(circleId), now, pruneOlderThan)
}

// --- Per-member writer-core retention (storage audit 2026-06-22) ---
// The bootstrap core above is the founder's writer core; the SAME
// time-based pruneOlderThan policy (launcher UI) is extended to every
// OTHER member's writer core so it actually bounds them too — previously
// the sweep only touched the bootstrap, so writer cores grew forever
// regardless of the configured retention. Each writer core has its own
// independent seq space, so the tracking key carries the coreKey:
//   seeder:wBlockTime:{circleId}:{coreKey}:{paddedSeq}
// Track-forward only (like the bootstrap core, which also never
// backfilled): blocks already on disk before this shipped carry no row
// and are reclaimed by a fresh seeder reinstall.

function writerBlockTimeKey (circleId, coreKey, seq) {
  return 'seeder:wBlockTime:' + circleId + ':' + coreKey + ':' + padSeq(seq)
}

function rangeForWriterCore (circleId, coreKey) {
  return {
    gt: 'seeder:wBlockTime:' + circleId + ':' + coreKey + ':',
    lt: 'seeder:wBlockTime:' + circleId + ':' + coreKey + ':~',
  }
}

function rangeForWriterCircle (circleId) {
  return {
    gt: 'seeder:wBlockTime:' + circleId + ':',
    lt: 'seeder:wBlockTime:' + circleId + ':~',
  }
}

async function recordWriterBlockReceived (localDb, circleId, coreKey, seq, receivedAt) {
  if (typeof circleId !== 'string' || circleId.length === 0) return false
  if (typeof coreKey !== 'string' || coreKey.length === 0) return false
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return false
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return false
  await localDb.put(writerBlockTimeKey(circleId, coreKey, seq), { seq, receivedAt })
  return true
}

async function removeWriterBlockTracking (localDb, circleId, coreKey, seq) {
  if (typeof circleId !== 'string' || circleId.length === 0) return false
  if (typeof coreKey !== 'string' || coreKey.length === 0) return false
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return false
  await localDb.del(writerBlockTimeKey(circleId, coreKey, seq)).catch(() => {})
  return true
}

async function pickStaleWriterBlocks (localDb, circleId, coreKey, now, pruneOlderThan) {
  if (typeof circleId !== 'string' || circleId.length === 0) return []
  if (typeof coreKey !== 'string' || coreKey.length === 0) return []
  return pickStaleInRange(localDb, rangeForWriterCore(circleId, coreKey), now, pruneOlderThan)
}

// One-shot orchestrator. Pure-ish: caller passes in clearBlock(seq)
// which performs core.clear(seq, seq+1) and removeBlockTracking via the
// real corestore + localDb. Returns counts so the boot mark can record
// how much was pruned.
async function runSeederRetentionSweep ({ localDb, enrolledCircles, getRetentionMs, clearBlock, now }) {
  // clearedBytes is an estimate: clearBlock returns the core's average block
  // size per cleared seq (exact per-block sizes aren't cheaply available on a
  // blind core, and the blocks a seeder holds are uniform). Physical disk is
  // reclaimed by the next RocksDB compaction, not by clear() itself.
  const result = { circles: 0, cleared: 0, clearedBytes: 0, errors: 0 }
  for (const circleId of enrolledCircles) {
    let pruneOlderThan = null
    try {
      pruneOlderThan = await getRetentionMs(circleId)
    } catch {
      result.errors++
      continue
    }
    if (typeof pruneOlderThan !== 'number' || pruneOlderThan <= 0) continue
    const stale = await pickStaleBlocks(localDb, circleId, now, pruneOlderThan)
    if (stale.length === 0) continue
    result.circles++
    for (const seq of stale) {
      try {
        const bytes = await clearBlock(circleId, seq)
        result.cleared++
        if (typeof bytes === 'number' && bytes > 0) result.clearedBytes += bytes
      } catch {
        result.errors++
      }
    }
  }
  return result
}

// Writer-core orchestrator. `writerCores` is a flat list of
// { circleId, coreKey }; retention is read once per circle (cached) and
// applied to each of that circle's writer cores. clearBlock(circleId,
// coreKey, seq) performs core.clear(seq, seq+1) + removeWriterBlockTracking
// on the specific writer core.
async function runSeederWriterRetentionSweep ({ localDb, writerCores, getRetentionMs, clearBlock, now }) {
  // clearedBytes is an estimate (avg block size per cleared seq) — see the note
  // on runSeederRetentionSweep.
  const result = { cores: 0, cleared: 0, clearedBytes: 0, errors: 0 }
  const retentionByCircle = new Map()
  for (const { circleId, coreKey } of writerCores) {
    let pruneOlderThan
    if (retentionByCircle.has(circleId)) {
      pruneOlderThan = retentionByCircle.get(circleId)
    } else {
      try {
        pruneOlderThan = await getRetentionMs(circleId)
      } catch {
        pruneOlderThan = null
        result.errors++
      }
      retentionByCircle.set(circleId, pruneOlderThan)
    }
    if (typeof pruneOlderThan !== 'number' || pruneOlderThan <= 0) continue
    const stale = await pickStaleWriterBlocks(localDb, circleId, coreKey, now, pruneOlderThan)
    if (stale.length === 0) continue
    result.cores++
    for (const seq of stale) {
      try {
        const bytes = await clearBlock(circleId, coreKey, seq)
        result.cleared++
        if (typeof bytes === 'number' && bytes > 0) result.clearedBytes += bytes
      } catch {
        result.errors++
      }
    }
  }
  return result
}

module.exports = {
  blockTimeKey,
  recordBlockReceived,
  removeBlockTracking,
  pickStaleBlocks,
  runSeederRetentionSweep,
  writerBlockTimeKey,
  rangeForWriterCircle,
  recordWriterBlockReceived,
  removeWriterBlockTracking,
  pickStaleWriterBlocks,
  runSeederWriterRetentionSweep,
}
