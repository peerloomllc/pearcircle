// PearCircle — Bare worklet entry point.
// Wire protocol v1 (proposals/2026-05-03-wire-protocol.md).
// Runs inside the Bare runtime launched by BareKit. No Node.js APIs.
//
// Slices landed: identity, local circle creation, Hyperswarm topic join,
// per-circle Autobase + replication, addWriter pair flow.
//
// IPC envelope per CLAUDE.md:
//   shell → worklet: { id, method, args }
//   worklet → shell: { id, result } or { id, error }
//   worklet → shell (events): { event, data }
//
// Shell MUST send `init` with a writable dataDir before any other method.
//
// Local-only Hyperbee namespaces (never replicated):
//   identity                  — keypair (proposal §3)
//   circles:joined:{id}       — index of circles this device participates in,
//                               including the circleKey needed to rejoin the
//                               swarm topic on next launch. Implementation
//                               detail; the replicated `circle:{id}` row in
//                               the per-circle Autobase is the canonical
//                               cross-peer record.

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const Autobase = require('autobase')
const b4a = require('b4a')
const { generateKeypair } = require('./identity')
const { generateCircleId, generateCircleKey, generatePlaceId } = require('./circle')
const { buildInvite, parseInvite } = require('./invite')
const { topicForCircleKey } = require('./swarm')
const { setupPairChannel, PAIR_PROTOCOL } = require('./pair')
const Protomux = require('protomux')
const { signValue, verifyValue, verifyValueWithSigner } = require('./lib/sign')
const { shouldAcceptSeederRow } = require('./lib/seederApply')
const { circleIsDeleted, memberHiddenByLeft } = require('./lib/circleFilter')
const { haversineMeters, classify, applyRegionEvent } = require('./lib/geofence')
const { handleNetworkChange } = require('./lib/networkChange')
const { newTripState, stepTrip } = require('./lib/trip')
const { nextEmittedMode } = require('./lib/locationMode')
const { padTripStartTs, tripApplyDecision, shouldReplicateTrip, mergeTripStreams } = require('./lib/tripWire')
const { TRIP_RETENTION_MS, tripIsExpired } = require('./lib/tripRetention')

// Reject values stamped more than 5 minutes in the future against the local
// clock (proposal §5). Catches replay/forgery and clock skew on the writer.
const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000

// Avatar base64 cap. Per DECISIONS 2026-05-03 the byte-budget is ~30KB,
// which is ~40KB after base64 inflation. We leave a small headroom.
// Upper bound for any avatar payload (base64 portion only — the
// data URL prefix is free). UI enforces stricter per-format caps:
// ~150KB for static formats (256x256 JPEG) and up to this 1MB
// ceiling for animated GIF/WebP that we store raw to preserve
// animation. Generous enough that common user-picked GIFs
// (400-700KB raw → ~530-930KB base64) make it through. Defensive
// upper bound vs. malicious peers sending oversized avatars to
// blow up replication bandwidth.
const AVATAR_MAX_BASE64 = 1_000_000

// Cold-start instrumentation. _bootTs anchors all timing relative to
// the moment Bare loaded this script; mark() emits a tagged console
// line so `adb logcat | grep coldstart` reconstructs the timeline.
// See TODO.md "Investigate ~60s cold-start delay".
//
// File-tee (added phase 4 verification, 2026-05-08): on iOS the only
// way to read these markers from a remote shell is to pull a file out
// of the app container with `xcrun devicectl device copy from`, since
// `log collect --device` requires root. mark() also appends each line
// to <dataDir>/coldstart.log once init has run; pre-init marks buffer
// in memory and get flushed on the same write. The file is rewritten
// (not appended) on every cold start so the trace stays tight.
const _bootTs = Date.now()
const _coldStartLines = []
function mark (name, extra) {
  const dt = Date.now() - _bootTs
  const line = (extra !== undefined)
    ? '[coldstart worklet+' + dt + 'ms] ' + name + ' ' + JSON.stringify(extra)
    : '[coldstart worklet+' + dt + 'ms] ' + name
  console.warn(line)
  _coldStartLines.push(line)
}
mark('worklet:loaded')

const _firstPeerMarked = new Set()      // circleIds with peer:first-connected emitted
const _firstWriterMarked = new Set()    // circleIds with writer:first-added emitted
const _firstLastSeenWriteMarked = new Set()   // circleIds with our first own lastSeen write
const _firstLastSeenRemoteMarked = new Set()  // circleIds where a non-self lastSeen has applied

let _store = null
let _localDb = null
let _identity = null
let _swarm = null
let _initialized = false

const _circlePeers = new Map()    // circleId → Set<remotePublicKeyHex>
const _topicToCircle = new Map()  // topicHex → circleId
const _circleBases = new Map()    // circleId → Autobase instance
// Active Hyperswarm connections (post-handshake, pre-close). Tracked so
// circle:join can open the pair channel for a newly-added circle on
// every live connection. Hyperswarm reuses one connection per peer
// pair regardless of how many topics they share, so a connection
// established before a circle existed has no pair channel for that
// circle unless we open it explicitly post-hoc.
// Proposal 2026-05-18-pair-channel-on-circle-add.
const _activeConns = new Set()
let _selfLastSeen = null          // latest signed location for own pubkey, used by the home map's empty state
// Per-circle sharing state. circleId → { enabled, expiresAt, expiryTimer }.
// Missing entry = enabled (default-on). Persisted as one Hyperbee row per
// circle under `sharing:{circleId}`. Loaded on init; pre-2026-05-14 global
// `sharing` row is migrated and removed in loadPersistedSharing().
//
// expiresAt: ms timestamp for a time-bounded pause. While enabled is false
// and expiresAt is in the future, the worklet auto-resumes when the timer
// fires (writes a fresh `visible` presence row to that circle and clears
// the disabled entry). null expiresAt with enabled=false = indefinite mute.
const _circleSharing = new Map()
// In-process trip-detection state. Lives only in memory; if the worklet
// dies mid-trip the in-flight polyline is lost. v1 doesn't persist
// every checkpoint to disk -- the cost would dominate the budget for
// no real benefit, since the most common loss case (force-stop or OOM)
// also kills the active drive use case. See proposal-deferred slice 2
// if this ever needs to survive crashes.
let _tripState = newTripState()

// Adaptive iOS location mode (proposal 2026-05-16). When enabled, the
// worklet drives the native CLLocationManager between SLC-only ("idle")
// and SLC+continuous ("tracking") based on trip-detection phase. Flip
// to false to pin the native side at "tracking" so behavior matches
// pre-adaptive without removing the driver wiring.
const ADAPTIVE_LOCATION_MODE_ENABLED = true
let _lastAdaptiveMode = null   // null until the first emission; mirrors what the shell last received

// Suppress duplicate `transition:applied` IPC emits when autobase
// re-applies the same op (indexer reorganization on writer-add or
// fork-merge can replay previously-processed nodes). The shell already
// dedups close-in-time repeats with a 10s TTL, but re-applies can
// land minutes apart and slip through. Keyed by the autobase op key
// `transition:{ts}:{pubkey}:{placeId}` which uniquely identifies a
// single transition write. Bounded to keep memory flat over long
// sessions; eviction is FIFO-on-overflow.
const _emittedTransitionKeys = new Set()
const _EMITTED_TRANSITION_MAX = 1024
// Cross-session freshness gate. The in-session dedup above only catches
// re-applies within a single worklet run; on cold boot (or after force-
// quit), the autobase indexer replays every historical transition op
// through the apply pass and the dedup set is empty. Without this gate,
// a user who hadn't opened the app in a day would get a notification
// for every peer arrival/departure that landed during the offline
// window. Real-time crossings carry a near-now ts and are unaffected.
// 10min matches the peer-trip path's window for the same reason.
const TRANSITION_FRESHNESS_MS = 10 * 60 * 1000

// Same in-session dedup mechanism for `peerTrip:completed` emits on
// `trip:{pubkey}:{startTsPadded}` appends. Cross-session replay (e.g.
// worklet restart re-applying historical trips) is gated separately by
// the PEER_TRIP_FRESHNESS_MS window below so we don't fire days-old
// notifications on cold boot.
const _emittedPeerTripKeys = new Set()
const _EMITTED_PEER_TRIP_MAX = 1024
// Only fire a peer-trip notification when the trip ended within this
// window. Bounds the cold-boot replay problem: when the worklet starts
// and autobase re-applies a peer's entire trip history, only genuinely
// recent completions break through. 10 min matches the user-intent
// framing ("they just got home"); older trips remain in trips history,
// just don't bug anyone.
const PEER_TRIP_FRESHNESS_MS = 10 * 60 * 1000
// Don't notify on micro-trips (GPS drift across the cooldown window can
// log a "trip" with a few meters of distance). Either bound flips the
// notification on. Trip record itself is always written; this only
// gates the OS notification.
const PEER_TRIP_MIN_DISTANCE_M = 500
const PEER_TRIP_MIN_DURATION_MS = 5 * 60 * 1000

// User pref. Default on; off mutes peer-trip OS notifications entirely.
// Persisted in _localDb under `tripNotifications`; loaded on init below.
let _tripNotificationsEnabled = true

// In-process geofence state: every place across every circle, with the
// most recent inside/outside classification. checkPlaceTransitions runs
// on every location:update, computes haversine distances, and fires
// transitions when classification flips. lastClassification === null is
// the "haven't seen a location yet" state; the next observation
// establishes the baseline silently (no spurious enter on cold start).
const _circlePlaces = new Map() // "{circleId}|{placeId}" → state

function trackPlace (circleId, place) {
  const key = circleId + '|' + place.id
  const existing = _circlePlaces.get(key)
  _circlePlaces.set(key, {
    circleId,
    placeId: place.id,
    lat: place.lat,
    lon: place.lon,
    radiusMeters: place.radiusMeters,
    // Preserve classification across rename/move so we don't fire a
    // spurious enter just because the user relocated a Place.
    lastClassification: existing?.lastClassification ?? null,
  })
  schedulePushRegionsToShell()
}

function untrackPlace (circleId, placeId) {
  _circlePlaces.delete(circleId + '|' + placeId)
  schedulePushRegionsToShell()
}

// CLCircularRegion reconciliation. Apple caps each app at 20
// simultaneously-monitored regions; we send up to that many on every
// place-set change so the iOS-side OS state stays in sync. Phase 1
// picks the first 20 by insertion order; Phase 3 will rotate based on
// distance to the user once a real >20-place user complains. The
// shell side no-ops on Android until Phase 2 wires GeofencingClient.
//
// Debounced via setTimeout because trackPlace fires repeatedly during
// circle sync / initial apply -- coalescing avoids 10+ native calls
// per second while a circle hydrates.
const REGIONS_PUSH_DEBOUNCE_MS = 200
const REGIONS_HARD_CAP = 20
let _regionsPushTimer = null
function schedulePushRegionsToShell () {
  if (_regionsPushTimer) return
  _regionsPushTimer = setTimeout(() => {
    _regionsPushTimer = null
    pushRegionsToShell()
  }, REGIONS_PUSH_DEBOUNCE_MS)
}
function pushRegionsToShell () {
  const regions = []
  for (const state of _circlePlaces.values()) {
    if (regions.length >= REGIONS_HARD_CAP) break
    if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)) continue
    if (!Number.isFinite(state.radiusMeters) || state.radiusMeters <= 0) continue
    regions.push({
      // Compose circleId into the id so the shell-side enter/exit
      // handler can route back to the right autobase without an
      // extra lookup. region:enter/exit on the worklet side splits
      // this back into (circleId, placeId).
      id: state.circleId + '|' + state.placeId,
      lat: state.lat,
      lon: state.lon,
      radius: state.radiusMeters,
    })
  }
  send({ event: 'regions:set', data: { regions } })
}

