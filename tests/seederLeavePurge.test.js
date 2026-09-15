const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { planSeederLeavePurge } = require('../src/lib/seederLeavePurge')
const { openPeerCore } = require('../src/memberLastKnown')

// A seeder leaving a circle must wipe what it mirrored for that circle, and
// nothing another enrolled circle still serves (found 2026-07-27: leave kept
// the old Hudgins circle's plaintext last-known tips on the Umbrel's disk).

describe('planSeederLeavePurge', () => {
  const base = {
    circleId: 'A',
    enrolled: [{ circleId: 'A', bootstrap: 'bootA' }, { circleId: 'B', bootstrap: 'bootB' }],
    writers: [{ circleId: 'A', coreKey: 'wA1' }, { circleId: 'B', coreKey: 'wB1' }],
    lastknown: [{ circleId: 'A', coreKey: 'lkA1' }, { circleId: 'A', coreKey: 'lkA2' }, { circleId: 'B', coreKey: 'lkB1' }],
  }

  test('clears every core this circle used and nothing from other circles', () => {
    const { clear, shared } = planSeederLeavePurge(base)
    expect(clear.sort()).toEqual(['bootA', 'lkA1', 'lkA2', 'wA1'])
    expect(shared).toEqual([])
  })

  test('keeps a core another enrolled circle still references', () => {
    const { clear, shared } = planSeederLeavePurge({
      ...base,
      // a duplicate enrollment of the same circle shares the bootstrap and a member core
      enrolled: [...base.enrolled, { circleId: 'A2', bootstrap: 'bootA' }],
      lastknown: [...base.lastknown, { circleId: 'A2', coreKey: 'lkA1' }],
    })
    expect(clear.sort()).toEqual(['lkA2', 'wA1'])
    expect(shared.sort()).toEqual(['bootA', 'lkA1'])
  })

  test('a key used twice within the leaving circle is cleared once', () => {
    const { clear } = planSeederLeavePurge({ circleId: 'A', enrolled: [{ circleId: 'A', bootstrap: 'k' }], writers: [{ circleId: 'A', coreKey: 'k' }] })
    expect(clear).toEqual(['k'])
  })

  test('ignores malformed rows and fails closed on missing input', () => {
    expect(planSeederLeavePurge({ circleId: 'A', writers: [null, { circleId: 'A' }, { circleId: 'A', coreKey: '' }] })).toEqual({ clear: [], shared: [] })
    expect(planSeederLeavePurge()).toEqual({ clear: [], shared: [] })
  })
})

describe('what the leave path relies on in hypercore', () => {
  function tmpStore () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-'))
    return path.join(dir, 's')
  }

  test('clear(0, length) removes the stored blocks, including after reopening the store', async () => {
    const dir = tmpStore()
    let store = new Corestore(dir)
    const writer = store.get({ name: 'member-core' })
    await writer.ready()
    for (let i = 0; i < 20; i++) await writer.append(b4a.from('position ' + i))
    const keyHex = b4a.toString(writer.key, 'hex')
    const core = openPeerCore(store, keyHex, null)
    await core.ready()
    expect(await core.has(0)).toBe(true)
    await core.clear(0, core.length)
    await core.close()
    await store.close()

    store = new Corestore(dir)
    const reopened = openPeerCore(store, keyHex, null)
    await reopened.ready()
    expect(reopened.length).toBe(20)
    for (let i = 0; i < 20; i++) {
      expect(await reopened.has(i)).toBe(false)
      expect(await reopened.get(i, { wait: false })).toBeNull()
    }
    await store.close()
  })

  test('Hypercore.purge() is not usable in this hypercore version', async () => {
    // If this starts passing, purge() works again and the leave path could use
    // it to drop the remaining tree metadata as well.
    const store = new Corestore(tmpStore())
    const core = store.get({ name: 'x' })
    await core.ready()
    await core.append(b4a.from('x'))
    await expect(core.purge()).rejects.toThrow()
    await store.close().catch(() => {})
  })
})
