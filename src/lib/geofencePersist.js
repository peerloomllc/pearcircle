// Local-only persistence of geofence inside/outside classification.
//
// The JS classifier keeps each place's last inside/outside state in memory
// only, so it resets to null on every worklet cold boot (force-quit, or iOS
// killing+relaunching the worklet). With a null prior, classify() silently
// re-baselines and fires no transition, so any boundary crossing that
// happened while the app was suspended is lost. Persisting the classification
// to the local Hyperbee lets boot hydration restore a real prior state, so
// the first fix after a wake can recover the missed enter/exit.
//
// Pure helpers over a Hyperbee-like { get, put, del } so they unit-test
// without the worklet. The rows are local-only: never signed, never
// replicated, never on the wire (proposal 2026-05-30).

const GEOFENCE_PREFIX = 'geofence:'

function classificationKey (circleId, placeId) {
  return GEOFENCE_PREFIX + circleId + ':' + placeId
}

// Write a classification flip. classification is 'inside' | 'outside'.
async function persistClassification (db, circleId, placeId, classification, ts) {
  if (!db) return
  await db.put(classificationKey(circleId, placeId), { classification, ts, v: 1 })
}

async function deleteClassification (db, circleId, placeId) {
  if (!db) return
  await db.del(classificationKey(circleId, placeId))
}

// Read a persisted classification back. Returns 'inside' | 'outside', or null
// when absent or stored as anything else (defensive against legacy/garbage
// rows).
async function readClassification (db, circleId, placeId) {
  if (!db) return null
  const row = await db.get(classificationKey(circleId, placeId))
  const c = row && row.value && row.value.classification
  return c === 'inside' || c === 'outside' ? c : null
}

// Decide whether a restored value should be applied onto in-memory state.
// Only fills a null slot (never clobbers an in-session value) and only with a
// clean inside/outside.
function shouldRestore (current, restored) {
  return current === null && (restored === 'inside' || restored === 'outside')
}

module.exports = {
  GEOFENCE_PREFIX,
  classificationKey,
  persistClassification,
  deleteClassification,
  readClassification,
  shouldRestore,
}