// Soft-delete tombstone (proposal amended 2026-05-05). A place row
// with `deleted: true` is treated as non-existent by all consumers:
// rendering, place:list, geofence checks. Older rows without the
// field are deleted=false (additive amendment).
function isDeleted (place) {
  return place != null && place.deleted === true
}

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

const handlers = {
  'ping': async () => ({ ok: true, ts: Date.now() }),

  'app:state': async ({ state }) => ({ state }),

  // Default-network change on the device (wifi <-> cell, vpn on/off,
  // ethernet plug). The Android side debounces the burst of native
  // callbacks during a single transition; we receive one event per real
  // network identity change. Hyperswarm's prior DHT announcement is now
  // stale (announced an IP that's no longer ours) and any existing peer
  // sockets are dead until TCP keepalive eventually times them out.
  // _swarm.flush() forces a fresh announce on the current network so
  // peers can find this device again within seconds instead of waiting
  // on Hyperswarm's internal periodic re-announce. See proposal
  // 2026-05-07-network-change-handler.md.
  'network:changed': async ({ transport, netHandle } = {}) => {
    if (!_initialized) return { ok: false, reason: 'not_initialized' }
    mark('network:changed', { transport, netHandle })
    const result = await handleNetworkChange(_swarm)
    if (!result.ok && result.error) {
      console.warn('[bare] swarm.flush after network:changed failed', result.error)
    }
    return result
  },

  'identity:get': async () => {
    if (!_identity) return { publicKey: null, ready: false }
    return { publicKey: b4a.toString(_identity.publicKey, 'hex'), ready: true }
  },

  'profile:get': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const row = await _localDb.get('profile')
    return row ? row.value : null
  },

  'profile:set': async (args = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    const { displayName } = args
    if (typeof displayName !== 'string') throw new Error('displayName must be a string')
    const trimmed = displayName.trim().slice(0, 64)
    if (trimmed.length === 0) throw new Error('displayName must be non-empty')
    // avatar handling distinguishes three states:
    //   - key absent          → preserve existing avatar (PATCH-like)
    //   - key present, null   → explicit clear
    //   - key present, string → validate + set
    // The previous implementation conflated absent and null, so any name
    // update wiped the photo.
    const avatarSpecified = Object.prototype.hasOwnProperty.call(args, 'avatar')
    const avatar = args.avatar
    let avatarValue
    if (!avatarSpecified) {
      const existing = await _localDb.get('profile')
      avatarValue = existing?.value?.avatar ?? null
    } else if (avatar === null || avatar === undefined) {
      avatarValue = null
    } else if (typeof avatar !== 'string') {
      throw new Error('avatar must be a string or null')
    } else {
      // avatar: a data URL (current) or raw base64 (legacy v1 = JPEG).
      // Cap is on the BASE64 PORTION only; the prefix is free.
      const comma = avatar.indexOf(',')
      const b64Len = (avatar.startsWith('data:') && comma > 0)
        ? avatar.length - comma - 1
        : avatar.length
      if (b64Len > AVATAR_MAX_BASE64) {
        throw new Error('avatar too large; pick a smaller photo')
      }
      avatarValue = avatar
    }

    const updatedAt = Date.now()
    const profile = { displayName: trimmed, updatedAt, v: 1 }
    if (avatarValue) profile.avatar = avatarValue
    await _localDb.put('profile', profile)

    // Re-broadcast member row to every writable circle so peers see the new name + avatar.
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    let republished = 0
    for (const [, base] of _circleBases) {
      if (!base.writable) continue
      try {
        const existing = await base.view.get('member:' + ourKey)
        const joinedAt = existing?.value?.joinedAt ?? updatedAt
        const memberValue = { pubkey: ourKey, displayName: trimmed, joinedAt, v: 1 }
        if (avatarValue) memberValue.avatar = avatarValue
        await base.append({
          type: 'put',
          key: 'member:' + ourKey,
          value: memberValue,
        })
        republished++
      } catch {
        // base closed mid-flight, etc.
      }
    }
    return { ok: true, displayName: trimmed, updatedAt, republished }
  },

  'circle:create': async ({ name } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
      throw new Error('name must be a non-empty string of at most 64 chars')
    }

    const circleId = generateCircleId()
    const circleKey = generateCircleKey()
    const ownerPublicKey = b4a.toString(_identity.publicKey, 'hex')
    const createdAt = Date.now()
    const profile = await readProfileForMemberRow(ownerPublicKey)

    // Open the per-circle Autobase as the founding writer (bootstrap=null).
    // Autobase auto-generates the writer keypair under our corestore
    // namespace; base.local.key becomes the published bootstrap (proposal
    // §2 amended 2026-05-04).
    const ns = _store.namespace(circleId)
    const base = new Autobase(ns, null, {
      open: openCircleView,
      apply: (nodes, view, b) => applyCircleNodes(nodes, view, b, circleId),
      valueEncoding: 'json',
    })
    await base.ready()
    _circleBases.set(circleId, base)
    const bootstrap = b4a.toString(base.local.key, 'hex')

    // Append initial replicated records per proposal §3 schema.
    await base.append({
      type: 'put',
      key: 'circle',
      value: { id: circleId, name, ownerKey: ownerPublicKey, createdAt, v: 1 },
    })
    const ownerMember = { pubkey: ownerPublicKey, displayName: profile.displayName, joinedAt: createdAt, v: 1 }
    if (profile.avatar) ownerMember.avatar = profile.avatar
    await base.append({
      type: 'put',
      key: 'member:' + ownerPublicKey,
      value: ownerMember,
    })

    await _localDb.put('circles:joined:' + circleId, {
      circleId,
      name,
      circleKey,
      bootstrap,
      role: 'owner',
      createdAt,
    })

    const invite = buildInvite({ circleId, name, circleKey, bootstrap, inviterPublicKey: ownerPublicKey })

    joinCircleTopic(circleId, circleKey)

    return { circleId, circleKey, bootstrap, name, ownerPublicKey, createdAt, invite }
  },

  'circle:join': async ({ invite } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof invite !== 'string') throw new Error('invite must be a string')

    const parsed = parseInvite(invite)
    if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)

    const { circleId, name, circleKey, bootstrap, inviterPublicKey } = parsed

    // Idempotent: if we already have a record (owner or member), return it
    // unchanged. The owner re-scanning their own invite must not be demoted
    // to 'member', and a member re-scanning the same invite is a no-op.
    const existing = await _localDb.get('circles:joined:' + circleId)
    if (existing) return { ...existing.value, alreadyJoined: true }

    // Open the per-circle Autobase as a reader. Replication populates the
    // view once a writer connects. addWriter (slice 6E) flips writable=true.
    const ns = _store.namespace(circleId)
    const base = new Autobase(ns, b4a.from(bootstrap, 'hex'), {
      open: openCircleView,
      apply: (nodes, view, b) => applyCircleNodes(nodes, view, b, circleId),
      valueEncoding: 'json',
    })
    await base.ready()

    // Stale-invite check (proposal amendment 2026-05-07 §1). Join the
    // swarm topic briefly so we can pull the latest `circle:` row; if the
    // owner has already torn down, refuse the join with a clear error.
    // We mount the topic before checking so peers serving the deleted
    // tombstone can reach us. If the post-sync circle row carries
    // `deleted: true`, we close the autobase and clean up the namespace
    // we never persisted; nothing lingers on disk.
    //
    // discovery.flushed() drives the DHT announce + lookup synchronously
    // so the existing writer finds us (and we find them) before the
    // user dismisses the "Joining…" dialog. Without it the joiner
    // sometimes sits with no peers for tens of seconds and pre-existing
    // members appear "disconnected" until an app restart kicks the DHT.
    _circleBases.set(circleId, base)
    openPairChannelsForCircle(circleId, base)
    const discovery = joinCircleTopic(circleId, circleKey)
    if (discovery && typeof discovery.flushed === 'function') {
      try { await discovery.flushed() } catch (e) {
        console.warn('[bare] discovery.flushed during join failed', e?.message)
      }
    }
    try {
      await base.update()
    } catch (e) { console.warn('[bare] base.update during join failed', e?.message) }
    const circleRow = await base.view.get('circle')
    if (circleRow?.value?.deleted) {
      // Roll back: leave swarm, close base, clear in-memory state.
      try {
        const topic = topicForCircleKey(circleKey)
        const topicHex = b4a.toString(topic, 'hex')
        _topicToCircle.delete(topicHex)
        _swarm?.leave(topic)
      } catch {}
      try { await base.close() } catch {}
      _circleBases.delete(circleId)
      _circlePeers.delete(circleId)
      throw new Error('this circle has been deleted by the owner')
    }

    const joinedAt = Date.now()
    const record = {
      circleId,
      name,
      circleKey,
      bootstrap,
      role: 'member',
      inviterPublicKey,
      joinedAt,
    }
    await _localDb.put('circles:joined:' + circleId, record)

    return { ...record, alreadyJoined: false }
  },

  'circle:get': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    return await snapshotCircle(circleId, base)
  },

  'circles:getAll': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const out = []
    for (const [circleId, base] of _circleBases) {
      try {
        const snap = await snapshotCircle(circleId, base)
        out.push({ circleId, ...snap })
        // Maintenance: every refresh, ensure our member row exists in
        // every writable circle. Idempotent: skips if a row already
        // exists. This is the reliable path that catches cases the
        // apply-branch hook misses (timing, missed restart, etc).
        autoAppendMemberRow(circleId).catch(() => {})
      } catch (e) {
        // Surface the failure but keep going so one bad base doesn't
        // black out the whole home view.
        out.push({ circleId, error: String(e?.message ?? e) })
      }
    }
    return { circles: out, selfLastSeen: _selfLastSeen }
  },

  'circle:append:member': async ({ circleId, displayName } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')

    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    const profile = await readProfileForMemberRow(ourKey)
    const dn = (typeof displayName === 'string' && displayName.length > 0)
      ? displayName.slice(0, 64)
      : profile.displayName
    const joinedAt = Date.now()

    const memberValue = { pubkey: ourKey, displayName: dn, joinedAt, v: 1 }
    if (profile.avatar) memberValue.avatar = profile.avatar
    await base.append({
      type: 'put',
      key: 'member:' + ourKey,
      value: memberValue,
    })

    return { ok: true, pubkey: ourKey, displayName: dn, joinedAt }
  },

  'place:create': async ({ circleId, name, lat, lon, radiusMeters } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) {
      throw new Error('name must be a non-empty string of at most 64 chars')
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('lat must be in [-90, 90]')
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('lon must be in [-180, 180]')
    if (!Number.isFinite(radiusMeters) || radiusMeters < 10 || radiusMeters > 10000) {
      throw new Error('radiusMeters must be in [10, 10000]')
    }

    const id = generatePlaceId()
    const createdBy = b4a.toString(_identity.publicKey, 'hex')
    const createdAt = Date.now()
    const value = { id, name: name.trim(), lat, lon, radiusMeters, createdBy, createdAt, v: 1 }

    await base.append({ type: 'put', key: 'place:' + id, value })
    return { ok: true, place: value }
  },

  'place:update': async ({ circleId, placeId, name, radiusMeters } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof placeId !== 'string') throw new Error('placeId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) {
      throw new Error('name must be a non-empty string of at most 64 chars')
    }
    if (!Number.isFinite(radiusMeters) || radiusMeters < 10 || radiusMeters > 10000) {
      throw new Error('radiusMeters must be in [10, 10000]')
    }
    const existing = await base.view.get('place:' + placeId)
    if (!existing || !existing.value) throw new Error('place not found')
    const prev = existing.value
    // Preserve id, lat, lon, createdBy from the original. Bump
    // createdAt to now — the apply branch (proposal §4) treats
    // createdAt as the LWW timestamp, so a fresh value here wins
    // over older replicas. Original creation time is sacrificed for
    // simplicity; if we want to preserve it later, add a separate
    // updatedAt field and amend the apply rule.
    const value = {
      id: prev.id,
      name: name.trim(),
      lat: prev.lat,
      lon: prev.lon,
      radiusMeters,
      createdBy: prev.createdBy,
      createdAt: Date.now(),
      v: 1,
    }
    await base.append({ type: 'put', key: 'place:' + placeId, value })
    return { ok: true, place: value }
  },

  'place:delete': async ({ circleId, placeId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof placeId !== 'string') throw new Error('placeId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')
    const existing = await base.view.get('place:' + placeId)
    if (!existing || !existing.value) throw new Error('place not found')
    if (isDeleted(existing.value)) return { ok: true, place: existing.value }
    const prev = existing.value
    // Soft-delete tombstone: same key, deleted: true, fresh
    // createdAt + deletedAt. The apply branch's existing
    // LWW-on-createdAt rule (proposal §4) keeps this winning over
    // older replicas. Undelete is just a non-deleted write with a
    // newer createdAt.
    const now = Date.now()
    const value = {
      id: prev.id,
      name: prev.name,
      lat: prev.lat,
      lon: prev.lon,
      radiusMeters: prev.radiusMeters,
      createdBy: prev.createdBy,
      createdAt: now,
      deleted: true,
      deletedAt: now,
      v: 1,
    }
    await base.append({ type: 'put', key: 'place:' + placeId, value })
    return { ok: true, place: value }
  },

  'place:list': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    await base.update()
    const places = []
    for await (const { value } of base.view.createReadStream({ gt: 'place:', lt: 'place:~' })) {
      if (value && !isDeleted(value)) places.push(value)
    }
    return { places }
  },

  'geofence:transition': async ({ circleId, placeId, kind, lat, lon, accuracy, ts } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof placeId !== 'string') throw new Error('placeId must be a string')
    if (kind !== 'enter' && kind !== 'exit') throw new Error("kind must be 'enter' or 'exit'")
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')

    const stamp = typeof ts === 'number' ? ts : Date.now()
    if (stamp > Date.now() + FUTURE_TS_TOLERANCE_MS) {
      throw new Error('ts is too far in the future')
    }
    const transition = await appendTransition(base, placeId, kind, stamp)
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      await appendLastSeen(base, lat, lon, accuracy, stamp)
    }
    // Sync the tracked classification so the JS check doesn't fight with
    // the manual fire on the next location:update.
    const tracked = _circlePlaces.get(circleId + '|' + placeId)
    if (tracked) tracked.lastClassification = kind === 'enter' ? 'inside' : 'outside'

    return { ok: true, transition }
  },

  // Rebuild a shareable invite for a circle the local device is already
  // a member of. The persisted joined-record holds everything buildInvite
  // needs (circleId, name, circleKey, bootstrap); the inviter pubkey is
  // ours so peers know who shared it. Used by the existing-circle share
  // flow — no new state, no Hyperbee writes, just a deterministic build.
  'circle:invite': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const record = await _localDb.get('circles:joined:' + circleId)
    if (!record?.value) throw new Error('not a member of that circle')
    const { name, circleKey, bootstrap } = record.value
    const inviterPublicKey = b4a.toString(_identity.publicKey, 'hex')
    const invite = buildInvite({ circleId, name, circleKey, bootstrap, inviterPublicKey })
    return { invite, name }
  },

  // Owner-only rename. Appends a fresh `circle:` row with the new name
  // retaining the rest of the row. The apply branch already restricts
  // `circle:` to owner-write only and uses linearization order (last
  // owner-write wins by ordering, no LWW-on-createdAt needed since the
  // owner is the sole writer). createdAt stays at the original value
  // so the UI's "Created on..." semantics stay intact.
  'circle:rename': async ({ circleId, name } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof name !== 'string') throw new Error('name must be a string')
    const trimmed = name.trim().slice(0, 64)
    if (trimmed.length === 0) throw new Error('name must be non-empty')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    const ourKeyHex = b4a.toString(_identity.publicKey, 'hex')
    const circleRow = await base.view.get('circle')
    if (!circleRow?.value) throw new Error('circle metadata missing')
    if (circleRow.value.ownerKey !== ourKeyHex) {
      throw new Error('only the owner can rename this circle')
    }
    if (circleRow.value.deleted) throw new Error('this circle has been deleted')
    if (!base.writable) throw new Error('not yet a writer for this circle')
    if (circleRow.value.name === trimmed) return { ok: true, name: trimmed }
    const updated = { ...circleRow.value, name: trimmed }
    await base.append({ type: 'put', key: 'circle', value: updated })
    // Mirror the new name to the local circles:joined record so the
    // dropdown / sheets reflect the rename even before circles:getAll
    // refreshes from the autobase view.
    const localRecord = await _localDb.get('circles:joined:' + circleId).catch(() => null)
    if (localRecord?.value) {
      await _localDb.put('circles:joined:' + circleId, { ...localRecord.value, name: trimmed }).catch(() => {})
    }
    return { ok: true, name: trimmed }
  },

  // Owner-only tear-down (proposal amendment 2026-05-07 §1). Appends a
  // `circle:` row with `deleted: true, deletedAt` retaining all other
  // existing fields, waits ~2s for replication-ack to currently-connected
  // peers, then runs local teardown. Open Question #5 acknowledged: peers
  // that aren't connected during the window won't see the tombstone until
  // they next sync against an online peer that does have it (degenerate
  // case if no such peer exists). Returns immediately on local teardown
  // completion; the toast caveat lives in the UI layer.
  'circle:delete': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    const ourKeyHex = b4a.toString(_identity.publicKey, 'hex')
    const circleRow = await base.view.get('circle')
    if (!circleRow?.value) throw new Error('circle metadata missing')
    if (circleRow.value.ownerKey !== ourKeyHex) {
      throw new Error('only the owner can delete this circle')
    }
    if (circleRow.value.deleted) {
      // Idempotent: already deleted on the wire; just ensure local state
      // is gone too.
      await tearDownCircleLocally(circleId)
      return { ok: true, alreadyDeleted: true }
    }
    if (!base.writable) throw new Error('not yet a writer for this circle')
    const tombstone = {
      ...circleRow.value,
      deleted: true,
      deletedAt: Date.now(),
    }
    await base.append({ type: 'put', key: 'circle', value: tombstone })
    // Brief replication window. Peers connected via Hyperswarm pull our
    // hypercore over the duplex stream; 2s is a best-effort upper bound
    // for letting an active connection drain. We don't have a true
    // replication-ack primitive, so this is empirical (proposal §Open
    // questions #2).
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await tearDownCircleLocally(circleId)
    return { ok: true, alreadyDeleted: false }
  },

  // Voluntary self-leave (proposal amendment 2026-05-07 §2). Appends a
  // signed `left:{ourKey}` row with our identity pubkey, waits ~2s for
  // peers to pull, then runs local teardown. Owners CAN call this for
  // symmetry; the UI nudges owners toward `circle:delete` instead since
  // owner-leave abandons the circle without a tombstone (other writers
  // continue, but no future delete is possible without an active owner).
  'circle:leave': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) {
      // No autobase mounted — could be a stale local record left over
      // from a partial cleanup. Just clear local state and return.
      await tearDownCircleLocally(circleId)
      return { ok: true, alreadyLeft: true }
    }
    if (!base.writable) {
      // We were never granted writer access — our `left:` write would be
      // dropped by the apply branch. Skip the on-wire write, just remove
      // ourselves locally; peers never knew us as a writer anyway.
      await tearDownCircleLocally(circleId)
      return { ok: true, alreadyLeft: true }
    }
    const ourKeyHex = b4a.toString(_identity.publicKey, 'hex')
    const value = signValue({
      pubkey: ourKeyHex,
      leftAt: Date.now(),
      v: 1,
    }, _identity.secretKey)
    await base.append({ type: 'put', key: 'left:' + ourKeyHex, value })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await tearDownCircleLocally(circleId)
    return { ok: true, alreadyLeft: false }
  },

  // Peer-side post-notification cleanup (proposal amendment 2026-05-07).
  // Bare emits `circle:deleted` when the apply branch processes an
  // owner-tear-down tombstone; the UI shows a one-time notice and then
  // calls this to actually free local state. Splitting emission from
  // teardown gives the UI a chance to surface the message before the
  // circle disappears from the user's list.
  'circle:cleanup-deleted': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    await tearDownCircleLocally(circleId)
    return { ok: true }
  },

  'circles:list': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const circles = []
    for await (const { value } of _localDb.createReadStream({
      gt: 'circles:joined:',
      lt: 'circles:joined:~',
    })) {
      if (value) circles.push(value)
    }
    return { circles }
  },

  'circles:peers': async () => {
    const out = {}
    for (const [circleId, peers] of _circlePeers) {
      out[circleId] = Array.from(peers)
    }
    return { peers: out }
  },

  // Per-circle sharing read. With circleId: returns the explicit state
  // for that circle (defaults applied). Without: returns the full map
  // plus an `anyEnabled` summary the shell uses for FGS lifecycle.
  'sharing:get': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (circleId != null && typeof circleId !== 'string') {
      throw new Error('circleId must be a string when present')
    }
    if (typeof circleId === 'string') {
      const s = getCircleSharing(circleId)
      return { circleId, enabled: s.enabled, expiresAt: s.expiresAt }
    }
    const sharing = {}
    for (const cid of _circleBases.keys()) {
      const s = getCircleSharing(cid)
      sharing[cid] = { enabled: s.enabled, expiresAt: s.expiresAt }
    }
    return { sharing, anyEnabled: anyCircleEnabled() }
  },

  'tripNotifications:get': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    return { enabled: _tripNotificationsEnabled }
  },

  'tripNotifications:set': async ({ enabled } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean')
    await _localDb.put('tripNotifications', { enabled, setAt: Date.now() })
    _tripNotificationsEnabled = enabled
    send({ event: 'tripNotifications:changed', data: { enabled } })
    return { ok: true, enabled }
  },

  'sharing:set': async ({ circleId, enabled, expiresAt = null } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean')
    if (expiresAt != null && (typeof expiresAt !== 'number' || expiresAt <= Date.now())) {
      throw new Error('expiresAt must be a future ms timestamp')
    }
    if (!_circleBases.has(circleId)) throw new Error('unknown circleId')
    // Resume always clears any pending expiry; mute keeps the caller's
    // expiresAt (null = indefinite) and arms the auto-resume timer.
    const effectiveExpiresAt = enabled ? null : expiresAt
    await persistCircleSharing(circleId, enabled, effectiveExpiresAt)
    armCircleExpiryTimer(circleId)
    // Presence write to THIS circle only (proposal §3 / §4): a signed
    // `presence:{ourKey}` row so other members can distinguish "muted"
    // from "stale lastSeen". expiresAt rides on the row so a peer whose
    // app is running can surface a countdown, and an expired mute reads
    // as visible even if the muting peer's app died before resume.
    await writePresenceToCircle(circleId, enabled ? 'visible' : 'muted', effectiveExpiresAt)
    const anyEnabled = anyCircleEnabled()
    send({ event: 'sharing:changed', data: { circleId, enabled, expiresAt: effectiveExpiresAt, anyEnabled } })
    return { ok: true, circleId, enabled, expiresAt: effectiveExpiresAt, anyEnabled }
  },

  'location:update': async ({ lat, lon, accuracy, ts, speed, battery, isCharging } = {}) => {
    if (!_initialized) return { ok: false, reason: 'not_initialized' }
    // Per-circle sharing gate: if EVERY circle is muted, drop the update.
    // The shell-side FGS lifecycle stops the foreground service in this
    // state, but a queued native event can still slip through during the
    // wind-down window. Partial mute (some circles on, some off) falls
    // through; the per-base write loop below skips muted circles.
    if (!anyCircleEnabled()) return { ok: false, reason: 'sharing_disabled' }
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return { ok: false, reason: 'invalid_coords' }
    }
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    const stamp = typeof ts === 'number' ? ts : Date.now()
    if (stamp > Date.now() + FUTURE_TS_TOLERANCE_MS) {
      return { ok: false, reason: 'future_ts' }
    }
    const batt = (typeof battery === 'number' && battery >= 0 && battery <= 100) ? battery : null
    // Charging state is an additive optional field on lastSeen (T1).
    // Older peers without this code simply ignore the unknown key when
    // they verify+apply the signed value; UI degrades to "no bolt".
    const charging = typeof isCharging === 'boolean' ? isCharging : null
    const value = signValue({
      pubkey: ourKey,
      lat,
      lon,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      ts: stamp,
      speed: typeof speed === 'number' ? speed : null,
      battery: batt,
      isCharging: charging,
      v: 1,
    }, _identity.secretKey)
    _selfLastSeen = value

    let written = 0
    for (const [circleId, base] of _circleBases) {
      if (!base.writable) continue
      // Per-circle mute: skip writes to muted circles. Local geofence
      // classification + trip detection below still run so the user
      // sees their own arrivals/trips.
      if (!getCircleSharing(circleId).enabled) continue
      try {
        await base.append({ type: 'put', key: 'lastSeen:' + ourKey, value })
        written++
        if (!_firstLastSeenWriteMarked.has(circleId)) {
          _firstLastSeenWriteMarked.add(circleId)
          const peers = _circlePeers.get(circleId)?.size ?? 0
          mark('lastseen:first-write', { circleId, peers })
        }
      } catch {
        // base closed mid-flight, etc.
      }
    }

    // After lastSeen lands, run the JS-side geofence check. Any flips
    // produce additional transition appends (and bump lastSeen again,
    // but the second write is byte-identical so the view is unchanged).
    await checkPlaceTransitions(lat, lon, accuracy, stamp, batt, charging)

    // Trip detection: feed the speed/coord pair through the state
    // machine. A completed trip (return value's `completed` is set)
    // gets persisted to the local Hyperbee under
    // `trips:{ourKey}:{startTs}` and broadcast as a `trip:completed`
    // event so the UI / OS-notification layer can react.
    //
    // Per proposal 2026-05-10, the trip is ALSO appended to each
    // per-circle autobase when the user has opted in via the
    // `trips:sharing:{circleId}` toggle. Default is OFF (absent row =
    // sharing disabled, opt-in policy); explicit enable starts
    // future trips replicating, never resurrects past ones. Policy
    // lives in shouldReplicateTrip.
    try {
      const sp = typeof speed === 'number' ? speed : null
      const r = stepTrip(_tripState, { lat, lon, ts: stamp, speed: sp })
      _tripState = r.state
      // Adaptive iOS location mode driver. Re-evaluate desired mode on
      // every step; emit only on actual change. Shell ignores the event
      // on non-iOS platforms so it's safe to fire unconditionally.
      const nextMode = nextEmittedMode(_lastAdaptiveMode, _tripState.phase, ADAPTIVE_LOCATION_MODE_ENABLED)
      if (nextMode != null) {
        _lastAdaptiveMode = nextMode
        send({ event: 'location:mode:set', data: { mode: nextMode } })
      }
      if (r.completed) {
        const tripKey = 'trips:' + ourKey + ':' + r.completed.startTs
        const trip = {
          pubkey: ourKey,
          startTs: r.completed.startTs,
          endTs: r.completed.endTs,
          polyline: r.completed.polyline,
          distanceMeters: r.completed.distanceMeters,
          durationMs: r.completed.durationMs,
          maxSpeedMps: r.completed.maxSpeedMps ?? 0,
          v: 1,
        }
        await _localDb.put(tripKey, trip)
        send({ event: 'trip:completed', data: trip })
        replicateTripToOptedInCircles(ourKey, trip).catch((e) =>
          console.warn('[bare] trip replicate failed', e?.message),
        )
      }
    } catch (e) { console.warn('[bare] trip step failed', e?.message) }

    return { ok: true, written, pubkey: ourKey }
  },

  // CLCircularRegion enter/exit, delivered from the iOS native module
  // via the shell. id is "{circleId}|{placeId}" -- the worklet packs
  // both into a single CLRegion.identifier in pushRegionsToShell so the
  // shell can route the callback back to the right autobase without an
  // extra lookup. Phase 1 is iOS-only; Phase 2 will route Android
  // GeofencingClient through the same path.
  //
  // Dedup is via _circlePlaces[].lastClassification: if the JS
  // classifier already saw the user inside (foreground / backgrounded
  // location:update path) it will have flipped state to 'inside'; a
  // duplicate native enter is a no-op. Same for outside / exit. This
  // is correctness-critical for the case where the app was alive AND
  // iOS fired didEnterRegion -- both paths race to write the same
  // transition; the classification flip is the serialization point.
  'region:enter': async ({ id, ts } = {}) => {
    return await handleRegionEvent('enter', id, ts)
  },

  'region:exit': async ({ id, ts } = {}) => {
    return await handleRegionEvent('exit', id, ts)
  },

  'trips:list': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    const trips = []
    for await (const { value } of _localDb.createReadStream({
      gt: 'trips:' + ourKey + ':',
      lt: 'trips:' + ourKey + ':~',
    })) {
      if (value) trips.push(value)
    }
    return { trips }
  },

  // Unified trip lookup for any member, merged across the local
  // Hyperbee (if pubkey is self) and every per-circle autobase the
  // user is in. Per proposal 2026-05-10 Q4, dedup happens here via
  // mergeTripStreams so the UI gets a single chronological list with
  // any-tombstone-wins semantics. Used by TripsView for both self and
  // non-self paths.
  'trips:listFor': async ({ pubkey } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof pubkey !== 'string') throw new Error('pubkey must be a string')
    const ourKey = b4a.toString(_identity.publicKey, 'hex')

    const localTrips = []
    if (pubkey === ourKey) {
      for await (const { value } of _localDb.createReadStream({
        gt: 'trips:' + pubkey + ':',
        lt: 'trips:' + pubkey + ':~',
      })) {
        if (value) localTrips.push(value)
      }
    }

    const circleTrips = []
    for (const [, base] of _circleBases) {
      const list = []
      for await (const { value } of base.view.createReadStream({
        gt: 'trip:' + pubkey + ':',
        lt: 'trip:' + pubkey + ':~',
      })) {
        if (value) list.push(value)
      }
      if (list.length > 0) circleTrips.push(list)
    }

    return { trips: mergeTripStreams({ localTrips, circleTrips }) }
  },

  // Scan a single circle's autobase view for `trip:{pubkey}:*` rows
  // (proposal 2026-05-10). Returns deleted-tombstone rows filtered out.
  // Kept alongside trips:listFor for callers (Settings UI) that need a
  // per-circle count rather than the merged view.
  'trips:listForMember': async ({ circleId, pubkey } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof pubkey !== 'string') throw new Error('pubkey must be a string')
    const base = _circleBases.get(circleId)
    if (!base) return { trips: [] }
    const trips = []
    for await (const { value } of base.view.createReadStream({
      gt: 'trip:' + pubkey + ':',
      lt: 'trip:' + pubkey + ':~',
    })) {
      if (value && value.deleted !== true) trips.push(value)
    }
    return { trips }
  },

  // Per-circle trip-sharing toggle (proposal 2026-05-10). Local-only;
  // default on (absent row = true) so new users start sharing trips
  // with their circles unless they opt out. Toggling affects only
  // FUTURE trips — no backfill on enable, no auto-tombstone on disable.
  // The shell prompts the user to delete past shared trips separately
  // if they want a clean wipe.
  'trips:sharing:get': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (circleId != null && typeof circleId !== 'string') {
      throw new Error('circleId must be a string when present')
    }
    if (typeof circleId === 'string') {
      const row = await _localDb.get('trips:sharing:' + circleId)
      return { enabled: row?.value?.enabled === true }
    }
    // No circleId: return explicit toggles. Missing entries default
    // to disabled (opt-in) matching shouldReplicateTrip's policy
    // (proposal 2026-05-10-trip-replication).
    const map = {}
    for await (const { key, value } of _localDb.createReadStream({
      gt: 'trips:sharing:',
      lt: 'trips:sharing:~',
    })) {
      const cid = key.slice('trips:sharing:'.length)
      map[cid] = value?.enabled === true
    }
    return { sharing: map }
  },

  'trips:sharing:set': async ({ circleId, enabled } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean')
    await _localDb.put('trips:sharing:' + circleId, {
      enabled,
      enabledAt: enabled ? Date.now() : null,
      v: 1,
    })
    return { ok: true, circleId, enabled }
  },

  // Delete a trip (proposal 2026-05-10). Scope:
  //   'local'  → remove from local Hyperbee only; replicated copies survive
  //   'circle' → write soft-delete tombstone to every per-circle autobase
  //              currently holding this trip; leave local Hyperbee intact
  //   'all'    → both of the above
  // Tombstone shape: signed value with deleted:true, deletedAt:now, no
  // polyline (polyline is omitted on the wire so the data is actually
  // wiped from receivers' views).
  'trips:delete': async ({ startTs, scope = 'all' } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof startTs !== 'number') throw new Error('startTs must be a number')
    if (scope !== 'local' && scope !== 'circle' && scope !== 'all') {
      throw new Error("scope must be 'local', 'circle', or 'all'")
    }
    const ourKey = b4a.toString(_identity.publicKey, 'hex')

    if (scope === 'local' || scope === 'all') {
      await _localDb.del('trips:' + ourKey + ':' + startTs)
    }

    let circlesTombstoned = 0
    if (scope === 'circle' || scope === 'all') {
      const tombstone = signValue({
        pubkey: ourKey,
        startTs,
        deleted: true,
        deletedAt: Date.now(),
        v: 1,
      }, _identity.secretKey)
      const replicatedKey = 'trip:' + ourKey + ':' + padTripStartTs(startTs)
      for (const [, base] of _circleBases) {
        if (!base.writable) continue
        const existing = await base.view.get(replicatedKey)
        if (!existing?.value) continue  // never replicated to this circle
        if (existing.value.deleted === true) continue  // already deleted
        try {
          await base.append({ type: 'put', key: replicatedKey, value: tombstone })
          circlesTombstoned++
        } catch {
          // base closed mid-flight, etc.
        }
      }
    }

    return { ok: true, scope, circlesTombstoned }
  },
}

