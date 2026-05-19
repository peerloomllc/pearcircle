// Seed-mode worklet primitives — proposal 2026-05-19-blind-seeder-peers slice 2.
//
// The seeder is a separate worklet entry point (running on a Pi or spare
// phone) that replicates encrypted Autobase blocks for circles it has been
// admitted to, without ever holding the encryption key. This module is the
// pure-logic core: mode detection, identity persistence, restricted IPC
// surface. Network and Autobase wiring land in slice 3 (admission protocol).
//
// Q3 resolution: seed mode is fixed at process launch. A member-mode
// worklet cannot also seed circles it is not in. Mode-detection runs
// once and is not reconfigurable.
//
// Persistence (in the same local Hyperbee that member mode uses, so a
// single device can ship either entry point without separate storage):
//   identity:seeder              — seeder Ed25519 keypair (Q2: one per device)
//   seeder:enrolled:{circleId}   — per-circle enrollment row populated by
//                                  seeder:enroll, consumed by mountSeederSwarm
//                                  in slice 3
//   seeder:retention:{circleId}  — per-circle pruneOlderThan config from
//                                  seeder:retention:set; daily sweep added
//                                  in slice 5

const b4a = require('b4a')
const { generateKeypair } = require('./identity')

// IPC methods the seed-mode worklet exposes. Anything else returns
// not-permitted-in-seed-mode so the seeder cannot accidentally act like
// a member (no lastSeen / transition / place / member / circle writes).
const SEED_METHODS = Object.freeze([
  'seeder:status',
  'seeder:enroll',
  'seeder:enrolled:list',
  'seeder:leave',
  'seeder:retention:get',
  'seeder:retention:set',
])

/**
 * Detect whether the worklet should boot in seed mode. Accepts either an
 * argv-style array (when the host runtime exposes process.argv) or an
 * options object carrying a `mode` field (when the launcher passes mode
 * via the init IPC).
 */
function detectSeedMode (input) {
  if (Array.isArray(input)) return input.includes('--seed')
  if (input && typeof input === 'object' && input.mode === 'seed') return true
  return false
}

/**
 * Load the seeder identity from the local Hyperbee, generating + persisting
 * a fresh keypair on first boot. Mirrors the member-mode identity flow but
 * stored under a separate key so a single device can host both entry points.
 *
 * @param {object} localDb - Hyperbee-like with async get / put
 * @returns {{ publicKey: Buffer, secretKey: Buffer, fresh: boolean }}
 */
async function loadOrCreateSeederIdentity (localDb) {
  const stored = await localDb.get('identity:seeder')
  if (stored?.value) {
    return {
      publicKey: b4a.from(stored.value.publicKey, 'hex'),
      secretKey: b4a.from(stored.value.secretKey, 'hex'),
      fresh: false,
    }
  }
  const keypair = generateKeypair()
  await localDb.put('identity:seeder', {
    publicKey: b4a.toString(keypair.publicKey, 'hex'),
    secretKey: b4a.toString(keypair.secretKey, 'hex'),
    createdAt: Date.now(),
  })
  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey, fresh: true }
}

/**
 * Build the seed-mode IPC handler map. Returns an object suitable for
 * direct use as the worklet's `handlers` map; all non-seed methods are
 * intentionally absent so the bare dispatcher returns its existing
 * "unknown method" error for them (no special routing needed there).
 *
 * @param {object} deps
 * @param {object} deps.localDb - Hyperbee-like with get / put / del / createReadStream
 * @param {{ publicKey: Buffer }} deps.identity - seeder identity
 * @param {number} [deps.bootTs=Date.now()] - injected for test determinism
 */
function createSeederHandlers ({ localDb, identity, bootTs = Date.now() }) {
  const pubkeyHex = b4a.toString(identity.publicKey, 'hex')

  return {
    'seeder:status': async () => ({
      pubkey: pubkeyHex,
      uptime: Date.now() - bootTs,
      // Bytes-replicated counter wires in slice 3 once the swarm is up.
      totalBytesReplicated: 0,
    }),

    // Stub: slice 3 implements seed-invite parsing + the admission
    // Protomux handshake. Slice 2 ships the IPC method shape so the
    // dispatcher recognizes it.
    'seeder:enroll': async ({ invite } = {}) => {
      if (typeof invite !== 'string' || invite.length === 0) {
        throw new Error('invite must be a non-empty string')
      }
      throw new Error('not-yet-implemented: slice 3 owns seed-invite admission')
    },

    'seeder:enrolled:list': async () => {
      const circles = []
      for await (const { value } of localDb.createReadStream({
        gt: 'seeder:enrolled:',
        lt: 'seeder:enrolled:~',
      })) {
        if (!value?.circleId) continue
        circles.push({
          circleId: value.circleId,
          name: value.name ?? '',
          inviter: value.inviter ?? null,
          enrolledAt: value.enrolledAt ?? null,
        })
      }
      return { circles }
    },

    'seeder:leave': async ({ circleId } = {}) => {
      if (typeof circleId !== 'string' || circleId.length === 0) {
        throw new Error('circleId must be a non-empty string')
      }
      await localDb.del('seeder:enrolled:' + circleId).catch(() => {})
      await localDb.del('seeder:retention:' + circleId).catch(() => {})
      return { ok: true, circleId }
    },

    'seeder:retention:get': async ({ circleId } = {}) => {
      if (typeof circleId !== 'string' || circleId.length === 0) {
        throw new Error('circleId must be a non-empty string')
      }
      const row = await localDb.get('seeder:retention:' + circleId)
      const pruneOlderThan = row?.value?.pruneOlderThan
      return { pruneOlderThan: typeof pruneOlderThan === 'number' ? pruneOlderThan : null }
    },

    'seeder:retention:set': async ({ circleId, pruneOlderThan } = {}) => {
      if (typeof circleId !== 'string' || circleId.length === 0) {
        throw new Error('circleId must be a non-empty string')
      }
      if (pruneOlderThan !== null && pruneOlderThan !== undefined) {
        if (typeof pruneOlderThan !== 'number' || !Number.isFinite(pruneOlderThan) || pruneOlderThan < 0) {
          throw new Error('pruneOlderThan must be a non-negative finite number or null')
        }
      }
      if (pruneOlderThan === null || pruneOlderThan === undefined) {
        await localDb.del('seeder:retention:' + circleId).catch(() => {})
      } else {
        await localDb.put('seeder:retention:' + circleId, {
          pruneOlderThan,
          setAt: Date.now(),
        })
      }
      return { ok: true }
    },
  }
}

module.exports = {
  SEED_METHODS,
  detectSeedMode,
  loadOrCreateSeederIdentity,
  createSeederHandlers,
}
