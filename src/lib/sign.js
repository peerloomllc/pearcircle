// Ed25519 sign/verify for replicated record values (proposal §5).
// canonicalize sorts object keys at every level so two devices building the
// same logical value produce byte-identical bytes to sign/verify. The `sig`
// field on the top-level object is excluded from the canonical form.
//
// Numbers use JSON.stringify's standard double representation. This is
// stable across V8/Hermes for our flat-ish value shapes (lat/lon doubles,
// integer ts/accuracy/radiusMeters, hex strings). If we ever need to sign
// arbitrary-precision numbers or large integers we'd revisit.

const { sign, verify } = require('../identity')
const b4a = require('b4a')

function canonicalize (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  const parts = []
  for (const k of keys) {
    if (value[k] === undefined) continue
    parts.push(JSON.stringify(k) + ':' + canonicalize(value[k]))
  }
  return '{' + parts.join(',') + '}'
}

function canonicalBytes (obj) {
  const { sig: _sig, ...rest } = obj
  return b4a.from(canonicalize(rest))
}

function signValue (obj, secretKey) {
  const bytes = canonicalBytes(obj)
  const sig = sign(bytes, secretKey)
  return { ...obj, sig: b4a.toString(sig, 'hex') }
}

function verifyValue (obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof obj.sig !== 'string' || obj.sig.length !== 128) return false
  if (typeof obj.pubkey !== 'string' || obj.pubkey.length !== 64) return false
  let sig, pub
  try {
    sig = b4a.from(obj.sig, 'hex')
    pub = b4a.from(obj.pubkey, 'hex')
  } catch {
    return false
  }
  if (sig.length !== 64 || pub.length !== 32) return false
  return verify(canonicalBytes(obj), sig, pub)
}

module.exports = { canonicalize, canonicalBytes, signValue, verifyValue }
