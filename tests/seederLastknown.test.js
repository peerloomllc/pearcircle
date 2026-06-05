const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { normalizeLastknownCores } = require('../src/seederAdmission')
const { openSelfCore, openPeerCore, appendFix, readTip } = require('../src/memberLastKnown')

// Proposal 2026-06-04-lastseen-ephemeral slice 2b: the blind seeder replicates
// + serves per-member last-known cores it learns over the admission channel.

const HEX64 = b4a.alloc(32, 1).toString('hex')
const HEX64_B = b4a.alloc(32, 2).toString('hex')
const ENC = b4a.alloc(32, 9).toString('hex')

function tmpStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-'))
  return new Corestore(path.join(dir, 's'))
}

describe('normalizeLastknownCores', () => {
  test('keeps well-formed entries, drops malformed ones', () => {
    const out = normalizeLastknownCores({
      cores: [
        { pubkey: HEX64, coreKey: HEX64_B },
        { pubkey: 'nothex', coreKey: HEX64_B },        // bad pubkey
        { pubkey: HEX64, coreKey: 'short' },            // bad coreKey
        { pubkey: HEX64 },                              // missing coreKey
        null,                                           // not an object
        { pubkey: HEX64_B, coreKey: HEX64 },
      ],
    })
    expect(out).toEqual([
      { pubkey: HEX64, coreKey: HEX64_B },
      { pubkey: HEX64_B, coreKey: HEX64 },
    ])
  })

  test('rejects non-array / non-object payloads', () => {
    expect(normalizeLastknownCores(null)).toBeNull()
    expect(normalizeLastknownCores({})).toBeNull()
    expect(normalizeLastknownCores({ cores: 'x' })).toBeNull()
    expect(normalizeLastknownCores({ cores: [] })).toEqual([])
  })

  test('caps the list so a peer cannot push an unbounded set', () => {
    const cores = Array.from({ length: 300 }, () => ({ pubkey: HEX64, coreKey: HEX64_B }))
    const out = normalizeLastknownCores({ cores })
    expect(out.length).toBe(256)
  })
})

// End-to-end relay: a member's tip reaches an offline-last-known reader via the
// blind seeder. member(A) --enc--> seeder(S, blind) --> reader(B, enc).
test('blind seeder relays the encrypted tip to a reader that holds the enc key', async () => {
  const a = tmpStore()   // author, has enc key
  const s = tmpStore()   // seeder, NO enc key (blind)
  const b = tmpStore()   // reader, has enc key

  const coreA = openSelfCore(a, 'circleZ', ENC)
  await appendFix(coreA, { pubkey: 'alice', ts: 100, lat: 1, lon: 2 })
  const keyHex = b4a.toString(coreA.key, 'hex')

  // A <-> S replicate; the seeder opens the core blind and pulls the tip.
  const a1 = a.replicate(true); const s1 = s.replicate(false)
  a1.pipe(s1).pipe(a1)
  const coreS = openPeerCore(s, keyHex, null) // blind: no enc key
  await coreS.ready()
  await coreS.update({ wait: true })
  await coreS.get(coreS.length - 1) // seeder downloads the (encrypted) tip block
  expect(coreS.length).toBe(1)
  expect(await readTip(coreS)).toBeNull() // seeder cannot decrypt (blind)

  // Author goes offline; reader B pulls the tip from the seeder and decrypts.
  a1.destroy(); s1.destroy()
  const s2 = s.replicate(true); const b2 = b.replicate(false)
  s2.pipe(b2).pipe(s2)
  const coreB = openPeerCore(b, keyHex, ENC)
  await coreB.ready()
  await coreB.update({ wait: true })
  await coreB.get(coreB.length - 1)
  expect(await readTip(coreB)).toEqual({ pubkey: 'alice', ts: 100, lat: 1, lon: 2 })

  s2.destroy(); b2.destroy()
  await a.close(); await s.close(); await b.close()
})
