// The client-side blind-relay policy (proposal 2026-07-23-blind-relay-adoption).
// Pins the direct-first escalation, the privacy toggle and the "no key baked =
// inert" behavior, so the one option the worklet adds to Hyperswarm
// (src/bare.js, member-mode swarm) can only ever do exactly this.

const b4a = require('b4a')
const { relayThroughFor, RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z } = require('../src/lib/relay')

const KEY = b4a.alloc(32, 7) // a stand-in relay key

describe('relayThroughFor', () => {
  test('direct-first: no relay on the first attempt (not forced, not randomized)', () => {
    expect(relayThroughFor({ force: false, randomized: false, useRelay: true, relayKey: KEY })).toBe(null)
  })

  test('escalates to the relay once forced (a HOLEPUNCH_ABORTED set force=true)', () => {
    expect(relayThroughFor({ force: true, randomized: false, useRelay: true, relayKey: KEY })).toBe(KEY)
  })

  test('a double-randomized NAT relays from the first attempt (direct can never work)', () => {
    expect(relayThroughFor({ force: false, randomized: true, useRelay: true, relayKey: KEY })).toBe(KEY)
  })

  test('an undefined randomized flag is simply falsy (hyperdht may not expose it)', () => {
    expect(relayThroughFor({ force: false, randomized: undefined, useRelay: true, relayKey: KEY })).toBe(null)
  })

  test('the privacy toggle wins: useRelay=false never relays, even when forced', () => {
    expect(relayThroughFor({ force: true, randomized: true, useRelay: false, relayKey: KEY })).toBe(null)
  })

  test('no key baked = inert: never relays regardless of force/NAT/toggle', () => {
    expect(relayThroughFor({ force: true, randomized: true, useRelay: true, relayKey: null })).toBe(null)
  })
})

describe('the baked relay key', () => {
  test('is the shared PeerLoom relay and decodes to a 32-byte public key', () => {
    expect(typeof RELAY_PUBLIC_KEY_Z).toBe('string')
    expect(RELAY_PUBLIC_KEY_Z.length).toBeGreaterThan(0)
    expect(RELAY_PUBLIC_KEY.length).toBe(32)
  })

  test('matches the key PearTune deployed, so the suite shares one relay', () => {
    // Changing this means pointing PearCircle at a different relay node. If that
    // is intended, update peartune/protocol/relay.js in the same breath.
    expect(RELAY_PUBLIC_KEY_Z).toBe('qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy')
  })
})
