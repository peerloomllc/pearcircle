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
const { parseSeedInvite } = require('./invite')

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
  'seeder:retention:sweep',
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
 * Enroll a single /circle/seed invite: parse, persist the
 * seeder:enrolled:{circleId} row, fire mountCircle. Idempotent — a
 * re-enroll of an already-known circle is a no-op returning
 * alreadyEnrolled:true. Shared by the seeder:enroll IPC and the
 * seeder-sync channel (proposal amendment 2026-05-20, auto-follow), so
 * both the manual paste and the auto-pushed bundle take the same path.
 *
 * @param {object} deps
 * @param {string} deps.invite - a /circle/seed invite URL
 * @param {object} deps.localDb - Hyperbee-like with get / put / del
 * @param {(enrollment: object) => Promise<void>} [deps.mountCircle]
 * @returns {{ ok, circleId, name, inviter, alreadyEnrolled }}
 */
async function enrollSeedInvite ({ invite, localDb, mountCircle }) {
  if (typeof invite !== 'string' || invite.length === 0) {
    throw new Error('invite must be a non-empty string')
  }
  const parsed = parseSeedInvite(invite)
  if (!parsed.ok) {
    throw new Error('invalid seed invite: ' + (parsed.error ?? 'unknown'))
  }
  const { circleId, name, circleKey, bootstrap, inviterPublicKey } = parsed
  const existing = await localDb.get('seeder:enrolled:' + circleId)
  if (existing?.value) {
    return {
      ok: true,
      circleId,
      name: existing.value.name ?? name,
      inviter: existing.value.inviter ?? inviterPublicKey,
      alreadyEnrolled: true,
    }
  }
  // Franken-enrollment guard (bugfix 2026-06-19). A blind seeder holds no
  // encryption key, so it cannot read the founder-written circle.id to verify
  // that the invite's circleId actually belongs to this circle — the member-side
  // inviteCircleIdMismatch check is impossible here. But every real circle has a
  // unique bootstrap (the Autobase root key), so a seed invite whose bootstrap is
  // ALREADY enrolled under a DIFFERENT circleId is always malformed: one circle's
  // id glued onto another's bootstrap. Enrolling it would mirror the same circle
  // twice under two ids (the "duplicate name, different id" symptom) and shadow
  // the real circle whose id was borrowed. Refuse it. Only reachable for a NEW
  // circleId — a legit re-enroll of the same circle returned above; a recreate
  // mints a fresh bootstrap so it never collides.
  if (typeof localDb.createReadStream === 'function') {
    for await (const { value } of localDb.createReadStream({ gt: 'seeder:enrolled:', lt: 'seeder:enrolled:~' })) {
      if (value && value.bootstrap === bootstrap && value.circleId !== circleId) {
        throw new Error(
          'franken seed invite: bootstrap already enrolled under circle ' +
          value.circleId + ' — refusing to bind it to a different circleId (' + circleId + ')'
        )
      }
    }
  }
  const row = {
    circleId,
    name,
    circleKey,
    bootstrap,
    inviter: inviterPublicKey,
    enrolledAt: Date.now(),
  }
  await localDb.put('seeder:enrolled:' + circleId, row)
  if (typeof mountCircle === 'function') {
    try {
      await mountCircle(row)
    } catch (e) {
      // Roll back so the next boot doesn't try to remount a circle the
      // host couldn't bring up. The caller retries.
      await localDb.del('seeder:enrolled:' + circleId).catch(() => {})
      throw new Error('seeder mount failed: ' + (e?.message ?? String(e)))
    }
  }
  return { ok: true, circleId, name, inviter: inviterPublicKey, alreadyEnrolled: false }
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
 * @param {(enrollment: object) => Promise<void>} [deps.mountCircle] - hook fired after
 *   seeder:enroll persists. Receives the freshly-stored enrollment row so the host
 *   can open the bootstrap Hypercore and join the swarm topic. Absent in pure-logic
 *   tests; bare.js seed-mode init provides the real implementation.
 * @param {(circleId: string) => Promise<void>} [deps.leaveCircle] - reverse of mountCircle.
 *   Called by seeder:leave before the persistence rows are deleted so the host can
 *   close the core and leave the topic without racing the persistence write.
 */
function createSeederHandlers ({ localDb, identity, bootTs = Date.now(), version = null, mountCircle, leaveCircle, getReplicatedBytes, runRetentionSweeps }) {
  const pubkeyHex = b4a.toString(identity.publicKey, 'hex')

  return {
    'seeder:status': async () => ({
      pubkey: pubkeyHex,
      // Build version stamped in by the launcher host at init (proposal
      // 2026-06-05-seeder-update slice 1); null when run without one.
      version: typeof version === 'string' && version.length > 0 ? version : null,
      uptime: Date.now() - bootTs,
      // Live tally across every mounted seeder core. The host wires the
      // getReplicatedBytes callback from its _seederCircles map; tests
      // omit it and get 0.
      totalBytesReplicated: typeof getReplicatedBytes === 'function'
        ? (await Promise.resolve(getReplicatedBytes())) || 0
        : 0,
    }),

    // Parse the /circle/seed URL, persist the enrollment row, mount the
    // circle. The shared enrollSeedInvite logic also backs the
    // seeder-sync channel's auto-follow path. Refuses member-shape
    // /circle/join URLs (parseSeedInvite rejects them).
    'seeder:enroll': async ({ invite } = {}) =>
      enrollSeedInvite({ invite, localDb, mountCircle }),

    'seeder:enrolled:list': async () => {
      // Collect enrolled rows first, then join each with its
      // seeder:revoked:{circleId} row (proposal 2026-05-21-seeder-revocation
      // -signal). Doing the revoked lookups after the enrolled range scan
      // keeps the two reads from interleaving on the same Hyperbee.
      const enrolled = []
      for await (const { value } of localDb.createReadStream({
        gt: 'seeder:enrolled:',
        lt: 'seeder:enrolled:~',
      })) {
        if (value?.circleId) enrolled.push(value)
      }
      const circles = []
      for (const value of enrolled) {
        const revokedNode = await localDb.get('seeder:revoked:' + value.circleId)
        const revoked = revokedNode?.value ?? null
        circles.push({
          circleId: value.circleId,
          name: value.name ?? '',
          inviter: value.inviter ?? null,
          enrolledAt: value.enrolledAt ?? null,
          revoked: !!revoked,
          revokedAt: revoked && typeof revoked.revokedAt === 'number' ? revoked.revokedAt : null,
        })
      }
      return { circles }
    },

    'seeder:leave': async ({ circleId } = {}) => {
      if (typeof circleId !== 'string' || circleId.length === 0) {
        throw new Error('circleId must be a non-empty string')
      }
      // Tear down the live swarm + core BEFORE deleting persistence so a
      // crash mid-leave doesn't strand the host with active sockets to a
      // circle the seeder no longer claims to track.
      if (typeof leaveCircle === 'function') {
        try { await leaveCircle(circleId) } catch (e) {
          // Best-effort: a failed teardown is logged but doesn't block the
          // persistence clear. The host's next boot won't remount this
          // circle since the enrolled row is gone.
        }
      }
      await localDb.del('seeder:enrolled:' + circleId).catch(() => {})
      await localDb.del('seeder:retention:' + circleId).catch(() => {})
      // Drop the revocation row too (proposal 2026-05-21) so a later
      // re-enroll of the same circle does not surface a stale badge.
      await localDb.del('seeder:revoked:' + circleId).catch(() => {})
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

    // Run both retention sweeps now (launcher "Run sweep now"). Applies a
    // just-changed retention policy immediately instead of waiting for the
    // 24h interval / a restart. Returns the per-sweep cleared counts.
    'seeder:retention:sweep': async () => {
      if (typeof runRetentionSweeps !== 'function') {
        throw new Error('retention sweep unavailable')
      }
      const r = await runRetentionSweeps()
      return { ok: true, ...r }
    },
  }
}

module.exports = {
  SEED_METHODS,
  detectSeedMode,
  loadOrCreateSeederIdentity,
  enrollSeedInvite,
  createSeederHandlers,
}
