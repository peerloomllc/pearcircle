const b4a = require('b4a')
const { readTipDetailed, readTipUnencrypted } = require('../src/memberLastKnown')

// Minimal stand-ins for a Hypercore session and a Corestore. The real objects
// need a store on disk and a replication partner; every rule under test here is
// about what we do with the bytes, so fakes keep it honest and fast.
function fakeCore ({ length = 1, block = null, throws = false } = {}) {
  return {
    length,
    key: b4a.alloc(32, 7),
    async ready () {},
    async close () {},
    async get () {
      if (throws) throw new Error('boom')
      return block
    },
  }
}

const FIX = { pubkey: 'a'.repeat(64), lat: 1.5, lon: -2.5, ts: 1_750_000_000_000, v: 1 }

describe('readTipDetailed', () => {
  test('parses a normal tip', async () => {
    const core = fakeCore({ block: b4a.from(JSON.stringify(FIX)) })
    const r = await readTipDetailed(core)
    expect(r.reason).toBeNull()
    expect(r.tip).toEqual(FIX)
  })

  test('distinguishes empty, absent, thrown and unparseable', async () => {
    expect((await readTipDetailed(fakeCore({ length: 0 }))).reason).toBe('empty')
    expect((await readTipDetailed(fakeCore({ block: null }))).reason).toBe('absent')
    expect((await readTipDetailed(fakeCore({ throws: true }))).reason).toBe('error')
    const garbage = b4a.from([0x2b, 0x73, 0x9f, 0x1e, 0x5f, 0x43, 0x00, 0xff])
    const r = await readTipDetailed(fakeCore({ block: garbage }))
    expect(r.reason).toBe('unparseable')
    expect(r.bytes).toBe(8)
  })

  test('does NOT try to salvage plaintext from the mangled buffer', async () => {
    // Once an encrypted session has XOR'd the body, the original is gone from
    // this buffer - the nonce came from padding hypercore already stripped.
    // Pretending otherwise would cache noise as a position.
    const mangled = b4a.from('xx{"pubkey":"' + 'a'.repeat(64) + '","ts":1}', 'utf8')
    mangled[0] = 0x00
    const r = await readTipDetailed(fakeCore({ block: mangled }))
    expect(r.reason).toBe('unparseable')
    expect(r.tip).toBeNull()
  })
})

describe('readTipUnencrypted', () => {
  const coreKeyHex = 'b'.repeat(64)

  test('reads a tip a writer published in the clear', async () => {
    // The Hudgins case: two members' tips were plain JSON on the wire.
    const store = { get: () => fakeCore({ block: b4a.from(JSON.stringify(FIX)) }) }
    expect(await readTipUnencrypted(store, coreKeyHex)).toEqual(FIX)
  })

  test('returns null rather than throwing on every failure mode', async () => {
    const cases = [
      { get: () => fakeCore({ length: 0 }) },
      { get: () => fakeCore({ block: null }) },
      { get: () => fakeCore({ throws: true }) },
      { get: () => fakeCore({ block: b4a.from([1, 2, 3]) }) },
      { get: () => { throw new Error('store exploded') } },
    ]
    for (const store of cases) {
      expect(await readTipUnencrypted(store, coreKeyHex)).toBeNull()
    }
  })

  test('rejects a non-object payload', async () => {
    // JSON.parse('42') succeeds; a number is not a fix.
    const store = { get: () => fakeCore({ block: b4a.from('42') }) }
    expect(await readTipUnencrypted(store, coreKeyHex)).toBeNull()
  })

  test('closes the extra session it opened', async () => {
    let closed = false
    const core = fakeCore({ block: b4a.from(JSON.stringify(FIX)) })
    core.close = async () => { closed = true }
    await readTipUnencrypted({ get: () => core }, coreKeyHex)
    expect(closed).toBe(true)
  })

  test('closes the session even when the read fails', async () => {
    let closed = false
    const core = fakeCore({ throws: true })
    core.close = async () => { closed = true }
    await readTipUnencrypted({ get: () => core }, coreKeyHex)
    expect(closed).toBe(true)
  })
})
