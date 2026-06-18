// Per-circle seeder admission protomux channel.
// Runs over the same Hyperswarm connection that carries corestore replication
// and the existing pair channel; protomux multiplexes them by protocol name.
//
// Wire: protocol 'pearcircle/seeder-admission/2', id = blake2b(bootstrap).
// Six messages, added in the same order on both sides so protomux indexes
// line up: [0] announce (seed -> member), [1] revoked (member -> seed),
// [2] lastknownCores (member -> seed), [3] writerCores (member -> seed),
// [4] admitted (member -> seed), [5] left (seed -> member). Messages are
// additive: an older peer that lacks [4]/[5] simply ignores that index, so no
// protocol-version bump is needed.
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

function setupSeederAdmissionChannel ({ conn, role, circleId, bootstrap, seederPubkey, label, version, onAnnounce, onRevoked, onAdmitted, onLeft, revokedNotice, admittedNotice, onLastknownCores, onWriterCores, mark }) {
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
  let admittedMessage = null
  let leftMessage = null

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

  // Send a { type:'admitted' } notice on this channel (member role only).
  // The explicit, durable counterpart to sendRevoked (proposal
  // 2026-06-11-seeder-readmit, T2): the seed clears its revoked flag on this
  // signal, instead of the fragile "any downloaded block clears it" heuristic
  // that cleared the revoke on the revoke's own replicated block. Sent on
  // channel open when the circle currently admits this seeder, and on demand
  // when circle:seeder:approve re-admits an already-open connection.
  //
  // Carries the admission row's updatedAt so the (blind) seed can order this
  // notice against the revoked notices it receives — the seeder row's updatedAt
  // bumps on every revoke/admit, so it is the monotonic last-writer-wins clock
  // both verdicts share. Without it, a not-yet-synced member re-asserting a
  // stale revoked/admitted on channel open could flap the seed's flag.
  function sendAdmitted (updatedAt) {
    if (role !== 'member' || !admittedMessage) return false
    try {
      admittedMessage.send({
        type: 'admitted',
        circleId,
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
      })
      trace('admission:admit-sent')
      return true
    } catch (e) {
      trace('admission:admit-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  // Send a { type:'left' } notice on this channel (seed role only). Proposal
  // 2026-06-17-seeder-leave-propagation: when the seeder operator leaves a
  // circle, it pushes this to currently-connected members BEFORE tearing down,
  // and each member writes a `left` tombstone so the seeder vanishes from their
  // Seeders list. Best-effort + content-blind (only the trusted channel id /
  // circleId, no key material). Mirrors the announce direction (seed -> member).
  function sendLeft () {
    if (role !== 'seed' || !leftMessage) return false
    try {
      leftMessage.send({ type: 'left', circleId })
      trace('admission:left-sent')
      return true
    } catch (e) {
      trace('admission:left-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  // Send the announce payload (seed role). Normally fired once on channel open;
  // also callable on demand so a re-enroll can re-announce over the SAME, still-
  // open channel without closing/recreating it (proposal 2026-06-17-seeder-leave
  // -propagation). Recreating on a persistent connection is racy — the
  // protocol+id reuse either hits create-failed or never reaches onopen — so we
  // keep the channel open across leave and just re-send this.
  function sendAnnounce () {
    if (role !== 'seed' || !announceMessage) return false
    try {
      const payload = { pubkey: seederPubkey }
      if (typeof label === 'string' && label.length > 0) payload.label = label
      // Seeder build version (proposal 2026-06-05-seeder-update slice 1), so
      // members can surface "update available". Additive + optional: an old
      // member ignores the unknown field, an old seeder simply omits it.
      if (typeof version === 'string' && version.length > 0) payload.version = version.slice(0, 64)
      announceMessage.send(payload)
      trace('admission:announce-sent')
      return true
    } catch (e) {
      trace('admission:announce-send-failed', { err: e?.message ?? String(e) })
      return false
    }
  }

  const channel = mux.createChannel({
    protocol: SEEDER_ADMISSION_PROTOCOL,
    id: channelId,
    onopen () {
      trace('admission:onopen')
      if (role === 'seed') sendAnnounce()
      // On open, push our current verdict on this seeder so its flag converges
      // even if the live revoke/admit signal was missed (e.g. re-admitted while
      // disconnected). Mutually exclusive: a seeder row is either revoked or
      // admitted. Unknown (no row / not a seeder) sends nothing.
      if (role === 'member') {
        if (revokedNotice) sendRevoked(revokedNotice.revokedAt)
        else if (admittedNotice) sendAdmitted(admittedNotice.updatedAt)
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

  // [4] admitted — member -> seed (proposal 2026-06-11-seeder-readmit, T2).
  // Explicit re-admission signal; the seed clears its revoked flag on receipt.
  // Additive after writerCores so protomux indices line up with older peers
  // (an old seed without this message simply ignores index 4; an old member
  // never sends it). circleId is the trusted channel id, never the body's.
  admittedMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      if (!msg || typeof msg !== 'object' || msg.type !== 'admitted') {
        trace('admission:admit-rejected', { reason: 'bad-shape' })
        return
      }
      const updatedAt = typeof msg.updatedAt === 'number' && Number.isFinite(msg.updatedAt)
        ? msg.updatedAt
        : null
      trace('admission:admit-received')
      try {
        // circleId is the trusted channel id, never msg.circleId.
        if (typeof onAdmitted === 'function') await onAdmitted({ circleId, updatedAt })
      } catch (e) {
        trace('admission:onadmit-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  // [5] left — seed -> member (proposal 2026-06-17-seeder-leave-propagation).
  // The seeder operator left this circle; the member writes a `left` tombstone
  // for this seeder's row so it disappears from the Seeders list. Additive
  // after admitted so protomux indices line up with older peers (an old member
  // without this message ignores index 5; an old seeder never sends it).
  // circleId is the trusted channel id, never the body's.
  leftMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'member') return
      if (!msg || typeof msg !== 'object' || msg.type !== 'left') {
        trace('admission:left-rejected', { reason: 'bad-shape' })
        return
      }
      trace('admission:left-received')
      try {
        if (typeof onLeft === 'function') await onLeft({ circleId })
      } catch (e) {
        trace('admission:onleft-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  channel.open()
  trace('admission:channel-opened')
  return { channel, sendRevoked, sendAdmitted, sendLeft, sendAnnounce, sendLastknownCores, sendWriterCores }
}

module.exports = { SEEDER_ADMISSION_PROTOCOL, setupSeederAdmissionChannel, admissionChannelId, normalizeLastknownCores, normalizeWriterCores }
