const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { openSelfCore, openPeerCore, appendFix, readTip } = require('../src/memberLastKnown')

// Proposal 2026-06-04-lastseen-ephemeral slice 2: per-member last-known core.
// Bounded storage (append latest + clear old) and cross-store encrypted
// replication of the tip - the offline fallback that replaces the oplog write.

const ENC = b4a.alloc(32, 9).toString('hex')

function tmpStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlk-'))
  return { store: new Corestore(path.join(dir, 's')), dir }
}

test('appendFix keeps the tip readable and clears earlier blocks (bounded storage)', async () => {
  const { store } = tmpStore()
  const core = openSelfCore(store, 'circle1', ENC)
  for (let i = 0; i < 6; i++) await appendFix(core, { pubkey: 'me', ts: i, lat: i })
  expect(core.length).toBe(6)
  // earlier blocks cleared, tip retained
  expect(await core.has(0)).toBe(false)
  expect(await core.has(5)).toBe(true)
  const tip = await readTip(core)
  expect(tip).toEqual({ pubkey: 'me', ts: 5, lat: 5 })
  await store.close()
})

test('readTip returns null on an empty core', async () => {
  const { store } = tmpStore()
  const core = openSelfCore(store, 'c', ENC)
  await core.ready()
  expect(await readTip(core)).toBeNull()
  await store.close()
})

test('a peer replicates and decrypts the tip via the announced key', async () => {
  const a = tmpStore()
  const b = tmpStore()
  const coreA = openSelfCore(a.store, 'circleX', ENC)
  await appendFix(coreA, { pubkey: 'alice', ts: 42, lat: 10, lon: 20 })
  const keyHex = b4a.toString(coreA.key, 'hex')

  // Wire corestore replication between the two stores.
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)

  const coreB = openPeerCore(b.store, keyHex, ENC)
  await coreB.ready()
  await coreB.update({ wait: true })
  expect(coreB.length).toBe(1)
  await coreB.get(0) // force block download+decrypt (readTip itself is non-blocking)
  const tip = await readTip(coreB)
  expect(tip).toEqual({ pubkey: 'alice', ts: 42, lat: 10, lon: 20 })

  s1.destroy(); s2.destroy()
  await a.store.close(); await b.store.close()
})

test('openPeerCore without the enc key cannot decrypt the tip (privacy boundary)', async () => {
  const a = tmpStore()
  const b = tmpStore()
  const coreA = openSelfCore(a.store, 'circleY', ENC)
  await appendFix(coreA, { pubkey: 'bob', ts: 7 })
  const keyHex = b4a.toString(coreA.key, 'hex')
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)

  // A blind holder (no enc key, like the seeder) can replicate the block but
  // readTip yields ciphertext that does not parse as our JSON value -> null.
  const coreB = openPeerCore(b.store, keyHex, null)
  await coreB.ready()
  await coreB.update({ wait: true })
  expect(coreB.length).toBe(1)
  // Force the block local, then confirm a blind holder can't recover our value.
  try { await coreB.get(0) } catch { /* may throw on decrypt mismatch */ }
  const tip = await readTip(coreB)
  expect(tip).toBeNull()

  s1.destroy(); s2.destroy()
  await a.store.close(); await b.store.close()
})
