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
async function pickStaleBlocks (localDb, circleId, now, pruneOlderThan) {
  if (typeof circleId !== 'string' || circleId.length === 0) return []
  if (typeof now !== 'number' || !Number.isFinite(now)) return []
  if (typeof pruneOlderThan !== 'number' || !Number.isFinite(pruneOlderThan) || pruneOlderThan <= 0) return []
  const cutoff = now - pruneOlderThan
  const stale = []
  for await (const { value } of localDb.createReadStream(rangeForCircle(circleId))) {
    if (!value || typeof value.seq !== 'number') continue
    if (typeof value.receivedAt !== 'number') continue
    if (value.receivedAt < cutoff) stale.push(value.seq)
  }
  return stale
}

// One-shot orchestrator. Pure-ish: caller passes in clearBlock(seq)
// which performs core.clear(seq, seq+1) and removeBlockTracking via the
// real corestore + localDb. Returns counts so the boot mark can record
// how much was pruned.
async function runSeederRetentionSweep ({ localDb, enrolledCircles, getRetentionMs, clearBlock, now }) {
  const result = { circles: 0, cleared: 0, errors: 0 }
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
        await clearBlock(circleId, seq)
        result.cleared++
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
}
