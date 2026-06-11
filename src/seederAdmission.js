// Per-circle seeder admission protomux channel.
// Runs over the same Hyperswarm connection that carries corestore replication
// and the existing pair channel; protomux multiplexes them by protocol name.
//
// Wire: protocol 'pearcircle/seeder-admission/1', id = utf-8(circleId).
// Four messages, added in the same order on both sides so protomux indexes
// line up: [0] announce (seed -> member), [1] revoked (member -> seed),
// [2] lastknownCores (member -> seed), [3] writerCores (member -> seed).
//
// Roles:
//   'seed'   — opened by a seed-mode worklet that has enrolled in this circle.
//              Sends one announce message on channel open carrying
//              { pubkey: seederPubkey, label?: string }. The channel stays
//              open so the member can later push a revocation notice; the
//              seed receives 'revoked' notices and calls onRevoked, and
//              'lastknownCores' lists and calls onLastknownCores.
//   'member' — opened by a member-mode worklet on a circle it participates in.
//              Receives announce, validates shape, calls onAnnounce with
//              { circleId, pubkey, label } so the host can dedupe against
//              existing seeder rows and auto-admit the seeder. When the
//              caller passes revokedNotice (the circle has revoked this
//              seeder), sends one { type:'revoked', circleId, revokedAt }
//              message on channel open. Pushes the circle's per-member
//              last-known core keys and per-member writer-core keys to the
//              (blind) seeder so it can replicate + serve them; the seeder
//              cannot read these from the encrypted view, so they travel
//              out-of-band here.
//
// Proposal 2026-05-19-blind-seeder-peers slice 3d;
// revocation notice added by proposal 2026-05-21-seeder-revocation-signal;
// lastknownCores added by proposal 2026-06-04-lastseen-ephemeral slice 2b;
// writerCores added by proposal 2026-05-19 slice 3d completion (2026-06-10).

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')
const sodium = require('sodium-universal')

// Bumped 1 -> 2 (proposal 2026-06-11-circleid-channel-binding): the channel id
// is now derived from the circle's bootstrap, not its arbitrary circleId, so a
// mislabeled circleId can't cross-pair two circles' admission channels. The id
// change alone is the version boundary; the string bump just makes it explicit.
const SEEDER_ADMISSION_PROTOCOL = 'pearcircle/seeder-admission/2'
const HEX_64 = /^[0-9a-f]{64}$/i

// Domain-separated so the admission channel id can never equal the swarm topic
// (blake2b(circleKey)) even though both use blake2b.
const ADMISSION_ID_LABEL = b4a.from('pearcircle/seeder-admission')

// Derive the per-circle admission channel id from the bootstrap (the autobase
// identity, unique per circle, known to both seed and member). blake2b, 32
// bytes, matching the topicForCircleKey primitive. Pure.
function admissionChannelId (bootstrapHex) {
  if (typeof bootstrapHex !== 'string' || !HEX_64.test(bootstrapHex)) {
    throw new Error('bootstrap must be a 64-char hex string (32 bytes)')
  }
  const out = b4a.allocUnsafe(32)
  sodium.crypto_generichash(out, b4a.concat([ADMISSION_ID_LABEL, b4a.from(bootstrapHex, 'hex')]))
  return out
}

// Validate + normalize a lastknownCores payload into a clean
// [{ pubkey, coreKey }] array (both hex64). Drops malformed entries and caps
// the count so a peer can't push an unbounded list. Pure.
const LASTKNOWN_CORES_MAX = 256
function normalizeLastknownCores (msg) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.cores)) return null
  const out = []
  for (const entry of msg.cores) {
    if (out.length >= LASTKNOWN_CORES_MAX) break
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.pubkey !== 'string' || !HEX_64.test(entry.pubkey)) continue
    if (typeof entry.coreKey !== 'string' || !HEX_64.test(entry.coreKey)) continue
    out.push({ pubkey: entry.pubkey, coreKey: entry.coreKey })
  }
  return out
}