// Worklet-side trip retention sweep (proposal 2026-05-10 follow-up).
// Drops trip records older than TRIP_RETENTION_MS from both surfaces:
//   - Local Hyperbee trips:{pubkey}:{ts}     (self-only by design)
//   - Per-circle autobase trip:{pubkey}:{padded} view (all members)
// View deletes are local-only (Hyperbee on top of the autobase log);
// they don't replicate, so each peer prunes its own copy independently.
// Re-replication of expired records is blocked by the apply-branch
// filter so the bound holds across reboots. Returns counts for logging.
async function pruneOldTrips () {
  if (!_initialized || !_localDb) return { localDeleted: 0, viewDeleted: 0 }
  const now = Date.now()
  let localDeleted = 0
  let viewDeleted = 0
  try {
    const toDelete = []
    for await (const { key, value } of _localDb.createReadStream({
      gt: 'trips:',
      lt: 'trips:~',
    })) {
      if (tripIsExpired(value, now)) toDelete.push(key)
    }
    for (const k of toDelete) {
      try { await _localDb.del(k); localDeleted++ } catch {}
    }
  } catch (e) { console.warn('[bare] pruneOldTrips local scan failed', e?.message) }
  for (const [, base] of _circleBases) {
    try {
      const toDelete = []
      for await (const { key, value } of base.view.createReadStream({
        gt: 'trip:',
        lt: 'trip:~',
      })) {
        if (tripIsExpired(value, now)) toDelete.push(key)
      }
      for (const k of toDelete) {
        try { await base.view.del(k); viewDeleted++ } catch {}
      }
    } catch (e) { console.warn('[bare] pruneOldTrips view scan failed', e?.message) }
  }
  return { localDeleted, viewDeleted }
}

