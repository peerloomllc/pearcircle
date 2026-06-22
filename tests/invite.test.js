const { buildInvite, parseInvite, buildSeedInvite, parseSeedInvite, NAME_MAX } = require('../src/invite')

const VALID = {
  circleId: 'A'.repeat(43),
  name: 'Smith Family',
  circleKey: 'a'.repeat(64),
  bootstrap: 'c'.repeat(64),
  inviterPublicKey: 'b'.repeat(64),
}

const VALID_ENC = 'd'.repeat(64)

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

  test('omits enc field when encryptionKey is absent', () => {
    const url = buildInvite(VALID)
    expect(url).not.toContain('enc=')
  })

  test('includes enc field when encryptionKey is provided', () => {
    const url = buildInvite({ ...VALID, encryptionKey: VALID_ENC })
    expect(url).toContain(`enc=${VALID_ENC}`)
  })

  test('throws on encryptionKey of wrong length', () => {
    expect(() => buildInvite({ ...VALID, encryptionKey: 'a'.repeat(63) })).toThrow(/encryptionKey/)
  })

  test('throws on encryptionKey with non-hex chars', () => {
    expect(() => buildInvite({ ...VALID, encryptionKey: 'z'.repeat(64) })).toThrow(/encryptionKey/)
  })

  test('accepts null encryptionKey as omitted', () => {
    const url = buildInvite({ ...VALID, encryptionKey: null })
    expect(url).not.toContain('enc=')
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

  test('round-trips an invite with encryptionKey', () => {
    const url = buildInvite({ ...VALID, encryptionKey: VALID_ENC })
    const result = parseInvite(url)
    expect(result.ok).toBe(true)
    expect(result.encryptionKey).toBe(VALID_ENC)
  })

  test('returns encryptionKey=null for legacy invites without enc', () => {
    const url = buildInvite(VALID)
    const result = parseInvite(url)
    expect(result.ok).toBe(true)
    expect(result.encryptionKey).toBe(null)
  })

  test('rejects malformed enc (wrong length)', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}&enc=${'a'.repeat(63)}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/encryptionKey/)
  })

  test('rejects malformed enc (non-hex)', () => {
    const url = `https://peerloomllc.com/circle/join?circle=${VALID.circleId}&name=Test&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}&enc=${'z'.repeat(64)}`
    const result = parseInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/encryptionKey/)
  })
})

describe('buildSeedInvite', () => {
  test('produces an https /circle/seed URL by default', () => {
    const url = buildSeedInvite(VALID)
    expect(url.startsWith('https://peerloomllc.com/circle/seed?')).toBe(true)
  })

  test('produces a pear:// /seed URL when scheme=pear', () => {
    const url = buildSeedInvite({ ...VALID, scheme: 'pear' })
    expect(url.startsWith('pear://pearcircle/seed?')).toBe(true)
  })

  test('contains every required field', () => {
    const url = buildSeedInvite(VALID)
    expect(url).toContain(`circle=${VALID.circleId}`)
    expect(url).toContain(`key=${VALID.circleKey}`)
    expect(url).toContain(`bootstrap=${VALID.bootstrap}`)
    expect(url).toContain(`inviter=${VALID.inviterPublicKey}`)
  })

  test('does not include an enc field', () => {
    const url = buildSeedInvite(VALID)
    expect(url).not.toContain('enc=')
  })

  test('throws on every malformed field', () => {
    expect(() => buildSeedInvite({ ...VALID, circleId: 'short' })).toThrow(/circleId/)
    expect(() => buildSeedInvite({ ...VALID, name: '' })).toThrow(/name/)
    expect(() => buildSeedInvite({ ...VALID, circleKey: 'z'.repeat(64) })).toThrow(/circleKey/)
    expect(() => buildSeedInvite({ ...VALID, bootstrap: 'a'.repeat(63) })).toThrow(/bootstrap/)
    expect(() => buildSeedInvite({ ...VALID, inviterPublicKey: 'g'.repeat(64) })).toThrow(/inviterPublicKey/)
    expect(() => buildSeedInvite({ ...VALID, scheme: 'ftp' })).toThrow(/scheme/)
  })
})

describe('parseSeedInvite', () => {
  test('round-trips buildSeedInvite (https)', () => {
    const url = buildSeedInvite(VALID)
    const result = parseSeedInvite(url)
    expect(result.ok).toBe(true)
    expect(result.scheme).toBe('https')
    expect(result.circleId).toBe(VALID.circleId)
    expect(result.name).toBe(VALID.name)
    expect(result.circleKey).toBe(VALID.circleKey)
    expect(result.bootstrap).toBe(VALID.bootstrap)
    expect(result.inviterPublicKey).toBe(VALID.inviterPublicKey)
  })

  test('round-trips buildSeedInvite (pear)', () => {
    const url = buildSeedInvite({ ...VALID, scheme: 'pear' })
    const result = parseSeedInvite(url)
    expect(result.ok).toBe(true)
    expect(result.scheme).toBe('pear')
  })

  test('refuses a member-shape /circle/join URL', () => {
    const memberUrl = buildInvite(VALID)
    const result = parseSeedInvite(memberUrl)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/seed invite/)
  })

  test('does not expose an encryptionKey field on the parsed result', () => {
    const url = buildSeedInvite(VALID)
    const result = parseSeedInvite(url)
    expect(result.encryptionKey).toBeUndefined()
  })

  test('rejects malformed circle param', () => {
    const url = `https://peerloomllc.com/circle/seed?circle=AAA&name=Test&key=${VALID.circleKey}&bootstrap=${VALID.bootstrap}&inviter=${VALID.inviterPublicKey}`
    const result = parseSeedInvite(url)
    expect(result.ok).toBe(false)
  })

  test('rejects missing bootstrap', () => {
    const url = `https://peerloomllc.com/circle/seed?circle=${VALID.circleId}&name=Test&key=${VALID.circleKey}&inviter=${VALID.inviterPublicKey}`
    const result = parseSeedInvite(url)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/bootstrap/)
  })

  test('rejects non-string input', () => {
    expect(parseSeedInvite(null).ok).toBe(false)
    expect(parseSeedInvite(undefined).ok).toBe(false)
    expect(parseSeedInvite(42).ok).toBe(false)
  })

  test('rejects unrecognized scheme', () => {
    const result = parseSeedInvite('http://peerloomllc.com/circle/seed?circle=' + VALID.circleId)
    expect(result.ok).toBe(false)
  })

  test('rejects wrong host', () => {
    const result = parseSeedInvite('https://evil.example.com/circle/seed?circle=' + VALID.circleId)
    expect(result.ok).toBe(false)
  })
})

