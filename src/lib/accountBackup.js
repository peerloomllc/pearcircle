// Account backup file (proposal 2026-10-06-owner-continuity, part 3).
//
// One file that brings the whole account back on a fresh install: the
// identity keypair, the profile and every circle's keys. Anyone holding the
// plaintext could read every circle and act as the user, so the file is
// always sealed with a password: Argon2id (crypto_pwhash, INTERACTIVE limits,
// 64 MB) derives a key and crypto_secretbox seals the JSON.
//
// The derived key can be kept (in the shell's secure store) so auto-backup
// can seal without the password; the salt and limits ride in the file so a
// restore with the password derives the same key.

const sodium = require('sodium-universal')
const b4a = require('b4a')

const BACKUP_TYPE = 'pearcircle.account-backup'
const BACKUP_VERSION = 1
const KDF_ALG = 'argon2id13'
const MIN_PASSWORD_LENGTH = 8
// Only these fields of a circles:joined record go in the file. Local repair
// state (rebuildGen, recreate links) belongs to the old install.
const CIRCLE_FIELDS = ['circleId', 'name', 'circleKey', 'bootstrap', 'encryptionKey', 'role', 'inviterPublicKey', 'joinedAt', 'createdAt']

function checkPassword (password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error('password must be at least ' + MIN_PASSWORD_LENGTH + ' characters')
  }
}

function deriveKey (password, { salt, ops, mem }) {
  const key = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_pwhash(key, b4a.from(password, 'utf-8'), b4a.from(salt, 'hex'), ops, mem, sodium.crypto_pwhash_ALG_ARGON2ID13)
  return key
}

// A fresh key for a new password. Returns hex fields safe to store.
function newBackupKey (password) {
  checkPassword(password)
  const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  const kdf = {
    alg: KDF_ALG,
    ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    salt: b4a.toString(salt, 'hex'),
  }
  return { key: b4a.toString(deriveKey(password, kdf), 'hex'), kdf }
}

function pickCircle (record) {
  const out = {}
  for (const f of CIRCLE_FIELDS) if (record[f] !== undefined) out[f] = record[f]
  return out
}

function buildPlain ({ identity, profile, circles, now = Date.now() }) {
  return {
    type: BACKUP_TYPE,
    v: BACKUP_VERSION,
    createdAt: now,
    identity: { publicKey: identity.publicKey, secretKey: identity.secretKey },
    profile: profile ? { displayName: profile.displayName, avatar: profile.avatar } : null,
    circles: (circles || []).map(pickCircle),
  }
}

// Seal a plaintext backup with a stored key ({ key, kdf } from newBackupKey).
function sealBackup (plain, { key, kdf }) {
  const msg = b4a.from(JSON.stringify(plain), 'utf-8')
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const cipher = b4a.alloc(msg.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cipher, msg, nonce, b4a.from(key, 'hex'))
  return {
    type: BACKUP_TYPE,
    v: BACKUP_VERSION,
    encrypted: true,
    createdAt: plain.createdAt,
    kdf,
    nonce: b4a.toString(nonce, 'hex'),
    ciphertext: b4a.toString(cipher, 'base64'),
  }
}

function isHex (s, bytes) {
  return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/i.test(s)
}

function validatePlain (p) {
  if (!p || p.type !== BACKUP_TYPE || p.v !== BACKUP_VERSION) throw new Error('not a PearCircle account backup')
  if (!p.identity || !isHex(p.identity.publicKey, 32) || !isHex(p.identity.secretKey, 64)) throw new Error('backup is missing the account key')
  if (!Array.isArray(p.circles)) throw new Error('backup is missing the circle list')
  for (const c of p.circles) {
    if (!c || typeof c.circleId !== 'string' || !isHex(c.circleKey, 32) || !isHex(c.bootstrap, 32)) throw new Error('backup has a damaged circle entry')
  }
  return p
}

// Open a backup file's text with the password. Throws a user-facing message.
function openBackup (text, password) {
  let env
  try { env = typeof text === 'string' ? JSON.parse(text) : text } catch { throw new Error('this file is not a PearCircle backup') }
  if (!env || env.type !== BACKUP_TYPE) throw new Error('this file is not a PearCircle account backup')
  return validatePlain(openSealed(env, password))
}

// Decrypt a sealed envelope (any type) with the password.
function openSealed (env, password) {
  if (env.v !== BACKUP_VERSION) throw new Error('this backup was made by a newer version of PearCircle')
  if (env.encrypted !== true || !env.kdf || env.kdf.alg !== KDF_ALG) throw new Error('unsupported backup format')
  if (typeof password !== 'string' || password.length === 0) throw new Error('enter the backup password')
  const { ops, mem, salt } = env.kdf
  if (!Number.isInteger(ops) || !Number.isInteger(mem) || !isHex(salt, sodium.crypto_pwhash_SALTBYTES)) throw new Error('unsupported backup format')
  // Refuse limits far above what we write, so a crafted file can't make
  // the phone allocate gigabytes.
  if (mem > sodium.crypto_pwhash_MEMLIMIT_MODERATE || ops > sodium.crypto_pwhash_OPSLIMIT_SENSITIVE) throw new Error('unsupported backup format')
  if (!isHex(env.nonce, sodium.crypto_secretbox_NONCEBYTES) || typeof env.ciphertext !== 'string') throw new Error('unsupported backup format')
  const key = deriveKey(password, { salt, ops, mem })
  const cipher = b4a.from(env.ciphertext, 'base64')
  if (cipher.length < sodium.crypto_secretbox_MACBYTES) throw new Error('this backup is damaged')
  const msg = b4a.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(msg, cipher, b4a.from(env.nonce, 'hex'), key)) {
    throw new Error('wrong password, or the file was changed')
  }
  return JSON.parse(b4a.toString(msg, 'utf-8'))
}

// Optional password on circle export files (PR #228 files hold Place
// coordinates). Same sealing as the account backup, its own type.
const SEALED_EXPORT_TYPE = 'pearcircle.circle-export.sealed'

function sealCircleExport (exportObj, password) {
  const sealed = sealBackup({ ...exportObj, createdAt: Date.now() }, newBackupKey(password))
  return { ...sealed, type: SEALED_EXPORT_TYPE }
}

function isSealedCircleExport (obj) {
  return !!obj && obj.type === SEALED_EXPORT_TYPE
}

function openCircleExport (obj, password) {
  const plain = openSealed({ ...obj, type: BACKUP_TYPE }, password)
  delete plain.createdAt
  return plain
}

// Changes when anything in the backup would change, so auto-backup can skip
// identical rewrites. Not secret: a hash of non-key fields.
function backupFingerprint ({ identity, profile, circles }) {
  const parts = [identity?.publicKey || '', profile?.displayName || '', String((profile?.avatar || '').length)]
  for (const c of [...(circles || [])].sort((a, b) => String(a.circleId).localeCompare(String(b.circleId)))) {
    parts.push(c.circleId + ':' + (c.name || '') + ':' + (c.role || ''))
  }
  const out = b4a.alloc(16)
  sodium.crypto_generichash(out, b4a.from(parts.join('|'), 'utf-8'))
  return b4a.toString(out, 'hex')
}

module.exports = {
  BACKUP_TYPE,
  MIN_PASSWORD_LENGTH,
  checkPassword,
  newBackupKey,
  buildPlain,
  sealBackup,
  openBackup,
  backupFingerprint,
  sealCircleExport,
  isSealedCircleExport,
  openCircleExport,
}
