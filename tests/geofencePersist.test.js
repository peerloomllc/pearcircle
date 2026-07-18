// Persisted geofence classification - recover a crossing across a cold boot.
// Proposal 2026-05-30-background-transition-detection (fix 1).

const {
  classificationKey,
  persistClassification,
  deleteClassification,
  readClassification,
  shouldRestore,
} = require('../src/lib/geofencePersist')
const { classify } = require('../src/lib/geofence')

// Minimal Hyperbee-shaped store: get returns { value } | null, like Hyperbee.
function fakeDb () {
  const m = new Map()
  return {
    async get (key) { return m.has(key) ? { value: m.get(key) } : null },
    async put (key, value) { m.set(key, value) },
    async del (key) { m.delete(key) },
    _map: m,
  }
}

describe('classificationKey', () => {
  test('is prefixed and scoped to circle + place', () => {
    expect(classificationKey('c1', 'home')).toBe('geofence:c1:home')
  })
})

describe('persist / read round-trip', () => {
  test('writes a classification and reads it back', async () => {
    const db = fakeDb()
    await persistClassification(db, 'c1', 'scooters', 'inside', 1714867200000)
    expect(await readClassification(db, 'c1', 'scooters')).toBe('inside')
  })

  test('overwrites on a later flip', async () => {
    const db = fakeDb()
    await persistClassification(db, 'c1', 'scooters', 'inside', 1)
    await persistClassification(db, 'c1', 'scooters', 'outside', 2)
    expect(await readClassification(db, 'c1', 'scooters')).toBe('outside')
  })

  test('absent row reads back as null', async () => {
    const db = fakeDb()
    expect(await readClassification(db, 'c1', 'nope')).toBeNull()
  })

  test('garbage stored classification reads back as null', async () => {
    const db = fakeDb()
    await db.put(classificationKey('c1', 'p'), { classification: 'sideways', v: 1 })
    expect(await readClassification(db, 'c1', 'p')).toBeNull()
  })

  test('delete removes the row', async () => {
    const db = fakeDb()
    await persistClassification(db, 'c1', 'p', 'inside', 1)
    await deleteClassification(db, 'c1', 'p')
    expect(await readClassification(db, 'c1', 'p')).toBeNull()
  })

  test('null db is a no-op, never throws', async () => {
    await expect(persistClassification(null, 'c', 'p', 'inside', 1)).resolves.toBeUndefined()
    await expect(deleteClassification(null, 'c', 'p')).resolves.toBeUndefined()
    expect(await readClassification(null, 'c', 'p')).toBeNull()
  })
})

describe('shouldRestore gate', () => {
  test('fills a null slot with a clean value', () => {
    expect(shouldRestore(null, 'inside')).toBe(true)
    expect(shouldRestore(null, 'outside')).toBe(true)
  })

  test('never clobbers an in-session value', () => {
    expect(shouldRestore('outside', 'inside')).toBe(false)
    expect(shouldRestore('inside', 'outside')).toBe(false)
  })

  test('ignores absent / garbage restored value even on a null slot', () => {
    expect(shouldRestore(null, null)).toBe(false)
    expect(shouldRestore(null, 'sideways')).toBe(false)
  })
})

describe('recover a crossing across a simulated cold boot', () => {
  // The bug this fixes: member is inside Scooters, the app is force-quit,
  // they leave, the app wakes and gets one fix outside the radius. Without a
  // restored prior the classifier sees null and silently re-baselines to
  // outside (kind: null) - the exit is lost. With restore it fires the exit.
  const RADIUS = 100

  test('without restore the first post-wake fix drops the exit', () => {
    // Fresh in-memory state after a cold boot: lastClassification === null.
    const r = classify(150 /* now outside */, RADIUS, null)
    expect(r.kind).toBeNull() // silent re-baseline - the lost transition
    expect(r.classification).toBe('outside')
  })

  test('with restore the first post-wake fix recovers the exit', async () => {
    const db = fakeDb()
    // Session 1: member crossed into Scooters; the flip was persisted.
    await persistClassification(db, 'c1', 'scooters', 'inside', 1)

    // Session 2 (cold boot): rebuild state, restore from disk.
    const state = { lastClassification: null }
    const restored = await readClassification(db, 'c1', 'scooters')
    if (shouldRestore(state.lastClassification, restored)) {
      state.lastClassification = restored
    }
    expect(state.lastClassification).toBe('inside')

    // Post-wake fixes are outside the radius -> recovered exit. The dwell rule
    // (bugfix/geofence-flap-hardening) needs two consecutive confirming fixes
    // before committing, so recovery costs one extra fix (~10s) but still fires.
    const first = classify(150, RADIUS, state.lastClassification, undefined, { pending: null, count: 0 })
    expect(first.kind).toBeNull() // candidate exit, not yet committed
    expect(first.classification).toBe('inside')
    const second = classify(150, RADIUS, first.classification, undefined, first.dwell)
    expect(second.kind).toBe('exit')
    expect(second.classification).toBe('outside')
  })

  test('still inside after the wake fires nothing (no spurious exit)', async () => {
    const db = fakeDb()
    await persistClassification(db, 'c1', 'scooters', 'inside', 1)
    const restored = await readClassification(db, 'c1', 'scooters')
    const r = classify(40 /* still inside */, RADIUS, restored)
    expect(r.kind).toBeNull()
    expect(r.classification).toBe('inside')
  })
})
