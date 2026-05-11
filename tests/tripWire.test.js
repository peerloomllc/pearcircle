// Tests for the pure pieces of trip replication (proposal 2026-05-10):
// apply-branch decision, sharing-gate predicate, view-layer dedup.

const {
  padTripStartTs,
  tripApplyDecision,
  shouldReplicateTrip,
  mergeTripStreams,
} = require('../src/lib/tripWire')
const { generateKeypair } = require('../src/identity')
const { signValue } = require('../src/lib/sign')
const b4a = require('b4a')

const kp = generateKeypair()
const pub = b4a.toString(kp.publicKey, 'hex')

function buildTrip (overrides = {}) {
  const base = {
    pubkey: pub,
    startTs: 1715000000000,
    endTs: 1715000600000,
    polyline: [[40.0, -73.0], [40.001, -73.001]],
    distanceMeters: 150,
    durationMs: 600000,
    maxSpeedMps: 1.2,
    v: 1,
  }
  return signValue({ ...base, ...overrides }, kp.secretKey)
}

function buildTombstone (overrides = {}) {
  const base = {
    pubkey: pub,
    startTs: 1715000000000,
    deleted: true,
    deletedAt: 1715000700000,
    v: 1,
  }
  return signValue({ ...base, ...overrides }, kp.secretKey)
}

function keyFor (pubkey, startTs) {
  return 'trip:' + pubkey + ':' + padTripStartTs(startTs)
}

const verifyValue = require('../src/lib/sign').verifyValue

describe('padTripStartTs', () => {
  test('pads ms to 13 digits for chronological prefix scans', () => {
    expect(padTripStartTs(1)).toBe('0000000000001')
    expect(padTripStartTs(1715000000000)).toBe('1715000000000')
  })
})

describe('tripApplyDecision (apply-branch rules)', () => {
  test('accepts well-formed signed original with no existing row', () => {
    const trip = buildTrip()
    const decision = tripApplyDecision(keyFor(pub, trip.startTs), trip, null, verifyValue)
    expect(decision).toBe('accept')
  })

  test('rejects when the signature does not verify', () => {
    const trip = buildTrip()
    const tampered = { ...trip, distanceMeters: 99999 }  // distanceMeters not in canonical, wait it is. Tamper polyline.
    const tampered2 = { ...trip, polyline: [[1, 1]] }
    expect(tripApplyDecision(keyFor(pub, trip.startTs), tampered2, null, verifyValue)).toBe('reject')
  })

  test('rejects when the key pubkey does not match the value pubkey', () => {
    const trip = buildTrip()
    const wrongKey = 'trip:' + 'deadbeef'.repeat(8) + ':' + padTripStartTs(trip.startTs)
    expect(tripApplyDecision(wrongKey, trip, null, verifyValue)).toBe('reject')
  })

  test('rejects when the key startTs does not match the value startTs', () => {
    const trip = buildTrip()
    const wrongTsKey = 'trip:' + pub + ':' + padTripStartTs(trip.startTs + 1)
    expect(tripApplyDecision(wrongTsKey, trip, null, verifyValue)).toBe('reject')
  })

  test('rejects when startTs is more than 5 min in the future', () => {
    const farFuture = Date.now() + 6 * 60 * 1000
    const trip = buildTrip({ startTs: farFuture })
    expect(tripApplyDecision(keyFor(pub, farFuture), trip, null, verifyValue)).toBe('reject')
  })

  test('rejects when value is missing required fields', () => {
    expect(tripApplyDecision(keyFor(pub, 1715000000000), null, null, verifyValue)).toBe('reject')
    expect(tripApplyDecision(keyFor(pub, 1715000000000), {}, null, verifyValue)).toBe('reject')
    expect(tripApplyDecision(
      keyFor(pub, 1715000000000),
      { pubkey: pub, v: 1 },
      null,
      verifyValue,
    )).toBe('reject')
  })

  test('rejects key that does not start with trip:', () => {
    const trip = buildTrip()
    expect(tripApplyDecision('lastSeen:' + pub, trip, null, verifyValue)).toBe('reject')
  })

  test('rejects malformed key (no colon after trip:)', () => {
    const trip = buildTrip()
    expect(tripApplyDecision('trip:', trip, null, verifyValue)).toBe('reject')
    expect(tripApplyDecision('trip:nokey', trip, null, verifyValue)).toBe('reject')
  })

  test('rejects overwrite of an existing original by another original (no edit)', () => {
    const original = buildTrip()
    const newOriginal = buildTrip({ distanceMeters: 200 })
    const existing = { value: original }
    expect(tripApplyDecision(keyFor(pub, original.startTs), newOriginal, existing, verifyValue)).toBe('reject')
  })

  test('accepts a delete tombstone over an existing original', () => {
    const original = buildTrip()
    const tombstone = buildTombstone({ startTs: original.startTs })
    const existing = { value: original }
    expect(tripApplyDecision(keyFor(pub, original.startTs), tombstone, existing, verifyValue)).toBe('accept')
  })

  test('rejects any write over an existing tombstone (no resurrection)', () => {
    const tombstone = buildTombstone()
    const existing = { value: tombstone }
    const tryResurrect = buildTrip()
    expect(tripApplyDecision(keyFor(pub, tryResurrect.startTs), tryResurrect, existing, verifyValue)).toBe('reject')
    const anotherTombstone = buildTombstone({ deletedAt: 1715000800000 })
    expect(tripApplyDecision(keyFor(pub, anotherTombstone.startTs), anotherTombstone, existing, verifyValue)).toBe('reject')
  })

  test('accepts tombstone arriving before original (delete wins for offline-peer order)', () => {
    const tombstone = buildTombstone()
    // No existing row yet — tombstone is the first write to land.
    expect(tripApplyDecision(keyFor(pub, tombstone.startTs), tombstone, null, verifyValue)).toBe('accept')
    // Then the original tries to land; rejected by the no-resurrection rule
    // once the tombstone is in place (asserted in the prior test).
  })
})