// Replicate a freshly-completed trip to every per-circle autobase
// whose sharing toggle is on. Per proposal 2026-05-10 the toggle is
// strict opt-in (absent row = off) and only applies to FUTURE trips
// (this function runs at trip-completion time, never on cold-start
// catch-up). The wire key is fixed-width zero-padded so lexicographic
// scans across `trip:{pubkey}:` return chronological order.
async function replicateTripToOptedInCircles (ourKey, trip) {
  const signedValue = signValue({
    pubkey: ourKey,
    startTs: trip.startTs,
    endTs: trip.endTs,
    polyline: trip.polyline,
    distanceMeters: trip.distanceMeters,
    durationMs: trip.durationMs,
    maxSpeedMps: trip.maxSpeedMps,
    v: 1,
  }, _identity.secretKey)
  const key = 'trip:' + ourKey + ':' + padTripStartTs(trip.startTs)
  for (const [circleId, base] of _circleBases) {
    if (!base.writable) continue
    // If location sharing is muted for this circle, trips are too:
    // sharing your route is strictly more revealing than sharing
    // presence, so the stricter gate wins.
    if (!getCircleSharing(circleId).enabled) continue
    const row = await _localDb.get('trips:sharing:' + circleId)
    if (!shouldReplicateTrip(row)) continue
    try {
      await base.append({ type: 'put', key, value: signedValue })
    } catch (e) {
      console.warn('[bare] trip replicate to', circleId, 'failed', e?.message)
    }
  }
}