// Validate + normalize a writerCores payload into a clean [{ pubkey, coreKey }]
// array (both hex64), where coreKey is a member's Autobase writer-core public
// key. Same shape + cap as lastknownCores; kept separate so the two surfaces
// stay independently testable. Pure. Proposal 2026-05-19 slice 3d completion.
const WRITER_CORES_MAX = 256
function normalizeWriterCores (msg) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.cores)) return null
  const out = []
  for (const entry of msg.cores) {
    if (out.length >= WRITER_CORES_MAX) break
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.pubkey !== 'string' || !HEX_64.test(entry.pubkey)) continue
    if (typeof entry.coreKey !== 'string' || !HEX_64.test(entry.coreKey)) continue
    out.push({ pubkey: entry.pubkey, coreKey: entry.coreKey })
  }
  return out
}

function setupSeederAdmissionChannel ({ conn, role, circleId, bootstrap, seederPubkey, label, version, onAnnounce, onRevoked, revokedNotice, onLastknownCores, onWriterCores, mark }) {
  if (role !== 'seed' && role !== 'member') {
    throw new Error('role must be "seed" or "member"')
  }
  // Channel id is bound to the bootstrap, not the circleId (proposal
  // 2026-06-11-circleid-channel-binding). circleId stays as a label for traces.
  const channelId = admissionChannelId(bootstrap)
  const mux = Protomux.from(conn)
  const cidShort = circleId.slice(0, 8)
  const trace = (name, extra) => {
    if (typeof mark === 'function') {
      try { mark(name, { cid: cidShort, role, ...(extra || {}) }) } catch {}
    }
  }

  let announceMessage = null
  let revokeMessage = null
  let lastknownMessage = null
  let writerMessage = null

  // Send a { cores: [{pubkey, coreKey}] } list on this channel (member role
  // only). Used for the on-open push and for re-pushes when the circle's known
  // last-known core keys change. Proposal 2026-06-04-lastseen-ephemeral 2b.
  function sendLastknownCores (cores) {
    if (role !== 'member' || !lastknownMessage) return false
    if (!Array.isArray(cores) || cores.length === 0) return false
    try {
      lastknownMessage.send({ cores })
      trace('admission:lastknown-sent', { count: cores.length })
      return true
    } catch (e) {
      trace('admission:lastknown-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  // Send a { cores: [{pubkey, coreKey}] } list of per-member writer-core keys
  // on this channel (member role only). The blind seeder opens + replicates
  // each so it mirrors every member's contributions, not just the founder's
  // bootstrap core. Re-pushed when the circle's writer set changes. Proposal
  // 2026-05-19 slice 3d completion.
  function sendWriterCores (cores) {
    if (role !== 'member' || !writerMessage) return false
    if (!Array.isArray(cores) || cores.length === 0) return false
    try {
      writerMessage.send({ cores })
      trace('admission:writer-sent', { count: cores.length })
      return true
    } catch (e) {
      trace('admission:writer-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  // Send a { type:'revoked' } notice on this channel (member role only).
  // Used both for the on-open send and for an immediate push when
  // circle:seeder:revoke fires on an already-open connection — proposal
  // 2026-05-21-seeder-revocation-signal amendment.
  function sendRevoked (revokedAt) {
    if (role !== 'member' || !revokeMessage) return false
    try {
      revokeMessage.send({
        type: 'revoked',
        circleId,
        revokedAt: typeof revokedAt === 'number' && Number.isFinite(revokedAt) ? revokedAt : null,
      })
      trace('admission:revoke-sent')
      return true
    } catch (e) {
      trace('admission:revoke-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  const channel = mux.createChannel({
    protocol: SEEDER_ADMISSION_PROTOCOL,
    id: channelId,
    onopen () {
      trace('admission:onopen')
      if (role === 'seed' && announceMessage) {
        try {
          const payload = { pubkey: seederPubkey }
          if (typeof label === 'string' && label.length > 0) payload.label = label
          // Seeder build version (proposal 2026-06-05-seeder-update slice 1), so
          // members can surface "update available". Additive + optional: an old
          // member ignores the unknown field, an old seeder simply omits it.
          if (typeof version === 'string' && version.length > 0) payload.version = version.slice(0, 64)
          announceMessage.send(payload)
          trace('admission:announce-sent')
        } catch (e) {
          trace('admission:announce-send-failed', { err: e?.message ?? String(e) })
        }
      }
      if (role === 'member' && revokedNotice) {
        sendRevoked(revokedNotice.revokedAt)
      }
      // The member pushes its last-known core keys only once the peer confirms
      // it is a seeder (its announce arrives), not blindly on open — see
      // handleSeederAnnounce in bare.js. Proposal 2026-06-04-lastseen-ephemeral 2b.
    },
    onclose () { trace('admission:onclose') },
  })
  if (!channel) {
    trace('admission:create-failed')
    return null
  }

  announceMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'member') return
      if (!msg || typeof msg !== 'object') {
        trace('admission:announce-rejected', { reason: 'not-object' })
        return
      }
      if (typeof msg.pubkey !== 'string' || !HEX_64.test(msg.pubkey)) {
        trace('admission:announce-rejected', { reason: 'bad-pubkey' })
        return
      }
      const label = typeof msg.label === 'string' ? msg.label.slice(0, 128) : null
      const version = typeof msg.version === 'string' ? msg.version.slice(0, 64) : null
      trace('admission:announce-received', { pubkey: msg.pubkey.slice(0, 8), version })
      try {
        if (typeof onAnnounce === 'function') {
          await onAnnounce({ circleId, pubkey: msg.pubkey, label, version })
        }
      } catch (e) {
        trace('admission:onannounce-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // [1] revoked — member -> seed. Advisory, UI-only (proposal 2026-05-21
  // question 1): the seed records it for the dashboard and takes no
  // automatic or network action on it.
  revokeMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      if (!msg || typeof msg !== 'object' || msg.type !== 'revoked') {
        trace('admission:revoke-rejected', { reason: 'bad-shape' })
        return
      }
      const revokedAt = typeof msg.revokedAt === 'number' && Number.isFinite(msg.revokedAt)
        ? msg.revokedAt
        : null
      trace('admission:revoke-received')
      try {
        // circleId is the trusted channel id, never msg.circleId.
        if (typeof onRevoked === 'function') await onRevoked({ circleId, revokedAt })
      } catch (e) {
        trace('admission:onrevoked-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // [2] lastknownCores — member -> seed. The blind seeder can't read the
  // encrypted view, so members hand it the per-member last-known core keys to
  // replicate + serve for offline last-known. Validated at the wire boundary;
  // circleId is the trusted channel id, never carried in the body. Proposal
  // 2026-06-04-lastseen-ephemeral slice 2b.
  lastknownMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      const cores = normalizeLastknownCores(msg)
      if (!cores || cores.length === 0) {
        trace('admission:lastknown-rejected', { reason: 'bad-shape' })
        return
      }
      trace('admission:lastknown-received', { count: cores.length })
      try {
        if (typeof onLastknownCores === 'function') await onLastknownCores({ circleId, cores })
      } catch (e) {
        trace('admission:onlastknown-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // [3] writerCores — member -> seed. The blind seeder can't enumerate the
  // circle's writers from the encrypted view, so members hand it the per-member
  // writer-core keys to replicate + serve. Without this the seeder mirrors only
  // the founder's bootstrap core. Validated at the wire boundary; circleId is
  // the trusted channel id, never carried in the body. Proposal 2026-05-19
  // slice 3d completion.
  writerMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      const cores = normalizeWriterCores(msg)
      if (!cores || cores.length === 0) {
        trace('admission:writer-rejected', { reason: 'bad-shape' })
        return
      }
      trace('admission:writer-received', { count: cores.length })
      try {
        if (typeof onWriterCores === 'function') await onWriterCores({ circleId, cores })
      } catch (e) {
        trace('admission:onwriter-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  channel.open()
  trace('admission:channel-opened')
  return { channel, sendRevoked, sendLastknownCores, sendWriterCores }
}

module.exports = { SEEDER_ADMISSION_PROTOCOL, setupSeederAdmissionChannel, admissionChannelId, normalizeLastknownCores, normalizeWriterCores }
