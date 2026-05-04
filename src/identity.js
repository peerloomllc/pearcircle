// Ed25519 identity helpers. Runs inside the Bare worklet (src/bare.js).
// Do not import from app/ — the RN shell goes through IPC, not direct require.

const sodium = require('sodium-universal')

/**
 * Generate a new Ed25519 keypair.
 * @returns {{ publicKey: Buffer, secretKey: Buffer }}
 */
function generateKeypair () {
  const publicKey = Buffer.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = Buffer.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

/**
 * Sign a message with an Ed25519 secret key.
 * @param {Buffer} msg
 * @param {Buffer} secretKey 64-byte Ed25519 secret key
 * @returns {Buffer} 64-byte detached signature
 */
function sign (msg, secretKey) {
  const sig = Buffer.allocUnsafe(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, msg, secretKey)
  return sig
}

/**
 * Verify an Ed25519 detached signature.
 * @param {Buffer} msg
 * @param {Buffer} sig 64-byte signature
 * @param {Buffer} publicKey 32-byte Ed25519 public key
 * @returns {boolean}
 */
function verify (msg, sig, publicKey) {
  try {
    return sodium.crypto_sign_verify_detached(sig, msg, publicKey)
  } catch {
    return false
  }
}

module.exports = { generateKeypair, sign, verify }