async function writePresenceToCircle (circleId, state, expiresAt = null) {
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const payload = { pubkey: ourKey, state, setAt: Date.now(), v: 1 }
  if (typeof expiresAt === 'number') payload.expiresAt = expiresAt
  const value = signValue(payload, _identity.secretKey)
  try {
    await base.append({ type: 'put', key: 'presence:' + ourKey, value })
  } catch {
    // base closed mid-flight, etc.
  }
}

// Per-circle sharing helpers. _circleSharing stores explicit entries
// only; missing key means "enabled with no expiry" (default-on).
function getCircleSharing (circleId) {
  const s = _circleSharing.get(circleId)
  if (!s) return { enabled: true, expiresAt: null }
  return { enabled: s.enabled, expiresAt: s.expiresAt }
}

function anyCircleEnabled () {
  // Zero circles → treat as enabled so the FGS keeps running for trip
  // detection and so a freshly-mounted circle picks up locations
  // immediately. Otherwise, any non-muted circle keeps the FGS alive.
  if (_circleBases.size === 0) return true
  for (const cid of _circleBases.keys()) {
    if (getCircleSharing(cid).enabled) return true
  }
  return false
}

async function persistCircleSharing (circleId, enabled, expiresAt) {
  if (enabled) {
    // Resume: drop the explicit row so default-on (absent) wins. Keeps
    // the local DB tidy and means cross-version reads always agree.
    _circleSharing.delete(circleId)
    await _localDb.del('sharing:' + circleId).catch(() => {})
    return
  }
  const entry = _circleSharing.get(circleId) ?? { enabled: true, expiresAt: null, expiryTimer: null }
  entry.enabled = false
  entry.expiresAt = expiresAt
  _circleSharing.set(circleId, entry)
  await _localDb.put('sharing:' + circleId, {
    enabled: false,
    expiresAt,
    setAt: Date.now(),
    v: 1,
  })
}

// Schedule (or cancel) the auto-resume timer for one circle. Called
// from sharing:set and on init. Idempotent: always clears the pending
// timer for that circle first.
function armCircleExpiryTimer (circleId) {
  const entry = _circleSharing.get(circleId)
  if (entry?.expiryTimer) {
    clearTimeout(entry.expiryTimer)
    entry.expiryTimer = null
  }
  if (!entry || entry.enabled || !entry.expiresAt) return
  const ms = entry.expiresAt - Date.now()
  if (ms <= 0) {
    // Already expired (clock jump or worklet sleep). Fire immediately.
    autoResumeCircleSharing(circleId).catch(() => {})
    return
  }
  entry.expiryTimer = setTimeout(() => {
    entry.expiryTimer = null
    autoResumeCircleSharing(circleId).catch(() => {})
  }, ms)
}

async function autoResumeCircleSharing (circleId) {
  const entry = _circleSharing.get(circleId)
  if (!entry || entry.enabled) return
  await persistCircleSharing(circleId, true, null)
  await writePresenceToCircle(circleId, 'visible', null)
  send({
    event: 'sharing:changed',
    data: { circleId, enabled: true, expiresAt: null, auto: true, anyEnabled: anyCircleEnabled() },
  })
}

// Load all `sharing:{circleId}` rows into _circleSharing. Also migrates
// the legacy global `sharing` row (pre-2026-05-14): if found with
// enabled=false, fan out to every mounted circle so an existing mute
// survives the upgrade, then delete the legacy row.
async function loadPersistedSharing () {
  for await (const { key, value } of _localDb.createReadStream({
    gt: 'sharing:', lt: 'sharing:~',
  })) {
    // Defensive: the `trips:sharing:` prefix shares the same root path
    // but lives outside this range because 't' > ':'. Skip anyway in
    // case future keys collide.
    if (key.startsWith('trips:sharing:')) continue
    if (!value || value.enabled !== false) continue
    const circleId = key.slice('sharing:'.length)
    _circleSharing.set(circleId, {
      enabled: false,
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
      expiryTimer: null,
    })
  }
  const legacy = await _localDb.get('sharing').catch(() => null)
  if (legacy?.value && legacy.value.enabled === false) {
    const exp = typeof legacy.value.expiresAt === 'number' ? legacy.value.expiresAt : null
    for (const cid of _circleBases.keys()) {
      if (_circleSharing.has(cid)) continue  // explicit per-circle row already takes precedence
      await persistCircleSharing(cid, false, exp)
    }
  }
  if (legacy) await _localDb.del('sharing').catch(() => {})
  for (const cid of _circleSharing.keys()) armCircleExpiryTimer(cid)
}

async function appendTransition (base, placeId, kind, ts) {
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const value = signValue(
    { pubkey: ourKey, placeId, kind, ts, v: 1 },
    _identity.secretKey,
  )
  // Key shape per proposal §3 amended 2026-05-04: ts:pubkey:placeId.
  // The placeId suffix prevents same-tick collisions when one
  // location:update produces multiple transitions.
  await base.append({
    type: 'put',
    key: 'transition:' + ts + ':' + ourKey + ':' + placeId,
    value,
  })
  return value
}

async function appendLastSeen (base, lat, lon, accuracy, ts, battery = null, isCharging = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const batt = (typeof battery === 'number' && battery >= 0 && battery <= 100) ? battery : null
  const charging = typeof isCharging === 'boolean' ? isCharging : null
  const value = signValue({
    pubkey: ourKey,
    lat,
    lon,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    ts,
    battery: batt,
    isCharging: charging,
    v: 1,
  }, _identity.secretKey)
  await base.append({ type: 'put', key: 'lastSeen:' + ourKey, value })
}

// Shared body for region:enter / region:exit IPC handlers. Splits the
// composite "{circleId}|{placeId}" id back into its parts, runs the
// applyRegionEvent dedup against the in-process geofence state, and
// appends a transition if the cross is new. Reasons returned to the
// caller are useful in tests; the shell discards them.
async function handleRegionEvent (kind, id, ts) {
  if (!_initialized) return { ok: false, reason: 'not_initialized' }
  if (typeof id !== 'string') return { ok: false, reason: 'invalid_id' }
  const sep = id.indexOf('|')
  if (sep < 0) return { ok: false, reason: 'invalid_id_shape' }
  const circleId = id.slice(0, sep)
  const placeId = id.slice(sep + 1)
  const state = _circlePlaces.get(id)
  if (!state) return { ok: false, reason: 'unknown_place' }
  const result = applyRegionEvent(state.lastClassification, kind)
  if (result.deduped) return { ok: true, deduped: true }
  state.lastClassification = result.classification
  // Per-circle mute: still update the dedup classifier above so a
  // later resume doesn't replay the boundary cross, but suppress the
  // autobase append for muted circles.
  if (!getCircleSharing(circleId).enabled) return { ok: false, reason: 'sharing_disabled' }
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return { ok: false, reason: 'no_base' }
  const stamp = typeof ts === 'number' ? ts : Date.now()
  try {
    await appendTransition(base, placeId, kind, stamp)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message }
  }
}

async function checkPlaceTransitions (lat, lon, accuracy, ts, battery = null, isCharging = null) {
  for (const state of _circlePlaces.values()) {
    const base = _circleBases.get(state.circleId)
    if (!base || !base.writable) continue
    const dist = haversineMeters(lat, lon, state.lat, state.lon)
    const result = classify(dist, state.radiusMeters, state.lastClassification)
    state.lastClassification = result.classification
    if (!result.kind) continue
    // Per-circle mute: still flip the classifier above (so a later
    // resume doesn't re-fire the entry/exit), but skip the autobase
    // append. Peers in muted circles don't see this transition.
    if (!getCircleSharing(state.circleId).enabled) continue
    try {
      await appendTransition(base, state.placeId, result.kind, ts)
      // Pass battery so the post-transition lastSeen write stays byte-
      // identical to the location:update one (autobase apply dedupes).
      await appendLastSeen(base, lat, lon, accuracy, ts, battery)
    } catch (e) {
      console.warn('[bare] failed to append transition', e?.message)
    }
  }
}