// Seed-invite bundle format — proposal amendment 2026-05-19 (global
// seeder setup). A bundle is just newline-joined /circle/seed URLs;
// circle:invite:seed:all builds it and the launcher host splits it.
// No new grammar — every line independently round-trips parseSeedInvite.
describe('seed invite bundle', () => {
  const circleIds = ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)]
  const buildBundle = () => circleIds
    .map((circleId, i) => buildSeedInvite({ ...VALID, circleId, name: 'Circle ' + i }))
    .join('\n')

  test('every line round-trips through parseSeedInvite', () => {
    const bundle = buildBundle()
    const lines = bundle.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
    const parsed = lines.map((l) => parseSeedInvite(l))
    expect(parsed.every((p) => p.ok)).toBe(true)
    expect(parsed.map((p) => p.circleId)).toEqual(circleIds)
  })

  test('blank lines and trailing newline are dropped on split', () => {
    const bundle = buildBundle() + '\n\n'
    const lines = bundle.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
  })

  test('a single invite is a valid one-line bundle', () => {
    const lines = buildSeedInvite(VALID).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(parseSeedInvite(lines[0]).ok).toBe(true)
  })

  test('no bundle line carries an encryption key', () => {
    for (const line of buildBundle().split('\n')) {
      expect(line).not.toContain('enc=')
    }
  })

  // Franken-enrollment guard (bug 2026-06-22). If a whole bundle reaches
  // parseSeedInvite UNSPLIT, parseQuery's last-key-wins merges fields across
  // invites (circle A's id + circle B's bootstrap/name) into one record that
  // passes every per-field check — a silent franken enrollment.
  test('parseSeedInvite rejects a whole newline-joined bundle instead of mangling it', () => {
    const r = parseSeedInvite(buildBundle())
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/bundle/i)
  })

  test('parseSeedInvite rejects a bundle whose newlines were URL-encoded to %0A in transit', () => {
    const r = parseSeedInvite(buildBundle().replace(/\n/g, '%0A'))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/bundle/i)
  })

  test('the exact two-circle franken (A.id + B.bootstrap) is refused, not enrolled', () => {
    const a = buildSeedInvite({ ...VALID, circleId: 'A'.repeat(43), bootstrap: 'a'.repeat(64), name: 'New2' })
    const b = buildSeedInvite({ ...VALID, circleId: 'B'.repeat(43), bootstrap: 'b'.repeat(64), name: 'SeederTest' })
    // Pre-fix this returned { circleId: A, bootstrap: b, name: SeederTest }.
    expect(parseSeedInvite(a + '%0A' + b).ok).toBe(false)
    expect(parseSeedInvite(a + '\n' + b).ok).toBe(false)
  })

  test('decoding %0A then splitting recovers every invite (mirrors launcher /api/enroll)', () => {
    const transitMangled = buildBundle().replace(/\n/g, '%0A')
    const lines = transitMangled
      .replace(/%0[dD]/g, '\r')
      .replace(/%0[aA]/g, '\n')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    expect(lines).toHaveLength(3)
    const parsed = lines.map((l) => parseSeedInvite(l))
    expect(parsed.every((p) => p.ok)).toBe(true)
    expect(parsed.map((p) => p.circleId)).toEqual(circleIds)
  })
})

// Proposal 2026-06-11 follow-up: app share links and some share sheets emit a
// trailing slash before the query (".../circle/join/?circle=..."). The deep-link
// path normalizes it; pasted links hit parse directly, so parse must tolerate it.
describe('trailing-slash tolerance', () => {
  test('parseInvite accepts a join link with a trailing slash before the query', () => {
    const slashed = buildInvite({ ...VALID, encryptionKey: VALID_ENC }).replace('/join?', '/join/?')
    expect(slashed).toContain('/circle/join/?')
    const p = parseInvite(slashed)
    expect(p.ok).toBe(true)
    expect(p.circleId).toBe(VALID.circleId)
    expect(p.encryptionKey).toBe(VALID_ENC)
  })

  test('parseSeedInvite accepts a seed link with a trailing slash', () => {
    const p = parseSeedInvite(buildSeedInvite(VALID).replace('/seed?', '/seed/?'))
    expect(p.ok).toBe(true)
    expect(p.circleId).toBe(VALID.circleId)
  })

  test('the canonical no-slash form still parses', () => {
    expect(parseInvite(buildInvite(VALID)).ok).toBe(true)
    expect(parseSeedInvite(buildSeedInvite(VALID)).ok).toBe(true)
  })
})