describe('shouldReplicateTrip (sharing-gate predicate)', () => {
  test('false when sharing row is absent', () => {
    expect(shouldReplicateTrip(null)).toBe(false)
    expect(shouldReplicateTrip(undefined)).toBe(false)
  })

  test('false when row.value is missing or enabled is not true', () => {
    expect(shouldReplicateTrip({})).toBe(false)
    expect(shouldReplicateTrip({ value: null })).toBe(false)
    expect(shouldReplicateTrip({ value: {} })).toBe(false)
    expect(shouldReplicateTrip({ value: { enabled: false } })).toBe(false)
    expect(shouldReplicateTrip({ value: { enabled: 'true' } })).toBe(false)
    expect(shouldReplicateTrip({ value: { enabled: 1 } })).toBe(false)
  })

  test('true only when enabled === true', () => {
    expect(shouldReplicateTrip({ value: { enabled: true } })).toBe(true)
    expect(shouldReplicateTrip({ value: { enabled: true, enabledAt: 123 } })).toBe(true)
  })
})

describe('mergeTripStreams (view-layer dedup by startTs)', () => {
  const a = pub
  const b = 'deadbeef'.repeat(8)

  test('returns empty when no streams', () => {
    expect(mergeTripStreams({})).toEqual([])
    expect(mergeTripStreams({ localTrips: [], circleTrips: [] })).toEqual([])
  })

  test('local-only trips pass through, sorted by startTs desc', () => {
    const t1 = { pubkey: a, startTs: 1000 }
    const t2 = { pubkey: a, startTs: 2000 }
    const merged = mergeTripStreams({ localTrips: [t1, t2] })
    expect(merged.map(t => t.startTs)).toEqual([2000, 1000])
  })

  test('same trip in two circles surfaces once', () => {
    const t = { pubkey: a, startTs: 1000 }
    const merged = mergeTripStreams({
      circleTrips: [[t], [t]],
    })
    expect(merged.length).toBe(1)
    expect(merged[0].startTs).toBe(1000)
  })

  test('distinct trips with same pubkey but different startTs are not deduped', () => {
    const t1 = { pubkey: a, startTs: 1000 }
    const t2 = { pubkey: a, startTs: 2000 }
    const merged = mergeTripStreams({ circleTrips: [[t1, t2]] })
    expect(merged.map(t => t.startTs)).toEqual([2000, 1000])
  })

  test('any tombstone wins: deleted in circle A hides the trip even if circle B still has the original', () => {
    const original = { pubkey: a, startTs: 1000 }
    const tombstone = { pubkey: a, startTs: 1000, deleted: true }
    const merged = mergeTripStreams({
      circleTrips: [[original], [tombstone]],
    })
    expect(merged).toEqual([])
  })

  test('tombstone in any circle hides the local copy too', () => {
    const localCopy = { pubkey: a, startTs: 1000 }
    const tombstone = { pubkey: a, startTs: 1000, deleted: true }
    const merged = mergeTripStreams({
      localTrips: [localCopy],
      circleTrips: [[tombstone]],
    })
    expect(merged).toEqual([])
  })

  test('trips for different pubkeys are independent', () => {
    const tA = { pubkey: a, startTs: 1000 }
    const tB = { pubkey: b, startTs: 1000 }
    const merged = mergeTripStreams({ circleTrips: [[tA, tB]] })
    expect(merged.length).toBe(2)
  })

  test('skips malformed entries (missing pubkey or startTs)', () => {
    const merged = mergeTripStreams({
      localTrips: [{ startTs: 1000 }, { pubkey: a }, null, { pubkey: a, startTs: 'oops' }],
      circleTrips: [[{ pubkey: a, startTs: 2000 }]],
    })
    expect(merged.length).toBe(1)
    expect(merged[0].startTs).toBe(2000)
  })
})