async function snapshotCircle (circleId, base) {
  await base.update()
  const view = base.view
  const circleRow = await view.get('circle')
  // Pull `left:` rows up front so the member / lastSeen / presence
  // streams below can filter against them via the leftAt > joinedAt rule
  // (proposal amendment 2026-05-07 §2). leavers stay hidden until they
  // rejoin with a fresh member: write whose joinedAt > left.leftAt.
  const leftAtByPubkey = new Map()
  for await (const { key, value } of view.createReadStream({ gt: 'left:', lt: 'left:~' })) {
    const pubkey = key.slice('left:'.length)
    if (typeof value?.leftAt === 'number') leftAtByPubkey.set(pubkey, value.leftAt)
  }
  const members = []
  for await (const { key, value } of view.createReadStream({ gt: 'member:', lt: 'member:~' })) {
    const leftAt = leftAtByPubkey.get(value?.pubkey)
    if (memberHiddenByLeft(leftAt, value?.joinedAt)) continue
    members.push({ key, value })
  }
  const lastSeen = {}
  for await (const { key, value } of view.createReadStream({ gt: 'lastSeen:', lt: 'lastSeen:~' })) {
    const pubkey = key.slice('lastSeen:'.length)
    if (leftAtByPubkey.has(pubkey)) {
      const memberRow = await view.get('member:' + pubkey)
      if (memberHiddenByLeft(leftAtByPubkey.get(pubkey), memberRow?.value?.joinedAt)) continue
    }
    lastSeen[pubkey] = value
  }
  const presence = {}
  for await (const { key, value } of view.createReadStream({ gt: 'presence:', lt: 'presence:~' })) {
    const pubkey = key.slice('presence:'.length)
    if (leftAtByPubkey.has(pubkey)) {
      const memberRow = await view.get('member:' + pubkey)
      if (memberHiddenByLeft(leftAtByPubkey.get(pubkey), memberRow?.value?.joinedAt)) continue
    }
    presence[pubkey] = value
  }
  const places = []
  for await (const { value } of view.createReadStream({ gt: 'place:', lt: 'place:~' })) {
    if (value && !isDeleted(value)) places.push(value)
  }
  // Most recent 50 transitions, newest first. Reverse-stream the
  // ts-prefixed keys so we don't have to load the whole range. We don't
  // filter transitions by `left:` — they're historical events; hiding
  // them after the fact would rewrite history (proposal §2).
  const transitions = []
  for await (const { value } of view.createReadStream({
    gt: 'transition:', lt: 'transition:~', reverse: true, limit: 50,
  })) {
    if (value) transitions.push(value)
  }
  return {
    circle: circleRow ? circleRow.value : null,
    members,
    lastSeen,
    presence,
    places,
    transitions,
    writable: base.writable,
    writers: base.writers ? base.writers.length : null,
  }
}

async function readProfileDisplayName (fallbackPubkey) {
  const row = await _localDb.get('profile')
  const dn = row?.value?.displayName
  if (typeof dn === 'string' && dn.length > 0) return dn
  return fallbackPubkey.slice(0, 8)
}

async function readProfileForMemberRow (fallbackPubkey) {
  const row = await _localDb.get('profile')
  const dn = row?.value?.displayName
  const av = row?.value?.avatar
  return {
    displayName: (typeof dn === 'string' && dn.length > 0) ? dn : fallbackPubkey.slice(0, 8),
    avatar: (typeof av === 'string' && av.length > 0) ? av : null,
  }
}

function joinCircleTopic (circleId, circleKey) {
  if (!_swarm) return null
  const topic = topicForCircleKey(circleKey)
  const topicHex = b4a.toString(topic, 'hex')
  if (_topicToCircle.has(topicHex)) return null
  _topicToCircle.set(topicHex, circleId)
  if (!_circlePeers.has(circleId)) _circlePeers.set(circleId, new Set())
  return _swarm.join(topic, { server: true, client: true })
}

// Local teardown for a circle (proposal amendment 2026-05-07): leave the
// swarm topic, close the autobase, drop in-memory geofence + peer state,
// remove the local `circles:joined` record. Used by both `circle:delete`
// (owner) and `circle:leave` (member) after the on-wire write has been
// appended and given a brief replication window. Idempotent — repeated
// calls on an already-cleaned-up circle are no-ops.
async function tearDownCircleLocally (circleId) {
  const record = await _localDb.get('circles:joined:' + circleId).catch(() => null)
  if (record?.value?.circleKey && _swarm) {
    try {
      const topic = topicForCircleKey(record.value.circleKey)
      const topicHex = b4a.toString(topic, 'hex')
      _topicToCircle.delete(topicHex)
      const discovery = _swarm.leave(topic)
      if (discovery && typeof discovery.flushed === 'function') {
        try { await discovery.flushed() } catch {}
      }
    } catch (e) { console.warn('[bare] swarm leave failed', e?.message) }
  }
  const base = _circleBases.get(circleId)
  if (base) {
    try { await base.close() } catch (e) { console.warn('[bare] base close failed', e?.message) }
    _circleBases.delete(circleId)
  }
  _circlePeers.delete(circleId)
  for (const key of Array.from(_circlePlaces.keys())) {
    if (key.startsWith(circleId + '|')) _circlePlaces.delete(key)
  }
  // Clear per-circle sharing state so a fresh re-join starts on the
  // default (enabled) and any pending auto-resume timer doesn't fire
  // against a torn-down base.
  const sharingEntry = _circleSharing.get(circleId)
  if (sharingEntry?.expiryTimer) clearTimeout(sharingEntry.expiryTimer)
  _circleSharing.delete(circleId)
  await _localDb.del('sharing:' + circleId).catch(() => {})
  await _localDb.del('circles:joined:' + circleId).catch(() => {})
}

// Autobase hooks. The view is a Hyperbee on a sub-core named 'view'; apply
// routes ops by record kind (proposal §4). For 6D scope, only `circle` and
// `member:*` are handled; addWriter and other kinds land in subsequent slices.
function openCircleView (store) {
  return new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  })
}

