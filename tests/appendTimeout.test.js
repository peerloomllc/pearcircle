const { raceAppend, withTimeout, APPEND_TIMEOUT_MS, READ_TIMEOUT_MS } = require('../src/lib/appendTimeout')

// Proposal 2026-06-03-autobase-append-hang: a base.append() that never
// resolves must not be able to hang the caller (which would freeze the whole
// IPC dispatcher). raceAppend bounds it.

test('a never-resolving append times out instead of hanging', async () => {
  const never = new Promise(() => {}) // never settles, like the wedged base
  const r = await raceAppend(never, 20)
  expect(r).toEqual({ ok: false, timedOut: true })
})

test('a fast append resolves ok and does not time out', async () => {
  const r = await raceAppend(Promise.resolve(5), 1000)
  expect(r).toEqual({ ok: true, timedOut: false })
})

test('a rejected append reports not-ok but is NOT treated as a timeout', async () => {
  // base closed mid-flight etc. -- a transient failure, not a wedge, so it
  // must not flag the circle for repair.
  const r = await raceAppend(Promise.reject(new Error('base closed')), 1000)
  expect(r).toEqual({ ok: false, timedOut: false })
})

test('the timeout timer is cleared on the fast path (no dangling handle)', async () => {
  let cleared = 0
  const fakeSet = (fn, ms) => ({ fn, ms, id: 1 })
  const fakeClear = () => { cleared++ }
  const r = await raceAppend(Promise.resolve(), 1000, fakeSet, fakeClear)
  expect(r.ok).toBe(true)
  expect(cleared).toBe(1)
})

test('default timeout is a sane bound', () => {
  expect(APPEND_TIMEOUT_MS).toBeGreaterThanOrEqual(5000)
  expect(APPEND_TIMEOUT_MS).toBeLessThanOrEqual(30000)
})

// Proposal 2026-06-03c: reads hang too. withTimeout bounds any read
// (snapshotCircle, trips view streams) so a corrupt base can't freeze them.

test('withTimeout returns the resolved value on the fast path', async () => {
  const r = await withTimeout(Promise.resolve([1, 2, 3]), 1000)
  expect(r).toEqual({ value: [1, 2, 3], timedOut: false })
})

test('withTimeout flags a never-resolving read as timed out', async () => {
  const never = new Promise(() => {}) // a wedged view stream drain
  const r = await withTimeout(never, 20)
  expect(r).toEqual({ value: undefined, timedOut: true })
})

test('withTimeout surfaces a rejection as not-timed-out', async () => {
  const r = await withTimeout(Promise.reject(new Error('boom')), 1000)
  expect(r.timedOut).toBe(false)
  expect(r.value).toBeUndefined()
  expect(r.error).toBeInstanceOf(Error)
})

test('READ_TIMEOUT_MS is a sane, generous bound (>= append timeout)', () => {
  expect(READ_TIMEOUT_MS).toBeGreaterThanOrEqual(APPEND_TIMEOUT_MS)
  expect(READ_TIMEOUT_MS).toBeLessThanOrEqual(30000)
})
