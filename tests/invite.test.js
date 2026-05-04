const { buildInvite, parseInvite, NAME_MAX } = require('../src/invite')

const VALID = {
  circleId: 'A'.repeat(43),
  name: 'Smith Family',
  circleKey: 'a'.repeat(64),
  bootstrap: 'c'.repeat(64),
  inviterPublicKey: 'b'.repeat(64),
}

describe('buildInvite', () => {
  test('produces an https URL by default', () => {
    const url = buildInvite(VALID)
    expect(url.startsWith('https://peerloomllc.com/circle/join?')).toBe(true)
  })

  test('produces a pear:// URL when scheme=pear', () => {
    const url = buildInvite({ ...VALID, scheme: 'pear' })
    expect(url.startsWith('pear://pearcircle/join?')).toBe(true)
  })

  test('URL-encodes the name', () => {
    const url = buildInvite({ ...VALID, name: 'Hello & World' })
    expect(url).toContain('name=Hello%20%26%20World')
  })

  test('throws on missing circleId', () => {
    expect(() => buildInvite({ ...VALID, circleId: undefined })).toThrow(/circleId/)
  })

  test('throws on circleId of wrong length', () => {
    expect(() => buildInvite({ ...VALID, circleId: 'A'.repeat(42) })).toThrow(/circleId/)
    expect(() => buildInvite({ ...VALID, circleId: 'A'.repeat(44) })).toThrow(/circleId/)
  })

  test('throws on circleId with non-base64url chars', () => {
    expect(() => buildInvite({ ...VALID, circleId: '+'.repeat(43) })).toThrow(/circleId/)
    expect(() => buildInvite({ ...VALID, circleId: '/'.repeat(43) })).toThrow(/circleId/)
  })

  test('throws on empty name', () => {
    expect(() => buildInvite({ ...VALID, name: '' })).toThrow(/name/)
  })

  test('throws on oversized name', () => {
    expect(() => buildInvite({ ...VALID, name: 'x'.repeat(NAME_MAX + 1) })).toThrow(/name/)
  })

  test('accepts name at exactly NAME_MAX length', () => {
    const url = buildInvite({ ...VALID, name: 'x'.repeat(NAME_MAX) })
    expect(typeof url).toBe('string')
  })

  test('throws on circleKey of wrong length', () => {
    expect(() => buildInvite({ ...VALID, circleKey: 'a'.repeat(63) })).toThrow(/circleKey/)
  })

  test('throws on circleKey with non-hex chars', () => {
    expect(() => buildInvite({ ...VALID, circleKey: 'g'.repeat(64) })).toThrow(/circleKey/)
  })

  test('throws on inviterPublicKey with non-hex chars', () => {
    expect(() => buildInvite({ ...VALID, inviterPublicKey: 'z'.repeat(64) })).toThrow(/inviterPublicKey/)
  })

  test('throws on missing bootstrap', () => {
    expect(() => buildInvite({ ...VALID, bootstrap: undefined })).toThrow(/bootstrap/)
  })

  test('throws on bootstrap of wrong length', () => {
    expect(() => buildInvite({ ...VALID, bootstrap: 'c'.repeat(63) })).toThrow(/bootstrap/)
  })

  test('throws on bootstrap with non-hex chars', () => {
    expect(() => buildInvite({ ...VALID, bootstrap: 'z'.repeat(64) })).toThrow(/bootstrap/)
  })

  test('throws on invalid scheme', () => {
    expect(() => buildInvite({ ...VALID, scheme: 'ftp' })).toThrow(/scheme/)
  })
})

describe('parseInvite', () => {
  test('round-trips buildInvite (https)', () => {
    const url = buildInvite(VALID)
    const result = parseInvite(url)
    expect(result.ok).toBe(true)
    expect(result.scheme).toBe('https')
    expect(result.circleId).toBe(VALID.circleId)
    expect(result.name).toBe(VALID.name)
    expect(result.circleKey).toBe(VALID.circleKey)
    expect(result.bootstrap).toBe(VALID.bootstrap)
    expect(result.inviterPublicKey).toBe(VALID.inviterPublicKey)
  })

  test('round-trips buildInvite (pear)', () => {
    const url = buildInvite({ ...VALID, scheme: 'pear' })
    const result = parseInvite(url)
    expect(result.ok).toBe(true)
    expect(result.scheme).toBe('pear')
    expect(result.circleId).toBe(VALID.circleId)
  })

  test('round-trips a name with spaces and ampersands', () => {
    const name = 'Hello & World = Test'
    const url = buildInvite({ ...VALID, name })
    const result = parseInvite(url)
    expect(result.ok).toBe(true)
    expect(result.name).toBe(name)
  })

  test('round-trips a name with unicode', () => {
    const name = 'Familia García 👨‍👩‍👧'
    const url = buildInvite({ ...VALID, name })
    const result = parseInvite(url)
    expect(result.ok).toBe(true)
    expect(result.name).toBe(name)
  })

  test('rejects non-string input', () => {
    expect(parseInvite(null).ok).toBe(false)
    expect(parseInvite(undefined).ok).toBe(false)
    expect(parseInvite(42).ok).toBe(false)
  })

  test('rejects unrecognized scheme', () => {
    const result = parseInvite('http://peerloomllc.com/circle/join?circle=' + VALID.circleId)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/PearCircle invite link/)
  })

  test('rejects wrong host', () => {
    const result = parseInvite('https://evil.example.com/circle/join?circle=' + VALID.circleId)
    expect(result.ok).toBe(false)
  })

  test('rejects wrong path', () => {
    const result = parseInvite('https://peerloomllc.com/join?circle=' + VALID.circleId)
    expect(result.ok).toBe(false)
  })

  test('rejects PearCal-style /join path on the same host', () => {
    const result = parseInvite('https://peerloomllc.com/join?circle=' + VALID.circleId)
    expect(result.ok).toBe(false)
  })

  test('rejects link with no query string', () => {
    const result = parseInvite('https://peerloomllc.com/circle/join')
    expect(result.ok).toBe(false)
  })

  test('rejects missing circle param', () => {
    const url = `https://peerloomllc.com/circle/join?name=Test&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/circleId/)
  })

  test('rejects missing key param', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/circleKey/)
  })

  test('rejects missing bootstrap param', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&key=${VALID.circleKey}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/bootstrap/)
  })

  test('rejects missing inviter param', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/inviterPublicKey/)
  })

  test('rejects missing name param', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/name/)
  })

  test('rejects malformed circle (wrong length)', () => {
    const url = `https://peerloomllc.com/circle/join?circle=AAA&name=Test&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
  })

  test('rejects malformed key (non-hex)', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&key=${'z'.repeat(64)}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
  })

  test('rejects malformed bootstrap (non-hex)', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&key=${VALID.circleKey}&bootstrap=${'z'.repeat(64)}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/bootstrap/)
  })

  test('rejects oversized name', () => {
    const longName = 'x'.repeat(NAME_MAX + 1)
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=${longName}&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
  })

  test('rejects empty name', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
  })

  test('handles malformed percent-encoding gracefully', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=%ZZ&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
  })
})
