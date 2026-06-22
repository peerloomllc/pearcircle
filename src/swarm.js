// Hyperswarm topic derivation for PearCircle.
// Per proposals/2026-05-03-wire-protocol.md §6: topic = blake2b(circleKey).
// One topic per circle, no global discovery topic.

const sodium = require('sodium-universal')
const b4a = require('b4a')

const TOPIC_BYTES = 32

/**
 * Derive the Hyperswarm topic for a circle from its 32-byte circleKey (hex).
 * @param {string} circleKeyHex 64-char hex string
 * @returns {Buffer} 32-byte blake2b digest
 */
function topicForCircleKey (circleKeyHex) {
  if (typeof circleKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(circleKeyHex)) {
    throw new Error('circleKey must be a 64-char hex string (32 bytes)')
  }
  const seed = b4a.from(circleKeyHex, 'hex')
  const out = b4a.allocUnsafe(TOPIC_BYTES)
  sodium.crypto_generichash(out, seed)
  return out
}

// Domain-separation prefix so a seeder-pair rendezvous topic can never collide
// with a circle topic even if the random rendezvous key happens to equal some
// circleKey (circle topics are blake2b(circleKey) with no prefix).
const SEEDER_PAIR_CONTEXT = 'pearcircle/seeder-pair'

/**
 * Derive the one-time Hyperswarm rendezvous topic for a seeder-pairing session
 * from its 32-byte rendezvous key (43-char base64url, as carried in the QR).
 * topic = blake2b(SEEDER_PAIR_CONTEXT || rvBytes). Seeder QR pairing proposal
 * 2026-06-22.
 * @param {string} rvB64 43-char base64url string (32 bytes)
 * @returns {Buffer} 32-byte blake2b digest
 */
function seederPairTopic (rvB64) {
  if (typeof rvB64 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rvB64)) {
    throw new Error('rendezvous key must be a 43-char base64url string (32 bytes)')
  }
  const rv = b4a.from(rvB64 + '=', 'base64') // 43 base64url chars -> 32 bytes
  const seed = b4a.concat([b4a.from(SEEDER_PAIR_CONTEXT), rv])
  const out = b4a.allocUnsafe(TOPIC_BYTES)
  sodium.crypto_generichash(out, seed)
  return out
}

module.exports = { topicForCircleKey, seederPairTopic, SEEDER_PAIR_CONTEXT, TOPIC_BYTES }