async function applyCircleNodes (nodes, view, base, circleId) {
  const bootstrapHex = b4a.toString(base.key, 'hex')
  let weJustBecameWritable = false
  for (const node of nodes) {
    const op = node.value
    if (!op || typeof op.type !== 'string') continue

    if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
      await base.addWriter(b4a.from(op.pubkey, 'hex'))
      // Detect "we just became a writer" so we can auto-append our
      // member row outside the apply pass. base.local.key is our local
      // writer-core key on this autobase.
      const ourLocalKey = base.local && b4a.toString(base.local.key, 'hex')
      if (ourLocalKey === op.pubkey) weJustBecameWritable = true
      continue
    }

    if (op.type === 'put' && typeof op.key === 'string') {
      // `circle`: owner-write only — bootstrap writer authored or ignored.
      // The optional `deleted: true, deletedAt` shape (proposal amendment
      // 2026-05-07) is the owner's tear-down tombstone. We pass it through
      // unchanged; consumers (snapshot helpers, circles:list, circle:join)
      // are responsible for filtering. Emit `circle:deleted` once the
      // deleted state lands so the shell can show a one-time notice and
      // clean up local state.
      if (op.key === 'circle') {
        const fromHex = b4a.toString(node.from.key, 'hex')
        if (fromHex !== bootstrapHex) continue
        const wasDeleted = !!(await view.get('circle'))?.value?.deleted
        await view.put('circle', op.value)
        // Suppress the event when this device originated the write — the
        // owner's own `circle:delete` IPC already runs the teardown, so
        // they don't need a "deleted by its owner" notification about
        // themselves. base.local.key is our writer-core key on this
        // autobase; for the owner it equals bootstrapHex, for peers it
        // doesn't.
        const ourLocalKey = base.local && b4a.toString(base.local.key, 'hex')
        const isOurOwnWrite = ourLocalKey && ourLocalKey === fromHex
        if (circleId && op.value?.deleted && !wasDeleted && !isOurOwnWrite) {
          try {
            send({ event: 'circle:deleted', data: {
              circleId,
              circleName: op.value?.name || 'Circle',
              deletedAt: typeof op.value?.deletedAt === 'number' ? op.value.deletedAt : Date.now(),
            }})
          } catch (e) { console.warn('[bare] circle:deleted emit failed', e?.message) }
        }
        continue
      }
      // `left:{pubkey}` (proposal amendment 2026-05-07): voluntary-leave
      // tombstone. Self-write only — signature must verify against the
      // value's pubkey, and the key segment must match. Filter rule lives
      // in the snapshot helpers: a member is hidden when
      // left.leftAt > member.joinedAt. Rejoin works without any explicit
      // unset because the new member-row's joinedAt beats the older leftAt.
      if (op.key.startsWith('left:')) {
        const incoming = op.value
        if (!verifyValue(incoming)) continue
        if (typeof incoming.leftAt !== 'number') continue
        if (incoming.leftAt > Date.now() + FUTURE_TS_TOLERANCE_MS) continue
        const keyPubkey = op.key.slice('left:'.length)
        if (keyPubkey !== incoming.pubkey) continue
        await view.put(op.key, incoming)
        continue
      }
      // `member:*`: any current writer
      if (op.key.startsWith('member:')) {
        await view.put(op.key, op.value)
        continue
      }
      // `lastSeen:{pubkey}`: signed by the user-identity in `pubkey`
      // (proposal §5). Reject unsigned, tampered, or future-stamped values.
      // Key suffix must match the signed pubkey so a writer can't impersonate
      // another member's row.
      if (op.key.startsWith('lastSeen:')) {
        const incoming = op.value
        if (!verifyValue(incoming)) continue
        if (typeof incoming.ts !== 'number') continue
        if (incoming.ts > Date.now() + FUTURE_TS_TOLERANCE_MS) continue
        const keyPubkey = op.key.slice('lastSeen:'.length)
        if (keyPubkey !== incoming.pubkey) continue
        await view.put(op.key, incoming)
        if (circleId && !_firstLastSeenRemoteMarked.has(circleId)) {
          const ourKeyHex = _identity && b4a.toString(_identity.publicKey, 'hex')
          if (ourKeyHex && keyPubkey !== ourKeyHex) {
            _firstLastSeenRemoteMarked.add(circleId)
            mark('lastseen:first-remote', { circleId, from: keyPubkey.slice(0, 8) })
          }
        }
        continue
      }
      // `presence:{pubkey}` (proposal §3 / §4): signed by the user-
      // identity in `pubkey`. Same pubkey-match rule as lastSeen — a
      // writer can't flip another member's presence. LWW on `setAt`
      // so a late-replicating older write can't clobber a newer flip.
      if (op.key.startsWith('presence:')) {
        const incoming = op.value
        if (!verifyValue(incoming)) continue
        if (typeof incoming.setAt !== 'number') continue
        if (incoming.setAt > Date.now() + FUTURE_TS_TOLERANCE_MS) continue
        if (incoming.state !== 'visible' && incoming.state !== 'muted') continue
        const keyPubkey = op.key.slice('presence:'.length)
        if (keyPubkey !== incoming.pubkey) continue
        const existing = await view.get(op.key)
        if (existing?.value && typeof existing.value.setAt === 'number') {
          if (incoming.setAt <= existing.value.setAt) continue
        }
        await view.put(op.key, incoming)
        continue
      }
      // `place:{id}`: any current writer; last-write-wins on createdAt
      // collision (proposal §4). Older records dropped silently so a
      // late-replicating node can't clobber a newer rename.
      if (op.key.startsWith('place:')) {
        const incoming = op.value
        if (!incoming || typeof incoming.createdAt !== 'number') continue
        const existing = await view.get(op.key)
        if (existing && existing.value && typeof existing.value.createdAt === 'number') {
          if (incoming.createdAt <= existing.value.createdAt) continue
        }
        await view.put(op.key, incoming)
        // Track for in-process geofence checks. circleId comes from the
        // closure captured at autobase creation. A delete tombstone
        // (deleted: true) untracks instead, so the next location:update
        // can't fire transitions against a deleted place.
        if (circleId) {
          if (isDeleted(incoming)) untrackPlace(circleId, incoming.id)
          else trackPlace(circleId, incoming)
        }
        continue
      }
      // `transition:{ts}:{pubkey}:{placeId}` (proposal §3 amended 2026-05-04):
      // signed by the user-identity in `pubkey` (proposal §5). Reject unsigned,
      // tampered, or future-stamped values. Each key segment is checked against
      // the corresponding value field so a writer can't impersonate another
      // member or claim a different place than the one they're writing about.
      // Old two-segment keys are silently dropped here; they remain in the
      // view from prior applies but no new ones land.
      if (op.key.startsWith('transition:')) {
        const incoming = op.value
        if (!verifyValue(incoming)) continue
        if (typeof incoming.ts !== 'number') continue
        if (typeof incoming.placeId !== 'string') continue
        if (incoming.ts > Date.now() + FUTURE_TS_TOLERANCE_MS) continue
        const tail = op.key.slice('transition:'.length)
        const firstColon = tail.indexOf(':')
        if (firstColon < 0) continue
        const secondColon = tail.indexOf(':', firstColon + 1)
        if (secondColon < 0) continue // old two-segment key
        const keyPubkey = tail.slice(firstColon + 1, secondColon)
        const keyPlaceId = tail.slice(secondColon + 1)
        if (keyPubkey !== incoming.pubkey) continue
        if (keyPlaceId !== incoming.placeId) continue
        await view.put(op.key, incoming)
        // Emit transition:applied so the RN shell can fire an OS notification.
        // Skip the emit when we've already fired for this exact op key in
        // this worklet session -- autobase re-applies the same node when
        // the indexer reorganizes (writer-add, fork-merge), and each
        // re-apply would otherwise produce another notification minutes
        // after the first. Resolved displayName + placeName piggyback on
        // the event so the receiver doesn't need to round-trip back to
        // the worklet.
        if (!_emittedTransitionKeys.has(op.key)) {
          if (_emittedTransitionKeys.size >= _EMITTED_TRANSITION_MAX) {
            // FIFO-on-overflow: drop the oldest half. Cheap, bounded.
            const arr = [..._emittedTransitionKeys]
            _emittedTransitionKeys.clear()
            for (let i = arr.length >> 1; i < arr.length; i++) _emittedTransitionKeys.add(arr[i])
          }
          _emittedTransitionKeys.add(op.key)
          // Cross-session freshness gate. The incoming.ts is the
          // signed timestamp at which the geofence crossing happened;
          // historical replays on cold boot carry old values and get
          // filtered here. Non-numeric ts (defensive) is treated as
          // stale.
          const fresh =
            typeof incoming.ts === 'number' &&
            Date.now() - incoming.ts <= TRANSITION_FRESHNESS_MS
          try {
            if (fresh && circleId) {
              const memberRow = await view.get('member:' + incoming.pubkey)
              const placeRow = await view.get('place:' + incoming.placeId)
              const placeDeleted = !!(placeRow?.value && isDeleted(placeRow.value))
              if (!placeDeleted) {
                send({ event: 'transition:applied', data: {
                  circleId,
                  transition: incoming,
                  displayName: memberRow?.value?.displayName || incoming.pubkey.slice(0, 8),
                  placeName: placeRow?.value?.name || 'a place',
                }})
              }
            }
          } catch (e) { console.warn('[bare] transition:applied emit failed', e?.message) }
        }
        continue
      }
      // `trip:{pubkey}:{startTsPadded}` (proposal 2026-05-10): signed
      // trip record replicating across opted-in circles. Decision
      // rules live in src/lib/tripWire.js (sig verify + key/value
      // cross-check + no-resurrection-of-deleted + no-overwrite-of-
      // original); we just dispatch. Trip records are passive history
      // for UI list pulls (trips:listForMember), but fresh, non-self,
      // above-threshold completions also fire a `peerTrip:completed`
      // IPC so the shell can post an OS notification (Life360-style
      // "Jane completed a 12 km trip"). Freshness + in-session dedup
      // together keep cold-boot autobase replay quiet.
      if (op.key.startsWith('trip:')) {
        const existing = await view.get(op.key)
        if (tripApplyDecision(op.key, op.value, existing, verifyValue) === 'accept') {
          // Retention gate: don't store trip records older than the
          // 14-day window. A late-syncing peer's stale trip log would
          // otherwise blow back the bound that pruneOldTrips() just
          // freed. tripIsExpired tolerates malformed records (keeps
          // them) so a missing endTs doesn't silently drop data.
          if (tripIsExpired(op.value, Date.now())) continue
          await view.put(op.key, op.value)
          try {
            if (
              _tripNotificationsEnabled &&
              circleId &&
              op.value &&
              op.value.deleted !== true &&
              typeof op.value.pubkey === 'string' &&
              typeof op.value.endTs === 'number' &&
              typeof op.value.distanceMeters === 'number'
            ) {
              const ourKeyHex = _identity && b4a.toString(_identity.publicKey, 'hex')
              const author = op.value.pubkey
              const fresh = Date.now() - op.value.endTs <= PEER_TRIP_FRESHNESS_MS
              const meetsThreshold =
                op.value.distanceMeters >= PEER_TRIP_MIN_DISTANCE_M ||
                (typeof op.value.durationMs === 'number' && op.value.durationMs >= PEER_TRIP_MIN_DURATION_MS)
              if (
                author !== ourKeyHex &&
                fresh &&
                meetsThreshold &&
                !_emittedPeerTripKeys.has(op.key)
              ) {
                if (_emittedPeerTripKeys.size >= _EMITTED_PEER_TRIP_MAX) {
                  const arr = [..._emittedPeerTripKeys]
                  _emittedPeerTripKeys.clear()
                  for (let i = arr.length >> 1; i < arr.length; i++) _emittedPeerTripKeys.add(arr[i])
                }
                _emittedPeerTripKeys.add(op.key)
                const memberRow = await view.get('member:' + author)
                send({ event: 'peerTrip:completed', data: {
                  circleId,
                  authorPubkey: author,
                  displayName: memberRow?.value?.displayName || author.slice(0, 8),
                  distanceMeters: op.value.distanceMeters,
                  durationMs: typeof op.value.durationMs === 'number' ? op.value.durationMs : null,
                  startTs: typeof op.value.startTs === 'number' ? op.value.startTs : null,
                  endTs: op.value.endTs,
                }})
              }
            }
          } catch (e) { console.warn('[bare] peerTrip:completed emit failed', e?.message) }
        }
        continue
      }
      // `seeder:{pubkey}` (proposal 2026-05-19-blind-seeder-peers slice 3a).
      // Signed by any current member via verifyValueWithSigner against the
      // `writer` field. shouldAcceptSeederRow encapsulates all gating:
      // shape, future-ts tolerance, writer-is-member, writer-not-removed,
      // LWW on updatedAt. See src/lib/seederApply.js for the full rule set.
      if (op.key.startsWith('seeder:')) {
        const incoming = op.value
        if (!incoming || typeof incoming.writer !== 'string') continue
        const keyPubkey = op.key.slice('seeder:'.length)
        const writerMember = (await view.get('member:' + incoming.writer))?.value
        const writerRemoved = (await view.get('removed:' + incoming.writer))?.value
        const existing = (await view.get(op.key))?.value
        const accept = shouldAcceptSeederRow({
          keyPubkey,
          incoming,
          writerMember,
          writerRemoved,
          existing,
          now: Date.now(),
          futureToleranceMs: FUTURE_TS_TOLERANCE_MS,
          verifySig: (val) => verifyValueWithSigner(val, 'writer'),
        })
        if (accept) await view.put(op.key, incoming)
        continue
      }
      // Other prefixes not yet wired — silently dropped.
    }
  }
  if (weJustBecameWritable) {
    // Schedule the member-row append for after this apply pass returns.
    // We can't append from inside apply (would deadlock the autobase
    // pipeline) and we don't have circleId in this scope, so look it up.
    let myCircleId = null
    for (const [cid, b] of _circleBases) {
      if (b === base) { myCircleId = cid; break }
    }
    if (myCircleId) {
      setTimeout(() => autoAppendMemberRow(myCircleId).catch(() => {}), 0)
    }
  }
}

async function autoAppendMemberRow (circleId) {
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const existing = await base.view.get('member:' + ourKey)
  if (existing && existing.value) return
  const profile = await readProfileForMemberRow(ourKey)
  const memberValue = { pubkey: ourKey, displayName: profile.displayName, joinedAt: Date.now(), v: 1 }
  if (profile.avatar) memberValue.avatar = profile.avatar
  try {
    await base.append({ type: 'put', key: 'member:' + ourKey, value: memberValue })
    if (!_firstWriterMarked.has(circleId)) {
      _firstWriterMarked.add(circleId)
      mark('writer:first-added', { circleId })
    }
    send({ event: 'circle:writer:added', data: { circleId, writerKey: ourKey } })
  } catch {
    // base closed / already appended via race; harmless
  }
}

async function mountCircleAutobase (circleId, bootstrapHex) {
  if (_circleBases.has(circleId)) return _circleBases.get(circleId)
  const ns = _store.namespace(circleId)
  const base = new Autobase(ns, b4a.from(bootstrapHex, 'hex'), {
    open: openCircleView,
    apply: (nodes, view, b) => applyCircleNodes(nodes, view, b, circleId),
    valueEncoding: 'json',
  })
  await base.ready()
  _circleBases.set(circleId, base)
  openPairChannelsForCircle(circleId, base)
  return base
}

// Open pair channels for a newly-added circle on every currently-live
// swarm connection (joiner-initiated path). The owner side does NOT
// call this from circle:create — instead the owner relies on the
// protomux pair() callback registered at conn-open time to lazily
// match an incoming open from the joiner. See registerPairNotify
// below. Calling this on the joiner side creates the channel on the
// joiner's mux and sends an OPEN frame; the owner's pair() notify
// catches it and creates the matching channel, letting the handshake
// complete.
// Proposal 2026-05-18-pair-channel-on-circle-add.
function openPairChannelsForCircle (circleId, base) {
  let opened = 0
  for (const conn of _activeConns) {
    const ch = setupPairChannel({
      conn,
      circleId,
      base,
      onWriterAdded: (writerKey) => {
        send({ event: 'circle:writer:added', data: { circleId, writerKey } })
      },
      mark,
    })
    if (ch) opened++
  }
  mark('pair:open-for-circle', { circleId: circleId.slice(0, 8), conns: _activeConns.size, opened, writable: !!base.writable })
}

// Register a protomux pair() notify on every conn so an OPEN frame
// from a peer for ANY circle id we know about gets a matching
// channel created lazily. Protomux behavior: when a remote opens a
// (protocol, id) without a local channel pending, the open is queued
// on info.incoming and _requestSession awaits our notify; if notify
// creates a matching channel during the await, the create call grabs
// the queued incoming entry and onopen fires on both sides; if not,
// protomux rejects the open. This is the canonical mechanism for
// "owner doesn't know a joiner is coming". Called from
// onSwarmConnection.
function registerPairNotify (conn) {
  const mux = Protomux.from(conn)
  mux.pair({ protocol: PAIR_PROTOCOL, id: null }, async (id) => {
    if (!id) return
    let circleIdStr
    try { circleIdStr = b4a.toString(id) } catch { return }
    const base = _circleBases.get(circleIdStr)
    if (!base) {
      mark('pair:remote-open-no-base', { cid: circleIdStr.slice(0, 8) })
      return
    }
    mark('pair:remote-open-matched', { cid: circleIdStr.slice(0, 8), writable: !!base.writable })
    setupPairChannel({
      conn,
      circleId: circleIdStr,
      base,
      onWriterAdded: (writerKey) => {
        send({ event: 'circle:writer:added', data: { circleId: circleIdStr, writerKey } })
      },
      mark,
    })
  })
}

