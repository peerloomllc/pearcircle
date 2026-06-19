const { resolveCircleName } = require('../src/lib/circleName')

// Bugfix: seed invites (and therefore the blind-seeder dashboard) read the
// stale circles:joined.name cache, so a circle renamed after join — or two
// circles whose cached names coincide — show a wrong / duplicated name on the
// seeder while the app shows the live Autobase view name. resolveCircleName is
// the shared decision both collectSeedInvites and the circles:getAll self-heal
// use: prefer the live view name, fall back to the cache.

describe('resolveCircleName', () => {
  test('prefers the live view name over the cached name (rename-after-join)', () => {
    const node = { value: { id: 'x', name: 'Beach Trip' } }
    expect(resolveCircleName('Untitled', node)).toBe('Beach Trip')
  })

  test('accepts a bare value (snapshot shape), not just a Hyperbee node', () => {
    expect(resolveCircleName('cached', { name: 'Live' })).toBe('Live')
  })

  test('falls back to the cache when the view has not replicated yet', () => {
    expect(resolveCircleName('Joined Name', null)).toBe('Joined Name')
    expect(resolveCircleName('Joined Name', undefined)).toBe('Joined Name')
    expect(resolveCircleName('Joined Name', { value: null })).toBe('Joined Name')
  })

  test('an empty / non-string view name never blanks the cache', () => {
    expect(resolveCircleName('Joined Name', { value: { name: '' } })).toBe('Joined Name')
    expect(resolveCircleName('Joined Name', { value: { name: 42 } })).toBe('Joined Name')
    expect(resolveCircleName('Joined Name', { value: {} })).toBe('Joined Name')
  })

  test('two distinct live names do not collapse to one (the duplication bug)', () => {
    const a = resolveCircleName('Shared Cache', { value: { name: 'Family' } })
    const b = resolveCircleName('Shared Cache', { value: { name: 'Work' } })
    expect(a).toBe('Family')
    expect(b).toBe('Work')
    expect(a).not.toBe(b)
  })

  test('returns null only when neither a live nor a cached name exists', () => {
    expect(resolveCircleName(undefined, null)).toBeNull()
    expect(resolveCircleName(null, { value: { name: '' } })).toBeNull()
  })
})
