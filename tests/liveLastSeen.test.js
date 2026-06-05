const { mergeLiveLastSeen, isNewer } = require('../src/lib/liveLastSeen')

// Proposal 2026-06-04-lastseen-ephemeral phase 1: snapshotCircle overlays
// ephemeral live positions over the Autobase view, freshest ts wins, gated to
// visible members.

test('live value overrides view when newer', () => {
  const view = { alice: { pubkey: 'alice', ts: 100, lat: 1 } }
  const live = new Map([['alice', { pubkey: 'alice', ts: 200, lat: 2 }]])
  const out = mergeLiveLastSeen(view, live, new Set(['alice']))
  expect(out.alice.ts).toBe(200)
  expect(out.alice.lat).toBe(2)
})

test('view value kept when live is older', () => {
  const view = { alice: { pubkey: 'alice', ts: 500 } }
  const live = new Map([['alice', { pubkey: 'alice', ts: 200 }]])
  const out = mergeLiveLastSeen(view, live, new Set(['alice']))
  expect(out.alice.ts).toBe(500)
})

test('live fills in a member with no view row', () => {
  const view = {}
  const live = new Map([['bob', { pubkey: 'bob', ts: 10 }]])
  const out = mergeLiveLastSeen(view, live, new Set(['bob']))
  expect(out.bob.ts).toBe(10)
})

test('live for a non-allowed pubkey is dropped (left/removed member)', () => {
  const view = { alice: { pubkey: 'alice', ts: 100 } }
  const live = new Map([['ghost', { pubkey: 'ghost', ts: 999 }]])
  const out = mergeLiveLastSeen(view, live, new Set(['alice']))
  expect(out.ghost).toBeUndefined()
  expect(Object.keys(out)).toEqual(['alice'])
})

test('null allowedPubkeys overlays all live entries', () => {
  const view = {}
  const live = new Map([['a', { ts: 1 }], ['b', { ts: 2 }]])
  const out = mergeLiveLastSeen(view, live, null)
  expect(Object.keys(out).sort()).toEqual(['a', 'b'])
})

test('does not mutate the input view object', () => {
  const view = { alice: { ts: 100 } }
  const live = new Map([['alice', { ts: 200 }]])
  mergeLiveLastSeen(view, live, new Set(['alice']))
  expect(view.alice.ts).toBe(100)
})

test('no live map returns a copy of the view', () => {
  const view = { alice: { ts: 100 } }
  const out = mergeLiveLastSeen(view, null)
  expect(out).toEqual(view)
  expect(out).not.toBe(view)
})

test('isNewer: missing current always loses to candidate', () => {
  expect(isNewer({ ts: 1 }, null)).toBe(true)
  expect(isNewer({}, null)).toBe(true)
})

test('isNewer: equal ts does not replace (no flapping)', () => {
  expect(isNewer({ ts: 100 }, { ts: 100 })).toBe(false)
})
