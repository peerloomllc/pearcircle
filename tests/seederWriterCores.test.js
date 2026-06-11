const b4a = require('b4a')
const { normalizeWriterCores } = require('../src/seederAdmission')

// Proposal 2026-05-19-blind-seeder-peers slice 3d completion: the blind seeder
// replicates every member's writer core, learned over the admission channel via
// the writerCores message. normalizeWriterCores validates that payload at the
// wire boundary. Same shape + cap as lastknownCores, kept independently tested.

const HEX64 = b4a.alloc(32, 1).toString('hex')
const HEX64_B = b4a.alloc(32, 2).toString('hex')

describe('normalizeWriterCores', () => {
  test('keeps well-formed entries, drops malformed ones', () => {
    const out = normalizeWriterCores({
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
    expect(normalizeWriterCores(null)).toBeNull()
    expect(normalizeWriterCores({})).toBeNull()
    expect(normalizeWriterCores({ cores: 'x' })).toBeNull()
    expect(normalizeWriterCores({ cores: [] })).toEqual([])
  })

  test('caps the list so a peer cannot push an unbounded set', () => {
    const cores = Array.from({ length: 300 }, () => ({ pubkey: HEX64, coreKey: HEX64_B }))
    const out = normalizeWriterCores({ cores })
    expect(out.length).toBe(256)
  })
})
