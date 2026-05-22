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
const { generateCircleId, generateCircleKey, generateEncryptionKey, generatePlaceId } = require('./circle')
const { buildInvite, parseInvite, buildSeedInvite } = require('./invite')
const { detectSeedMode, loadOrCreateSeederIdentity, createSeederHandlers, enrollSeedInvite } = require('./seeder')
const { topicForCircleKey } = require('./swarm')
const { setupPairChannel, PAIR_PROTOCOL } = require('./pair')
const Protomux = require('protomux')
const { signValue, verifyValue, verifyValueWithSigner } = require('./lib/sign')
const { shouldAcceptSeederRow, buildSeederRevoke, buildSeederAdmission } = require('./lib/seederApply')
const { setupSeederAdmissionChannel } = require('./seederAdmission')
const { setupSeederSyncChannel } = require('./seederSync')
const { classifySeederConnection } = require('./lib/seederPeerFilter')
const { recordBlockReceived, removeBlockTracking, runSeederRetentionSweep } = require('./lib/seederRetention')
const { revocationNoticeFor, recordRevocationNotice, clearRevocationNotice, loadRevokedCircles } = require('./lib/seederRevocation')
const { circleIsDeleted, memberHiddenByLeft, memberHiddenByRemoved, shouldAcceptRemovedRow } = require('./lib/circleFilter')
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
// Active IPC handler map, swapped in by init based on mode. Defaults to
// member-mode `handlers` (declared below); seed-mode init reassigns to
// the restricted seeder handlers from src/seeder.js. The dispatcher at
// the bottom of this file consults _activeHandlers, never `handlers`
// directly, so a seed-mode worklet cannot accidentally route a member
// IPC method (proposal 2026-05-19-blind-seeder-peers Q3 resolution:
// mode is fixed at process launch and not mixable).
let _activeHandlers = null
let _seedMode = false

const _circlePeers = new Map()    // circleId → Set<remotePublicKeyHex>
const _topicToCircle = new Map()  // topicHex → circleId
const _circleBases = new Map()    // circleId → Autobase instance
// Seed-mode only: per-circle replication state. Each entry holds the
// bootstrap Hypercore session + the swarm discovery handle so leave can
// tear both down cleanly. Empty in member mode.
const _seederCircles = new Map()  // circleId → { core, topicHex, discovery }
// Seed-mode only: circleIds that carry a seeder:revoked:{circleId} local
// row. Mirrors the persisted rows in memory so the per-block download hook
// can clear a revocation cheaply when replication resumes (proposal
// 2026-05-21 question 4). Populated at boot from loadRevokedCircles.
const _seederRevokedCircles = new Set()
// Member-side: live member-role seeder-admission channels, so
// circle:seeder:revoke can push a revocation notice to a connected seeder
// at once instead of waiting for the next connection (proposal 2026-05-21
// amendment). conn → Map(circleId → { pubkeyHex, sendRevoked }).
const _memberAdmissionChannels = new Map()
// conn → remote pubkey hex. Lets openPairChannelsForCircle key the
// registry above by seeder pubkey when all it has is the connection.
const _connPubkey = new Map()
// Active Hyperswarm connections (post-handshake, pre-close). Tracked so
// circle:join can open the pair channel for a newly-added circle on
// every live connection. Hyperswarm reuses one connection per peer
// pair regardless of how many topics they share, so a connection
// established before a circle existed has no pair channel for that
// circle unless we open it explicitly post-hoc.
// Proposal 2026-05-18-pair-channel-on-circle-add.
const _activeConns = new Set()
// Seed-mode active connections. Tracked so a circle auto-enrolled after
// a connection already exists can open its admission channel on that
// connection — Hyperswarm reuses one connection per peer pair, so a new
// topic join emits no fresh `connection` event. Member-mode equivalent
// is _activeConns. Proposal amendment 2026-05-20 (blind-seeder auto-follow).
const _seederActiveConns = new Set()
// Open member-side seeder-sync channels. One per live connection; each
// entry is { resend }. The channel sends the seed bundle only when the
// remote is a followed seeder (checked at send time), so a channel to a
// plain member peer just sits idle. circle:create / circle:join and the
// follow toggle call every resend so a new circle (or a freshly-followed
// seeder) picks up the bundle without waiting for a reconnect.
// Proposal amendment 2026-05-20 (blind-seeder auto-follow).
const _memberSyncChannels = new Set()
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

// Adaptive-mode escalation inputs (proposal 2026-05-21). The 2026-05-16
// design drove the mode from trip phase alone, which left the idle-trap:
// in "idle" mode location:update fires only on ~500m SLC events, so a
// trip starting while idle wasn't seen until ~500m in. These two
// trip-detector-independent signals escalate to "tracking" promptly.
let _appForeground = false   // RN AppState 'active'; set via the app:state IPC
let _motionMoving = false    // CoreMotion reported the device moving (iOS)
let _motionRecentUntil = 0   // motion still counts as "recent" until this ms timestamp
let _motionGraceTimer = null // re-runs the driver when the grace window lapses
// True once the first real location:update has been processed. The
// driver must not emit "idle" before this: native startUpdatesNow only
// begins continuous delivery when its mode is "tracking", so a premature
// "idle" (from an app:state event that lands before native startUpdates)
// would suppress the very first GPS fix entirely.
let _locationUpdateSeen = false
// Q3: hold "tracking" for this long after motion stops before allowing
// a step-down, so a brief stop (red light, gas station, the user
// briefly backgrounding the app mid-walk) doesn't flap the radio.
const MOTION_GRACE_MS = 2 * 60 * 1000

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

// IPC duplex. On mobile the RN shell exposes BareKit.IPC. On a standalone
// bare-runtime CLI launch (the desktop blind-seeder launcher spawns
// `bare src/bare.js --seed`) BareKit is undefined; bridge to bare-process
// stdio so the host parent can pipe the same JSON-newline IPC over the
// subprocess's stdin/stdout.
//
// Outbound IPC is a synchronous write straight to fd 1: bare-stdio wraps a
// piped stdout in a buffered pipe stream that does not flush to the parent
// until the worklet exits, which deadlocks the host's init handshake.
const _bareProcess = typeof BareKit === 'undefined' ? require('bare-process') : null
const _bareFs = _bareProcess ? require('bare-fs') : null
const _ipcRead = _bareProcess ? _bareProcess.stdin : BareKit.IPC
const _ipcWrite = (buf) => _bareProcess ? _bareFs.writeSync(1, buf) : BareKit.IPC.write(buf)

const send = (msg) => _ipcWrite(Buffer.from(JSON.stringify(msg) + '\n'))

// Motion counts as "recent" while CoreMotion still reports the device
// moving, or within MOTION_GRACE_MS of the last moving->stationary
// transition (the Q3 step-down grace window).
function motionIsRecent () {
  return _motionMoving || Date.now() < _motionRecentUntil
}

// Adaptive iOS location-mode driver (proposals 2026-05-16, 2026-05-21).
// Recomputes the desired native CLLocationManager mode from the three
// escalation inputs (trip phase, app foreground, recent motion) and
// emits location:mode:set only on an actual change. Called from the
// location:update, app:state, and motion:changed handlers and from the
// motion grace timer. The shell ignores the event on non-iOS platforms,
// so it is safe to run unconditionally.
function runLocationModeDriver () {
  const nextMode = nextEmittedMode(
    _lastAdaptiveMode,
    {
      phase: _tripState.phase,
      appForeground: _appForeground,
      recentMotion: motionIsRecent(),
      locationStarted: _locationUpdateSeen,
    },
    ADAPTIVE_LOCATION_MODE_ENABLED,
  )
  if (nextMode != null) {
    _lastAdaptiveMode = nextMode
    send({ event: 'location:mode:set', data: { mode: nextMode } })
  }
}

