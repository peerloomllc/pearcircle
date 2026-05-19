// Pure helpers for circle creation. No IPC, no Hyperbee, no swarm —
// safe to import from both the Bare worklet and unit tests in Node.
//
// circleId: 32 random bytes encoded as base64url (43 chars, no padding)
// circleKey: 32 random bytes encoded as hex (64 chars). This is the
// Hyperswarm topic seed; the swarm topic is blake2b(circleKey).

const sodium = require('sodium-universal')
const b4a = require('b4a')

function randomBytes32 () {
  const buf = b4a.allocUnsafe(32)
  sodium.randombytes_buf(buf)
  return buf
}

function toBase64url (buf) {
  return b4a.toString(buf, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function generateCircleId () {
  return toBase64url(randomBytes32())
}

function generateCircleKey () {
  return b4a.toString(randomBytes32(), 'hex')
}

// Per-circle 32-byte block-encryption key (hex). Distinct from circleKey
// (which is the swarm topic seed) so a blind seeder holding circleKey
// cannot derive encryptionKey. See proposal 2026-05-19-blind-seeder-peers
// §Design / Encryption key derivation.
function generateEncryptionKey () {
  return b4a.toString(randomBytes32(), 'hex')
}

// 16-byte hex (32 chars). Place ids are scoped within a circle's Autobase
// view; 128 bits is more than enough to avoid collisions in any practical
// circle while keeping keys short.
function generatePlaceId () {
  const buf = b4a.allocUnsafe(16)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

module.exports = { generateCircleId, generateCircleKey, generateEncryptionKey, generatePlaceId }
