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

module.exports = { topicForCircleKey, TOPIC_BYTES }