const handlers = {
  'ping': async () => ({ ok: true, ts: Date.now() }),

  // RN AppState foreground/background, forwarded from app/index.tsx.
  // Foreground pins the adaptive location mode to "tracking" (proposal
  // 2026-05-21) so an opened map shows fresh positions including the
  // user's own; backgrounding hands control back to the trip-phase and
  // motion escalations.
  'app:state': async ({ state } = {}) => {
    _appForeground = state === 'active'
    runLocationModeDriver()
    return { state, appForeground: _appForeground }
  },

  // CoreMotion activity transition from the iOS native module (proposal
  // 2026-05-21). A stationary->moving change escalates the adaptive
  // location mode to "tracking" without waiting on the trip detector,
  // closing the idle-trap. On moving->stationary the Q3 grace window
  // holds "tracking" a while longer before a step-down is allowed.
  'motion:changed': async ({ moving } = {}) => {
    const isMoving = moving === true
    if (_motionGraceTimer) { clearTimeout(_motionGraceTimer); _motionGraceTimer = null }
    if (isMoving) {
      _motionMoving = true
    } else {
      _motionMoving = false
      _motionRecentUntil = Date.now() + MOTION_GRACE_MS
      // Nothing else fires once the device is sitting still, so arm a
      // timer to re-run the driver when the grace window lapses --
      // otherwise the mode would stay "tracking" indefinitely.
      _motionGraceTimer = setTimeout(() => {
        _motionGraceTimer = null
        runLocationModeDriver()
      }, MOTION_GRACE_MS)
    }
    runLocationModeDriver()
    return { moving: isMoving, recentMotion: motionIsRecent() }
  },

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
    // Per-circle block-encryption key. Always-on for new circles (proposal
    // 2026-05-19-blind-seeder-peers Q1 resolution). Distinct from circleKey
    // so a blind seeder holding the swarm topic seed cannot derive enc.
    const encryptionKey = generateEncryptionKey()
    const encryptionKeyBuf = b4a.from(encryptionKey, 'hex')
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
      encryptionKey: encryptionKeyBuf,
    })
    await base.ready()
    _circleBases.set(circleId, base)
    const bootstrap = b4a.toString(base.local.key, 'hex')

    // Append initial replicated records per proposal §3 schema.
    await base.append({
      type: 'put',
      key: 'circle',
      value: { id: circleId, name, ownerKey: ownerPublicKey, createdAt, encrypted: true, v: 1 },
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
      encryptionKey,
      role: 'owner',
      createdAt,
    })

    const invite = buildInvite({ circleId, name, circleKey, bootstrap, encryptionKey, inviterPublicKey: ownerPublicKey })

    joinCircleTopic(circleId, circleKey)
    // Open pair + admission channels for the new circle on any live
    // connection (e.g. an existing connection to a followed seeder for
    // another circle) so the seeder's announce can be received here.
    openPairChannelsForCircle(circleId, base)

    // Auto-follow (proposal amendment 2026-05-20): push the updated
    // bundle to followed seeders so the new circle seeds, and write the
    // admission rows directly — the founder is the writer here, so the
    // seeder shows up in every member's Seeders list immediately with no
    // announce handshake.
    repushFollowedSeeders().catch(() => {})
    admitFollowedSeedersToCircle(circleId, base).catch(() => {})

    return { circleId, circleKey, bootstrap, encryptionKey, name, ownerPublicKey, createdAt, invite }
  },

  'circle:join': async ({ invite } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof invite !== 'string') throw new Error('invite must be a string')

    const parsed = parseInvite(invite)
    if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)

    const { circleId, name, circleKey, bootstrap, inviterPublicKey, encryptionKey } = parsed

    // Idempotent: if we already have a record (owner or member), return it
    // unchanged. The owner re-scanning their own invite must not be demoted
    // to 'member', and a member re-scanning the same invite is a no-op.
    const existing = await _localDb.get('circles:joined:' + circleId)
    if (existing) return { ...existing.value, alreadyJoined: true }

    // Open the per-circle Autobase as a reader. Replication populates the
    // view once a writer connects. addWriter (slice 6E) flips writable=true.
    // encryptionKey is null for legacy unencrypted invites; in that case
    // Autobase opens without block encryption (proposal 2026-05-19 Compat).
    const ns = _store.namespace(circleId)
    const baseOpts = {
      open: openCircleView,
      apply: (nodes, view, b) => applyCircleNodes(nodes, view, b, circleId),
      valueEncoding: 'json',
    }
    if (encryptionKey) baseOpts.encryptionKey = b4a.from(encryptionKey, 'hex')
    const base = new Autobase(ns, b4a.from(bootstrap, 'hex'), baseOpts)
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
    if (encryptionKey) record.encryptionKey = encryptionKey
    await _localDb.put('circles:joined:' + circleId, record)

    // Auto-follow: push the updated bundle to followed seeders so the
    // joined circle seeds too (proposal amendment 2026-05-20).
    repushFollowedSeeders().catch(() => {})

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
    // No base.update(): same cold-boot discovery stall as snapshotCircle
    // (see the note there). Read the on-disk view directly.
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
    const { name, circleKey, bootstrap, encryptionKey } = record.value
    const inviterPublicKey = b4a.toString(_identity.publicKey, 'hex')
    const invite = buildInvite({ circleId, name, circleKey, bootstrap, encryptionKey, inviterPublicKey })
    return { invite, name }
  },

  // Mint a seed-only invite for a circle the local device is a member of.
  // Proposal 2026-05-19-blind-seeder-peers slice 3b. The seed invite uses
  // the /circle/seed path and intentionally omits any encryption-key field
  // so a blind seeder consuming it cannot decrypt circle content. The
  // optional label is for the inviter's own record-keeping and is NOT
  // baked into the URL (it lands on the seeder:{pubkey} row at admission
  // time in slice 3d).
  'circle:invite:seed': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const record = await _localDb.get('circles:joined:' + circleId)
    if (!record?.value) throw new Error('not a member of that circle')
    const { name, circleKey, bootstrap } = record.value
    const inviterPublicKey = b4a.toString(_identity.publicKey, 'hex')
    const invite = buildSeedInvite({ circleId, name, circleKey, bootstrap, inviterPublicKey })
    return { invite, name }
  },

  // List the current (non-revoked) seeders for a circle the local device
  // is a member of. Proposal 2026-05-19-blind-seeder-peers slice 3b.
  // Reads the autobase view's `seeder:` prefix; the apply branch already
  // rejected malformed / unauthorized rows, so consumers can trust the
  // shape returned here. Settings UI in slice 4 renders this list.
  'circle:seeders:list': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    const seeders = []
    for await (const { value } of base.view.createReadStream({
      gt: 'seeder:',
      lt: 'seeder:~',
    })) {
      if (!value || value.revoked === true) continue
      seeders.push({
        pubkey: value.pubkey,
        addedBy: value.addedBy,
        addedAt: value.addedAt,
        updatedAt: value.updatedAt,
        label: typeof value.label === 'string' ? value.label : null,
      })
    }
    return { seeders }
  },

  // Mint seed invites for every encrypted circle this device is in,
  // newline-joined into one bundle. Proposal amendment 2026-05-19
  // (global seeder setup): a seeder operator wants one device covering
  // all their circles, so the UI mints the whole set in one action.
  // Legacy unencrypted circles can't take a blind seeder (no encryption
  // boundary to hide behind) — they're skipped and counted. Each bundle
  // line is an independent /circle/seed URL that round-trips through
  // parseSeedInvite; no new invite grammar.
  'circle:invite:seed:all': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const { entries, skipped } = await collectSeedInvites()
    return {
      bundle: entries.map((e) => e.invite).join('\n'),
      invites: entries.map(({ circleId, name }) => ({ circleId, name })),
      skipped,
    }
  },

  // Every seeder across every circle this device is in, grouped by
  // seeder pubkey so the Settings UI renders one row per seeder device
  // (each listing the circles it covers). Proposal amendment 2026-05-19
  // (global seeder setup). Includes revoked rows with a revoked flag so
  // the UI can show per-circle state.
  'seeders:listAll': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const byPubkey = new Map()
    for (const [circleId, base] of _circleBases) {
      let circleName = circleId.slice(0, 8)
      try {
        const circleRow = await base.view.get('circle')
        if (circleRow?.value?.name) circleName = circleRow.value.name
      } catch {}
      try {
        for await (const { value } of base.view.createReadStream({
          gt: 'seeder:',
          lt: 'seeder:~',
        })) {
          if (!value || typeof value.pubkey !== 'string') continue
          let entry = byPubkey.get(value.pubkey)
          if (!entry) {
            entry = { pubkey: value.pubkey, label: null, followed: false, circles: [] }
            byPubkey.set(value.pubkey, entry)
          }
          if (!entry.label && typeof value.label === 'string') entry.label = value.label
          entry.circles.push({ circleId, name: circleName, revoked: value.revoked === true })
        }
      } catch {}
    }
    // Mark which seeders are followed (auto-enrolled in new circles).
    // Proposal amendment 2026-05-20 (blind-seeder auto-follow).
    for (const entry of byPubkey.values()) {
      entry.followed = await isFollowedSeeder(entry.pubkey)
    }
    return { seeders: Array.from(byPubkey.values()) }
  },

  // Toggle a seeder as "followed" — when on, this device auto-pushes
  // seed invites for every circle it creates/joins to that seeder over
  // the seeder-sync channel, and auto-approves its announces. Off by
  // default; the user opts in per device. Proposal amendment 2026-05-20.
  'circle:seeder:follow:set': async ({ pubkey, enabled } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof pubkey !== 'string' || pubkey.length !== 64) {
      throw new Error('pubkey must be a 64-char hex string')
    }
    if (enabled) {
      await _localDb.put('seederfollow:' + pubkey, { pubkey, since: Date.now() })
      // Push the current bundle immediately if we already have an open
      // sync channel to this seeder (it just became followed).
      repushFollowedSeeders().catch(() => {})
    } else {
      await _localDb.del('seederfollow:' + pubkey).catch(() => {})
    }
    return { ok: true, pubkey, enabled: !!enabled }
  },

  // Revoke an admitted seeder. Proposal 2026-05-19-blind-seeder-peers
  // slice 3b. Writes a tombstone row signed by the local member. Apply
  // branch + peer-filter (slice 3d) enforce the revocation across the
  // fleet: members refuse swarm connections to revoked seeder pubkeys.
  // Idempotent on already-revoked rows in the sense that re-revoking
  // just bumps updatedAt; harmless. Refuses on absent rows so callers
  // get a clear error rather than a silent no-op.
  'circle:seeder:revoke': async ({ circleId, pubkey } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof pubkey !== 'string' || pubkey.length !== 64) {
      throw new Error('pubkey must be a 64-char hex string')
    }
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')
    const existingNode = await base.view.get('seeder:' + pubkey)
    const existing = existingNode?.value
    if (!existing) throw new Error('no seeder with that pubkey in this circle')
    const revokerPubkeyHex = b4a.toString(_identity.publicKey, 'hex')
    const unsigned = buildSeederRevoke({ existing, revokerPubkeyHex, now: Date.now() })
    if (!unsigned) throw new Error('existing seeder row is malformed; cannot revoke')
    const signed = signValue(unsigned, _identity.secretKey)
    await base.append({ type: 'put', key: 'seeder:' + pubkey, value: signed })
    // Push the content-blind notice to the seeder over any live connection
    // right away, so its dashboard updates without waiting for a reconnect
    // (proposal 2026-05-21 amendment). Best-effort.
    notifySeederRevoked(circleId, pubkey, unsigned.revokedAt)
    return { ok: true, circleId, pubkey }
  },

  // Admit a seeder (fresh or re-admit) for a circle the local device is a
  // member of. Proposal 2026-05-19-blind-seeder-peers slice 3d. Called by
  // the shell when the user approves a seeder:announced prompt OR when the
  // user wants to re-admit a previously-revoked seeder via Settings.
  // The seeder pubkey is signed into the row by the local member (writer
  // field); apply branch ensures the writer is a current circle member.
  'circle:seeder:approve': async ({ circleId, pubkey, label } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof pubkey !== 'string' || pubkey.length !== 64) {
      throw new Error('pubkey must be a 64-char hex string')
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      throw new Error('label must be a string if provided')
    }
    return approveSeederRow(circleId, pubkey, label)
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

  // Owner-only member removal (proposal 2026-05-03 §3). Appends a
  // `removed:{pubkey}` tombstone. Owner-write only: the apply branch
  // accepts it solely from the bootstrap writer. The tombstone rides the
  // owner's bootstrap core -- the most reliably replicated core in the
  // circle -- so it converges to every member. snapshotCircle then hides
  // the member and the pubkey-keyed apply branches drop their later
  // writes; the removed member's own device tears the circle down via
  // the circle:removed-self event.
  'circle:remove': async ({ circleId, pubkey } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof pubkey !== 'string' || pubkey.length === 0) throw new Error('pubkey must be a string')
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    const ourKeyHex = b4a.toString(_identity.publicKey, 'hex')
    if (pubkey === ourKeyHex) throw new Error('the owner cannot remove themselves')
    const circleRow = await base.view.get('circle')
    if (!circleRow?.value) throw new Error('circle metadata missing')
    if (circleRow.value.ownerKey !== ourKeyHex) {
      throw new Error('only the owner can remove members')
    }
    if (circleRow.value.deleted) throw new Error('this circle has been deleted')
    if (!base.writable) throw new Error('not yet a writer for this circle')
    await base.append({
      type: 'put',
      key: 'removed:' + pubkey,
      value: { pubkey, removedBy: ourKeyHex, ts: Date.now(), v: 1 },
    })
    return { ok: true, pubkey }
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
    // Continuous delivery is confirmed up: the driver may now step the
    // native side down to "idle" when escalations go quiet.
    _locationUpdateSeen = true
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
      // Re-evaluate the adaptive location mode now that trip phase may
      // have changed. The foreground and motion escalations re-run the
      // driver from their own IPC handlers.
      runLocationModeDriver()
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
  // No base.update() here. On a cold boot Autobase's update() blocks
  // until Hyperswarm peer discovery flushes -- 40+ seconds when a
  // circle's members are offline (confirmed on-device 2026-05-22 via the
  // snapshot:slow trace). circles:getAll polls this every ~3s, so a
  // blocking update froze the whole circle list and map. The view core
  // is already on disk and Autobase auto-applies replicated data into
  // it, so reading it directly returns last-known state instantly and
  // the re-poll converges as the swarm warms up. The in-flight update()
  // also serialized base.append() behind it on the same base, delaying
  // the device's own location writes -- dropping it frees that too.
  // circle:join / circle:create keep their own explicit update() where
  // a synchronous wait is genuinely required.
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
  // Owner-kicked members (proposal 2026-05-03 §3). Like `left:`, a
  // `removed:` tombstone hides the member only while its `ts` beats
  // their member-row joinedAt -- a fresh rejoin (newer joinedAt)
  // overrides it, so removal is reversible by rejoining.
  const removedAtByPubkey = new Map()
  for await (const { key, value } of view.createReadStream({ gt: 'removed:', lt: 'removed:~' })) {
    const pubkey = key.slice('removed:'.length)
    if (typeof value?.ts === 'number') removedAtByPubkey.set(pubkey, value.ts)
  }
  const members = []
  for await (const { key, value } of view.createReadStream({ gt: 'member:', lt: 'member:~' })) {
    if (memberHiddenByRemoved(removedAtByPubkey.get(value?.pubkey), value?.joinedAt)) continue
    const leftAt = leftAtByPubkey.get(value?.pubkey)
    if (memberHiddenByLeft(leftAt, value?.joinedAt)) continue
    members.push({ key, value })
  }
  const lastSeen = {}
  for await (const { key, value } of view.createReadStream({ gt: 'lastSeen:', lt: 'lastSeen:~' })) {
    const pubkey = key.slice('lastSeen:'.length)
    if (removedAtByPubkey.has(pubkey) || leftAtByPubkey.has(pubkey)) {
      const memberRow = await view.get('member:' + pubkey)
      if (memberHiddenByRemoved(removedAtByPubkey.get(pubkey), memberRow?.value?.joinedAt)) continue
      if (memberHiddenByLeft(leftAtByPubkey.get(pubkey), memberRow?.value?.joinedAt)) continue
    }
    lastSeen[pubkey] = value
  }
  const presence = {}
  for await (const { key, value } of view.createReadStream({ gt: 'presence:', lt: 'presence:~' })) {
    const pubkey = key.slice('presence:'.length)
    if (removedAtByPubkey.has(pubkey) || leftAtByPubkey.has(pubkey)) {
      const memberRow = await view.get('member:' + pubkey)
      if (memberHiddenByRemoved(removedAtByPubkey.get(pubkey), memberRow?.value?.joinedAt)) continue
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
      // `removed:{pubkey}` (proposal 2026-05-03 §3): owner-only kick
      // tombstone, gated by shouldAcceptRemovedRow (bootstrap-writer
      // authored, well-formed, key matches value), LWW on `ts`. Removal
      // is NOT permanent: snapshotCircle hides the member only while
      // removed.ts beats their member-row joinedAt, so a fresh rejoin
      // overrides it -- same rule as the `left:` tombstone. If the
      // tombstone names our own identity AND post-dates our current join
      // we emit circle:removed-self so the shell shows a notice and
      // tears the circle down; gating on the local circles:joined
      // joinedAt stops a stale removed: row from bouncing us again after
      // we have rejoined.
      if (op.key.startsWith('removed:')) {
        const fromHex = b4a.toString(node.from.key, 'hex')
        const keyPubkey = op.key.slice('removed:'.length)
        if (!shouldAcceptRemovedRow({ fromHex, bootstrapHex, keyPubkey, value: op.value })) continue
        const existingRemoved = (await view.get(op.key))?.value
        if (existingRemoved && typeof existingRemoved.ts === 'number' &&
            typeof op.value?.ts === 'number' && op.value.ts <= existingRemoved.ts) continue
        await view.put(op.key, op.value)
        if (circleId && typeof op.value?.ts === 'number') {
          const ourKeyHex = _identity && b4a.toString(_identity.publicKey, 'hex')
          if (ourKeyHex && keyPubkey === ourKeyHex) {
            try {
              const joinedRec = await _localDb.get('circles:joined:' + circleId).catch(() => null)
              const localJoinedAt = joinedRec?.value?.joinedAt
              if (typeof localJoinedAt === 'number' && op.value.ts > localJoinedAt) {
                const circleRow = await view.get('circle')
                send({ event: 'circle:removed-self', data: {
                  circleId,
                  circleName: circleRow?.value?.name || 'Circle',
                }})
              }
            } catch (e) { console.warn('[bare] circle:removed-self emit failed', e?.message) }
          }
        }
        continue
      }
      // `member:*`: any current writer. A removed member's rejoin is a
      // fresh member: row with a newer joinedAt; storing it is what
      // overrides the removed: tombstone (see snapshotCircle).
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
        // Soft-removal: the writer counts as removed only while a
        // removed: ts still beats their member-row joinedAt; a rejoin
        // clears it (same rule as snapshotCircle).
        const writerRemovedRow = (await view.get('removed:' + incoming.writer))?.value
        const writerRemoved = memberHiddenByRemoved(writerRemovedRow?.ts, writerMember?.joinedAt)
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
      setTimeout(() => {
        autoAppendMemberRow(myCircleId).catch(() => {})
        autoAppendSelfLastSeen(myCircleId).catch(() => {})
      }, 0)
    }
  }
}

