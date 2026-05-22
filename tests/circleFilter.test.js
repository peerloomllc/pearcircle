const { circleIsDeleted, memberHiddenByLeft, memberHiddenByRemoved, shouldAcceptRemovedRow } = require('../src/lib/circleFilter')

describe('circleIsDeleted', () => {
  test('null and undefined are not deleted', () => {
    expect(circleIsDeleted(null)).toBe(false)
    expect(circleIsDeleted(undefined)).toBe(false)
  })

  test('row without deleted field is alive (additive amendment)', () => {
    expect(circleIsDeleted({ id: 'c', name: 'Foo' })).toBe(false)
  })

  test('row with deleted: false is alive', () => {
    expect(circleIsDeleted({ id: 'c', name: 'Foo', deleted: false })).toBe(false)
  })

  test('row with deleted: true is the tombstone', () => {
    expect(circleIsDeleted({ id: 'c', name: 'Foo', deleted: true, deletedAt: 123 })).toBe(true)
  })

  test('truthy non-true value does not count as deleted', () => {
    expect(circleIsDeleted({ deleted: 1 })).toBe(false)
    expect(circleIsDeleted({ deleted: 'yes' })).toBe(false)
  })
})

describe('memberHiddenByLeft', () => {
  test('no leftAt means never hide', () => {
    expect(memberHiddenByLeft(null, 1000)).toBe(false)
    expect(memberHiddenByLeft(undefined, 1000)).toBe(false)
  })

  test('non-numeric leftAt means never hide', () => {
    expect(memberHiddenByLeft('1000', 500)).toBe(false)
  })

  test('member-row missing joinedAt with a left row hides', () => {
    expect(memberHiddenByLeft(1000, null)).toBe(true)
    expect(memberHiddenByLeft(1000, undefined)).toBe(true)
  })

  test('leftAt strictly newer than joinedAt hides (the leave wins)', () => {
    expect(memberHiddenByLeft(2000, 1000)).toBe(true)
  })

  test('leftAt equal to joinedAt does not hide (rejoin tied with leave shows)', () => {
    expect(memberHiddenByLeft(1000, 1000)).toBe(false)
  })

  test('leftAt older than joinedAt does not hide (rejoin wins)', () => {
    expect(memberHiddenByLeft(1000, 2000)).toBe(false)
  })
})

describe('memberHiddenByRemoved', () => {
  test('no removedAt means never hide', () => {
    expect(memberHiddenByRemoved(null, 1000)).toBe(false)
    expect(memberHiddenByRemoved(undefined, 1000)).toBe(false)
  })

  test('non-numeric removedAt means never hide', () => {
    expect(memberHiddenByRemoved('1000', 500)).toBe(false)
  })

  test('member-row missing joinedAt with a removed row hides', () => {
    expect(memberHiddenByRemoved(1000, null)).toBe(true)
    expect(memberHiddenByRemoved(1000, undefined)).toBe(true)
  })

  test('removedAt strictly newer than joinedAt hides (the kick wins)', () => {
    expect(memberHiddenByRemoved(2000, 1000)).toBe(true)
  })

  test('removedAt equal to joinedAt does not hide (rejoin tied with kick shows)', () => {
    expect(memberHiddenByRemoved(1000, 1000)).toBe(false)
  })

  test('removedAt older than joinedAt does not hide (rejoin overrides the kick)', () => {
    expect(memberHiddenByRemoved(1000, 2000)).toBe(false)
  })
})

describe('shouldAcceptRemovedRow', () => {
  const owner = 'a'.repeat(64)
  const member = 'b'.repeat(64)
  const valid = { pubkey: member, removedBy: owner, ts: 1000, v: 1 }

  test('owner-authored, well-formed row is accepted', () => {
    expect(shouldAcceptRemovedRow({
      fromHex: owner, bootstrapHex: owner, keyPubkey: member, value: valid,
    })).toBe(true)
  })

  test('non-owner author is rejected (owner-write-only)', () => {
    expect(shouldAcceptRemovedRow({
      fromHex: member, bootstrapHex: owner, keyPubkey: member, value: valid,
    })).toBe(false)
  })

  test('key suffix not matching the value pubkey is rejected', () => {
    expect(shouldAcceptRemovedRow({
      fromHex: owner, bootstrapHex: owner, keyPubkey: 'c'.repeat(64), value: valid,
    })).toBe(false)
  })

  test('missing or malformed value is rejected', () => {
    expect(shouldAcceptRemovedRow({
      fromHex: owner, bootstrapHex: owner, keyPubkey: member, value: null,
    })).toBe(false)
    expect(shouldAcceptRemovedRow({
      fromHex: owner, bootstrapHex: owner, keyPubkey: member, value: { removedBy: owner },
    })).toBe(false)
  })

  test('non-string author or bootstrap key is rejected', () => {
    expect(shouldAcceptRemovedRow({
      fromHex: null, bootstrapHex: owner, keyPubkey: member, value: valid,
    })).toBe(false)
    expect(shouldAcceptRemovedRow({
      fromHex: owner, bootstrapHex: undefined, keyPubkey: member, value: valid,
    })).toBe(false)
  })
})