function onSwarmConnection (conn, info) {
  // Pipe corestore replication first so cores can negotiate before we
  // emit peer:connected — UI typically calls circle:get right after that
  // event and we want the view to be fresh.
  _store.replicate(conn)
  _activeConns.add(conn)
  registerPairNotify(conn)

  const remotePublicKey = b4a.toString(info.publicKey, 'hex')

  // info.topics is asymmetric on real-DHT connections: the lookup side may
  // have it populated, the announce side often does not. Setting up the
  // pair channel for every known circle is safe — protomux only matches
  // when both sides open the same protocol+id, and unmatched channels
  // don't affect corestore replication.
  for (const [circleId, base] of _circleBases) {
    setupPairChannel({
      conn,
      circleId,
      base,
      onWriterAdded: (writerKey) => {
        send({ event: 'circle:writer:added', data: { circleId, writerKey } })
      },
      mark,
    })
  }

  // Peer tracking: prefer info.topics, fall back to all circles we both
  // could be on. The fallback over-counts when the remote isn't actually
  // in our circle, but in v1 we only accept connections on circle topics
  // we joined, so practically this matches.
  const matchedCircleIds = []
  if (info.topics && info.topics.length > 0) {
    for (const topicBuf of info.topics) {
      const topicHex = b4a.toString(topicBuf, 'hex')
      const circleId = _topicToCircle.get(topicHex)
      if (circleId) matchedCircleIds.push(circleId)
    }
  } else {
    for (const circleId of _circleBases.keys()) matchedCircleIds.push(circleId)
  }

  for (const circleId of matchedCircleIds) {
    const peers = _circlePeers.get(circleId)
    if (peers) peers.add(remotePublicKey)
    if (!_firstPeerMarked.has(circleId)) {
      _firstPeerMarked.add(circleId)
      mark('peer:first-connected', { circleId, remote: remotePublicKey.slice(0, 8) })
    } else {
      mark('peer:reconnected', { circleId, remote: remotePublicKey.slice(0, 8) })
    }
    send({ event: 'peer:connected', data: { circleId, remotePublicKey } })
  }
  conn.on('close', () => {
    _activeConns.delete(conn)
    for (const circleId of matchedCircleIds) {
      const peers = _circlePeers.get(circleId)
      if (peers) peers.delete(remotePublicKey)
      mark('peer:disconnected', { circleId, remote: remotePublicKey.slice(0, 8) })
      send({ event: 'peer:disconnected', data: { circleId, remotePublicKey } })
    }
  })
  conn.on('error', (err) => {
    mark('peer:error', { remote: remotePublicKey.slice(0, 8), err: err?.message ?? String(err) })
  })
}

async function init ({ dataDir } = {}, attempt = 0) {
  if (_initialized) {
    send({ event: 'ready', data: { publicKey: b4a.toString(_identity.publicKey, 'hex') } })
    return
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('init requires { dataDir: string }')
  }
  mark('init:start', { attempt })

  // Retry on lock errors: BareKit may restart the worklet before the prior
  // instance has released the corestore lock file.
  try {
    _store = new Corestore(dataDir + '/pearcircle/store')
    await _store.ready()
  } catch (e) {
    if (e?.message?.includes('lock') && attempt < 20) {
      await new Promise(r => setTimeout(r, 1000))
      return init({ dataDir }, attempt + 1)
    }
    throw e
  }

  mark('init:store-ready')

  const localCore = _store.get({ name: 'local' })
  await localCore.ready()
  _localDb = new Hyperbee(localCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await _localDb.ready()

  const stored = await _localDb.get('identity')
  if (stored) {
    _identity = {
      publicKey: b4a.from(stored.value.publicKey, 'hex'),
      secretKey: b4a.from(stored.value.secretKey, 'hex'),
    }
  } else {
    _identity = generateKeypair()
    await _localDb.put('identity', {
      publicKey: b4a.toString(_identity.publicKey, 'hex'),
      secretKey: b4a.toString(_identity.secretKey, 'hex'),
      createdAt: Date.now(),
    })
  }
  mark('init:identity-ready', { fresh: !stored })

  _swarm = new Hyperswarm({ keyPair: _identity })
  _swarm.on('connection', onSwarmConnection)
  mark('init:swarm-created')

  // Rejoin all known circle topics and mount their Autobases. Pre-existing
  // local records (from prior launches) need their swarm topics re-announced
  // and their Autobases reopened on every boot.
  for await (const { value } of _localDb.createReadStream({
    gt: 'circles:joined:',
    lt: 'circles:joined:~',
  })) {
    if (!value || !value.circleId) continue
    if (value.bootstrap) {
      try { await mountCircleAutobase(value.circleId, value.bootstrap) } catch (e) {
        console.warn('[bare] failed to mount circle', value.circleId, e?.message)
      }
    }
    if (value.circleKey) joinCircleTopic(value.circleId, value.circleKey)
  }
  mark('init:circles-mounted', { count: _circleBases.size })

  // Stale-deleted sweep (proposal amendment 2026-05-07). If a previous
  // session pulled an owner's circle.deleted tombstone but the
  // circle:deleted event was lost (e.g., fired before the WebView was
  // loaded — the queue-until-loaded pattern only protects deeplink and
  // notification:focus), the local circles:joined record is still here
  // and the autobase view shows deleted=true. Tear down silently — the
  // user already missed the in-app notice on the prior session, so a
  // fresh notification on every cold-start would be noise.
  for (const [circleId, base] of Array.from(_circleBases)) {
    try {
      const circleRow = await base.view.get('circle')
      if (circleRow?.value?.deleted) {
        await tearDownCircleLocally(circleId)
      }
    } catch (e) {
      console.warn('[bare] stale-deleted check failed for', circleId, e?.message)
    }
  }

  // Populate the in-process geofence tracker from each circle's current
  // view. Places landing later via apply branch will be added there too.
  // Initial classification is null; the first location:update establishes
  // the baseline silently so a cold start while inside a Place doesn't
  // fire a spurious "arrived" notification.
  _circlePlaces.clear()
  for (const [circleId, base] of _circleBases) {
    try {
      for await (const { value } of base.view.createReadStream({ gt: 'place:', lt: 'place:~' })) {
        if (value && !isDeleted(value)) trackPlace(circleId, value)
      }
    } catch (e) {
      console.warn('[bare] failed to enumerate places for', circleId, e?.message)
    }
  }

  // Sweep: for every circle where we're a writer, make sure our member
  // row exists. Catches the case where we became writable while the app
  // was offline (or in an earlier session before the auto-append was
  // wired) and never got around to publishing our row.
  for (const [circleId] of _circleBases) {
    autoAppendMemberRow(circleId).catch(() => {})
  }

  // Worklet-level membership sweep. Runs even when the UI isn't open
  // (the foreground service keeps the bare process alive in the
  // background) so a fresh-joined circle gets our member row appended
  // promptly regardless of HomeMapView's polling cadence.
  setInterval(() => {
    for (const [circleId] of _circleBases) {
      autoAppendMemberRow(circleId).catch(() => {})
    }
  }, 5000)

  // Load per-circle sharing state (default visible per circle). Mutes
  // with expired timestamps fire immediately via armCircleExpiryTimer.
  // Also migrates and clears any legacy global `sharing` row.
  try { await loadPersistedSharing() } catch (e) {
    console.warn('[bare] loadPersistedSharing failed', e?.message)
  }

  // Cold-boot self-position preload. Loads the most recent lastSeen
  // we previously wrote into any writable circle so the home-screen
  // empty-state and the self pin have something to render before the
  // first organic location:update arrives. Local-only: nothing is
  // republished from this value — peers see our position freshness
  // through their swarm-connected dot plus our actual location writes
  // (proposal 2026-05-17-swarm-live-signal). The heartbeat republish
  // that motivated this preload's earlier incarnation is gone.
  try {
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    let newest = null
    for (const [, base] of _circleBases) {
      if (!base.writable) continue
      const row = await base.view.get('lastSeen:' + ourKey).catch(() => null)
      const v = row?.value
      if (v && typeof v.ts === 'number' && (!newest || v.ts > newest.ts)) {
        newest = v
      }
    }
    if (newest) {
      _selfLastSeen = newest
      mark('coldboot:selfLastSeen:preloaded', { ageMs: Date.now() - newest.ts })
    }
  } catch (e) {
    console.warn('[bare] selfLastSeen preload failed', e?.message)
  }

  // Peer-trip notification toggle. Default on; only flip if the user
  // explicitly opted out (persisted false). Missing row = default state.
  try {
    const row = await _localDb.get('tripNotifications')
    if (row?.value?.enabled === false) _tripNotificationsEnabled = false
  } catch {}

  _initialized = true
  mark('init:done', { circles: _circleBases.size })

  // Trip retention sweep. Run once on boot to claw back space from
  // anything that aged past the cutoff while the worklet was down,
  // then on a 6h cadence. Fire-and-forget; failures are logged inside
  // pruneOldTrips and never block the boot path. Cheap (read-stream
  // + a handful of deletes per circle) so a fixed cadence beats
  // anything cleverer.
  const TRIP_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
  pruneOldTrips().then((r) => mark('trip:prune:boot', r))
    .catch((e) => console.warn('[bare] pruneOldTrips boot failed', e?.message))
  setInterval(() => {
    pruneOldTrips().then((r) => mark('trip:prune:interval', r))
      .catch((e) => console.warn('[bare] pruneOldTrips interval failed', e?.message))
  }, TRIP_PRUNE_INTERVAL_MS)
  // Reconcile iOS CLCircularRegion state once init completes. Even
  // when zero places exist, this clears any stale OS-side regions
  // left over from a prior install. trackPlace calls during apply
  // also fire scheduled pushes via the debouncer, so this final call
  // is mostly a "ensure-at-least-once" guarantee.
  schedulePushRegionsToShell()
  // Phase-4 device verification side-channel: ship the buffered
  // cold-start trace to the shell so it can write it to
  // FileSystem.documentDirectory/coldstart.log. On a real iPhone the
  // os_log stream isn't reachable from a remote shell without root,
  // and bare-fs writes inside the worklet didn't materialize a file
  // (suspected bare-fs/iOS sandbox interaction). The shell-side
  // expo-file-system path is known-good. Android-side: the shell
  // ignores this event; logcat already has the same lines.
  send({ event: 'coldstart:trace', data: { lines: _coldStartLines.slice() } })
  send({
    event: 'ready',
    data: {
      publicKey: b4a.toString(_identity.publicKey, 'hex'),
      // Shell uses anyEnabled to decide whether to start the foreground
      // location service on cold start; if every circle is muted, skip
      // the FGS until the user resumes sharing.
      sharingAnyEnabled: anyCircleEnabled(),
    },
  })
}

let buffer = ''
BareKit.IPC.on('data', async (chunk) => {
  buffer += chunk.toString()
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (!line.trim()) continue

    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg.method === 'init') {
      try {
        await init(msg.args ?? {})
        send({ id: msg.id, result: { ok: true } })
      } catch (err) {
        send({ id: msg.id, error: err?.message ?? String(err) })
      }
      continue
    }

    const handler = handlers[msg.method]
    if (!handler) {
      send({ id: msg.id, error: `unknown method: ${msg.method}` })
      continue
    }
    try {
      const result = await handler(msg.args ?? {})
      send({ id: msg.id, result })
    } catch (err) {
      send({ id: msg.id, error: err?.message ?? String(err) })
    }
  }
})