async function autoAppendMemberRow (circleId) {
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const existing = await base.view.get('member:' + ourKey)
  if (existing && existing.value) {
    // A member row already exists, so joinedAt normally stays stable --
    // a left: / removed: tombstone hides us only while its ts beats
    // joinedAt, and a periodic rewrite would keep bumping joinedAt and
    // defeat that. The exception is a rejoin: if such a tombstone
    // currently hides us, rewrite the row with a fresh joinedAt so the
    // tombstone is out-dated and peers see us again. Without this a
    // rejoining member keeps the stale joinedAt and stays hidden on
    // every other device (their own still shows them via self-inject).
    const leftRow = await base.view.get('left:' + ourKey)
    const removedRow = await base.view.get('removed:' + ourKey)
    const hidden =
      memberHiddenByLeft(leftRow?.value?.leftAt, existing.value.joinedAt) ||
      memberHiddenByRemoved(removedRow?.value?.ts, existing.value.joinedAt)
    if (!hidden) return
  }
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

// Backfill our last-known position into a circle we just gained write
// access to. location:update writes lastSeen only to circles writable at
// the instant the native event fires, so a circle joined afterwards has
// no position for us until the next native event. On a stationary iPhone
// in significant-location-change mode that wait can be very long, leaving
// us as "no location yet" to the other members. Seeding _selfLastSeen on
// becoming a writer makes us visible right away. One-shot per circle: it
// is skipped once any lastSeen for us exists, so it never overwrites a
// fresher organic write and is not a periodic heartbeat.
async function autoAppendSelfLastSeen (circleId) {
  if (!_selfLastSeen) return
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return
  if (!getCircleSharing(circleId).enabled) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const existing = await base.view.get('lastSeen:' + ourKey)
  if (existing && existing.value) return
  try {
    await base.append({ type: 'put', key: 'lastSeen:' + ourKey, value: _selfLastSeen })
  } catch {
    // base closed / raced an organic location:update; the 5s sweep retries
  }
}

async function mountCircleAutobase (circleId, bootstrapHex, encryptionKeyHex) {
  if (_circleBases.has(circleId)) return _circleBases.get(circleId)
  const ns = _store.namespace(circleId)
  const baseOpts = {
    open: openCircleView,
    apply: (nodes, view, b) => applyCircleNodes(nodes, view, b, circleId),
    valueEncoding: 'json',
  }
  if (encryptionKeyHex) baseOpts.encryptionKey = b4a.from(encryptionKeyHex, 'hex')
  const base = new Autobase(ns, b4a.from(bootstrapHex, 'hex'), baseOpts)
  await base.ready()
  _circleBases.set(circleId, base)
  openPairChannelsForCircle(circleId, base)
  return base
}

// Seed-mode counterpart of mountCircleAutobase. Opens the bootstrap
// Hypercore for the circle (via corestore namespace) so corestore.replicate
// can offer it to connecting member peers, then joins the swarm topic so
// peers find this seeder. Proposal 2026-05-19-blind-seeder-peers slice 3c.
//
// What this does NOT do: open the circle's Autobase, decrypt any blocks,
// or call any apply branch. The seeder is a dumb block-forwarder for the
// bootstrap core. View core + later writer cores reach the seeder via
// corestore's on-demand session opening as peers ask for them through
// the replication mux — provided the seeder has those cores in its store.
// Multi-writer circles will need the slice 3d admission protocol to push
// additional writer-core keys to the seeder; v1 of this slice only
// guarantees bootstrap-core replication.
async function mountSeederCircle (enrollment) {
  const { circleId, circleKey, bootstrap } = enrollment
  if (_seederCircles.has(circleId)) return _seederCircles.get(circleId)
  const ns = _store.namespace(circleId)
  const core = ns.get({ key: b4a.from(bootstrap, 'hex') })
  await core.ready()
  // Track per-block receive time so the retention sweep can drop blocks
  // older than the user's pruneOlderThan threshold. Proposal 2026-05-19
  // slice 5. The 'download' event fires per block as replication
  // progresses; receivedAt is when the seeder first stored the block,
  // not when the member wrote it (which we can't read without the
  // encryption key).
  const onDownload = (index) => {
    recordBlockReceived(_localDb, circleId, index, Date.now()).catch((e) => {
      console.warn('[bare] seeder block-track failed', circleId, index, e?.message)
    })
    // Proposal 2026-05-21 question 4: a downloaded block is unspoofable
    // proof that this circle's members are replicating to the seeder
    // again, so clear any stale revocation notice. The in-memory set
    // keeps the per-block path a cheap has() check; the del runs once,
    // on the revoked -> active transition.
    if (_seederRevokedCircles.has(circleId)) {
      _seederRevokedCircles.delete(circleId)
      clearRevocationNotice(_localDb, circleId)
        .then(() => mark('seeder:revocation-cleared', { circleId }))
        .catch((e) => console.warn('[bare] seeder revocation-clear failed', circleId, e?.message))
    }
    // Coarse instrumentation: log every 10th block so the seeder.log
    // shows replication progress without flooding on a fast initial sync.
    if (index % 10 === 0 || index < 5) {
      mark('seeder:block-downloaded', { circleId, index, length: core.length, contiguousLength: core.contiguousLength })
    }
  }
  core.on('download', onDownload)
  // Hypercore's default replication is reactive — peers exchange "have"
  // bitfields and the core fetches blocks the peer offers. On a fresh
  // mount the seeder may not actively pull historical blocks until a
  // get() is called. Force a background download of every block so the
  // seeder can serve the full core to other peers even when no member
  // is requesting via the seeder. linear:false lets blocks arrive in
  // any order; the retention sweep doesn't care.
  core.download({ start: 0, end: -1, linear: false })
  const topic = topicForCircleKey(circleKey)
  const topicHex = b4a.toString(topic, 'hex')
  _topicToCircle.set(topicHex, circleId)
  const discovery = _swarm.join(topic, { server: true, client: true })
  _seederCircles.set(circleId, { core, topicHex, discovery, onDownload })
  mark('seeder:mounted', { circleId, bootstrap: bootstrap.slice(0, 8), authorityLength: core.length, contiguousLength: core.contiguousLength })
  // Open the seed-role admission channel for this circle on every
  // existing connection. New connections get it via onSeederSwarmConnection;
  // this covers circles auto-enrolled after a connection already formed,
  // so the seeder can announce itself for them (proposal amendment
  // 2026-05-20). At boot _seederActiveConns is empty — harmless no-op.
  const seederPubkeyHex = b4a.toString(_identity.publicKey, 'hex')
  for (const conn of _seederActiveConns) {
    setupSeederAdmissionChannel({
      conn,
      role: 'seed',
      circleId,
      seederPubkey: seederPubkeyHex,
      onRevoked: handleSeederRevocationNotice,
      mark,
    })
    mark('seeder:announce-channel-open', { circleId, remote: 'post-mount' })
  }
  return _seederCircles.get(circleId)
}

// Seed-mode handler for an inbound revocation notice on the admission
// channel. Advisory and UI-only (proposal 2026-05-21 question 1): records
// the seeder:revoked:{circleId} local row so seeder:enrolled:list can flag
// the circle, and takes no automatic or network action — the seeder keeps
// announcing and joining the topic so re-admission stays instant. Only
// records for an enrolled circle; the admission channel is per-circle and
// opened only for enrolled circles, so this gate is belt-and-suspenders.
async function handleSeederRevocationNotice ({ circleId, revokedAt }) {
  if (!_seederCircles.has(circleId)) {
    mark('seeder:revocation-notice-unenrolled', { circleId })
    return
  }
  try {
    await recordRevocationNotice(_localDb, { circleId, revokedAt, now: Date.now() })
    _seederRevokedCircles.add(circleId)
    mark('seeder:revocation-noticed', { circleId, revokedAt })
  } catch (e) {
    mark('seeder:revocation-record-failed', { circleId, err: e?.message ?? String(e) })
  }
}

// One pass of the seeder retention sweep. Reads pruneOlderThan from the
// seeder:retention:{circleId} sidecar for every currently-mounted circle;
// pure helper picks the stale block seqs; we call core.clear + drop the
// per-block tracker row. Proposal 2026-05-19-blind-seeder-peers slice 5.
async function runOneSeederRetentionSweep () {
  return runSeederRetentionSweep({
    localDb: _localDb,
    enrolledCircles: Array.from(_seederCircles.keys()),
    getRetentionMs: async (circleId) => {
      const row = await _localDb.get('seeder:retention:' + circleId)
      const v = row?.value?.pruneOlderThan
      return typeof v === 'number' ? v : null
    },
    clearBlock: async (circleId, seq) => {
      const entry = _seederCircles.get(circleId)
      if (!entry?.core) return
      try {
        await entry.core.clear(seq, seq + 1)
      } finally {
        await removeBlockTracking(_localDb, circleId, seq).catch(() => {})
      }
    },
    now: Date.now(),
  })
}

async function leaveSeederCircle (circleId) {
  _seederRevokedCircles.delete(circleId)
  const entry = _seederCircles.get(circleId)
  if (!entry) return
  try {
    const topic = b4a.from(entry.topicHex, 'hex')
    await _swarm.leave(topic).catch(() => {})
  } catch {}
  _topicToCircle.delete(entry.topicHex)
  if (entry.onDownload && entry.core) {
    try { entry.core.off('download', entry.onDownload) } catch {}
  }
  try { await entry.core.close() } catch {}
  _seederCircles.delete(circleId)
  mark('seeder:left', { circleId })
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
// Open the per-circle Protomux channels (pair + seeder-admission) for a
// circle on every live connection. Needed when a circle is mounted after
// connections already exist — Hyperswarm reuses one connection per peer
// pair, so a new topic join emits no fresh `connection` event and the
// onSwarmConnection per-circle setup never runs for it. Proposal
// 2026-05-18 (pair) + amendment 2026-05-20 (admission, for auto-follow).
// Member-role seeder-admission channel setup + registration. Stores the
// channel's revoke-sender in _memberAdmissionChannels keyed by
// (conn, circleId) so circle:seeder:revoke can push a notice to a live
// seeder at once. Proposal 2026-05-21-seeder-revocation-signal amendment.
function setupMemberAdmissionChannel (conn, circleId, base, revokedNotice) {
  const result = setupSeederAdmissionChannel({
    conn,
    role: 'member',
    circleId,
    onAnnounce: (msg) => handleSeederAnnounce(circleId, base, msg, conn),
    revokedNotice: revokedNotice ?? null,
    mark,
  })
  if (!result || typeof result.sendRevoked !== 'function') return
  const pubkeyHex = _connPubkey.get(conn)
  if (!pubkeyHex) return
  let perConn = _memberAdmissionChannels.get(conn)
  if (!perConn) {
    perConn = new Map()
    _memberAdmissionChannels.set(conn, perConn)
  }
  perConn.set(circleId, { pubkeyHex, sendRevoked: result.sendRevoked })
}

// Push a revocation notice to any live connection to `pubkey` for this
// circle. Best-effort: if the seeder is not currently connected, the
// connect-time send (revokedNotice on channel open) covers the next
// connection. Proposal 2026-05-21 amendment.
function notifySeederRevoked (circleId, pubkey, revokedAt) {
  let sent = 0
  for (const perConn of _memberAdmissionChannels.values()) {
    const entry = perConn.get(circleId)
    if (entry && entry.pubkeyHex === pubkey && entry.sendRevoked(revokedAt)) sent++
  }
  if (sent > 0) {
    mark('seeder:revoke-notice-pushed', { circleId, pubkey: pubkey.slice(0, 8), sent })
  }
}

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
    // Member-role admission channel — without this a seeder that
    // auto-enrolls (or is invited to) a circle created after the
    // connection formed could never have its announce received.
    setupMemberAdmissionChannel(conn, circleId, base)
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

// Collect a seed invite for every encrypted circle this device is in.
// Shared by circle:invite:seed:all (the manual bundle mint) and the
// seeder-sync channel's getBundle (auto-follow push). Legacy unencrypted
// circles are skipped + counted. Proposal amendments 2026-05-19/-05-20.
async function collectSeedInvites () {
  const inviterPublicKey = b4a.toString(_identity.publicKey, 'hex')
  const entries = []
  let skipped = 0
  for await (const { value } of _localDb.createReadStream({
    gt: 'circles:joined:',
    lt: 'circles:joined:~',
  })) {
    if (!value || !value.circleId) continue
    if (!value.encryptionKey) { skipped++; continue }
    const { circleId, name, circleKey, bootstrap } = value
    const invite = buildSeedInvite({ circleId, name, circleKey, bootstrap, inviterPublicKey })
    entries.push({ circleId, name, invite })
  }
  return { entries, skipped }
}

// Is this pubkey a followed seeder (auto-enroll new circles into it)?
// Proposal amendment 2026-05-20 (blind-seeder auto-follow).
async function isFollowedSeeder (pubkeyHex) {
  if (typeof pubkeyHex !== 'string' || pubkeyHex.length !== 64) return false
  const row = await _localDb.get('seederfollow:' + pubkeyHex).catch(() => null)
  return !!row?.value
}

// Re-push the seed bundle over every open member-side sync channel. Each
// channel's getBundle re-checks followed-status at send time, so this
// both feeds new circles to existing followed seeders and starts feeding
// a seeder the moment its follow toggle is flipped on.
async function repushFollowedSeeders () {
  for (const entry of _memberSyncChannels) {
    try { await entry.resend() } catch {}
  }
}

// Seed-mode trust gate: is this pubkey the inviter of a circle this
// seeder is already enrolled in? Only such members may auto-push more
// circles over the sync channel, so a random peer can't spam the seeder
// into enrolling. Proposal amendment 2026-05-20 (blind-seeder auto-follow).
async function isKnownInviter (pubkeyHex) {
  if (typeof pubkeyHex !== 'string' || pubkeyHex.length === 0) return false
  for await (const { value } of _localDb.createReadStream({
    gt: 'seeder:enrolled:',
    lt: 'seeder:enrolled:~',
  })) {
    if (value?.inviter === pubkeyHex) return true
  }
  return false
}

// Write a signed seeder:{pubkey} admission row. Extracted from the
// circle:seeder:approve IPC so the auto-approve path (followed seeders)
// can reuse it. Proposal 2026-05-19 slice 3d + 2026-05-20 amendment.
async function approveSeederRow (circleId, pubkey, label) {
  const base = _circleBases.get(circleId)
  if (!base) throw new Error('unknown circle: ' + circleId)
  if (!base.writable) throw new Error('not yet a writer for this circle')
  const existingNode = await base.view.get('seeder:' + pubkey).catch(() => null)
  const existing = existingNode?.value ?? null
  const adminPubkeyHex = b4a.toString(_identity.publicKey, 'hex')
  const unsigned = buildSeederAdmission({
    seederPubkey: pubkey,
    adminPubkeyHex,
    label,
    existing,
    now: Date.now(),
  })
  if (!unsigned) throw new Error('cannot build admission row from given input')
  const signed = signValue(unsigned, _identity.secretKey)
  await base.append({ type: 'put', key: 'seeder:' + pubkey, value: signed })
  return { ok: true, circleId, pubkey, reAdmit: existing !== null }
}

// Member-side handler for a seeder's admission announce. A first-time
// announce (no seeder:{pubkey} row yet) is auto-admitted — the approval
// prompt was dropped (proposal amendment 2026-05-20): a blind seeder
// carries no encryption key, the row stays visible to every member, and
// revoke is one-tap, so a human consent gate added friction without
// payoff.
//
// Revocation is durable (proposal 2026-05-21-seeder-revocation-signal
// amendment, revises 2026-05-20): an announce from an *already-revoked*
// seeder is NOT a re-admission request. Re-admission is an explicit
// Settings action (circle:seeder:approve). Such an announce only means
// the seeder reconnected or mounted the circle late, so we re-send the
// revocation notice — this both keeps the revoke in force and closes the
// race where the seeder mounted the circle after we connected and so
// missed the connect-time notice.
async function handleSeederAnnounce (circleId, base, { pubkey, label }, conn) {
  const existingNode = await base.view.get('seeder:' + pubkey).catch(() => null)
  const existing = existingNode?.value ?? null
  // Already admitted (non-revoked): nothing to do.
  if (existing && existing.revoked !== true) {
    mark('admission:dedup', { circleId, seeder: pubkey.slice(0, 8) })
    return
  }
  // Already revoked: keep the revocation, re-send the notice, do not admit.
  if (existing && existing.revoked === true) {
    mark('admission:announce-from-revoked', { circleId, seeder: pubkey.slice(0, 8) })
    const entry = conn ? _memberAdmissionChannels.get(conn)?.get(circleId) : null
    if (entry) {
      entry.sendRevoked(typeof existing.revokedAt === 'number' ? existing.revokedAt : null)
    }
    return
  }
  // No row yet — first admission. Frictionless auto-admit.
  if (!base.writable) {
    mark('admission:not-writable', { circleId, seeder: pubkey.slice(0, 8) })
    return
  }
  try {
    await approveSeederRow(circleId, pubkey, label ?? undefined)
    mark('admission:auto-admitted', { circleId, seeder: pubkey.slice(0, 8) })
    send({ event: 'seeder:admitted', data: { circleId, pubkey } })
  } catch (e) {
    mark('admission:auto-admit-failed', { circleId, err: e?.message ?? String(e) })
  }
}

// Write seeder:{pubkey} admission rows for every followed seeder into a
// circle's autobase. Called on circle:create so an auto-followed
// seeder's admission lands immediately and locally — no dependence on a
// cross-device announce handshake. Proposal amendment 2026-05-20.
async function admitFollowedSeedersToCircle (circleId, base) {
  if (!base?.writable) return
  for await (const { value } of _localDb.createReadStream({
    gt: 'seederfollow:',
    lt: 'seederfollow:~',
  })) {
    const pubkey = value?.pubkey
    if (typeof pubkey !== 'string' || pubkey.length !== 64) continue
    try {
      await approveSeederRow(circleId, pubkey)
      mark('seeder:auto-admitted-followed', { circleId, seeder: pubkey.slice(0, 8) })
    } catch (e) {
      mark('seeder:auto-admit-failed', { circleId, err: e?.message ?? String(e) })
    }
  }
}

// Seed-mode swarm connection handler. Proposal 2026-05-19-blind-seeder-peers
// slice 3d. Pipes corestore replication (so encrypted blocks flow) and opens
// the admission Protomux channel for each enrolled circle whose topic is
// reachable through this connection.
function onSeederSwarmConnection (conn, info) {
  try { _store.replicate(conn) } catch (e) {
    console.warn('[bare] seeder replicate failed', e?.message)
  }
  // Track for post-mount admission-channel opening (auto-follow enrolls
  // circles after a connection already exists).
  _seederActiveConns.add(conn)
  conn.once('close', () => _seederActiveConns.delete(conn))
  const remotePublicKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex') : null
  const seederPubkeyHex = b4a.toString(_identity.publicKey, 'hex')
  // Figure out which enrolled circles this connection belongs to. info.topics
  // is asymmetric (often empty on the announce side); fall back to "any
  // enrolled circle" so the announce reaches the member regardless of which
  // direction the connection went. Protomux unmatched channels are harmless.
  const candidateCircleIds = []
  if (info?.topics && info.topics.length > 0) {
    for (const topicBuf of info.topics) {
      const topicHex = b4a.toString(topicBuf, 'hex')
      const cid = _topicToCircle.get(topicHex)
      if (cid && _seederCircles.has(cid)) candidateCircleIds.push(cid)
    }
  } else {
    for (const cid of _seederCircles.keys()) candidateCircleIds.push(cid)
  }
  for (const circleId of candidateCircleIds) {
    const enrollment = _seederCircles.get(circleId)
    setupSeederAdmissionChannel({
      conn,
      role: 'seed',
      circleId,
      seederPubkey: seederPubkeyHex,
      label: enrollment?.label,
      onRevoked: handleSeederRevocationNotice,
      mark,
    })
    if (remotePublicKey) {
      mark('seeder:announce-channel-open', { circleId, remote: remotePublicKey.slice(0, 8) })
    }
  }

  // Seeder-sync receiver (proposal amendment 2026-05-20, auto-follow). A
  // followed member pushes its full seed bundle here; auto-enroll any
  // circle not yet enrolled. Trust gate: only accept from a member that
  // is the inviter of an existing enrollment, so a random peer can't
  // spam this seeder into enrolling in arbitrary circles.
  setupSeederSyncChannel({
    conn,
    role: 'seed',
    onBundle: async ({ invites }) => {
      if (!await isKnownInviter(remotePublicKey)) {
        mark('seedersync:untrusted-push', { remote: (remotePublicKey || '?').slice(0, 8) })
        return
      }
      for (const invite of invites) {
        try {
          const r = await enrollSeedInvite({ invite, localDb: _localDb, mountCircle: mountSeederCircle })
          if (!r.alreadyEnrolled) mark('seedersync:auto-enrolled', { circleId: r.circleId })
        } catch (e) {
          mark('seedersync:enroll-failed', { err: e?.message ?? String(e) })
        }
      }
    },
    mark,
  })
}

async function onSwarmConnection (conn, info) {
  const remotePublicKey = b4a.toString(info.publicKey, 'hex')

  // Seeder revocation enforcement (slice 3d + 2026-05-19 amendment).
  // A seeder revoked in *every* circle it has a row in should stop
  // receiving blocks — but we must NOT destroy the connection. The
  // admission Protomux channel rides this same connection; destroying it
  // permanently bricks re-admission (the seeder could never re-announce,
  // making the proposal's "re-admit by writing a fresh row" impossible).
  // So: skip corestore replication for a revoked-everywhere seeder, but
  // keep the connection + admission channels alive. A seeder still
  // admitted in some circle keeps replicating — it is blind, so a
  // revoked circle's blocks are ciphertext to it (bandwidth cost only).
  // seeder:{pubkey} rows for the remote peer, captured per circle during
  // classification and reused below to emit revocation notices (proposal
  // 2026-05-21) without a second autobase read.
  const seederRowByCircle = new Map()
  let replicate = true
  try {
    const cls = await classifySeederConnection({
      remotePubkeyHex: remotePublicKey,
      circleIds: Array.from(_circleBases.keys()),
      getSeederRow: async (cid, pk) => {
        const base = _circleBases.get(cid)
        if (!base) return null
        const node = await base.view.get('seeder:' + pk)
        const row = node?.value ?? null
        seederRowByCircle.set(cid, row)
        return row
      },
    })
    if (cls === 'revoked-everywhere') {
      replicate = false
      mark('peer-filter:revoked-seeder-no-replicate', { remote: remotePublicKey.slice(0, 8) })
    }
  } catch {}
  if (conn.destroyed) return

  // Pipe corestore replication first so cores can negotiate before we
  // emit peer:connected — UI typically calls circle:get right after that
  // event and we want the view to be fresh. Skipped for a revoked-
  // everywhere seeder; the admission channels below still get set up so
  // the seeder can re-announce.
  if (replicate) _store.replicate(conn)
  _activeConns.add(conn)
  _connPubkey.set(conn, remotePublicKey)
  registerPairNotify(conn)

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
    // Seeder admission receiver. Proposal 2026-05-19 slice 3d. Unmatched
    // channels (peer isn't a seeder) close harmlessly. The announce
    // handler dedupes / auto-approves / emits seeder:announced.
    //
    // revokedNotice: if this circle has revoked the remote peer as a
    // seeder, the channel pushes a content-blind revocation notice on
    // open so the seeder's dashboard stops listing the circle (proposal
    // 2026-05-21). Non-seeder peers have no seeder:{pubkey} row, so
    // revocationNoticeFor returns null and nothing is sent.
    setupMemberAdmissionChannel(
      conn, circleId, base,
      revocationNoticeFor(circleId, seederRowByCircle.get(circleId)),
    )
  }

  // Member-side seeder-sync channel (proposal amendment 2026-05-20,
  // auto-follow). Set up on every connection — getBundle only emits the
  // seed bundle when the remote is a followed seeder, so a channel to a
  // plain member peer stays idle. Registered in _memberSyncChannels so
  // circle:create / circle:join / the follow toggle can re-push.
  const syncChannel = setupSeederSyncChannel({
    conn,
    role: 'member',
    getBundle: async () => {
      if (!await isFollowedSeeder(remotePublicKey)) return []
      const { entries } = await collectSeedInvites()
      return entries.map((e) => e.invite)
    },
    mark,
  })
  if (syncChannel) {
    const entry = { resend: syncChannel.resend }
    _memberSyncChannels.add(entry)
    conn.once('close', () => _memberSyncChannels.delete(entry))
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
    _memberAdmissionChannels.delete(conn)
    _connPubkey.delete(conn)
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

async function init ({ dataDir, mode } = {}, attempt = 0) {
  if (_initialized) {
    const pubkey = _seedMode
      ? b4a.toString(_identity.publicKey, 'hex')
      : b4a.toString(_identity.publicKey, 'hex')
    send({ event: 'ready', data: { mode: _seedMode ? 'seed' : 'member', publicKey: pubkey } })
    return
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('init requires { dataDir: string }')
  }
  mark('init:start', { attempt, mode: mode ?? 'member' })

  // Retry on lock errors: BareKit may restart the worklet before the prior
  // instance has released the corestore lock file.
  try {
    _store = new Corestore(dataDir + '/pearcircle/store')
    await _store.ready()
  } catch (e) {
    if (e?.message?.includes('lock') && attempt < 20) {
      await new Promise(r => setTimeout(r, 1000))
      return init({ dataDir, mode }, attempt + 1)
    }
    throw e
  }

  mark('init:store-ready')

  const localCore = _store.get({ name: 'local' })
  await localCore.ready()
  _localDb = new Hyperbee(localCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await _localDb.ready()

  // Seed-mode branch (proposal 2026-05-19-blind-seeder-peers slices 2 + 3c).
  // Load (or generate) the seeder identity, stand up Hyperswarm wired to
  // corestore replication, mount every persisted enrollment, and install
  // the restricted handler map. No member-mode IPC surface, no Autobase
  // instance — the seeder replicates encrypted blocks at the Hypercore
  // protocol level without ever decrypting them.
  if (detectSeedMode({ mode })) {
    const seederIdentity = await loadOrCreateSeederIdentity(_localDb)
    _identity = seederIdentity
    _seedMode = true
    mark('init:identity-ready', { fresh: seederIdentity.fresh, mode: 'seed' })

    _swarm = new Hyperswarm({ keyPair: _identity })
    _swarm.on('connection', onSeederSwarmConnection)
    mark('init:swarm-created', { mode: 'seed' })

    _activeHandlers = createSeederHandlers({
      localDb: _localDb,
      identity: seederIdentity,
      mountCircle: mountSeederCircle,
      leaveCircle: leaveSeederCircle,
      // Sum byteLength across every mounted seeder core. Hypercore 11's
      // contiguousByteLength is a stub that returns 0 (hypercore/index.js
      // line 631), so we can't use it. byteLength is the AUTHORITY total
      // — would normally over-report by including blocks not yet
      // downloaded — but the open-ended core.download() in mountSeederCircle
      // means the seeder proactively pulls everything, so authority and
      // actual-downloaded converge within a short window.
      getReplicatedBytes: () => {
        let total = 0
        for (const entry of _seederCircles.values()) {
          if (entry?.core?.byteLength) total += entry.core.byteLength
        }
        return total
      },
    })

    // Mirror persisted seeder:revoked:* rows into the in-memory set so the
    // per-block download hook can clear a revocation when replication
    // resumes (proposal 2026-05-21 question 4). Loaded before the remount
    // loop because mountSeederCircle starts core.download() right away.
    const revokedAtBoot = await loadRevokedCircles(_localDb)
    for (const cid of revokedAtBoot.keys()) _seederRevokedCircles.add(cid)
    mark('seeder:revoked-loaded', { count: _seederRevokedCircles.size })

    // Re-mount every persisted enrollment so a process restart picks up
    // where the seeder left off.
    let mountedCount = 0
    for await (const { value } of _localDb.createReadStream({
      gt: 'seeder:enrolled:',
      lt: 'seeder:enrolled:~',
    })) {
      if (!value || !value.circleId || !value.bootstrap || !value.circleKey) continue
      try {
        await mountSeederCircle(value)
        mountedCount++
      } catch (e) {
        console.warn('[bare] seeder remount failed', value.circleId, e?.message)
      }
    }
    mark('init:circles-mounted', { mode: 'seed', count: mountedCount })

    // Schedule the retention sweep. Once on boot to claw back disk from
    // anything that aged past the cutoff while the seeder was down, then
    // on a 24h cadence. Fire-and-forget per the existing trip-prune
    // pattern; pure helper handles all the I/O.
    const SEEDER_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
    runOneSeederRetentionSweep().then((r) => mark('seeder:retention:boot', r))
      .catch((e) => console.warn('[bare] seeder retention boot failed', e?.message))
    setInterval(() => {
      runOneSeederRetentionSweep().then((r) => mark('seeder:retention:interval', r))
        .catch((e) => console.warn('[bare] seeder retention interval failed', e?.message))
    }, SEEDER_RETENTION_INTERVAL_MS)

    _initialized = true
    mark('init:done', { mode: 'seed' })
    return
  }

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
      try { await mountCircleAutobase(value.circleId, value.bootstrap, value.encryptionKey) } catch (e) {
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
      autoAppendSelfLastSeen(circleId).catch(() => {})
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
  // first organic location:update arrives. Beyond the self pin, this
  // value is seeded once into a circle when we become its writer (see
  // autoAppendSelfLastSeen) so a freshly joined device shows up for the
  // other members without waiting on the next native fix. It is never
  // republished periodically; peers see ongoing freshness through their
  // swarm-connected dot plus our actual location writes (proposal
  // 2026-05-17-swarm-live-signal). The heartbeat republish that
  // motivated this preload's earlier incarnation is gone.
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

  _activeHandlers = handlers
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
_ipcRead.on('data', async (chunk) => {
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

    const activeHandlers = _activeHandlers ?? handlers
    const handler = activeHandlers[msg.method]
    if (!handler) {
      // Distinguish "unknown" from "method exists in member mode but is
      // not exposed in seed mode" so callers can detect mode mismatch
      // without inspecting the worklet shape. The seeder handler map is
      // strictly smaller than the member map; methods present in
      // `handlers` but absent in seeder handlers fall here when the
      // worklet booted in seed mode.
      if (_seedMode && handlers[msg.method]) {
        send({ id: msg.id, error: 'not-permitted-in-seed-mode' })
      } else {
        send({ id: msg.id, error: `unknown method: ${msg.method}` })
      }
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
