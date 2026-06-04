const { allMembersAnnouncedCore } = require('../src/lib/lastSeenCutover')

// Proposal 2026-06-04-lastseen-ephemeral slice 3: the Autobase lastSeen write
// stops only once EVERY visible member has announced a last-known core.

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

test('all visible members announced → cutover allowed', () => {
  expect(allMembersAnnouncedCore([A, B], new Set([A, B]))).toBe(true)
})

test('a member without an announce keeps the write on (safety)', () => {
  expect(allMembersAnnouncedCore([A, B, C], new Set([A, B]))).toBe(false)
})

test('a solo upgraded member (self only) allows cutover', () => {
  expect(allMembersAnnouncedCore([A], new Set([A]))).toBe(true)
})

test('empty member set never cuts over (no one to serve, but errs safe)', () => {
  expect(allMembersAnnouncedCore([], new Set([A]))).toBe(false)
})

test('extra announces beyond the membership are harmless', () => {
  // a left/removed member still in the announce set must not affect the result
  expect(allMembersAnnouncedCore([A], new Set([A, B, C]))).toBe(true)
})

test('defensive: bad inputs err toward keep-writing', () => {
  expect(allMembersAnnouncedCore(null, new Set([A]))).toBe(false)
  expect(allMembersAnnouncedCore([A], null)).toBe(false)
  expect(allMembersAnnouncedCore([A, 123], new Set([A]))).toBe(false)
})
