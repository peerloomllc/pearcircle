const { circleIsDeleted, memberHiddenByLeft } = require('../src/lib/circleFilter')

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
