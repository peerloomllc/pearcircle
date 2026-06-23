// Seeder-pairing channel input validation (proposal 2026-06-22). The full
// handshake rides a live protomux connection and is validated on-device; here
// we cover the synchronous guards that fire before any connection is touched.

const { setupSeederPairChannel, SEEDER_PAIR_PROTOCOL } = require('../src/seederPair')

describe('setupSeederPairChannel', () => {
  const dummyConn = {} // never reached: validation throws first

  test('exposes the wire protocol id', () => {
    expect(SEEDER_PAIR_PROTOCOL).toBe('pearcircle/seeder-pair/1')
  })

  test('rejects an unknown role', () => {
    expect(() => setupSeederPairChannel({ conn: dummyConn, role: 'nope', rv: 'A'.repeat(43) }))
      .toThrow(/role/)
  })

  test('rejects a malformed rendezvous key', () => {
    expect(() => setupSeederPairChannel({ conn: dummyConn, role: 'seed', rv: 'short' })).toThrow(/rv/)
    expect(() => setupSeederPairChannel({ conn: dummyConn, role: 'member', rv: '+'.repeat(43) })).toThrow(/rv/)
    expect(() => setupSeederPairChannel({ conn: dummyConn, role: 'seed', rv: null })).toThrow(/rv/)
  })
})
