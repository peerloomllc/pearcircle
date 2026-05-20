// Classifier for seeder revocation enforcement.
// Proposal 2026-05-19-blind-seeder-peers slice 3d + 2026-05-19 amendment.

const { classifySeederConnection } = require('../src/lib/seederPeerFilter')

describe('classifySeederConnection', () => {
  const remotePubkeyHex = 'a'.repeat(64)
  const otherPubkeyHex = 'b'.repeat(64)

  // Construct a getSeederRow mock from a circleId → row map.
  function mockGetter (rowsByCircle) {
    return async (circleId, pubkey) => {
      const circleMap = rowsByCircle[circleId]
      if (!circleMap) return null
      return circleMap[pubkey] ?? null
    }
  }

  test("'none' when no circles", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: [],
      getSeederRow: mockGetter({}),
    })
    expect(result).toBe('none')
  })

  test("'none' when remote is not a seeder for any circle", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1', 'c2'],
      getSeederRow: mockGetter({
        c1: { [otherPubkeyHex]: { pubkey: otherPubkeyHex, revoked: false } },
        c2: { [otherPubkeyHex]: { pubkey: otherPubkeyHex, revoked: true } },
      }),
    })
    expect(result).toBe('none')
  })

  test("'admitted' when remote has a non-revoked seeder row", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: false } },
      }),
    })
    expect(result).toBe('admitted')
  })

  test("'admitted' when revoked in one circle but still admitted in another", async () => {
    // The collateral-damage fix: a seeder revoked in c2 but live in c1/c3
    // keeps replicating — the connection serves c1 and c3.
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1', 'c2', 'c3'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: false } },
        c2: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: true } },
        c3: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: false } },
      }),
    })
    expect(result).toBe('admitted')
  })

  test("'revoked-everywhere' when every seeder row is revoked", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1', 'c2'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: true } },
        c2: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: true } },
      }),
    })
    expect(result).toBe('revoked-everywhere')
  })

  test("'revoked-everywhere' when the single seeder row is revoked", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex, revoked: true } },
      }),
    })
    expect(result).toBe('revoked-everywhere')
  })

  test("'none' on missing getSeederRow function", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: null,
    })
    expect(result).toBe('none')
  })

  test("'none' on missing remotePubkeyHex", async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex: '',
      circleIds: ['c1'],
      getSeederRow: mockGetter({}),
    })
    expect(result).toBe('none')
  })

  test('treats a missing revoked field as a live admission', async () => {
    const result = await classifySeederConnection({
      remotePubkeyHex,
      circleIds: ['c1'],
      getSeederRow: mockGetter({
        c1: { [remotePubkeyHex]: { pubkey: remotePubkeyHex } },  // no revoked field
      }),
    })
    expect(result).toBe('admitted')
  })
})
