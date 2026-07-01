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
const { generateCircleId, generateRendezvousKey, generateCircleKey, generateEncryptionKey, generatePlaceId } = require('./circle')
const { buildInvite, parseInvite, buildSeedInvite, buildSeederPairLink, parseSeederPairLink, inviteCircleIdMismatch } = require('./invite')
const { detectSeedMode, loadOrCreateSeederIdentity, createSeederHandlers, enrollSeedInvite } = require('./seeder')
const { topicForCircleKey, seederPairTopic } = require('./swarm')
const { setupPairChannel, PAIR_PROTOCOL } = require('./pair')
const { setupSeederPairChannel } = require('./seederPair')
const { setupLiveChannel, LIVE_PROTOCOL } = require('./liveLocation')
const { mergeLiveLastSeen } = require('./lib/liveLastSeen')
const { openSelfCore, openPeerCore, appendFix, readTip } = require('./memberLastKnown')
const Protomux = require('protomux')
const { signValue, verifyValue, verifyValueWithSigner } = require('./lib/sign')
const { shouldAcceptSeederRow, buildSeederRevoke, buildSeederAdmission, buildSeederGone } = require('./lib/seederApply')
const { shouldAcceptSupersede } = require('./lib/supersedeApply')
const { setupSeederAdmissionChannel } = require('./seederAdmission')
const { setupSeederSyncChannel } = require('./seederSync')
const { classifySeederConnection } = require('./lib/seederPeerFilter')
const { recordBlockReceived, removeBlockTracking, runSeederRetentionSweep, rangeForWriterCircle, recordWriterBlockReceived, removeWriterBlockTracking, runSeederWriterRetentionSweep } = require('./lib/seederRetention')
const { revocationNoticeFor, recordRevocationNotice, clearRevocationNotice, loadRevokedCircles } = require('./lib/seederRevocation')
const { circleIsDeleted, memberHiddenByLeft, memberHiddenByRemoved, shouldAcceptRemovedRow } = require('./lib/circleFilter')
const { haversineMeters, classify, applyRegionEvent, selectNearestRegions, regionAppendDecision, MIN_PLACE_RADIUS_M } = require('./lib/geofence')
const geofencePersist = require('./lib/geofencePersist')
const { shouldAppendLastSeen } = require('./lib/lastSeenGate')
const { allMembersAnnouncedCore } = require('./lib/lastSeenCutover')
const { resolveCircleName } = require('./lib/circleName')
const { createStoreFlusher, createStoreCompactor } = require('./lib/storeFlush')
const { buildExport, validateImport } = require('./lib/circleExport')
const { raceAppend, withTimeout, APPEND_TIMEOUT_MS, READ_TIMEOUT_MS } = require('./lib/appendTimeout')
const { shouldSwallowFault, parseConflictLog } = require('./lib/conflictSeatbelt')
const { writerRewindStatus } = require('./lib/rewindGuard')
const { handleNetworkChange } = require('./lib/networkChange')
const { newTripState, stepTrip } = require('./lib/trip')
const { nextEmittedMode } = require('./lib/locationMode')
const { padTripStartTs, tripApplyDecision, shouldReplicateTrip, mergeTripStreams } = require('./lib/tripWire')
const { TRIP_RETENTION_MS, tripIsExpired } = require('./lib/tripRetention')
const { TRANSITION_RETENTION_MS, transitionIsExpired } = require('./lib/transitionRetention')

// Reject values stamped more than 5 minutes in the future against the local
// clock (proposal §5). Catches replay/forgery and clock skew on the writer.
const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000
// Bound a background peer last-known tip fetch so a never-served block can't
// leave a get() pending forever (proposal 2026-06-04-lastseen-ephemeral 2a).
const PEER_TIP_FETCH_TIMEOUT_MS = 15000

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

// Re-ship the accumulated mark buffer to the shell so it overwrites
// coldstart.log with the latest lines. The buffered trace is otherwise only
// shipped once at init:done; this lets late, rare marks (e.g. the first live
// broadcast/receive, proposal 2026-06-04 phase 1) reach the pulled log on a
// debug build where worklet console.warn does not hit logcat. Called only on
// bounded one-shot events, never per location update, so no IPC flood.
function reshipTrace () {
  try { send({ event: 'coldstart:trace', data: { lines: _coldStartLines.slice() } }) } catch {}
}

const _firstPeerMarked = new Set()      // circleIds with peer:first-connected emitted
const _firstWriterMarked = new Set()    // circleIds with writer:first-added emitted
const _firstLastSeenWriteMarked = new Set()   // circleIds with our first own lastSeen write
const _firstLastSeenRemoteMarked = new Set()  // circleIds where a non-self lastSeen has applied
const _firstLiveBroadcastMarked = new Set()   // circleIds where we first broadcast a live fix (proposal 2026-06-04 phase 1)
const _firstLiveRecvMarked = new Set()        // circleIds where we first received a peer's live fix
const _firstLastKnownWriteMarked = new Set()  // circleIds where we first appended our last-known core fix (proposal 2026-06-04 slice 2a)
const _firstPeerLastKnownMarked = new Set()   // circleIds where we first cached a peer's last-known core tip
const _seederLastknownTipMarked = new Set()   // coreKeyHex of peer last-known cores whose tip the seeder has replicated (slice 2b)

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
// Seeder build version, passed in by the launcher host at init (proposal
// 2026-06-05-seeder-update slice 1). Reported via seeder:status and announced
// to members so the app can surface "update available". null when unknown.
let _seederVersion = null
// Member-side: remote seeder pubkey hex → its reported build version, learned
// from the admission announce. Advisory + in-memory; surfaced by
// circle:seeders:list so the mobile app can flag out-of-date seeders.
const _seederVersions = new Map()

const _circlePeers = new Map()    // circleId → Set<remotePublicKeyHex>
const _topicToCircle = new Map()  // topicHex → circleId
const _circleBases = new Map()    // circleId → Autobase instance
// Ephemeral live position (proposal 2026-06-04-lastseen-ephemeral, phase 1).
// _liveLastSeen: circleId → Map<pubkeyHex, signed value> of the freshest fix
// received over the live protomux channel (never persisted). _liveByCircle:
// circleId → Map<conn, send(value)>, indexed by circle so broadcasting our fix
// touches only the peers on that circle (O(peers), not O(all connections) per
// fix — storage/sync audit 2026-06-22).
const _liveLastSeen = new Map()
const _liveByCircle = new Map()

// Live-channel index helpers (keep the circle→conn→send map consistent).
function liveChannelAdd (circleId, conn, sendFn) {
  let byConn = _liveByCircle.get(circleId)
  if (!byConn) { byConn = new Map(); _liveByCircle.set(circleId, byConn) }
  byConn.set(conn, sendFn)
}
function liveChannelHas (circleId, conn) {
  const byConn = _liveByCircle.get(circleId)
  return !!(byConn && byConn.has(conn))
}
function liveChannelDropConn (conn) {
  for (const byConn of _liveByCircle.values()) byConn.delete(conn)
}
function liveChannelDropCircle (circleId) {
  _liveByCircle.delete(circleId)
}
// Per-member last-known cores (proposal 2026-06-04-lastseen-ephemeral, slice 2a).
// The bounded, persisted offline fallback that will replace the Autobase
// lastSeen oplog write. _lastKnownSelfCores: circleId → our own single-writer
// Hypercore (append latest + clear earlier blocks). _lastKnownPeerCores:
// circleId → Map<pubkeyHex, core> opened by each peer's announced key.
// _lastKnownCache: circleId → Map<pubkeyHex, signed value> of the freshest tip
// we have downloaded, read into snapshotCircle's precedence overlay.
// _circleEncKeys: circleId → circle enc key hex (for opening the cores).
// _lastKnownAnnounced: circleIds whose self core key is published in the view.
const _lastKnownSelfCores = new Map()
const _lastKnownPeerCores = new Map()
const _lastKnownCache = new Map()
const _circleEncKeys = new Map()
const _lastKnownAnnounced = new Set()
// circleId → signature of the last-known core-key set last pushed to seeders,
// so the periodic re-push (slice 2b) only sends on a real delta.
const _lastSentLastknownSig = new Map()
// circleId → signature of the writer core-key set last pushed to seeders, so the
// periodic re-push (slice 3d) only sends when the writer set changes.
const _lastSentWriterSig = new Map()
// Phase-2 cutover (slice 3): circleIds whose Autobase lastSeen write we have
// stopped because every visible member announced a last-known core. Recomputed
// off the hot path (5s sweep); the location:update + appendLastSeen paths
// consult it. _forceAutobaseLastSeen is the keep-writing safety kill-switch.
const _lastSeenCutoverCircles = new Set()
const _cutoverBlockedMarked = new Set() // circleIds we've logged a cutover-blocked diagnostic for (re-armed on engage)
let _forceAutobaseLastSeen = false
const _degradedCircles = new Set() // circleIds whose base append/read timed out (wedged local Autobase); surfaced as needsRepair, persisted as circleDegraded:{id}, healed by nukeTip on boot / circle:repair (proposal 2026-06-03-autobase-append-hang)
const _repairingCircles = new Set() // circleIds whose circle:repair is in flight: rebuilt but still re-syncing / awaiting writer re-admission. Surfaced as `repairing`, persisted as circleRepairing:{id}, cleared when the base is writable again
const _repairStaged = new Set() // circleIds whose rebuild couldn't be mounted in-process (the in-app remount hangs) and is staged for the next app launch. In-memory only; surfaced as `repairStaged` so the UI asks the user to reopen the app. The OLD base stays mounted meanwhile so the circle never blanks.
let _lastConflictAt = 0 // ts of the most recent hypercore 'conflict' event; gates the post-conflict seatbelt so it only swallows a fork's fallout, not unrelated bugs (proposal 2026-06-27-fork-conflict-recovery)
const _rewoundCircles = new Set() // circleIds whose local writer core is behind the network (truncated); appends are blocked while the original tail downloads, then self-clears (proposal 2026-06-27 item 3)
let _faultHandlersInstalled = false // guards installFaultHandlers against re-running on init retry (lock-contention reattempts)
const _leavingCircles = new Set() // circleIds with a voluntary circle:leave in flight. Set before we append our left: tombstone, cleared on local teardown. Suppresses autoAppendMemberRow so the membership sweep doesn't mistake our just-written self-leave for a stale tombstone and resurrect our member row with a fresh joinedAt -- which would un-leave us on every peer (and fire a spurious member:joined).
const _lastGoodSnapshot = new Map() // circleId → last successful snapshotCircle result, served when a bounded snapshot times out so the UI stays populated (proposal 2026-06-03c)
const _lastAppendedPos = new Map() // circleId → { lat, lon } last written to lastSeen (movement-gate state, proposal 2026-05-29)
// Seed-mode only: per-circle replication state. Each entry holds the
// bootstrap Hypercore session + the swarm discovery handle so leave can
// tear both down cleanly. Empty in member mode.
const _seederCircles = new Map()  // circleId → { core, topicHex, discovery }
// Seed-mode only: circleIds that carry a seeder:revoked:{circleId} local
// row. Mirrors the persisted rows in memory so the per-block download hook
// can clear a revocation cheaply when replication resumes (proposal
// 2026-05-21 question 4). Populated at boot from loadRevokedCircles.
const _seederRevokedCircles = new Set()
// Seed-mode only: last-writer-wins clock per circle, keyed by circleId, value
// is the updatedAt/revokedAt of the most recent admission verdict we've applied
// to _seederRevokedCircles. The seeder row's updatedAt bumps on every
// revoke/admit, so both the `revoked` (revokedAt) and `admitted` (updatedAt)
// notices carry a value from the same monotonic clock. A notice older than the
// stored ts is stale — a not-yet-synced member re-asserting its lagging row —
// and is ignored so it can't flap the flag (proposal 2026-06-11-seeder-readmit).
// Seeded at boot from the persisted seeder:revoked:* revokedAt.
const _seederFlagTs = new Map()
// Member-side: live member-role seeder-admission channels, so
// circle:seeder:revoke can push a revocation notice to a connected seeder
// at once instead of waiting for the next connection (proposal 2026-05-21
// amendment). conn → Map(circleId → { pubkeyHex, sendRevoked }).
const _memberAdmissionChannels = new Map()
// conn → remote pubkey hex. Lets openPairChannelsForCircle key the
// registry above by seeder pubkey when all it has is the connection.
const _connPubkey = new Map()
// Per-circle Protomux channels (pair / member-admission / live) opened on
// the active connections. Tracked so tearDownCircleLocally can close them on
// leave: Protomux.createChannel refuses a duplicate protocol+id, so if a
// leave leaves these open on a still-live connection, an immediate rejoin in
// the same session can't recreate them (pair/admission/live:create-failed) --
// and the stale channels stay bound to the now-closed base. That breaks
// writer re-admission (the joiner can't re-advertise its writer key) and live
// presence on the rejoined circle. circleId → Set<channel>.
const _circleProtoChannels = new Map()
function trackCircleChannel (circleId, channel) {
  if (!channel) return
  let set = _circleProtoChannels.get(circleId)
  if (!set) { set = new Set(); _circleProtoChannels.set(circleId, set) }
  // Drop refs to channels that have since closed (e.g. their connection
  // dropped) so the set doesn't accumulate across reconnects.
  for (const ch of set) { if (ch.closed) set.delete(ch) }
  set.add(channel)
}
function closeCircleChannels (circleId) {
  const set = _circleProtoChannels.get(circleId)
  if (!set) return
  for (const ch of set) { try { ch.close() } catch {} }
  _circleProtoChannels.delete(circleId)
}
// Active Hyperswarm connections (post-handshake, pre-close). Tracked so
// circle:join can open the pair channel for a newly-added circle on
// every live connection. Hyperswarm reuses one connection per peer
// pair regardless of how many topics they share, so a connection
// established before a circle existed has no pair channel for that
// circle unless we open it explicitly post-hoc.
// Proposal 2026-05-18-pair-channel-on-circle-add.
const _activeConns = new Set()
// Member connections we've attached corestore replication to. A revoked-
// everywhere seeder is skipped (onSwarmConnection), so resumeSeederReplication
// can re-attach it on re-admit without double-attaching to a connection that
// already replicates (proposal 2026-06-11-seeder-readmit-resume-replication).
const _replicatingConns = new Set()
// Seed-mode active connections. Tracked so a circle auto-enrolled after
// a connection already exists can open its admission channel on that
// connection — Hyperswarm reuses one connection per peer pair, so a new
// topic join emits no fresh `connection` event. Member-mode equivalent
// is _activeConns. Proposal amendment 2026-05-20 (blind-seeder auto-follow).
const _seederActiveConns = new Set()
// Seed-mode: per-connection admission-channel send handles, so leaveSeederCircle
// can push the in-band `left` notice to currently-connected members before
// tearing the circle down (proposal 2026-06-17-seeder-leave-propagation).
// conn → Map<circleId, { sendLeft }>. Cleaned on connection close.
const _seederAdmissionChannels = new Map()
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
// Notified-trip dedup. Persisted across cold boots in the local Hyperbee
// (`tripNotify:seen`) so a trip notified once never re-notifies, which is what
// lets the freshness window below be generous instead of a 10-min cliff
// (proposal 2026-06-11-peer-trip-notification-freshness). Loaded into this set
// on init; _EMITTED_PEER_TRIP_MAX caps the in-memory set, _PERSISTED_TRIP_SEEN_MAX
// caps the persisted FIFO list.
const _emittedPeerTripKeys = new Set()
const _EMITTED_PEER_TRIP_MAX = 1024
const _PERSISTED_TRIP_SEEN_MAX = 512
// Suppress notifications for trips that ended before this device first started
// caring (set once on init, persisted as `tripNotify:baseline`), so a fresh
// install / first upgrade doesn't replay a circle's trip history as a burst of
// notifications. Loaded on init.
let _tripNotifyBaseline = null
// Backstop freshness window (was 10 min, a cliff that dropped late-replicating
// trips even though they're real). With the persisted dedup as the primary
// guard and the baseline suppressing first-sync history, this only bounds a
// long-absence catch-up: a device offline for days notifies for at most the
// last 24h of unseen trips, not weeks. Trips that end away and replicate in
// 10-20 min later now notify instead of being silently dropped.
const PEER_TRIP_FRESHNESS_MS = 24 * 60 * 60 * 1000
// Don't notify on micro-trips (GPS drift across the cooldown window can
// log a "trip" with a few meters of distance). Either bound flips the
// notification on. Trip record itself is always written; this only
// gates the OS notification.
const PEER_TRIP_MIN_DISTANCE_M = 500
const PEER_TRIP_MIN_DURATION_MS = 5 * 60 * 1000

// Member join / leave OS notifications ("Jane joined Family" / "Jane
// left Family"). Same dual gate the transition and peer-trip emits use:
// an in-session dedup set absorbs autobase re-applies, and a freshness
// window keeps a fresh device's historical-roster replay quiet. A join
// is a member: row whose joinedAt is fresh; a leave is a fresh left: /
// removed: tombstone. joinedAt is stable across profile edits (see the
// profile:set handler, which preserves it on a displayName/avatar
// change), so {circleId}:{pubkey}:{joinedAt} uniquely identifies one
// join and a rename never re-notifies.
const _emittedMemberJoinKeys = new Set()
const _emittedMemberLeaveKeys = new Set()
const _EMITTED_MEMBER_MAX = 1024
const MEMBER_NOTIF_FRESHNESS_MS = 10 * 60 * 1000

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

// Last transition kind we actually appended per place, keyed
// "{circleId}|{placeId}" → 'enter' | 'exit'. The in-memory classifier plus
// applyRegionEvent already dedup the common case, but they can't span the
// seams where two writer paths and a cold-boot restore disagree about the
// running state (observed 2026-06-10: a phantom exit followed by two enters
// for the same place in one circle, with no exit between). This guard makes
// the invariant structural — appendTransition refuses to write the same kind
// twice in a row for a place, so a duplicate enter/exit can never reach the
// autobase regardless of which path raced. Seeded from the persisted
// classification on boot; alternating real crossings always pass.
const _lastAppendedKind = new Map()

// Crossings detected while the writer wasn't ready to append them. Keyed by
// circleId|placeId, holding only the LATEST crossing per Place. This is the
// no-resurrection backstop for the native OS region path: iOS fires
// didEnterRegion/didExitRegion exactly once at the boundary, and on a
// suspended-app wake the autobase can still be opening or rebuilding (not yet
// writable) at that instant. Without this queue the crossing is dropped with
// no history and no notification, and because the persisted classification
// would advance, it never re-fires -- lost forever. Flushed from the 5s sweep
// and on foreground once the writer is writable (proposal 2026-07-01).
const _pendingTransitions = new Map()
// circleIds for which we've re-pushed the OS region set since the writer last
// became writable, so a registration that went stale while read-only self-heals.
const _regionsPushedForWriter = new Set()

// Rolling record of the last N geofence outcomes, surfaced in-app via
// geofence:diag so a missed crossing is observable on a production build with
// no devicectl access to the device (the affected phone is an App Store
// install, not a dev-provisioned one). Newest last.
const _geofenceLog = []
function logGeofence (ev, placeId, kind, extra) {
  _geofenceLog.push({ ev, place: placeId ? placeId.slice(0, 8) : null, kind: kind || null, at: Date.now(), ...(extra || {}) })
  if (_geofenceLog.length > 40) _geofenceLog.shift()
}

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
  _lastAppendedKind.delete(circleId + '|' + placeId)
  // Drop the persisted classification too so deleted places don't leave
  // stale geofence: rows on _localDb (proposal 2026-05-30).
  if (_localDb) geofencePersist.deleteClassification(_localDb, circleId, placeId).catch(() => {})
  schedulePushRegionsToShell()
}

// Persist a place's inside/outside classification to the local Hyperbee so a
// crossing that happens while the app is suspended or force-quit can be
// recovered on the first fix after the next wake, instead of being lost to the
// in-memory reset (which silently re-baselines and drops the transition).
// Local-only, never signed, never replicated (proposal 2026-05-30).
function persistClassification (circleId, placeId, classification, ts) {
  if (!_localDb) return Promise.resolve()
  return geofencePersist
    .persistClassification(_localDb, circleId, placeId, classification, ts)
    .catch((e) => console.warn('[bare] persistClassification failed', e?.message))
}

// Restore a place's persisted classification into the in-process tracker.
// Called during boot hydration, before _initialized flips (so before any
// location:update is processed). Only fills a null slot; never clobbers an
// in-session value, and ignores anything but a clean inside/outside.
async function restorePersistedClassification (circleId, placeId) {
  if (!_localDb) return
  const state = _circlePlaces.get(circleId + '|' + placeId)
  if (!state) return
  try {
    const restored = await geofencePersist.readClassification(_localDb, circleId, placeId)
    if (geofencePersist.shouldRestore(state.lastClassification, restored)) {
      state.lastClassification = restored
      // Seed the same-kind append guard so a redundant native region:enter (or
      // a re-baselined classifier) right after boot can't re-emit a transition
      // we already wrote in the previous session. inside ⟺ last crossing was an
      // enter; outside ⟺ exit. A genuine crossing flips the kind and passes.
      _lastAppendedKind.set(circleId + '|' + placeId, restored === 'inside' ? 'enter' : 'exit')
    }
  } catch (e) {
    console.warn('[bare] restorePersistedClassification failed', e?.message)
  }
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
// Re-rank the OS region set once the device has moved far enough that the
// nearest-N places may have changed (proposal 2026-05-30 fix 2, Q3). Big
// enough not to churn native setMonitoredRegions calls on every ~10s fix
// while stationary or on a short walk, small enough to follow a real drive.
const REGION_RERANK_MIN_MOVE_M = 500
let _regionsPushTimer = null
// Device's last known position, used to proximity-rank which Places win the
// limited OS region slots. Null before the first fix (we then fall back to
// insertion order). _lastRegionRankPos is the position captured at the last
// push, used to decide when a move warrants a re-rank.
let _lastDevicePos = null
let _lastRegionRankPos = null
function schedulePushRegionsToShell () {
  if (_regionsPushTimer) return
  _regionsPushTimer = setTimeout(() => {
    _regionsPushTimer = null
    pushRegionsToShell()
  }, REGIONS_PUSH_DEBOUNCE_MS)
}
function pushRegionsToShell () {
  // Keep the nearest Places (proposal 2026-05-30 fix 2). Compose circleId into
  // the id so the shell-side enter/exit handler can route back to the right
  // autobase without an extra lookup; the worklet splits it on '|'.
  const selected = selectNearestRegions([..._circlePlaces.values()], _lastDevicePos, REGIONS_HARD_CAP)
  const regions = selected.map((state) => ({
    id: state.circleId + '|' + state.placeId,
    lat: state.lat,
    lon: state.lon,
    // Floor the OS-region radius at the iOS reliability minimum. New Places
    // can't be created below it, but a legacy Place stored before that gate
    // still needs its OS geofence widened or iOS may never fire the wake.
    // The JS classifier keeps state.radiusMeters unchanged (see checkPlaceTransitions).
    radius: Math.max(state.radiusMeters, MIN_PLACE_RADIUS_M),
  }))
  _lastRegionRankPos = _lastDevicePos
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

  // Force a RocksDB memtable flush (truncates the WAL). Exposed for the
  // verify gate / recovery tooling; the worklet also flushes on a timer and
  // on background. See flushStore for the why (device 4fc221b3 WAL wedge).
  'store:flush': async ({ reason } = {}) => ({ flushed: await flushStore(reason || 'manual') }),

  // RN AppState foreground/background, forwarded from app/index.tsx.
  // Foreground pins the adaptive location mode to "tracking" (proposal
  // 2026-05-21) so an opened map shows fresh positions including the
  // user's own; backgrounding hands control back to the trip-phase and
  // motion escalations.
  'app:state': async ({ state } = {}) => {
    _appForeground = state === 'active'
    // Reset the lastSeen movement gate on foreground so the next fix
    // (typically the foreground one-shot, #63) always publishes a current
    // position even when the user is stationary (storage-growth
    // remediation, proposal 2026-05-29).
    if (_appForeground) _lastAppendedPos.clear()
    // On foreground, nudge connections so a stale socket from a network change
    // while backgrounded is shed before the user looks at the map (proposal
    // 2026-06-01).
    if (_appForeground) probeConnections('foreground')
    // Backgrounding is the most likely moment just before the OS kills or the
    // user swipes the app away, so flush the WAL now to keep the next cold
    // start's replay small (store maintenance). Fire-and-forget: never block
    // the IPC response on disk I/O, and flushStore swallows its own errors.
    if (!_appForeground) flushStore('background')
    // On foreground, drain any crossings that queued while the writer was
    // read-only and re-push the OS region set, so the map the user is about to
    // look at reflects reality promptly (proposal 2026-07-01).
    if (_appForeground) {
      flushAllPendingTransitions().catch(() => {})
      schedulePushRegionsToShell()
    }
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
    attachConflictListeners(base, circleId)
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

  // Export a circle's curated config (name + Places + per-circle toggles) as a
  // versioned, keyless JSON envelope (proposal 2026-06-17). Read-only.
  'circle:export': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    return buildExport(await readCircleConfigForExport(circleId))
  },

  // Create a brand-new circle from a previously-exported config envelope.
  // Always mints a fresh circle (the envelope carries no keys/ids); returns the
  // new circle's invite for the owner to share.
  'circle:import': async ({ payload } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    const result = validateImport(payload)
    if (!result.ok) throw new Error('invalid import: ' + result.error)
    const created = await createCircleFromConfig(result.value)
    return { circleId: created.circleId, name: created.name, invite: created.invite }
  },

  // In-app one-shot: recreate THIS circle on a fresh empty Autobase, keeping its
  // name + Places + toggles, and link the two locally so Settings can tell them
  // apart and guard the delete screen. Owner-only. Leaves the source untouched.
  'circle:recreate': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const sourceRec = await _localDb.get('circles:joined:' + circleId)
    if (!sourceRec) throw new Error('unknown circle: ' + circleId)
    if (sourceRec.value.role !== 'owner') throw new Error('only the circle owner can recreate it')

    const created = await createCircleFromConfig(await readCircleConfigForExport(circleId))
    const recreatedAt = Date.now()
    // Local-only links: distinguish the two same-named circles in Settings and
    // back the delete-confirmation guard (proposal 2026-06-17). No wire effect.
    const newRec = await _localDb.get('circles:joined:' + created.circleId)
    if (newRec) {
      await _localDb.put('circles:joined:' + created.circleId, { ...newRec.value, recreatedFrom: circleId, recreatedAt })
    }
    await _localDb.put('circles:joined:' + circleId, { ...sourceRec.value, recreatedTo: created.circleId, recreatedAt })

    // Post the in-band migration nudge into the OLD circle so upgraded members
    // get a one-tap "your group moved" prompt carrying the new invite (proposal
    // 2026-06-17 slice 3). Best-effort: a supersede failure (e.g. source not yet
    // writable) must not fail the recreate, which already succeeded.
    try {
      await handlers['circle:supersede']({ oldCircleId: circleId, newCircleId: created.circleId })
    } catch (e) { console.warn('[bare] circle:supersede during recreate failed', e?.message) }

    return { circleId: created.circleId, name: created.name, invite: created.invite, sourceCircleId: circleId }
  },

  // Post (or re-post) the owner-signed migration nudge into the OLD circle's
  // Autobase: a `supersede:{newCircleId}` record carrying the new circle's
  // invite, readable only by the old circle's current members (the view is
  // encrypted with the old encryptionKey, so the blind seeder can't read it).
  // applyCircleNodes accepts it only when its signature verifies against the
  // circle's ownerKey, so no other writer can forge a "we moved" notice. A
  // no-op for a non-owner of the old circle. Proposal 2026-06-17 slice 3.
  'circle:supersede': async ({ oldCircleId, newCircleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof oldCircleId !== 'string') throw new Error('oldCircleId must be a string')
    if (typeof newCircleId !== 'string') throw new Error('newCircleId must be a string')
    const base = _circleBases.get(oldCircleId)
    if (!base) throw new Error('unknown circle: ' + oldCircleId)
    const ourKeyHex = b4a.toString(_identity.publicKey, 'hex')
    const circleRow = await base.view.get('circle')
    // Non-owner of the old circle: nothing to post (only the owner's signature
    // is accepted on the wire). Return a benign no-op rather than throwing.
    if (circleRow?.value?.ownerKey !== ourKeyHex) return { ok: false, reason: 'not_owner' }
    if (!base.writable) throw new Error('not yet a writer for this circle')

    // Build the new circle's invite from its persisted joined record (same
    // fields circle:invite uses). The owner must already hold the new circle.
    const newRec = await _localDb.get('circles:joined:' + newCircleId)
    if (!newRec?.value) throw new Error('unknown new circle: ' + newCircleId)
    const { circleKey, bootstrap, encryptionKey, name } = newRec.value
    const invite = buildInvite({ circleId: newCircleId, name, circleKey, bootstrap, encryptionKey, inviterPublicKey: ourKeyHex })

    // ownerKey is the signer field (verifyValueWithSigner against 'ownerKey'),
    // and the apply branch cross-checks it equals the circle row's ownerKey.
    const value = signValue({
      newCircleId,
      name,
      invite,
      ownerKey: ourKeyHex,
      postedAt: Date.now(),
      v: 1,
    }, _identity.secretKey)
    await base.append({ type: 'put', key: 'supersede:' + newCircleId, value })
    return { ok: true }
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
    attachConflictListeners(base, circleId)

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
      // Roll back: leave swarm (only if we own the topic), close base, clear
      // in-memory state.
      rollbackJoinTopic(circleId, circleKey)
      try { await base.close() } catch {}
      _circleBases.delete(circleId)
      _circlePeers.delete(circleId)
      throw new Error('this circle has been deleted by the owner')
    }
    // circleId-binding guard (proposal 2026-06-11). The founder wrote the
    // canonical id into the `circle` row at creation; if the invite's circleId
    // disagrees, adopting it would diverge this device from every other member
    // and silently break the per-circle protomux channels (pair / live / admin
    // all key on circleId). A mismatch is always a malformed or stale invite,
    // so reject rather than reconcile (reconciling means re-keying all local
    // state). Only fires on a positive mismatch - if the row hasn't replicated
    // yet (id undefined) we don't block the join.
    if (inviteCircleIdMismatch(circleId, circleRow?.value)) {
      rollbackJoinTopic(circleId, circleKey)
      try { await base.close() } catch {}
      _circleBases.delete(circleId)
      _circlePeers.delete(circleId)
      throw new Error('invite does not match this circle (malformed or stale invite)')
    }

    // Only now - the circle is confirmed real and not a franken - advertise our
    // writer key over the pair channel. Doing this before the canonical-id check
    // let a rejected franken join (for a circle we share an autobase with) get a
    // junk writer admitted into the shared autobase before the rollback. The
    // pair channel isn't needed for base.update above (that replicates over the
    // connection-level corestore stream). Proposal 2026-06-11 follow-up.
    openPairChannelsForCircle(circleId, base)

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
    return await safeSnapshot(circleId, base)
  },

  'circles:getAll': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const out = []
    for (const [circleId, base] of _circleBases) {
      try {
        const snap = await safeSnapshot(circleId, base)
        // Attach the local-only recreate links + createdAt so the Settings UI
        // can date each row, show member counts, badge a recreated pair
        // ("Being replaced" / "New") and guard the delete confirmation
        // (proposal 2026-06-17 slice 3). These live in the joined record, not
        // the replicated view, so they're read here rather than in the snapshot.
        const localRec = await _localDb.get('circles:joined:' + circleId).catch(() => null)
        const lv = localRec?.value || {}
        // Self-heal the local name cache: the app shows snap.circle.name (live
        // view), but circles:joined.name only updates at create/join + on the
        // renamer's own device, so a member who joined before a rename keeps a
        // stale name that seed invites then leak. Mirror the live name back when
        // it has moved past the cache. Only writes on an actual change, so the
        // ~3s poll isn't chatty; skips when the view hasn't replicated (snap.circle
        // null / empty name) so a cold-boot blank can't clobber a good cache.
        const healedName = resolveCircleName(lv.name, snap?.circle)
        if (localRec && healedName && healedName !== lv.name) {
          lv.name = healedName
          await _localDb.put('circles:joined:' + circleId, { ...localRec.value, name: healedName }).catch(() => {})
        }
        out.push({
          circleId,
          ...snap,
          createdAt: typeof lv.createdAt === 'number' ? lv.createdAt : (typeof lv.joinedAt === 'number' ? lv.joinedAt : null),
          recreatedFrom: lv.recreatedFrom || null,
          recreatedTo: lv.recreatedTo || null,
          recreatedAt: typeof lv.recreatedAt === 'number' ? lv.recreatedAt : null,
        })
        // A repairing circle is "done enough" once its rebuilt base is
        // writable again (re-admitted as a writer == functional). Historical
        // catch-up continues as normal replication after this.
        if (_repairingCircles.has(circleId) && base.writable) clearRepairing(circleId)
        // Maintenance: every refresh, ensure our member row exists in
        // every writable circle. Idempotent: skips if a row already
        // exists. This is the reliable path that catches cases the
        // apply-branch hook misses (timing, missed restart, etc). Skip a
        // degraded circle: its view reads stall, so this would just spawn
        // more hung tasks until the next-boot nukeTip heals it (2026-06-03c).
        if (!_degradedCircles.has(circleId)) autoAppendMemberRow(circleId).catch(() => {})
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
    if (!Number.isFinite(radiusMeters) || radiusMeters < MIN_PLACE_RADIUS_M || radiusMeters > 10000) {
      throw new Error('radiusMeters must be in [' + MIN_PLACE_RADIUS_M + ', 10000]')
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
    if (!Number.isFinite(radiusMeters) || radiusMeters < MIN_PLACE_RADIUS_M || radiusMeters > 10000) {
      throw new Error('radiusMeters must be in [' + MIN_PLACE_RADIUS_M + ', 10000]')
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
    // Manual fire (debug affordance): bypass the same-kind guard so a tester
    // can re-emit a kind on demand, but still keep the guard's state in sync.
    const transition = await appendTransition(base, placeId, kind, stamp, { circleId, force: true })
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      await appendLastSeen(base, lat, lon, accuracy, stamp)
    }
    // Sync the tracked classification so the JS check doesn't fight with
    // the manual fire on the next location:update.
    const tracked = _circlePlaces.get(circleId + '|' + placeId)
    if (tracked) {
      tracked.lastClassification = kind === 'enter' ? 'inside' : 'outside'
      await persistClassification(circleId, placeId, tracked.lastClassification, stamp)
    }

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
    // Defense-in-depth (bugfix 2026-06-19): refuse to mint a seed invite from a
    // franken local record whose circleId disagrees with the founder-written
    // circle.id in our own view — it would enroll a phantom on the blind seeder.
    const base = _circleBases.get(circleId)
    let viewRow = null
    if (base) { try { viewRow = await base.view.get('circle') } catch (e) { /* view not ready */ } }
    if (inviteCircleIdMismatch(circleId, viewRow?.value)) {
      throw new Error('refusing to mint a seed invite: local record does not match this circle')
    }
    const liveName = resolveCircleName(name, viewRow)
    const inviterPublicKey = b4a.toString(_identity.publicKey, 'hex')
    const invite = buildSeedInvite({ circleId, name: liveName, circleKey, bootstrap, inviterPublicKey })
    return { invite, name: liveName }
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
      // `left` rows are seeders that left/were removed — hidden entirely
      // (proposal 2026-06-17-seeder-leave-propagation), unlike `revoked`.
      if (!value || value.revoked === true || value.left === true) continue
      seeders.push({
        pubkey: value.pubkey,
        addedBy: value.addedBy,
        addedAt: value.addedAt,
        updatedAt: value.updatedAt,
        label: typeof value.label === 'string' ? value.label : null,
        // Build version learned from the seeder's admission announce (proposal
        // 2026-06-05-seeder-update slice 1). undefined → never connected this
        // session; null → connected but pre-version (old) seeder.
        version: _seederVersions.has(value.pubkey) ? _seederVersions.get(value.pubkey) : undefined,
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
          // A seeder that left / was removed is hidden entirely (proposal
          // 2026-06-17-seeder-leave-propagation). If this is its only circle,
          // the seeder won't appear at all; if it's still live elsewhere, just
          // this circle is dropped from its list.
          if (value.left === true) continue
          let entry = byPubkey.get(value.pubkey)
          if (!entry) {
            entry = { pubkey: value.pubkey, label: null, followed: false, circles: [] }
            byPubkey.set(value.pubkey, entry)
          }
          if (!entry.label && typeof value.label === 'string') entry.label = value.label
          entry.circles.push({ circleId, name: circleName, revoked: value.revoked === true })
          // Build version learned from this seeder's admission announce (proposal
          // 2026-06-05-seeder-update slice 1). undefined = not connected this
          // session; null = connected but pre-version (out-of-date) seeder.
          if (_seederVersions.has(value.pubkey)) entry.version = _seederVersions.get(value.pubkey)
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

  // Pair with a seeder by scanning its QR (proposal 2026-06-22). Parse the
  // pairing link, join its one-time rendezvous topic, and push our seed bundle
  // to the connection whose authenticated remote pubkey matches the QR's seeder
  // (the security anchor). Resolves when the seeder acks the enroll, or after a
  // timeout. Also marks the seeder followed so future circles auto-push.
  'seeder:pair:scan': async ({ link } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (!SEEDER_PAIR_ENABLED) throw new Error('seeder pairing is disabled')
    const parsed = parseSeederPairLink(link)
    if (!parsed.ok) throw new Error('invalid pairing link: ' + (parsed.error ?? 'unknown'))
    if (_pairScan) throw new Error('a pairing is already in progress')
    const { rv, seeder } = parsed
    const topic = seederPairTopic(rv)
    const topicHex = b4a.toString(topic, 'hex')
    try { _swarm.join(topic, { server: true, client: true }) } catch (e) {
      throw new Error('rendezvous join failed: ' + (e?.message ?? String(e)))
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => finishPairScan({ ok: false, error: 'timed out waiting for the seeder' }), SEEDER_PAIR_SCAN_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      _pairScan = { rv, topic, topicHex, seederKeyHex: seeder, timer, resolve }
      mark('seeder:pair:scan-started', { seeder: seeder.slice(0, 8) })
      // Cover the rare case where we're already connected to the seeder.
      for (const conn of _activeConns) {
        if (_connPubkey.get(conn) === seeder) maybeSetupPairScanChannel(conn, seeder)
      }
    })
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

  // Remove a seeder from this circle's list entirely (proposal 2026-06-17
  // -seeder-leave-propagation). Writes a `left` tombstone — distinct from
  // revoke, which lingers for re-admit. The manual counterpart to the seeder's
  // in-band "left" notice: use it to clear a seeder that's gone (e.g. it left
  // while no member was connected, so the in-band signal was never delivered).
  // A later re-announce from the same seeder auto-re-admits it (left is not a
  // durable trust decision; see handleSeederAnnounce).
  'circle:seeder:remove': async ({ circleId, pubkey } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    if (typeof pubkey !== 'string' || pubkey.length !== 64) {
      throw new Error('pubkey must be a 64-char hex string')
    }
    const base = _circleBases.get(circleId)
    if (!base) throw new Error('unknown circle: ' + circleId)
    if (!base.writable) throw new Error('not yet a writer for this circle')
    const wrote = await writeSeederGone(circleId, base, pubkey)
    if (!wrote) throw new Error('no removable seeder with that pubkey in this circle')
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
    const result = await approveSeederRow(circleId, pubkey, label)
    // Re-admit of a previously-revoked seeder (proposal 2026-06-11-seeder-readmit):
    // (1) tell the seeder explicitly so it clears its revoked flag now (the seed
    // can't read the encrypted row, and we no longer rely on the fragile
    // any-block-clears-it heuristic), and (2) resume replication so a seeder that
    // was revoked-everywhere (skipped at connect time) starts receiving blocks
    // and re-seeds.
    if (result?.reAdmit) {
      notifySeederAdmitted(circleId, pubkey, result.updatedAt)
      resumeSeederReplication(pubkey)
    }
    return result
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
    // Guard the resurrection race: the 5s membership sweep / circles:getAll
    // poll both call autoAppendMemberRow, which rewrites our member row
    // with a fresh joinedAt whenever a left:/removed: tombstone currently
    // hides us (the rejoin-recovery path). Our own just-written left: row
    // trips that exact condition, so without this flag the sweep would
    // out-date our leave and replicate a fresh member row to peers --
    // un-leaving us. Set before the append, cleared in tearDownCircleLocally.
    _leavingCircles.add(circleId)
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

  // Local recovery for a wedged circle Autobase (proposal
  // 2026-06-03-autobase-append-hang). When appends to a circle have timed
  // out (it shows needsRepair), the local Autobase is wedged below the tip
  // (the linearizer stalls on the indexed history) and every append hangs.
  // nukeTip is not enough — it rewinds the tip but the corruption persists
  // (validated on-device 2026-06-03). Strong repair: remount the circle under
  // a FRESH corestore namespace (rebuildGen+1), giving it brand-new local
  // writer/view/system cores that re-apply from the bootstrap and re-sync
  // clean from the seeder. The corrupt old-generation cores are orphaned on
  // disk. The new namespace means a new local writer key, so this device
  // drops to read-only for the circle until an existing writer re-admits it
  // via the pair-channel addWriter flow (automatic once the owner is online)
  // — exactly the join-as-writer path. Identity, membership and history are
  // preserved (the seeder holds them). Every await is bounded so a still-bad
  // base reports an error instead of re-wedging the worklet.
  'circle:repair': async ({ circleId } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof circleId !== 'string') throw new Error('circleId must be a string')
    const record = await _localDb.get('circles:joined:' + circleId).catch(() => null)
    if (!record?.value?.bootstrap) return { ok: false, reason: 'unknown_circle' }
    const { bootstrap, encryptionKey } = record.value
    const newGen = (typeof record.value.rebuildGen === 'number' ? record.value.rebuildGen : 0) + 1
    mark('circle:repair:start', { circleId: circleId.slice(0, 8), newGen })
    // 1. Clear the bootstrap's autobase/local pin so the gen+1 mount derives a
    //    BRAND-NEW local writer. A fresh namespace alone re-opens the same
    //    corrupt writer, which boot.js finds via the shared bootstrap core's
    //    autobase/local userData. Bounded so a hung core open can't freeze us.
    //    Safe to clear while the old base is still mounted: that base already
    //    booted its writer and won't re-read the pin.
    const pinRes = await withTimeout((async () => {
      const bc = _store.get({ key: b4a.from(bootstrap, 'hex'), active: false })
      await bc.ready()
      await bc.setUserData('autobase/local', null)
      await bc.close()
      return true
    })(), APPEND_TIMEOUT_MS)
    if (pinRes.timedOut) mark('circle:repair:pin-clear-timeout', { circleId: circleId.slice(0, 8) })
    else if (pinRes.error) mark('circle:repair:pin-clear-failed', { circleId: circleId.slice(0, 8), err: pinRes.error?.message })
    // 2. Persist the new generation so the next launch boots into the fresh
    //    namespace even if everything below is interrupted.
    await _localDb.put('circles:joined:' + circleId, { ...record.value, rebuildGen: newGen }).catch(() => {})
    // 3. BUILD the rebuilt base WITHOUT touching the live one, bounded. The old
    //    base stays mounted the whole time, so a hung build can never leave the
    //    circle unmounted ("not in any circles"). The in-app remount of a fresh
    //    namespace can still hang while the old base is around; if it does we
    //    fall through to staging it for the next launch.
    let newBase = null
    try {
      newBase = await Promise.race([
        buildCircleAutobase(circleId, bootstrap, encryptionKey || null, newGen),
        new Promise((_, reject) => setTimeout(() => reject(new Error('repair_mount_timeout')), 18000)),
      ])
    } catch (e) {
      mark('circle:repair:mount-staged', { circleId: circleId.slice(0, 8), newGen, err: e?.message })
    }
    if (newBase) {
      // 4a. Built in-process — swap atomically. Abandon the old base (no
      //     Autobase.close(); it hangs) and install the rebuilt one. Mark
      //     repairing so the indicator runs until it is writable again.
      _circleBases.delete(circleId)
      _circleBases.set(circleId, newBase)
      openPairChannelsForCircle(circleId, newBase)
      clearDegraded(circleId)
      _firstLastSeenWriteMarked.delete(circleId)
      _firstWriterMarked.delete(circleId)
      _lastAppendedPos.delete(circleId)
      _lastGoodSnapshot.delete(circleId)
      _repairStaged.delete(circleId)
      // Re-announce the (namespace-stable) last-known core key into the rebuilt
      // view, which starts empty (proposal 2026-06-04 slice 2a).
      _lastKnownAnnounced.delete(circleId)
      setRepairing(circleId)
      mark('circle:repair:done', { circleId: circleId.slice(0, 8), newGen, writable: !!newBase.writable })
      send({ event: 'circle:repaired', data: { circleId, restartRequired: false } })
      return { ok: true, writable: !!newBase.writable }
    }
    // 4b. In-app remount hung. Keep the OLD base mounted (circle stays visible)
    //     and stage the rebuild for the next launch, where the boot mount loop
    //     opens gen+1 cleanly. clearDegraded so the old base's stalls don't read
    //     as "needs repair"; _repairStaged surfaces "reopen to finish"; the
    //     persisted circleRepairing flag resumes "Repairing…" after the restart.
    //     We do NOT add to _repairingCircles now — the old base is writable,
    //     which would clear it prematurely in circles:getAll.
    clearDegraded(circleId)
    _repairStaged.add(circleId)
    _localDb.put('circleRepairing:' + circleId, { ts: Date.now() }).catch(() => {})
    send({ event: 'circle:repaired', data: { circleId, restartRequired: true } })
    return { ok: true, staged: true, restartRequired: true }
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
    // Connected-peer truth is derived live from the current connections, not
    // the connection-time topic snapshot in _circlePeers. Hyperswarm reuses one
    // connection per peer pair, so a circle joined AFTER a connection formed
    // (e.g. every device migrating to a recreated circle over the links it
    // already held for the old one) never fires a fresh 'connection' event and
    // never lands in _circlePeers — the peer then reads as "not connected" until
    // an app restart re-forms every link with the new topic. Intersecting the
    // set of pubkeys we hold a live socket to with each circle's membership
    // reflects reality regardless of when the socket formed. The event-tracked
    // _circlePeers set is merged in as a floor so nothing regresses; a degraded
    // circle (view reads stall) falls back to it alone.
    const connectedRemotes = new Set(_connPubkey.values())
    const out = {}
    for (const [circleId, base] of _circleBases) {
      const acc = new Set(_circlePeers.get(circleId) ?? [])
      if (connectedRemotes.size && !_degradedCircles.has(circleId)) {
        try {
          for await (const { value } of base.view.createReadStream({ gt: 'member:', lt: 'member:~' })) {
            const pk = value?.pubkey
            if (typeof pk === 'string' && connectedRemotes.has(pk)) acc.add(pk)
          }
        } catch (e) { console.warn('[bare] circles:peers member reconcile failed', e?.message) }
      }
      out[circleId] = Array.from(acc)
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

  // Phase-2 cutover controls (proposal 2026-06-04 slice 3). `get` reports the
  // keep-writing kill-switch and which circles have stopped the Autobase
  // lastSeen write. `set` flips the kill-switch (true = force the durable write
  // back on everywhere) and persists it.
  'lastSeen:cutover:get': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    return {
      forceAutobaseLastSeen: _forceAutobaseLastSeen,
      cutoverCircles: Array.from(_lastSeenCutoverCircles),
    }
  },

  'lastSeen:cutover:setForceWrite': async ({ enabled } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    const now = await setForceAutobaseLastSeen(enabled)
    return { forceAutobaseLastSeen: now }
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
    // Track position for proximity-ranking the OS region set, and re-rank
    // when we've moved far enough that the nearest-N places may have changed
    // (proposal 2026-05-30 fix 2). The first fix always re-ranks (the boot
    // push used insertion order with no position). Debounced in the scheduler.
    _lastDevicePos = { lat, lon }
    if (!_lastRegionRankPos ||
        haversineMeters(_lastRegionRankPos.lat, _lastRegionRankPos.lon, lat, lon) >= REGION_RERANK_MIN_MOVE_M) {
      schedulePushRegionsToShell()
    }
    // We're getting fresh fixes (likely moving), the exact case where a swarm
    // socket goes stale. Probe connections so a dead one is shed and a fresh
    // one redials before we try to replicate this position (proposal
    // 2026-06-01; debounced internally).
    probeConnections('location')
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
      // Phase-2 cutover (proposal 2026-06-04 slice 3): once every member of
      // this circle supports the new read path (live + last-known core), the
      // durable Autobase write is redundant, so skip it and let the oplog stop
      // growing. The live broadcast + core append below still run. The last
      // value we wrote stays in the view, so even a brand-new old joiner sees a
      // position until the cutover reverts and we refresh it.
      if (_lastSeenCutoverCircles.has(circleId)) continue
      // Movement gate (storage-growth remediation, proposal 2026-05-29):
      // skip the append when we haven't moved far enough since the last
      // one we wrote for this circle. lastSeen is LWW current position,
      // so dropping near-stationary repeats costs the peer nothing and
      // stops a stationary phone bloating the core on every ~10s native
      // fix. _lastAppendedPos is reset on app foreground so opening the
      // app always publishes a current fix even when stationary. The
      // classifier and trip detector below run on every fix regardless.
      if (!shouldAppendLastSeen(_lastAppendedPos.get(circleId), lat, lon)) continue
      // safeAppend bounds a wedged base so one stuck append can't freeze the
      // whole worklet (proposal 2026-06-03-autobase-append-hang). Only record
      // the write / first-write mark when it actually landed.
      if (await safeAppend(base, { type: 'put', key: 'lastSeen:' + ourKey, value }, 'lastSeen')) {
        _lastAppendedPos.set(circleId, { lat, lon })
        written++
        if (!_firstLastSeenWriteMarked.has(circleId)) {
          _firstLastSeenWriteMarked.add(circleId)
          const peers = _circlePeers.get(circleId)?.size ?? 0
          mark('lastseen:first-write', { circleId, peers })
        }
      }
    }

    // Phase 1 (proposal 2026-06-04-lastseen-ephemeral): also broadcast the
    // fix ephemerally to connected peers, alongside the Autobase dual-write
    // above. This is the path that will replace the oplog write in phase 2.
    // Independent of writable / the movement gate, so a read-only member and a
    // stationary-but-open app still share live position.
    for (const circleId of _circleBases.keys()) {
      if (!getCircleSharing(circleId).enabled) continue
      broadcastLive(circleId, value)
      // Persist the bounded last-known fix to our per-member core (slice 2a).
      // The offline fallback that will replace the Autobase write in phase 2;
      // append + clear keeps on-disk DATA O(1), unlike the oplog.
      appendSelfLastKnown(circleId, value).catch((e) => {
        console.warn('[bare] appendSelfLastKnown failed', circleId, e?.message)
      })
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

  // Geofence health snapshot for the in-app diagnostics reveal. Read-only and
  // cheap; safe to call from a production build. Lets us confirm on the actual
  // device whether a Place's OS region should be registered, whether the writer
  // is writable, and whether any crossing is stuck in the pending queue
  // (proposal 2026-07-01).
  'geofence:diag': async () => {
    const circles = []
    for (const [circleId, base] of _circleBases) {
      circles.push({
        circleId: circleId.slice(0, 8),
        writable: !!(base && base.writable),
        sharing: getCircleSharing(circleId).enabled,
      })
    }
    const places = [..._circlePlaces.values()]
    const selected = selectNearestRegions(places, _lastDevicePos, REGIONS_HARD_CAP)
    return {
      circles,
      placeCount: places.length,
      // How many Places SHOULD be registered as OS regions right now.
      regionsMonitored: selected.length,
      hasDevicePos: !!_lastDevicePos,
      classifications: places.map((s) => ({ place: s.placeId.slice(0, 8), radius: s.radiusMeters, state: s.lastClassification })),
      pending: [..._pendingTransitions.values()].map((p) => ({ place: p.placeId.slice(0, 8), kind: p.kind, ts: p.ts })),
      recent: _geofenceLog.slice(-25),
    }
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
    // Diagnostic marks (2026-06-03): TripsView reports an indefinite
    // "Loading…" on some devices. This handler fans a read across the
    // local DB and every circle base; if any stream stalls the IPC
    // never resolves. Marking each stage localises where it hangs.
    mark('trips:listFor:start', { self: pubkey === ourKey, bases: _circleBases.size })

    const localTrips = []
    if (pubkey === ourKey) {
      for await (const { value } of _localDb.createReadStream({
        gt: 'trips:' + pubkey + ':',
        lt: 'trips:' + pubkey + ':~',
      })) {
        if (value) localTrips.push(value)
      }
    }
    mark('trips:listFor:local-done', { count: localTrips.length })

    const circleTrips = []
    for (const [circleId, base] of _circleBases) {
      // Bound the per-base view read (proposal 2026-06-03c): a corrupt base
      // stalls the stream and would hang trips forever. On timeout, flag the
      // circle for repair and skip it rather than freeze the whole list.
      const drain = (async () => {
        const list = []
        for await (const { value } of base.view.createReadStream({
          gt: 'trip:' + pubkey + ':',
          lt: 'trip:' + pubkey + ':~',
        })) {
          if (value) list.push(value)
        }
        return list
      })()
      const { value: list, timedOut } = await withTimeout(drain, READ_TIMEOUT_MS)
      if (timedOut) {
        flagDegraded(circleId, 'trips:read')
        mark('trips:listFor:base-timeout', { circleId: circleId.slice(0, 8) })
        continue
      }
      if (list && list.length > 0) circleTrips.push(list)
      mark('trips:listFor:base-done', { circleId: circleId.slice(0, 8), count: list ? list.length : 0 })
    }

    mark('trips:listFor:done', { circles: circleTrips.length })
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
  // Debug-only (peer-trip notification investigation 2026-06-11): synthesize a
  // completed trip and run the exact real completion path (local store +
  // replicateTripToOptedInCircles) so the peer-trip notification chain can be
  // tested deterministically without a real drive. Triggered from the Advanced
  // settings "Inject test trip" button. distanceMeters defaults above the 500m
  // notification threshold; endTs is now so the receiver's freshness gate
  // passes when both devices are connected.
  'trip:debugComplete': async ({ distanceMeters = 1600, durationMs = 6 * 60 * 1000 } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    const now = Date.now()
    const startTs = now - durationMs
    const trip = {
      pubkey: ourKey,
      startTs,
      endTs: now,
      polyline: [[0, 0, startTs], [0, 0, now]],
      distanceMeters,
      durationMs,
      maxSpeedMps: 20,
      v: 1,
    }
    await _localDb.put('trips:' + ourKey + ':' + startTs, trip)
    send({ event: 'trip:completed', data: trip })
    mark('trip:debug-injected', { distanceMeters, durationMs })
    reshipTrace()
    await replicateTripToOptedInCircles(ourKey, trip)
    return { ok: true, trip }
  },

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
        if (await safeAppend(base, { type: 'put', key: replicatedKey, value: tombstone }, 'trip:delete')) {
          circlesTombstoned++
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
      // No invalidateCircleView: `trip:` keys aren't part of the cached
      // snapshot view (only `transition:` is); trips reach the UI via trips:list.
    } catch (e) { console.warn('[bare] pruneOldTrips view scan failed', e?.message) }
  }
  return { localDeleted, viewDeleted }
}

// Worklet-side transition retention sweep (storage audit 2026-06-22).
// Drops transition records older than TRANSITION_RETENTION_MS from each
// per-circle autobase transition:{ts}:{pubkey}:{placeId} view. Unlike
// trips there is no local Hyperbee copy — transitions live only in the
// per-circle autobase view. View deletes are local-only and don't
// replicate, so each peer prunes its own copy; the apply-branch filter
// keeps the bound across reboots. Returns a count for logging.
async function pruneOldTransitions () {
  if (!_initialized) return { viewDeleted: 0 }
  const now = Date.now()
  let viewDeleted = 0
  for (const [circleId, base] of _circleBases) {
    try {
      const toDelete = []
      for await (const { key, value } of base.view.createReadStream({
        gt: 'transition:',
        lt: 'transition:~',
      })) {
        if (transitionIsExpired(value, now)) toDelete.push(key)
      }
      for (const k of toDelete) {
        try { await base.view.del(k); viewDeleted++ } catch {}
      }
      // Transitions are in the cached snapshot view; drop it so the next poll
      // reflects the prune (storage/sync audit 2026-06-22).
      if (toDelete.length) invalidateCircleView(circleId)
    } catch (e) { console.warn('[bare] pruneOldTransitions view scan failed', e?.message) }
  }
  return { viewDeleted }
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
  // Diagnostic (peer-trip notification investigation 2026-06-11): mark the
  // sender-side outcome per circle so a missing peer notification can be traced
  // to (a) trip sharing / location sharing off here, (b) the block never being
  // pulled by a peer (instrumentTripUpload), vs (c) a receiver-side gate.
  let replicated = 0
  for (const [circleId, base] of _circleBases) {
    if (!base.writable) { mark('trip:replicate-skip', { circleId: circleId.slice(0, 8), reason: 'not-writable' }); continue }
    // If location sharing is muted for this circle, trips are too:
    // sharing your route is strictly more revealing than sharing
    // presence, so the stricter gate wins.
    const locOn = getCircleSharing(circleId).enabled
    const row = await _localDb.get('trips:sharing:' + circleId)
    const shareOn = shouldReplicateTrip(row)
    if (!locOn || !shareOn) { mark('trip:replicate-skip', { circleId: circleId.slice(0, 8), locOn, shareOn }); continue }
    const ok = await safeAppend(base, { type: 'put', key, value: signedValue }, 'trip')
    if (ok) { replicated++; instrumentTripUpload(base, circleId) }
  }
  mark('trip:replicated', { circles: replicated, distanceMeters: trip.distanceMeters })
  reshipTrace()
}

// One-shot watch on our local writer core: marks how long after a trip commit a
// peer first pulls the new block (peer-trip investigation 2026-06-11). A trip
// that commits but is never pulled (no `trip:uploaded` mark) is the iPhone-
// killed-before-upload case the user suspects. Reaped after 30min so an offline
// device can't leak a listener.
function instrumentTripUpload (base, circleId) {
  const local = base && base.local
  if (!local || typeof local.on !== 'function') return
  const ourIndex = (typeof local.length === 'number' ? local.length : 1) - 1
  const t0 = Date.now()
  let timer = null
  const onUpload = (index) => {
    if (typeof index === 'number' && index < ourIndex) return
    local.off('upload', onUpload)
    if (timer) clearTimeout(timer)
    mark('trip:uploaded', { circleId: circleId.slice(0, 8), lagMs: Date.now() - t0 })
    reshipTrace()
  }
  local.on('upload', onUpload)
  timer = setTimeout(() => local.off('upload', onUpload), 30 * 60 * 1000)
}

// Load the persisted peer-trip notification state on init (proposal
// 2026-06-11-peer-trip-notification-freshness): the durable already-notified set
// and the one-time baseline. Both are local-only, never replicated. The baseline
// is stamped now on first run so a fresh install doesn't replay trip history.
async function loadTripNotifyState () {
  try {
    const seen = await _localDb.get('tripNotify:seen')
    if (Array.isArray(seen?.value?.keys)) {
      for (const k of seen.value.keys) _emittedPeerTripKeys.add(k)
    }
  } catch (e) { console.warn('[bare] load tripNotify:seen failed', e?.message) }
  try {
    const base = await _localDb.get('tripNotify:baseline')
    if (typeof base?.value?.ts === 'number') {
      _tripNotifyBaseline = base.value.ts
    } else {
      _tripNotifyBaseline = Date.now()
      await _localDb.put('tripNotify:baseline', { ts: _tripNotifyBaseline })
    }
  } catch (e) {
    console.warn('[bare] load tripNotify:baseline failed', e?.message)
    if (_tripNotifyBaseline == null) _tripNotifyBaseline = Date.now()
  }
}

// Record that we've fired a notification for this trip key: in-memory for the
// hot path, persisted (capped FIFO) so a cold boot / autobase replay never
// re-notifies. Called only on actual emit, so the persisted list grows at the
// rate of real peer-trip notifications (a few per day).
async function markTripNotified (key) {
  if (_emittedPeerTripKeys.size >= _EMITTED_PEER_TRIP_MAX) {
    const arr = [..._emittedPeerTripKeys]
    _emittedPeerTripKeys.clear()
    for (let i = arr.length >> 1; i < arr.length; i++) _emittedPeerTripKeys.add(arr[i])
  }
  _emittedPeerTripKeys.add(key)
  try {
    let keys = [..._emittedPeerTripKeys]
    if (keys.length > _PERSISTED_TRIP_SEEN_MAX) keys = keys.slice(keys.length - _PERSISTED_TRIP_SEEN_MAX)
    await _localDb.put('tripNotify:seen', { keys })
  } catch (e) { console.warn('[bare] persist tripNotify:seen failed', e?.message) }
}

async function writePresenceToCircle (circleId, state, expiresAt = null) {
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const payload = { pubkey: ourKey, state, setAt: Date.now(), v: 1 }
  if (typeof expiresAt === 'number') payload.expiresAt = expiresAt
  const value = signValue(payload, _identity.secretKey)
  await safeAppend(base, { type: 'put', key: 'presence:' + ourKey, value }, 'presence')
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

function circleIdForBase (base) {
  for (const [cid, b] of _circleBases) if (b === base) return cid
  return null
}

// Best-effort attribution of a conflicting Hypercore to a mounted circle.
// The observed fork (Benjamin's Pixel 7, 2026-06-24) is on the local writer
// core (writable=true), so a base.local.key match covers the real case;
// bootstrap/view matches are added defensively. An unattributable conflict
// (e.g. a remote writer core opened on demand) still gets the seatbelt — the
// affected base's sessions close, so its next append times out and the
// existing flagDegraded path catches it (proposal 2026-06-27-fork-conflict-recovery).
function circleIdForConflictCore (core) {
  let keyHex = null
  try { keyHex = core && core.key ? b4a.toString(core.key, 'hex') : null } catch (e) { /* core not ready */ }
  if (!keyHex) return null
  for (const [cid, base] of _circleBases) {
    try { if (base.local && base.local.key && b4a.toString(base.local.key, 'hex') === keyHex) return cid } catch (e) {}
    try { if (base.bootstrap && b4a.toString(base.bootstrap, 'hex') === keyHex) return cid } catch (e) {}
    try { if (base.view && base.view.key && b4a.toString(base.view.key, 'hex') === keyHex) return cid } catch (e) {}
  }
  return null
}

// Fires on a hypercore fork conflict (two validly-signed but divergent blocks
// at the same index). Hypercore emits this from _onconflict BEFORE it tears
// down the core's sessions, so we stamp _lastConflictAt (arming the seatbelt
// for the 'Closed' rejection that the teardown leaks) and flag the circle for
// repair, which the user heals via circle:repair (fresh writer + seeder
// re-sync). Recovery is routing, not crashing.
function onCoreConflict (core, length, fork, knownCircleId) {
  _lastConflictAt = Date.now()
  let disc = null
  try { disc = core && core.discoveryKey ? b4a.toString(core.discoveryKey, 'hex') : null } catch (e) {}
  const circleId = knownCircleId || circleIdForConflictCore(core)
  let writable = false
  try { writable = !!(core && core.writable) } catch (e) {}
  mark('conflict:detected', { circle: circleId ? circleId.slice(0, 8) : null, disc: disc ? disc.slice(0, 16) : null, writable, length, fork })
  if (circleId) {
    flagDegraded(circleId, 'conflict')
    mark('conflict:routed-to-repair', { circle: circleId.slice(0, 8) })
  } else {
    mark('conflict:unattributed', { disc: disc ? disc.slice(0, 16) : null })
  }
}

// Last line of defense. Hypercore's conflict teardown rejects in-flight
// sessions with Error('Closed'), and that rejection escapes through the
// replicator's Promise.all as an unhandled rejection. With no handler Bare
// aborts the whole worklet (every circle, not just the broken one) — the
// 17x crash loop on Benjamin's Pixel 7. shouldSwallowFault (lib/conflictSeatbelt)
// swallows ONLY a conflict's fallout; we preserve fail-fast abort for everything
// else, so the diagnostic stack the logcat report relies on is never lost.
function onWorkletFault (err, kind) {
  if (shouldSwallowFault(err, _lastConflictAt, Date.now())) {
    mark('conflict:seatbelt-caught', { kind, msg: ((err && err.message) || String(err)).slice(0, 80) })
    console.warn('[bare] swallowed post-conflict ' + kind + ': ' + ((err && err.message) || err))
    return // circle already flagged needsRepair; keep the rest of the app alive
  }
  // Not conflict fallout: preserve today's fail-fast behavior. Log the stack
  // the crash report depends on, then terminate via the Bare runtime global
  // (Bare.exit) — NOT a native abort addon, which isn't linked into the APK.
  console.error('[bare] fatal ' + kind + ': ' + ((err && err.stack) || (err && err.message) || err))
  Bare.exit(1)
}

// Install once (guarded against init-retry double-registration). Just the
// global seatbelt; per-core 'conflict' listeners are attached per circle at
// mount time (attachConflictListeners), since corestore's core tracker hands
// back an internal Core without an .on() — only the Autobase's Hypercore
// sessions (base.local / base.view) expose the event.
function installFaultHandlers () {
  if (_faultHandlersInstalled) return
  _faultHandlersInstalled = true
  Bare.on('uncaughtException', (err) => onWorkletFault(err, 'uncaughtException'))
  Bare.on('unhandledRejection', (err) => onWorkletFault(err, 'unhandledRejection'))
  // Source-agnostic conflict arming: hypercore logs '[hypercore] conflict
  // detected in <discoveryKey>' for ANY forked core, including a remote
  // member's writer core that base.local/base.view listeners never see. Tap
  // that line to stamp _lastConflictAt (so the seatbelt swallows the 'Closed'
  // fallout regardless of whose core forked) and flag the circle best-effort.
  // Always passes through to the original console.log; never throws.
  const _origConsoleLog = console.log.bind(console)
  console.log = function (...consoleArgs) {
    try {
      const disc = parseConflictLog(consoleArgs[0])
      if (disc) onConflictLog(disc)
    } catch (e) { /* never let logging break */ }
    return _origConsoleLog(...consoleArgs)
  }
  mark('faulthandlers:installed')
}

// Arm the seatbelt from hypercore's conflict log line (remote- or local-core
// fork). Attribution is best-effort: a remote writer core's discoveryKey won't
// match a known circle, in which case the affected base's next append times out
// and the existing flagDegraded path flags it. The stamp itself is what keeps
// the worklet alive.
function onConflictLog (discHex) {
  _lastConflictAt = Date.now()
  const circleId = circleIdForDiscoveryKey(discHex)
  mark('conflict:log-detected', { disc: discHex.slice(0, 16), circle: circleId ? circleId.slice(0, 8) : null })
  if (circleId) flagDegraded(circleId, 'conflict')
}

// Map a discoveryKey hex to a mounted circle by comparing against each base's
// local/view core discoveryKeys (the cores we open ourselves). Remote writer
// cores aren't covered — see onConflictLog.
function circleIdForDiscoveryKey (discHex) {
  for (const [cid, base] of _circleBases) {
    for (const core of [base.local, base.view]) {
      try { if (core && core.discoveryKey && b4a.toString(core.discoveryKey, 'hex') === discHex) return cid } catch (e) {}
    }
  }
  return null
}

// Attach 'conflict' listeners to a mounted circle's writer + view Hypercore
// sessions. Fully defensive: a fork must never let listener wiring break the
// mount. The observed fork (Benjamin's Pixel 7) is on the local writer core
// (writable=true), so base.local is the load-bearing one; base.view is added
// in case the linearized view core conflicts. attachConflictListeners is safe
// to call repeatedly (hypercore dedups identical listeners by monitor index).
function attachConflictListeners (base, circleId) {
  if (!base) return
  for (const core of [base.local, base.view]) {
    try {
      if (core && typeof core.on === 'function') {
        core.on('conflict', (length, fork) => onCoreConflict(core, length, fork, circleId))
      }
    } catch (e) { mark('conflict:listener-attach-failed', { circle: circleId ? circleId.slice(0, 8) : null, err: e && e.message }) }
  }
}

// Mark a circle's local Autobase as wedged (append or read timed out). Idempotent.
// Persists `circleDegraded:{id}` so the next boot mounts it with nukeTip and
// self-heals (proposal 2026-06-03c), surfaces needsRepair to the UI, and the
// in-memory set short-circuits further appends until repaired.
function flagDegraded (circleId, label) {
  if (!circleId || _degradedCircles.has(circleId)) return
  // A repair already in flight (mounted-and-syncing, or staged for restart):
  // don't re-flag needsRepair from the old base's stalls, or the UI would
  // flip back to "needs repair" while the rebuild is underway.
  if (_repairingCircles.has(circleId) || _repairStaged.has(circleId)) return
  _degradedCircles.add(circleId)
  mark('circle:degraded', { circleId: circleId.slice(0, 8), label })
  _localDb.put('circleDegraded:' + circleId, { ts: Date.now(), label: label || null }).catch(() => {})
  send({ event: 'circle:degraded', data: { circleId } })
}

// Clear the degraded state after a (presumed) heal — circle:repair, or a clean
// nukeTip mount on boot. If the base re-wedges, the next timeout re-flags it.
function clearDegraded (circleId) {
  _degradedCircles.delete(circleId)
  _localDb.del('circleDegraded:' + circleId).catch(() => {})
}

// Repair-in-progress state. circle:repair returns right after the fresh-
// namespace remount, but the actual re-sync from the seeder + writer re-
// admission run asynchronously and can take a long time (hours on a big
// circle / slow link, observed on-device). Track it so the UI can show an
// indeterminate "Repairing…" indicator. Persisted so it survives an app
// restart mid-repair. Cleared once the rebuilt base is writable again (re-
// admitted == functional); see circles:getAll.
function setRepairing (circleId) {
  if (!circleId || _repairingCircles.has(circleId)) return
  _repairingCircles.add(circleId)
  _localDb.put('circleRepairing:' + circleId, { ts: Date.now() }).catch(() => {})
  send({ event: 'circle:repairing', data: { circleId, repairing: true } })
}

function clearRepairing (circleId) {
  if (!_repairingCircles.has(circleId)) return
  _repairingCircles.delete(circleId)
  _localDb.del('circleRepairing:' + circleId).catch(() => {})
  mark('circle:repair:settled', { circleId: circleId.slice(0, 8) })
  send({ event: 'circle:repairing', data: { circleId, repairing: false } })
}

// Drop-in for `await base.append(op)` on the automatic/background write paths.
// Bounds the append (raceAppend) so it cannot wedge the dispatcher: on timeout
// it flags the circle degraded (surfaced to the UI as needsRepair), skips
// further appends to that base until circle:repair rebuilds it, and returns
// false. A normal rejection (base closed mid-flight) returns false WITHOUT
// degrading. Returns true iff the row was appended. Proposal
// 2026-06-03-autobase-append-hang.
async function safeAppend (base, op, label) {
  const cid = circleIdForBase(base)
  if (cid && _degradedCircles.has(cid)) return false
  // Rewind guard (proposal 2026-06-27 item 3): never append past a truncated
  // writer tip while the network still holds the original blocks, or we fork.
  if (writerRewindBlocked(base, cid)) return false
  const { ok, timedOut } = await raceAppend(base.append(op), APPEND_TIMEOUT_MS)
  if (timedOut) flagDegraded(cid, 'append:' + (label || ''))
  else if (ok) scheduleDurabilityFlush() // item 4: bound the WAL-loss window after a writer append
  return ok
}

// Synchronous, never-throws check on the writer-append hot path. Returns true
// (block the append) when our own writer core (base.local) is shorter than the
// longest copy a connected peer advertises for it — which can only mean we were
// truncated, since nobody else signs our core. In that case we kick off a
// background download of the original tail and skip the append; lastSeen is
// last-writer-wins so the next location fix re-appends once we've caught up, and
// member/transition writes retry on their own sweeps. If no peer is connected
// (networkLength 0) we are authoritative and the append proceeds. Self-clears.
function writerRewindBlocked (base, cid) {
  try {
    const local = base && base.local
    if (!local || !local.peers || local.peers.length === 0) return false
    let networkLen = 0
    for (const p of local.peers) { const rl = (p && p.remoteLength) || 0; if (rl > networkLen) networkLen = rl }
    const status = writerRewindStatus({ localLength: local.length, networkLength: networkLen })
    if (!status.behind) {
      if (cid && _rewoundCircles.has(cid)) { _rewoundCircles.delete(cid); mark('writer:rewind-cleared', { circle: cid.slice(0, 8), len: local.length }) }
      return false
    }
    if (cid && !_rewoundCircles.has(cid)) {
      _rewoundCircles.add(cid)
      mark('writer:rewind-detected', { circle: cid.slice(0, 8), localLen: status.downloadFrom, networkLen: status.downloadTo })
    }
    try { local.download({ start: status.downloadFrom, end: status.downloadTo }) } catch (e) { /* download is best-effort */ }
    return true
  } catch (e) { return false } // a guard bug must never block all appends
}

// Bounded snapshotCircle (proposal 2026-06-03c). A corrupt base stalls the
// view reads inside snapshotCircle, which would freeze the circles:getAll
// poll and the whole UI. Bound it: on timeout, flag the circle degraded (so
// the next boot nuke-tips it) and serve the last good snapshot so the map
// stays populated instead of hanging. Caches every clean snapshot.
async function safeSnapshot (circleId, base) {
  const { value, timedOut } = await withTimeout(snapshotCircle(circleId, base), READ_TIMEOUT_MS)
  if (timedOut) {
    flagDegraded(circleId, 'snapshot')
    const cached = _lastGoodSnapshot.get(circleId)
    if (cached) return { ...cached, needsRepair: true }
    // No prior snapshot to serve: return the full empty shape (not a bare
    // object) so the UI's renderers never hit an undefined members/places.
    return { circle: null, members: [], lastSeen: {}, presence: {}, places: [], transitions: [], supersedes: [], writable: false, writers: null, needsRepair: true, stale: true }
  }
  _lastGoodSnapshot.set(circleId, value)
  return value
}

async function appendTransition (base, placeId, kind, ts, { circleId = circleIdForBase(base), force = false } = {}) {
  // Same-kind dedup guard (2026-06-10). A place's transitions must strictly
  // alternate enter/exit; two enters (or two exits) in a row are always a
  // double-write from racing writer paths or a cold-boot re-baseline, never a
  // real event. Refuse the redundant write here so the invariant holds no
  // matter which path called us. `force` is for the manual debug fire, which
  // is deliberately allowed to repeat a kind.
  const gkey = (circleId || '') + '|' + placeId
  if (!force && _lastAppendedKind.get(gkey) === kind) return null
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const value = signValue(
    { pubkey: ourKey, placeId, kind, ts, v: 1 },
    _identity.secretKey,
  )
  // Key shape per proposal §3 amended 2026-05-04: ts:pubkey:placeId.
  // The placeId suffix prevents same-tick collisions when one
  // location:update produces multiple transitions.
  await safeAppend(base, {
    type: 'put',
    key: 'transition:' + ts + ':' + ourKey + ':' + placeId,
    value,
  }, 'transition')
  _lastAppendedKind.set(gkey, kind)
  return value
}

// Stash a crossing that could not be durably appended (writer not writable, or
// the append threw). Only the latest crossing per Place is kept; a newer one
// supersedes. We deliberately do NOT advance the persisted classification here
// -- leaving it lets flushPendingTransitions re-detect and, if the crossing is
// stale by flush time, appendTransition's same-kind guard makes it idempotent.
function enqueuePendingTransition (circleId, placeId, kind, ts) {
  _pendingTransitions.set(circleId + '|' + placeId, { circleId, placeId, kind, ts })
  mark('transition:queued', { circleId: circleId.slice(0, 8), placeId: placeId.slice(0, 8), kind })
  logGeofence('queued', placeId, kind)
}

// Append any queued crossings for a circle now that its writer is ready.
// Advances + persists the dedup classifier only after the append succeeds, so
// the crossing survives a suspend/force-quit exactly like the live path.
async function flushPendingTransitions (circleId, base) {
  if (_pendingTransitions.size === 0) return
  if (!base || !base.writable) return
  // Muted circles don't append; leave the crossing queued so it publishes if
  // sharing is turned back on (rare; the live path never queues while muted).
  if (!getCircleSharing(circleId).enabled) return
  for (const [key, pend] of _pendingTransitions) {
    if (pend.circleId !== circleId) continue
    try {
      const appended = await appendTransition(base, pend.placeId, pend.kind, pend.ts, { circleId })
      _pendingTransitions.delete(key)
      const state = _circlePlaces.get(key)
      if (state) {
        state.lastClassification = pend.kind === 'enter' ? 'inside' : 'outside'
        await persistClassification(circleId, pend.placeId, state.lastClassification, pend.ts)
      }
      mark('transition:flushed', { circleId: circleId.slice(0, 8), placeId: pend.placeId.slice(0, 8), kind: pend.kind, appended: !!appended })
      logGeofence('flushed', pend.placeId, pend.kind, { appended: !!appended })
    } catch (e) {
      // Still not durable; leave it queued and let the next sweep retry.
      mark('transition:flush-fail', { circleId: circleId.slice(0, 8), err: e && e.message })
      break
    }
  }
}

async function flushAllPendingTransitions () {
  if (_pendingTransitions.size === 0) return
  for (const [circleId, base] of _circleBases) {
    try { await flushPendingTransitions(circleId, base) } catch {}
  }
}

async function appendLastSeen (base, lat, lon, accuracy, ts, battery = null, isCharging = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
  // Phase-2 cutover (proposal 2026-06-04 slice 3): skip the durable write once
  // the circle has converged on the new read path. Covers the geofence-flip and
  // region:enter/exit lastSeen refreshes, not just the location:update path.
  const cutoverCid = circleIdForBase(base)
  if (cutoverCid && _lastSeenCutoverCircles.has(cutoverCid)) return
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
  await safeAppend(base, { type: 'put', key: 'lastSeen:' + ourKey, value }, 'lastSeen:transition')
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
  const stamp = typeof ts === 'number' ? ts : Date.now()
  const sharing = getCircleSharing(circleId).enabled
  const base = _circleBases.get(circleId)
  const decision = regionAppendDecision({ sharing, writable: !!(base && base.writable) })

  // Writer isn't ready (opening / rebuilding / wedged on a suspended-app wake):
  // DO NOT advance or persist the classifier. iOS fires the region event
  // exactly once, so advancing here would strand the crossing forever -- no
  // append now, and the recovered baseline would read as already-crossed. Queue
  // it and let flushPendingTransitions append it once writable (2026-07-01).
  if (decision === 'queue') {
    enqueuePendingTransition(circleId, placeId, kind, stamp)
    return { ok: false, reason: 'not_writable_queued' }
  }

  // Safe to advance + persist the dedup classifier now: either the circle is
  // muted (append is intentionally suppressed) or the writer is ready and we
  // are about to append durably. Persist so the baseline survives a
  // suspend/force-quit (proposal 2026-05-30).
  state.lastClassification = result.classification
  await persistClassification(circleId, placeId, result.classification, stamp)

  // Per-circle mute: dedup classifier is advanced above; suppress the append.
  if (decision === 'muted') { logGeofence('muted', placeId, kind); return { ok: false, reason: 'sharing_disabled' } }
  try {
    await appendTransition(base, placeId, kind, stamp, { circleId })
    logGeofence('region-append', placeId, kind)
    return { ok: true }
  } catch (e) {
    // Append failed after advancing the classifier (timeout / wedge). Queue for
    // retry; the same-kind guard keeps the eventual flush idempotent.
    enqueuePendingTransition(circleId, placeId, kind, stamp)
    return { ok: false, error: e?.message, queued: true }
  }
}

async function checkPlaceTransitions (lat, lon, accuracy, ts, battery = null, isCharging = null) {
  for (const state of _circlePlaces.values()) {
    const base = _circleBases.get(state.circleId)
    if (!base || !base.writable) continue
    const dist = haversineMeters(lat, lon, state.lat, state.lon)
    const prev = state.lastClassification
    // Pass the fix's accuracy so a low-confidence reading can't bounce an
    // at-home user out of the radius and back in (phantom exit, 2026-06-10).
    const result = classify(dist, state.radiusMeters, prev, accuracy)
    state.lastClassification = result.classification
    // Persist on any change of stored state, including the null->baseline
    // establishment, so the inside/outside is on disk to recover a crossing
    // after a suspend/force-quit (proposal 2026-05-30).
    if (result.classification !== prev) {
      await persistClassification(state.circleId, state.placeId, result.classification, ts)
    }
    if (!result.kind) continue
    // Per-circle mute: still flip the classifier above (so a later
    // resume doesn't re-fire the entry/exit), but skip the autobase
    // append. Peers in muted circles don't see this transition.
    if (!getCircleSharing(state.circleId).enabled) continue
    try {
      await appendTransition(base, state.placeId, result.kind, ts, { circleId: state.circleId })
      logGeofence('live-append', state.placeId, result.kind)
      // Pass battery so the post-transition lastSeen write stays byte-
      // identical to the location:update one (autobase apply dedupes).
      await appendLastSeen(base, lat, lon, accuracy, ts, battery)
    } catch (e) {
      // The classifier already advanced above, so a dropped append would
      // otherwise be lost (no re-detect). Queue it for the writable-flush
      // retry, same backstop as the native region path.
      enqueuePendingTransition(state.circleId, state.placeId, result.kind, ts)
      console.warn('[bare] failed to append transition, queued for retry', e?.message)
    }
  }
}

// Cache of the expensive view-derived part of a snapshot: the range scans over
// circle/left/removed/member/lastSeen/presence/place/transition/supersede keys.
// circles:getAll polls snapshotCircle every ~3s, and the view only changes when
// the autobase apply pass (or a prune sweep) mutates it -- so we rebuild this
// part only when the view is dirty and re-overlay the cheap live/runtime state
// on every read. Keyed by circleId; the stored base ref guards a repair/rebuild
// swap (storage/sync audit 2026-06-22). Entries are dropped by
// invalidateCircleView from applyCircleNodes + pruneOldTrips/Transitions.
const _viewSnapshotCache = new Map() // circleId → { base, gen, view: {...} }
// Monotonic per-circle mutation counter. The worklet is single-threaded but
// readCircleView awaits between range scans, so an apply / prune can interleave
// mid-scan. Bumping the gen on every invalidation lets readCircleView refuse to
// cache a result that was built across a concurrent mutation -- otherwise a
// write that lands mid-scan and is the last write for a while could be served
// stale indefinitely (storage/sync audit 2026-06-22).
const _viewGen = new Map() // circleId → number

function invalidateCircleView (circleId) {
  _viewGen.set(circleId, (_viewGen.get(circleId) || 0) + 1)
  _viewSnapshotCache.delete(circleId)
}

// Read (and cache) the view-derived part of a circle snapshot. Pure reads off
// base.view -- no base.update() (see snapshotCircle's cold-boot rationale). The
// returned object is treated as immutable; snapshotCircle composes the live
// overlay into a fresh object rather than mutating these.
async function readCircleView (circleId, base) {
  const genAtStart = _viewGen.get(circleId) || 0
  const cached = _viewSnapshotCache.get(circleId)
  if (cached && cached.base === base && cached.gen === genAtStart) return cached.view
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
  // Owner-signed migration nudges (proposal 2026-06-17 slice 3). Each record
  // carries the new circle's invite; the member-side UI shows a "your group
  // moved" prompt for any circle the local device does NOT already hold (it
  // filters by newCircleId against circles:list). Newest first.
  const supersedes = []
  for await (const { value } of view.createReadStream({ gt: 'supersede:', lt: 'supersede:~' })) {
    if (value && typeof value.newCircleId === 'string' && typeof value.invite === 'string') {
      supersedes.push({
        newCircleId: value.newCircleId,
        name: value.name,
        invite: value.invite,
        postedAt: typeof value.postedAt === 'number' ? value.postedAt : 0,
      })
    }
  }
  supersedes.sort((a, b) => b.postedAt - a.postedAt)
  const result = {
    circle: circleRow ? circleRow.value : null,
    members,
    lastSeen,
    presence,
    places,
    transitions,
    supersedes,
  }
  // Only cache when no mutation raced our scans; if the gen moved, return this
  // result for the current call but leave the cache empty so the next poll
  // rebuilds from the post-mutation view.
  if ((_viewGen.get(circleId) || 0) === genAtStart) {
    _viewSnapshotCache.set(circleId, { base, gen: genAtStart, view: result })
  }
  return result
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
  const v = await readCircleView(circleId, base)
  // Overlay last-known core tips then ephemeral live positions (proposal
  // 2026-06-04 phase 1, precedence live > core > view). mergeLiveLastSeen is
  // freshest-ts-wins, so composing it twice (view←core, then ←live) yields the
  // freshest of the three. Restricted to visible members so a stale entry for a
  // left/removed member (already filtered out of `members`) can't reappear.
  const allowedMemberKeys = new Set(v.members.map((m) => m.value?.pubkey).filter(Boolean))
  // Kick a background refresh of peers' last-known cores; the result lands in
  // the cache for a later poll (slice 2a). Non-blocking — never awaited here.
  refreshPeerLastKnown(circleId).catch(() => {})
  const withCore = mergeLiveLastSeen(v.lastSeen, _lastKnownCache.get(circleId), allowedMemberKeys)
  const mergedLastSeen = mergeLiveLastSeen(withCore, _liveLastSeen.get(circleId), allowedMemberKeys)
  return {
    circle: v.circle,
    members: v.members,
    lastSeen: mergedLastSeen,
    presence: v.presence,
    places: v.places,
    transitions: v.transitions,
    supersedes: v.supersedes,
    writable: base.writable,
    writers: base.writers ? base.writers.length : null,
    // True once an append to this circle timed out (wedged local Autobase);
    // the UI offers a "repair" action that calls circle:repair. Cleared by a
    // successful repair (proposal 2026-06-03-autobase-append-hang).
    needsRepair: _degradedCircles.has(circleId),
    // True while a circle:repair is in flight (rebuilt, still re-syncing /
    // awaiting writer re-admission). Drives the indeterminate "Repairing…"
    // indicator; supersedes needsRepair in the UI.
    repairing: _repairingCircles.has(circleId),
    // True when the rebuild was staged because the in-app remount hung: the
    // old base is still mounted and the rebuild applies on the next launch.
    // The UI shows "reopen the app to finish".
    repairStaged: _repairStaged.has(circleId),
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

// Undo a joinCircleTopic done during a join that's being rolled back. Only
// leaves the topic + drops its mapping if THIS circle owns the mapping. If the
// topic is mapped to a different circle (e.g. a franken invite for a circle we
// are already in - same circleKey, so joinCircleTopic no-op'd), leaving would
// disconnect the legit membership. Proposal 2026-06-11 follow-up.
function rollbackJoinTopic (circleId, circleKey) {
  try {
    const topic = topicForCircleKey(circleKey)
    const topicHex = b4a.toString(topic, 'hex')
    if (_topicToCircle.get(topicHex) === circleId) {
      _topicToCircle.delete(topicHex)
      _swarm?.leave(topic)
    }
  } catch {}
}

// Local teardown for a circle (proposal amendment 2026-05-07): leave the
// swarm topic, close the autobase, drop in-memory geofence + peer state,
// remove the local `circles:joined` record. Used by both `circle:delete`
// (owner) and `circle:leave` (member) after the on-wire write has been
// appended and given a brief replication window. Idempotent — repeated
// calls on an already-cleaned-up circle are no-ops.
async function tearDownCircleLocally (circleId) {
  // Leave finished (or circle otherwise gone): drop the resurrection
  // guard so a later rejoin of the same circleId can publish a member
  // row again. Harmless no-op for teardown paths that never set it.
  _leavingCircles.delete(circleId)
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
  // Close the per-circle pair/admission/live Protomux channels on every
  // active connection, then drop their registry entries. Without this an
  // immediate rejoin in the same session can't recreate them (Protomux
  // refuses a duplicate protocol+id) and they stay bound to the base we're
  // about to close -- breaking writer re-admission and live presence on
  // the rejoined circle (the warm leave->rejoin "join did nothing" path).
  closeCircleChannels(circleId)
  for (const perConn of _memberAdmissionChannels.values()) perConn.delete(circleId)
  // Drop ephemeral live state for the circle (proposal 2026-06-04 phase 1).
  _liveLastSeen.delete(circleId)
  liveChannelDropCircle(circleId)
  invalidateCircleView(circleId)
  // Close + drop per-member last-known cores for the circle (slice 2a).
  const selfCore = _lastKnownSelfCores.get(circleId)
  if (selfCore) {
    try { await selfCore.close() } catch (e) { console.warn('[bare] self last-known close failed', e?.message) }
    _lastKnownSelfCores.delete(circleId)
  }
  const peerCores = _lastKnownPeerCores.get(circleId)
  if (peerCores) {
    for (const c of peerCores.values()) {
      try { await c.close() } catch (e) { console.warn('[bare] peer last-known close failed', e?.message) }
    }
    _lastKnownPeerCores.delete(circleId)
  }
  _lastKnownCache.delete(circleId)
  _circleEncKeys.delete(circleId)
  _lastKnownAnnounced.delete(circleId)
  _firstLastKnownWriteMarked.delete(circleId)
  _firstPeerLastKnownMarked.delete(circleId)
  _lastSeenCutoverCircles.delete(circleId)
  _cutoverBlockedMarked.delete(circleId)
  _lastSentLastknownSig.delete(circleId)
  _lastSentWriterSig.delete(circleId)
  for (const key of Array.from(_circlePlaces.keys())) {
    if (key.startsWith(circleId + '|')) _circlePlaces.delete(key)
  }
  for (const key of Array.from(_lastAppendedKind.keys())) {
    if (key.startsWith(circleId + '|')) _lastAppendedKind.delete(key)
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

// FIFO-on-overflow bound for the member notify dedup sets: when full,
// drop the oldest half. Cheap and keeps memory flat over long sessions
// -- same eviction the transition / peer-trip emits inline.
function rememberEmitted (set, key, max) {
  if (set.size >= max) {
    const arr = [...set]
    set.clear()
    for (let i = arr.length >> 1; i < arr.length; i++) set.add(arr[i])
  }
  set.add(key)
}

// Our own identity + the joinedAt on our member row in this circle's
// view. Used to anchor join/leave notifications to events that post-
// date our own arrival: a brand-new circle's owner row carries a fresh
// joinedAt too, and without this anchor the peer who actually just
// joined would be told the owner "joined". Returns nulls when we have
// no identity yet or no member row (e.g. a read-only observer) -- the
// callers fall back to the freshness gate alone in that case.
async function memberSelfAnchor (view) {
  const ourKeyHex = _identity && b4a.toString(_identity.publicKey, 'hex')
  if (!ourKeyHex) return { ourKeyHex: null, joinedAt: null }
  const row = await view.get('member:' + ourKeyHex)
  return { ourKeyHex, joinedAt: typeof row?.value?.joinedAt === 'number' ? row.value.joinedAt : null }
}

// Emit member:joined so the shell can post an OS notification. Gated by:
// self-suppression, the freshness window, the post-dates-our-join anchor,
// per-(circle,pubkey,joinedAt) in-session dedup, and a circle-deleted
// check. memberValue is the stored member: row.
async function emitMemberJoined (view, circleId, memberValue, priorValue) {
  try {
    const joinedAt = memberValue && memberValue.joinedAt
    const pubkey = memberValue && memberValue.pubkey
    if (!circleId || typeof joinedAt !== 'number' || typeof pubkey !== 'string') return
    if (Date.now() - joinedAt > MEMBER_NOTIF_FRESHNESS_MS) return
    // Only a genuinely new member row notifies. If we already held a row
    // for this pubkey with the same-or-newer joinedAt, this is an autobase
    // re-apply (indexer reorg) or a profile edit (joinedAt preserved) --
    // not a join. View-backed, so it holds even on a fresh session with an
    // empty dedup set, unlike the in-session set alone.
    if (priorValue && typeof priorValue.joinedAt === 'number' && priorValue.joinedAt >= joinedAt) return
    const { ourKeyHex, joinedAt: ourJoinedAt } = await memberSelfAnchor(view)
    if (pubkey === ourKeyHex) return
    if (typeof ourJoinedAt === 'number' && joinedAt <= ourJoinedAt) return
    const dedupKey = circleId + ':' + pubkey + ':' + joinedAt
    if (_emittedMemberJoinKeys.has(dedupKey)) return
    rememberEmitted(_emittedMemberJoinKeys, dedupKey, _EMITTED_MEMBER_MAX)
    const circleRow = await view.get('circle')
    if (circleRow?.value?.deleted) return
    const displayName = (typeof memberValue.displayName === 'string' && memberValue.displayName.length > 0)
      ? memberValue.displayName : pubkey.slice(0, 8)
    send({ event: 'member:joined', data: {
      circleId,
      pubkey,
      displayName,
      circleName: circleRow?.value?.name || 'Circle',
    }})
  } catch (e) { console.warn('[bare] member:joined emit failed', e?.message) }
}

// Emit member:left for a voluntary `left:` or owner `removed:` tombstone.
// Same gates as the join path; leftTs is the tombstone's leftAt (left:)
// or ts (removed:). The leaver themselves is suppressed -- they already
// get circle:removed-self / their own teardown. displayName is read off
// the still-present member: row (tombstones hide the member at snapshot
// time, they don't delete the row).
async function emitMemberLeft (view, circleId, pubkey, leftTs) {
  try {
    if (!circleId || typeof pubkey !== 'string' || typeof leftTs !== 'number') return
    if (Date.now() - leftTs > MEMBER_NOTIF_FRESHNESS_MS) return
    const { ourKeyHex, joinedAt: ourJoinedAt } = await memberSelfAnchor(view)
    if (pubkey === ourKeyHex) return
    if (typeof ourJoinedAt === 'number' && leftTs <= ourJoinedAt) return
    const dedupKey = circleId + ':' + pubkey + ':' + leftTs
    if (_emittedMemberLeaveKeys.has(dedupKey)) return
    rememberEmitted(_emittedMemberLeaveKeys, dedupKey, _EMITTED_MEMBER_MAX)
    const circleRow = await view.get('circle')
    if (circleRow?.value?.deleted) return
    const memberRow = await view.get('member:' + pubkey)
    const displayName = (typeof memberRow?.value?.displayName === 'string' && memberRow.value.displayName.length > 0)
      ? memberRow.value.displayName : pubkey.slice(0, 8)
    send({ event: 'member:left', data: {
      circleId,
      pubkey,
      displayName,
      circleName: circleRow?.value?.name || 'Circle',
    }})
  } catch (e) { console.warn('[bare] member:left emit failed', e?.message) }
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
        await emitMemberLeft(view, circleId, keyPubkey, incoming.leftAt)
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
        // Other members see "X left Family". emitMemberLeft self-
        // suppresses, so the removed member gets only circle:removed-self
        // below, not a "you left" notification about themselves.
        await emitMemberLeft(view, circleId, keyPubkey, op.value?.ts)
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
        // Capture the row we had BEFORE this put so emitMemberJoined can
        // tell a genuine (re)join from an autobase re-apply or a profile
        // edit (which re-puts the row with an unchanged joinedAt).
        const priorMember = await view.get(op.key)
        await view.put(op.key, op.value)
        // A fresh member: row whose joinedAt post-dates our own join is a
        // real join (or rejoin -- autoAppendMemberRow rewrites with a new
        // joinedAt to out-date a stale tombstone). emitMemberJoined owns
        // the freshness / dedup / self / new-row gates.
        await emitMemberJoined(view, circleId, op.value, priorMember?.value)
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
      // `lastknownCore:{pubkey}` (proposal 2026-06-04-lastseen-ephemeral
      // slice 2a): a one-time announce of the author's per-member last-known
      // Hypercore key, signed by the user-identity in `pubkey`. Peers read it
      // to open + replicate that member's bounded last-known core. Same
      // pubkey-match rule as lastSeen so a writer can't announce a core under
      // another member's key. A negligible low-frequency op (one per member,
      // re-emitted only if the core key changes).
      if (op.key.startsWith('lastknownCore:')) {
        const incoming = op.value
        if (!verifyValue(incoming)) continue
        if (typeof incoming.coreKey !== 'string') continue
        const keyPubkey = op.key.slice('lastknownCore:'.length)
        if (keyPubkey !== incoming.pubkey) continue
        await view.put(op.key, incoming)
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
        // Retention gate: don't store transitions older than the 90-day
        // window. A late-syncing peer's stale transition log would
        // otherwise blow back the bound that pruneOldTransitions() just
        // freed. transitionIsExpired tolerates malformed ts (keeps them).
        // Expired transitions are always well past TRANSITION_FRESHNESS_MS
        // so no notification would have fired anyway.
        if (transitionIsExpired(incoming, Date.now())) continue
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
            const v = op.value
            const ourKeyHex = _identity && b4a.toString(_identity.publicKey, 'hex')
            if (
              circleId && v && v.deleted !== true &&
              typeof v.pubkey === 'string' &&
              typeof v.endTs === 'number' &&
              typeof v.distanceMeters === 'number' &&
              v.pubkey !== ourKeyHex
            ) {
              const author = v.pubkey
              const lagMs = Date.now() - v.endTs
              // Freshness is now a generous backstop (24h); the persisted dedup
              // and baseline are the real guards (proposal 2026-06-11).
              const fresh = lagMs <= PEER_TRIP_FRESHNESS_MS
              const afterBaseline = typeof _tripNotifyBaseline !== 'number' || v.endTs >= _tripNotifyBaseline
              const notFuture = v.endTs <= Date.now() + FUTURE_TS_TOLERANCE_MS
              const meetsThreshold =
                v.distanceMeters >= PEER_TRIP_MIN_DISTANCE_M ||
                (typeof v.durationMs === 'number' && v.durationMs >= PEER_TRIP_MIN_DURATION_MS)
              const already = _emittedPeerTripKeys.has(op.key)
              const willEmit = _tripNotificationsEnabled && fresh && afterBaseline && notFuture && meetsThreshold && !already
              // Diagnostic (peer-trip notification investigation 2026-06-11):
              // record the gate decision so a non-firing notification splits
              // cleanly into stale / pre-baseline / below-threshold / toggle-off
              // / already-emitted. Marked only when it'll emit or is recent, so
              // a cold-boot replay of old trips can't flood the trace.
              if (willEmit || lagMs < 30 * 60 * 1000) {
                mark('trip:apply', { from: author.slice(0, 8), lagMs, fresh, afterBaseline, meetsThreshold, notif: _tripNotificationsEnabled, already, distanceMeters: v.distanceMeters, willEmit })
                reshipTrace()
              }
              if (willEmit) {
                await markTripNotified(op.key)
                const memberRow = await view.get('member:' + author)
                send({ event: 'peerTrip:completed', data: {
                  circleId,
                  authorPubkey: author,
                  displayName: memberRow?.value?.displayName || author.slice(0, 8),
                  distanceMeters: v.distanceMeters,
                  durationMs: typeof v.durationMs === 'number' ? v.durationMs : null,
                  startTs: typeof v.startTs === 'number' ? v.startTs : null,
                  endTs: v.endTs,
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
      // `supersede:{newCircleId}` (proposal 2026-06-17 slice 3): the owner's
      // migration nudge, carrying the new circle's invite. Accepted only when
      // the signature verifies against the circle's ownerKey (no other writer
      // can forge a "we moved" notice), the embedded ownerKey matches the
      // circle row's ownerKey, and the key segment matches the signed
      // newCircleId. LWW on postedAt so a re-post out-dates the prior record.
      // Old-build members ignore the unknown prefix and migrate manually.
      if (op.key.startsWith('supersede:')) {
        const incoming = op.value
        const keyNew = op.key.slice('supersede:'.length)
        const ownerKey = (await view.get('circle'))?.value?.ownerKey
        const existing = (await view.get(op.key))?.value
        const accept = shouldAcceptSupersede({
          keyNew,
          incoming,
          ownerKey,
          existing,
          now: Date.now(),
          futureToleranceMs: FUTURE_TS_TOLERANCE_MS,
          verifySig: (val) => verifyValueWithSigner(val, 'ownerKey'),
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
  // This apply pass may have mutated the view; drop the cached snapshot view so
  // the next circles:getAll poll rebuilds it (storage/sync audit 2026-06-22).
  // circleId is passed by every apply wrapper; fall back to a base match so a
  // future caller that omits it can't leave the cache silently stale.
  let cid = circleId
  if (!cid) for (const [c, b] of _circleBases) { if (b === base) { cid = c; break } }
  invalidateCircleView(cid)
}

async function autoAppendMemberRow (circleId) {
  // A voluntary leave is in flight: do not resurrect our member row. The
  // rejoin-recovery below would otherwise read our own left: tombstone as
  // a stale one and out-date it, cancelling the leave on every peer.
  if (_leavingCircles.has(circleId)) return
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
  if (await safeAppend(base, { type: 'put', key: 'member:' + ourKey, value: memberValue }, 'member')) {
    if (!_firstWriterMarked.has(circleId)) {
      _firstWriterMarked.add(circleId)
      mark('writer:first-added', { circleId })
    }
    send({ event: 'circle:writer:added', data: { circleId, writerKey: ourKey } })
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
  await safeAppend(base, { type: 'put', key: 'lastSeen:' + ourKey, value: _selfLastSeen }, 'lastSeen:boot')
}

// Derive the corestore namespace for a circle at a given rebuild generation.
// Gen 0 uses the bare circleId (legacy / freshly joined). circle:repair bumps
// the generation and remounts under `:r{gen}`, so the rebuilt base gets fresh
// local cores (writer/view/system) and re-syncs clean from the seeder while
// the corrupt gen-0 cores are orphaned (proposal 2026-06-03c, strong repair).
function circleNamespaceKey (circleId, rebuildGen) {
  return rebuildGen ? circleId + ':r' + rebuildGen : circleId
}

// Build (but do not register) a circle's Autobase under its rebuildGen
// namespace. Split out so circle:repair can build the rebuilt base BEFORE
// swapping out the old one — a hung build then never leaves the circle
// unmounted (it just keeps the old base).
async function buildCircleAutobase (circleId, bootstrapHex, encryptionKeyHex, rebuildGen = 0) {
  const ns = _store.namespace(circleNamespaceKey(circleId, rebuildGen))
  const baseOpts = {
    open: openCircleView,
    apply: (nodes, view, b) => applyCircleNodes(nodes, view, b, circleId),
    valueEncoding: 'json',
  }
  if (encryptionKeyHex) baseOpts.encryptionKey = b4a.from(encryptionKeyHex, 'hex')
  const base = new Autobase(ns, b4a.from(bootstrapHex, 'hex'), baseOpts)
  await base.ready()
  attachConflictListeners(base, circleId)
  return base
}

async function mountCircleAutobase (circleId, bootstrapHex, encryptionKeyHex, { rebuildGen = 0 } = {}) {
  if (_circleBases.has(circleId)) return _circleBases.get(circleId)
  const base = await buildCircleAutobase(circleId, bootstrapHex, encryptionKeyHex, rebuildGen)
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
    // The revocation flag is now cleared ONLY by an explicit `admitted` notice
    // on the admission channel (handleSeederAdmittedNotice), not by block
    // downloads (proposal 2026-06-11-seeder-readmit). The old "any download
    // clears the revoke" heuristic was fundamentally broken: revoking appends a
    // block to the member's core, and on a still-live connection the seeder
    // downloaded that very block and cleared the revoke ~12ms after recording
    // it, so a revoke never stuck. Re-admission is explicit instead.
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
  // lastknownCores: pubkeyHex → that member's last-known core (opened blind,
  // tip-only, served to offline-last-known requesters). Proposal 2026-06-04 2b.
  // writerCores: coreKeyHex → a member's Autobase writer core (opened blind,
  // full history downloaded, so the seeder mirrors every member's contributions
  // and not just the founder's bootstrap. Proposal 2026-05-19 slice 3d.
  // bootstrap kept on the entry so the per-connection admission setup
  // (onSeederSwarmConnection) can derive the bootstrap-bound channel id without
  // re-reading the enrolled row. Proposal 2026-06-11-circleid-channel-binding.
  _seederCircles.set(circleId, { core, topicHex, discovery, onDownload, bootstrap, lastknownCores: new Map(), writerCores: new Map() })
  mark('seeder:mounted', { circleId, bootstrap: bootstrap.slice(0, 8), authorityLength: core.length, contiguousLength: core.contiguousLength })
  // Open the seed-role admission channel for this circle on every
  // existing connection. New connections get it via onSeederSwarmConnection;
  // this covers circles auto-enrolled after a connection already formed,
  // so the seeder can announce itself for them (proposal amendment
  // 2026-05-20). At boot _seederActiveConns is empty — harmless no-op.
  const seederPubkeyHex = b4a.toString(_identity.publicKey, 'hex')
  for (const conn of _seederActiveConns) {
    // Re-enroll over a persistent connection: the admission channel from before
    // the leave is still open on both sides, so just re-send the announce on it
    // (recreating the channel here is racy — create-failed / never-opens — and
    // was the re-enroll resurrection bug). Only create a fresh channel when none
    // exists for this connection (first enroll, or after a reconnect).
    const existing = _seederAdmissionChannels.get(conn)?.get(circleId)
    if (existing && typeof existing.sendAnnounce === 'function') {
      existing.sendAnnounce()
      mark('seeder:announce-channel-open', { circleId, remote: 'post-mount-reannounce' })
      continue
    }
    const handle = setupSeederAdmissionChannel({
      conn,
      role: 'seed',
      circleId,
      bootstrap,
      seederPubkey: seederPubkeyHex,
      version: _seederVersion,
      onRevoked: handleSeederRevocationNotice,
      onAdmitted: handleSeederAdmittedNotice,
      onLastknownCores: handleSeederLastknownCores,
      onWriterCores: handleSeederWriterCores,
      mark,
    })
    trackSeederAdmissionChannel(conn, circleId, handle)
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
  // Last-writer-wins: ignore a revoked notice older than the verdict we've
  // already applied for this circle, so a not-yet-synced member re-asserting
  // its lagging row can't undo a newer re-admit and flap the flag (proposal
  // 2026-06-11-seeder-readmit). A null revokedAt (legacy member, pre-revokedAt)
  // can't be ordered, so it always applies — no regression for old peers.
  if (typeof revokedAt === 'number' && Number.isFinite(revokedAt)) {
    const applied = _seederFlagTs.get(circleId)
    if (typeof applied === 'number' && revokedAt < applied) {
      mark('seeder:revoke-notice-stale', { circleId, revokedAt, applied })
      return
    }
  }
  try {
    await recordRevocationNotice(_localDb, { circleId, revokedAt, now: Date.now() })
    _seederRevokedCircles.add(circleId)
    if (typeof revokedAt === 'number' && Number.isFinite(revokedAt)) _seederFlagTs.set(circleId, revokedAt)
    mark('seeder:revocation-noticed', { circleId, revokedAt })
  } catch (e) {
    mark('seeder:revocation-record-failed', { circleId, err: e?.message ?? String(e) })
  }
}

// Seed-mode handler for an inbound explicit `admitted` notice on the admission
// channel (proposal 2026-06-11-seeder-readmit). Clears the seeder:revoked
// flag for this circle so the dashboard stops showing it revoked and the
// circle re-seeds. Idempotent: a no-op if the circle wasn't flagged revoked.
async function handleSeederAdmittedNotice ({ circleId, updatedAt }) {
  // Last-writer-wins: ignore an admitted notice older than the verdict we've
  // already applied, so a not-yet-synced member re-asserting a stale admitted
  // can't undo a newer revoke and flap the flag (proposal 2026-06-11-seeder-
  // readmit). A null updatedAt (legacy member) can't be ordered, so it always
  // applies. Record the ts even when not currently revoked, so a later stale
  // revoke is ordered against this admit and rejected.
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    const applied = _seederFlagTs.get(circleId)
    if (typeof applied === 'number' && updatedAt < applied) {
      mark('seeder:admit-notice-stale', { circleId, updatedAt, applied })
      return
    }
    _seederFlagTs.set(circleId, updatedAt)
  }
  if (!_seederRevokedCircles.has(circleId)) return
  _seederRevokedCircles.delete(circleId)
  try {
    await clearRevocationNotice(_localDb, circleId)
    mark('seeder:admit-noticed', { circleId })
  } catch (e) {
    mark('seeder:admit-clear-failed', { circleId, err: e?.message ?? String(e) })
  }
}

// One pass of the seeder retention sweep. Reads pruneOlderThan from the
// seeder:retention:{circleId} sidecar for every currently-mounted circle;
// pure helper picks the stale block seqs; we call core.clear + drop the
// per-block tracker row. Proposal 2026-05-19-blind-seeder-peers slice 5.
// Estimate a core's per-block byte size for the sweep's reclaimed-bytes
// diagnostic. byteLength is the authority total and doesn't drop on clear(),
// and exact per-block sizes aren't cheaply available on a blind core, so the
// average is the honest cheap proxy (seeder blocks are uniform lastSeen/
// transition ops). Physical disk is reclaimed by the next RocksDB compaction.
function avgBlockBytes (core) {
  const len = core?.length || 0
  const bytes = core?.byteLength || 0
  return len > 0 && bytes > 0 ? Math.round(bytes / len) : 0
}

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
      if (!entry?.core) return 0
      const bytes = avgBlockBytes(entry.core)
      try {
        await entry.core.clear(seq, seq + 1)
      } finally {
        await removeBlockTracking(_localDb, circleId, seq).catch(() => {})
      }
      return bytes
    },
    now: Date.now(),
  })
}

// One pass of the per-member writer-core retention sweep (storage audit
// 2026-06-22). Same time-based pruneOlderThan policy as the bootstrap
// sweep above, applied to every mounted circle's writer cores so the
// launcher retention knob actually bounds them. Clears on the specific
// writer core (independent seq space), not entry.core.
async function runOneSeederWriterRetentionSweep () {
  const writerCores = []
  for (const [circleId, entry] of _seederCircles) {
    if (!entry?.writerCores) continue
    for (const coreKey of entry.writerCores.keys()) writerCores.push({ circleId, coreKey })
  }
  return runSeederWriterRetentionSweep({
    localDb: _localDb,
    writerCores,
    getRetentionMs: async (circleId) => {
      const row = await _localDb.get('seeder:retention:' + circleId)
      const v = row?.value?.pruneOlderThan
      return typeof v === 'number' ? v : null
    },
    clearBlock: async (circleId, coreKey, seq) => {
      const entry = _seederCircles.get(circleId)
      const core = entry?.writerCores?.get(coreKey)
      if (!core) return 0
      const bytes = avgBlockBytes(core)
      try {
        await core.clear(seq, seq + 1)
      } finally {
        await removeWriterBlockTracking(_localDb, circleId, coreKey, seq).catch(() => {})
      }
      return bytes
    },
    now: Date.now(),
  })
}

// Register a seed-role admission channel's send handles so leaveSeederCircle can
// later push the in-band `left` notice over it (proposal 2026-06-17-seeder-leave
// -propagation). No-op for older handles lacking sendLeft.
function trackSeederAdmissionChannel (conn, circleId, handle) {
  if (!handle || typeof handle.sendLeft !== 'function') return
  let perConn = _seederAdmissionChannels.get(conn)
  if (!perConn) { perConn = new Map(); _seederAdmissionChannels.set(conn, perConn) }
  // Keep sendLeft (push the leave notice) + sendAnnounce (re-announce on
  // re-enroll over this same still-open channel — see leaveSeederCircle /
  // mountSeederCircle). We deliberately do NOT close the channel on leave:
  // recreating a per-circle admission channel on a persistent Hyperswarm
  // connection is racy (create-failed, or it never reaches onopen). Keeping it
  // open and re-sending the announce is the reliable re-enroll path.
  perConn.set(circleId, { sendLeft: handle.sendLeft, sendAnnounce: handle.sendAnnounce, channel: handle.channel })
}

async function leaveSeederCircle (circleId) {
  _seederRevokedCircles.delete(circleId)
  // Tell currently-connected members we're leaving BEFORE tearing down, so each
  // writes a `left` tombstone and the seeder vanishes from their Seeders list
  // (proposal 2026-06-17-seeder-leave-propagation). The Hyperswarm connection is
  // shared across circles and is NOT closed here, so the admission channel is
  // still live to carry this frame. Best-effort: members not connected right now
  // never receive it and rely on the manual Remove in Settings.
  // Push the leave notice over each connected member's admission channel, but
  // KEEP the channel open (do not close, do not drop the registry entry): a
  // re-enroll re-announces over this same channel (mountSeederCircle), which is
  // reliable, whereas closing + recreating on a persistent connection is racy
  // (the recreate hits create-failed or never reaches onopen, so the seeder
  // never reappears on members).
  let leftSent = 0
  for (const perConn of _seederAdmissionChannels.values()) {
    const h = perConn.get(circleId)
    if (h && h.sendLeft()) leftSent++
  }
  if (leftSent > 0) mark('seeder:left-notice-pushed', { circleId, sent: leftSent })
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
  // Close + forget this circle's last-known cores and their persisted keys (2b).
  if (entry.lastknownCores) {
    for (const c of entry.lastknownCores.values()) { try { await c.close() } catch {} }
    entry.lastknownCores.clear()
  }
  for await (const { key } of _localDb.createReadStream({
    gt: 'seeder:lastknownCore:' + circleId + ':', lt: 'seeder:lastknownCore:' + circleId + ':~',
  })) {
    await _localDb.del(key).catch(() => {})
  }
  // Close + forget this circle's writer cores and their persisted keys (slice 3d).
  if (entry.writerCores) {
    for (const [coreKey, c] of entry.writerCores) {
      const fn = entry.writerOnDownload?.get(coreKey)
      if (fn) { try { c.off('download', fn) } catch {} }
      try { await c.close() } catch {}
    }
    entry.writerCores.clear()
  }
  if (entry.writerOnDownload) entry.writerOnDownload.clear()
  for await (const { key } of _localDb.createReadStream({
    gt: 'seeder:writerCore:' + circleId + ':', lt: 'seeder:writerCore:' + circleId + ':~',
  })) {
    await _localDb.del(key).catch(() => {})
  }
  // Drop per-block writer retention tracking rows for this circle (storage
  // audit 2026-06-22) so they don't orphan after a leave.
  for await (const { key } of _localDb.createReadStream(rangeForWriterCircle(circleId))) {
    await _localDb.del(key).catch(() => {})
  }
  _seederCircles.delete(circleId)
  mark('seeder:left', { circleId })
}

// Seed-mode handler for a member's last-known core-key list. The blind seeder
// can't read the encrypted view, so members push these keys here; we open each
// core (no enc key — we replicate ciphertext, never decrypt) and serve its tip
// to peers wanting offline last-known. Only for enrolled circles, persisted so
// a restart re-opens them. Proposal 2026-06-04-lastseen-ephemeral slice 2b.
async function handleSeederLastknownCores ({ circleId, cores }) {
  const entry = _seederCircles.get(circleId)
  if (!entry) return // not enrolled — ignore (channel is per-circle, belt-and-suspenders)
  if (!entry.lastknownCores) entry.lastknownCores = new Map()
  for (const { pubkey, coreKey } of cores) {
    const existing = entry.lastknownCores.get(pubkey)
    if (existing && b4a.toString(existing.key, 'hex') === coreKey) continue // already serving this exact core
    await openSeederLastknownCore(entry, circleId, pubkey, coreKey)
    await _localDb.put('seeder:lastknownCore:' + circleId + ':' + pubkey, {
      circleId, pubkey, coreKey, addedAt: Date.now(),
    }).catch((e) => console.warn('[bare] seeder lastknown persist failed', e?.message))
  }
}

// Open one peer last-known core blind and keep its tip downloaded + bounded.
async function openSeederLastknownCore (entry, circleId, pubkey, coreKey) {
  if (!entry.lastknownCores) entry.lastknownCores = new Map()
  const prev = entry.lastknownCores.get(pubkey)
  if (prev) { try { await prev.close() } catch {} } // key changed: drop the old one
  const core = openPeerCore(_store, coreKey, null)
  await core.ready()
  entry.lastknownCores.set(pubkey, core)
  // Follow the member's appends: download each new tip, then clear the prior
  // blocks so the seeder's copy stays O(1) (mirrors the member's appendFix).
  const onAppend = () => { refreshSeederLastknownTip(core, circleId, pubkey).catch(() => {}) }
  core.on('append', onAppend)
  refreshSeederLastknownTip(core, circleId, pubkey).catch(() => {})
  mark('seeder:lastknown-opened', { circleId, pubkey: pubkey.slice(0, 8), coreKey: coreKey.slice(0, 8) })
}

// Download a seeder-held last-known core's tip block, then clear earlier blocks
// so storage stays bounded to the latest fix (we never decrypt — the seeder
// only stores + serves ciphertext). Best-effort throughout.
async function refreshSeederLastknownTip (core, circleId, pubkey) {
  await core.ready()
  try { await core.update({ wait: false }) } catch {}
  if (core.length === 0) return
  try {
    await core.get(core.length - 1, { wait: true, timeout: PEER_TIP_FETCH_TIMEOUT_MS })
  } catch { return } // tip not served yet; the 'append'/next push retries
  // One-shot observability: the seeder replicated a member's (encrypted) tip,
  // so it can now serve offline last-known (proposal 2026-06-04 slice 2b).
  const coreKeyHex = b4a.toString(core.key, 'hex')
  if (!_seederLastknownTipMarked.has(coreKeyHex)) {
    _seederLastknownTipMarked.add(coreKeyHex)
    mark('seeder:lastknown-tip', { circleId, pubkey: (pubkey || '').slice(0, 8), length: core.length })
  }
  if (core.length > 1) { try { await core.clear(0, core.length - 1) } catch {} }
}

// Seed-mode handler for a member's writer-core-key list. The blind seeder can't
// enumerate the circle's writers from the encrypted view, so members push the
// per-member writer-core keys here; we open each blind (no enc key — ciphertext
// only) and download its full history so the seeder mirrors every member's
// contributions, not just the founder's bootstrap. Only for enrolled circles,
// persisted so a restart re-opens them. Proposal 2026-05-19 slice 3d.
async function handleSeederWriterCores ({ circleId, cores }) {
  const entry = _seederCircles.get(circleId)
  if (!entry) return // not enrolled — ignore (channel is per-circle, belt-and-suspenders)
  if (!entry.writerCores) entry.writerCores = new Map()
  for (const { pubkey, coreKey } of cores) {
    // The founder's writer core IS the bootstrap, already open + downloading
    // in mountSeederCircle; skip the redundant second open.
    if (entry.core && b4a.toString(entry.core.key, 'hex') === coreKey) continue
    if (entry.writerCores.has(coreKey)) continue // already mirroring this exact core
    await openSeederWriterCore(entry, circleId, pubkey, coreKey)
    await _localDb.put('seeder:writerCore:' + circleId + ':' + coreKey, {
      circleId, pubkey, coreKey, addedAt: Date.now(),
    }).catch((e) => console.warn('[bare] seeder writer-core persist failed', e?.message))
  }
}

// Open one member writer core blind and background-download its full history,
// mirroring the bootstrap-core treatment in mountSeederCircle. Unlike a
// last-known core (tip-only), a writer core carries the member's whole signed
// op log, so we keep all of it for the seeder to serve. Not TTL-pruned in this
// slice — see the retention note in proposal 2026-05-19 slice 3d completion.
async function openSeederWriterCore (entry, circleId, pubkey, coreKey) {
  if (!entry.writerCores) entry.writerCores = new Map()
  if (entry.writerCores.has(coreKey)) return
  const core = openPeerCore(_store, coreKey, null)
  await core.ready()
  entry.writerCores.set(coreKey, core)
  // Track per-block receive time so the writer-core retention sweep can
  // drop blocks older than the circle's pruneOlderThan (storage audit
  // 2026-06-22). Mirrors the bootstrap core's onDownload in
  // mountSeederCircle; track-forward only (already-downloaded blocks
  // don't re-emit 'download'). receivedAt is when THIS seeder stored the
  // block, the only thing measurable without the encryption key.
  const onDownload = (index) => {
    recordWriterBlockReceived(_localDb, circleId, coreKey, index, Date.now()).catch((e) => {
      console.warn('[bare] seeder writer block-track failed', circleId, coreKey.slice(0, 8), index, e?.message)
    })
  }
  core.on('download', onDownload)
  if (!entry.writerOnDownload) entry.writerOnDownload = new Map()
  entry.writerOnDownload.set(coreKey, onDownload)
  core.download({ start: 0, end: -1, linear: false })
  mark('seeder:writer-opened', { circleId, pubkey: (pubkey || '').slice(0, 8), coreKey: coreKey.slice(0, 8), length: core.length })
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
async function setupMemberAdmissionChannel (conn, circleId, base) {
  const pubkeyHex = _connPubkey.get(conn)
  // Our current verdict on this peer-as-seeder, pushed on channel open so the
  // seeder's revoked flag converges to ours even if a live signal was missed
  // (proposal 2026-06-11-seeder-readmit). A seeder row is either revoked or
  // admitted; no row means not a known seeder, so send nothing (it announces
  // and gets auto-admitted fresh).
  let revokedNotice = null
  let admittedNotice = null
  if (pubkeyHex) {
    try {
      const row = (await base.view.get('seeder:' + pubkeyHex))?.value ?? null
      revokedNotice = revocationNoticeFor(circleId, row)
      // Carry the row's updatedAt so the seed can order this admit against the
      // revoked notices other members push (proposal 2026-06-11-seeder-readmit).
      if (row && row.revoked !== true) {
        admittedNotice = { circleId, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : null }
      }
    } catch {}
  }
  const result = setupSeederAdmissionChannel({
    conn,
    role: 'member',
    circleId,
    // base.key is this circle's bootstrap; the channel id binds to it so a
    // mislabeled circleId can't cross-pair (2026-06-11-circleid-channel-binding).
    bootstrap: b4a.toString(base.key, 'hex'),
    onAnnounce: (msg) => handleSeederAnnounce(circleId, base, msg, conn),
    // The seeder operator left this circle (proposal 2026-06-17-seeder-leave
    // -propagation): write the `left` tombstone so it vanishes from our list.
    onLeft: () => handleSeederLeaveNotice(circleId, base, conn),
    revokedNotice,
    admittedNotice,
    mark,
  })
  if (!result || typeof result.sendRevoked !== 'function') return
  trackCircleChannel(circleId, result.channel)
  if (!pubkeyHex) return
  let perConn = _memberAdmissionChannels.get(conn)
  if (!perConn) {
    perConn = new Map()
    _memberAdmissionChannels.set(conn, perConn)
  }
  // isSeeder flips true once this peer's announce arrives (handleSeederAnnounce);
  // last-known + writer core keys are pushed only to confirmed seeders.
  perConn.set(circleId, { pubkeyHex, isSeeder: false, sendRevoked: result.sendRevoked, sendAdmitted: result.sendAdmitted, sendLastknownCores: result.sendLastknownCores, sendWriterCores: result.sendWriterCores })
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

// Push an explicit re-admission notice to any live connection to `pubkey` for
// this circle (proposal 2026-06-11-seeder-readmit). The seed clears its revoked
// flag on receipt; the connect-time admittedNotice on channel open covers a
// seeder that isn't connected at re-admit time. Best-effort, mirrors
// notifySeederRevoked.
function notifySeederAdmitted (circleId, pubkey, updatedAt) {
  let sent = 0
  for (const perConn of _memberAdmissionChannels.values()) {
    const entry = perConn.get(circleId)
    if (entry && entry.pubkeyHex === pubkey && typeof entry.sendAdmitted === 'function' && entry.sendAdmitted(updatedAt)) sent++
  }
  if (sent > 0) {
    mark('seeder:admit-notice-pushed', { circleId, pubkey: pubkey.slice(0, 8), sent })
  }
}

// Re-attach corestore replication to a seeder's live connection(s) after a
// re-admit (proposal 2026-06-11-seeder-readmit-resume-replication). A seeder
// revoked from every circle had `_store.replicate(conn)` skipped at connect
// time; re-admitting it must resume replication so blocks flow again and the
// seeder's own download-triggered revocation-clear fires. Guarded by
// _replicatingConns so a connection that already replicates is never
// double-attached (the partially-revoked case).
function resumeSeederReplication (pubkey) {
  let resumed = 0
  for (const conn of _activeConns) {
    if (_connPubkey.get(conn) !== pubkey) continue
    if (_replicatingConns.has(conn)) continue
    try {
      _store.replicate(conn)
      _replicatingConns.add(conn)
      resumed++
    } catch (e) {
      mark('seeder:replication-resume-failed', { pubkey: pubkey.slice(0, 8), err: e?.message ?? String(e) })
    }
  }
  if (resumed > 0) mark('seeder:replication-resumed', { pubkey: pubkey.slice(0, 8), resumed })
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
    if (ch) { opened++; trackCircleChannel(circleId, ch) }
    // Member-role admission channel — without this a seeder that
    // auto-enrolls (or is invited to) a circle created after the
    // connection formed could never have its announce received.
    setupMemberAdmissionChannel(conn, circleId, base).catch(() => {})
    // Ephemeral live-position channel (proposal 2026-06-04 phase 1).
    setupLiveChannelFor(conn, circleId)
  }
  mark('pair:open-for-circle', { circleId: circleId.slice(0, 8), conns: _activeConns.size, opened, writable: !!base.writable })
}

// Open the live-position channel for (conn, circleId) and register its sender
// so location:update can broadcast to this peer. getOutgoing sends our current
// fix on open only when the circle is actively sharing (respects per-circle
// mute). Received positions go through handleLivePosition. Proposal 2026-06-04.
function setupLiveChannelFor (conn, circleId) {
  const handle = setupLiveChannel({
    conn,
    circleId,
    mark,
    getOutgoing: () => (getCircleSharing(circleId).enabled ? _selfLastSeen : null),
    onPosition: (value) => { handleLivePosition(circleId, value).catch(() => {}) },
  })
  if (!handle) return
  trackCircleChannel(circleId, handle.channel)
  liveChannelAdd(circleId, conn, handle.send)
}

// Lazy live-channel creation when a peer opens the live protocol for a circle
// we know about but didn't proactively open (mirrors registerPairNotify).
function registerLiveNotify (conn) {
  const mux = Protomux.from(conn)
  mux.pair({ protocol: LIVE_PROTOCOL, id: null }, async (id) => {
    if (!id) return
    let circleIdStr
    try { circleIdStr = b4a.toString(id) } catch { return }
    if (!_circleBases.has(circleIdStr)) return
    if (liveChannelHas(circleIdStr, conn)) return // already open
    setupLiveChannelFor(conn, circleIdStr)
  })
}

// Verify + gate a received live position, then store the freshest per member.
// Security: verifyValue proves the sender holds the embedded pubkey's secret
// key, and the member-row check keeps non-members out of memory. snapshotCircle
// re-filters against left/removed, so this is a coarse gate. Drops our own
// echoes and stale/duplicate fixes (ts not advancing).
async function handleLivePosition (circleId, value) {
  if (!value || typeof value.pubkey !== 'string') return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  if (value.pubkey === ourKey) return
  if (!verifyValue(value)) return
  const base = _circleBases.get(circleId)
  if (!base) return
  const member = await base.view.get('member:' + value.pubkey).catch(() => null)
  if (!member?.value) return
  let perCircle = _liveLastSeen.get(circleId)
  if (!perCircle) { perCircle = new Map(); _liveLastSeen.set(circleId, perCircle) }
  const cur = perCircle.get(value.pubkey)
  if (cur && typeof cur.ts === 'number' && typeof value.ts === 'number' && value.ts <= cur.ts) return
  perCircle.set(value.pubkey, value)
  // One-shot observability: the first live fix received per circle confirms the
  // ephemeral receive path works (proposal 2026-06-04 phase 1). Bounded to once
  // per circle, then re-ship the trace so it lands in coldstart.log.
  if (!_firstLiveRecvMarked.has(circleId)) {
    _firstLiveRecvMarked.add(circleId)
    mark('live:recv:first', { circleId: circleId.slice(0, 8), from: value.pubkey.slice(0, 8) })
    reshipTrace()
  }
  // Nudge the UI to re-read the snapshot promptly (it polls circles:getAll).
  send({ event: 'circle:liveLocation', data: { circleId } })
}

// Broadcast a signed fix to every connected peer's live channel for a circle.
function broadcastLive (circleId, value) {
  let sent = 0
  const byConn = _liveByCircle.get(circleId)
  if (byConn) {
    for (const sendFn of byConn.values()) {
      if (sendFn(value)) sent++
    }
  }
  // One-shot observability: the first time we actually push a live fix to at
  // least one peer for a circle (proposal 2026-06-04 phase 1). Bounded to once
  // per circle, then re-ship the trace so it lands in coldstart.log.
  if (sent > 0 && !_firstLiveBroadcastMarked.has(circleId)) {
    _firstLiveBroadcastMarked.add(circleId)
    mark('live:broadcast:first', { circleId: circleId.slice(0, 8), peers: sent })
    reshipTrace()
  }
  return sent
}

// --- Per-member last-known cores (proposal 2026-06-04-lastseen-ephemeral slice 2a) ---

// Resolve a circle's enc key hex, caching it. Falls back to the local
// circles:joined record so callers don't have to thread it from the mount site
// (legacy unencrypted circles resolve to null, which openSelf/PeerCore handle).
async function circleEncKeyHex (circleId) {
  if (_circleEncKeys.has(circleId)) return _circleEncKeys.get(circleId)
  const rec = await _localDb.get('circles:joined:' + circleId).catch(() => null)
  const k = rec?.value?.encryptionKey || null
  _circleEncKeys.set(circleId, k)
  return k
}

// Open (creating on first use) our own last-known core for a circle, cached.
async function ensureSelfLastKnownCore (circleId) {
  let core = _lastKnownSelfCores.get(circleId)
  if (core) return core
  const encKey = await circleEncKeyHex(circleId)
  core = openSelfCore(_store, circleId, encKey)
  _lastKnownSelfCores.set(circleId, core)
  return core
}

// Persist the latest signed fix to our per-member core (append + clear earlier
// blocks so on-disk DATA stays O(1)). Runs alongside the live broadcast and the
// Autobase dual-write on every accepted location:update. Independent of base
// writability: the core is single-writer and entirely ours.
async function appendSelfLastKnown (circleId, value) {
  const core = await ensureSelfLastKnownCore(circleId)
  await appendFix(core, value)
  if (!_firstLastKnownWriteMarked.has(circleId)) {
    _firstLastKnownWriteMarked.add(circleId)
    mark('lastknown:first-write', { circleId: circleId.slice(0, 8) })
    reshipTrace()
  }
}

// Announce our last-known core key in the Autobase once per circle, so peers
// can discover and replicate the core. Writable-only (the announce is an
// Autobase op) and idempotent: skipped once the view already carries our
// current key. A single low-frequency op per member.
async function announceLastKnownCore (circleId) {
  if (_lastKnownAnnounced.has(circleId)) return
  const base = _circleBases.get(circleId)
  if (!base || !base.writable) return
  const core = await ensureSelfLastKnownCore(circleId)
  await core.ready()
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const coreKeyHex = b4a.toString(core.key, 'hex')
  const existing = await base.view.get('lastknownCore:' + ourKey).catch(() => null)
  if (existing?.value?.coreKey === coreKeyHex) { _lastKnownAnnounced.add(circleId); return }
  const announce = signValue({ pubkey: ourKey, coreKey: coreKeyHex, v: 1 }, _identity.secretKey)
  if (await safeAppend(base, { type: 'put', key: 'lastknownCore:' + ourKey, value: announce }, 'lastknownCore')) {
    _lastKnownAnnounced.add(circleId)
    mark('lastknown:announced', { circleId: circleId.slice(0, 8), coreKey: coreKeyHex.slice(0, 8) })
    reshipTrace()
  }
}

// Read peers' announced core keys from the view, open their cores (cached), and
// pull each tip into _lastKnownCache. Non-blocking with respect to snapshot: a
// not-yet-downloaded tip triggers a background fetch and lands on a later poll.
async function refreshPeerLastKnown (circleId) {
  const base = _circleBases.get(circleId)
  if (!base) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const encKey = await circleEncKeyHex(circleId)
  let peerCores = _lastKnownPeerCores.get(circleId)
  if (!peerCores) { peerCores = new Map(); _lastKnownPeerCores.set(circleId, peerCores) }
  if (!_lastKnownCache.has(circleId)) _lastKnownCache.set(circleId, new Map())
  for await (const { key, value } of base.view.createReadStream({ gt: 'lastknownCore:', lt: 'lastknownCore:~' })) {
    const pubkey = key.slice('lastknownCore:'.length)
    if (pubkey === ourKey) continue
    if (!value || typeof value.coreKey !== 'string') continue
    if (value.pubkey !== pubkey || !verifyValue(value)) continue
    let core = peerCores.get(pubkey)
    if (!core) {
      core = openPeerCore(_store, value.coreKey, encKey)
      peerCores.set(pubkey, core)
    }
    pullPeerTip(circleId, pubkey, core).catch(() => {})
  }
}

// Download + cache a peer core's tip. readTip is non-blocking, so on a cold
// core we fire a bounded background fetch of the tip block and return; the next
// refresh reads it. Validates the signed value (signature + pubkey match) so a
// blind/forged block can't poison the cache, and is LWW on ts.
async function pullPeerTip (circleId, pubkey, core) {
  await core.ready()
  try { await core.update({ wait: false }) } catch {}
  if (core.length === 0) return
  const tip = await readTip(core)
  if (!tip) {
    // Tip not local yet: request it in the background (bounded), cache later.
    core.get(core.length - 1, { wait: true, timeout: PEER_TIP_FETCH_TIMEOUT_MS }).catch(() => {})
    return
  }
  if (tip.pubkey !== pubkey || !verifyValue(tip)) return
  const cache = _lastKnownCache.get(circleId)
  if (!cache) return
  const cur = cache.get(pubkey)
  if (cur && typeof cur.ts === 'number' && typeof tip.ts === 'number' && tip.ts <= cur.ts) return
  cache.set(pubkey, tip)
  // One-shot observability: the first peer tip we replicate + decrypt + cache
  // for a circle confirms the full last-known read path (announce → open core →
  // download tip → verify → cache), the slice-2a payoff (proposal 2026-06-04).
  if (!_firstPeerLastKnownMarked.has(circleId)) {
    _firstPeerLastKnownMarked.add(circleId)
    mark('lastknown:peer-tip:first', { circleId: circleId.slice(0, 8), from: pubkey.slice(0, 8) })
    reshipTrace()
  }
}

// Collect the per-member last-known core keys known for a circle: our own self
// core plus every peer's announced `lastknownCore:` row from the view (which we
// can read but the blind seeder can't). Returned to the seeder over the
// admission channel so it can replicate + serve them (slice 2b).
async function collectLastknownCores (circleId) {
  const out = []
  const seen = new Set()
  try {
    const core = await ensureSelfLastKnownCore(circleId)
    await core.ready()
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    out.push({ pubkey: ourKey, coreKey: b4a.toString(core.key, 'hex') })
    seen.add(ourKey)
  } catch (e) { console.warn('[bare] collectLastknownCores self failed', e?.message) }
  const base = _circleBases.get(circleId)
  if (base) {
    try {
      for await (const { key, value } of base.view.createReadStream({ gt: 'lastknownCore:', lt: 'lastknownCore:~' })) {
        const pubkey = key.slice('lastknownCore:'.length)
        if (seen.has(pubkey)) continue
        if (!value || typeof value.coreKey !== 'string') continue
        if (value.pubkey !== pubkey || !verifyValue(value)) continue
        out.push({ pubkey, coreKey: value.coreKey })
        seen.add(pubkey)
      }
    } catch (e) { console.warn('[bare] collectLastknownCores view failed', e?.message) }
  }
  return out
}

// Re-push the circle's last-known core keys to every connected, confirmed
// seeder, but only when the set has changed since the last push (cheap
// signature compare) so the 5s sweep isn't chatty. The first push to a freshly
// confirmed seeder is driven by pushLastknownCoresToSeeder on its announce;
// this covers peer cores discovered afterward (slice 2b).
async function repushLastknownCoresToSeeders (circleId) {
  if (_memberAdmissionChannels.size === 0) return
  const cores = await collectLastknownCores(circleId)
  if (cores.length === 0) return
  const sig = cores.map((c) => c.pubkey + ':' + c.coreKey).sort().join('|')
  if (_lastSentLastknownSig.get(circleId) === sig) return
  let sent = 0
  for (const perConn of _memberAdmissionChannels.values()) {
    const entry = perConn.get(circleId)
    if (entry?.isSeeder && entry.sendLastknownCores && entry.sendLastknownCores(cores)) sent++
  }
  if (sent > 0) _lastSentLastknownSig.set(circleId, sig)
}

// Push the circle's current last-known core keys to one just-confirmed seeder
// (its admission entry). Used when a seeder's announce arrives so it gets the
// keys immediately, independent of the per-circle delta dedup (slice 2b).
async function pushLastknownCoresToSeeder (circleId, conn) {
  const entry = conn ? _memberAdmissionChannels.get(conn)?.get(circleId) : null
  if (!entry?.sendLastknownCores) return
  const cores = await collectLastknownCores(circleId)
  if (cores.length > 0) entry.sendLastknownCores(cores)
}

// Collect the circle's writer core keys from the live Autobase. Writers are
// identified by core key in this system (addWriter ops carry the writer key,
// not an identity pubkey), and the seeder keys its writerCores map by coreKey
// and uses pubkey only for its log line — so we pass the coreKey for both
// fields of the { pubkey, coreKey } wire shape. The founder's bootstrap core is
// included and de-duped seeder-side (it's already open there). Proposal
// 2026-05-19 slice 3d.
function collectCircleWriters (circleId) {
  const base = _circleBases.get(circleId)
  if (!base) return []
  const out = []
  const seen = new Set()
  const writers = base.activeWriters ? [...base.activeWriters] : []
  for (const w of writers) {
    if (!w?.core?.key) continue
    const coreKey = b4a.toString(w.core.key, 'hex')
    if (seen.has(coreKey)) continue
    seen.add(coreKey)
    out.push({ pubkey: coreKey, coreKey })
  }
  return out
}

// Re-push the circle's writer core keys to every connected, confirmed seeder,
// but only when the set has changed since the last push (cheap signature
// compare) so the 5s sweep isn't chatty. This is also the trigger that picks up
// a newly-added writer: the next sweep after the addWriter op linearizes sees a
// larger activeWriters set and pushes it. Proposal 2026-05-19 slice 3d.
function repushWriterCoresToSeeders (circleId) {
  if (_memberAdmissionChannels.size === 0) return
  const cores = collectCircleWriters(circleId)
  if (cores.length === 0) return
  const sig = cores.map((c) => c.coreKey).sort().join('|')
  if (_lastSentWriterSig.get(circleId) === sig) return
  let sent = 0
  for (const perConn of _memberAdmissionChannels.values()) {
    const entry = perConn.get(circleId)
    if (entry?.isSeeder && entry.sendWriterCores && entry.sendWriterCores(cores)) sent++
  }
  if (sent > 0) _lastSentWriterSig.set(circleId, sig)
}

// Push the circle's current writer core keys to one just-confirmed seeder, so it
// starts mirroring every member's core immediately on announce, independent of
// the per-circle delta dedup. Proposal 2026-05-19 slice 3d.
function pushWriterCoresToSeeder (circleId, conn) {
  const entry = conn ? _memberAdmissionChannels.get(conn)?.get(circleId) : null
  if (!entry?.sendWriterCores) return
  const cores = collectCircleWriters(circleId)
  if (cores.length > 0) entry.sendWriterCores(cores)
}

// Currently-visible member identity pubkeys for a circle (left/removed filtered
// out, same rule as snapshotCircle). Lean — only the pubkeys, for the cutover
// check. Proposal 2026-06-04 slice 3.
async function circleVisibleMemberPubkeys (view) {
  const leftAt = new Map()
  for await (const { key, value } of view.createReadStream({ gt: 'left:', lt: 'left:~' })) {
    if (typeof value?.leftAt === 'number') leftAt.set(key.slice('left:'.length), value.leftAt)
  }
  const removedAt = new Map()
  for await (const { key, value } of view.createReadStream({ gt: 'removed:', lt: 'removed:~' })) {
    if (typeof value?.ts === 'number') removedAt.set(key.slice('removed:'.length), value.ts)
  }
  const out = []
  for await (const { value } of view.createReadStream({ gt: 'member:', lt: 'member:~' })) {
    const pubkey = value?.pubkey
    if (typeof pubkey !== 'string') continue
    if (memberHiddenByRemoved(removedAt.get(pubkey), value?.joinedAt)) continue
    if (memberHiddenByLeft(leftAt.get(pubkey), value?.joinedAt)) continue
    out.push(pubkey)
  }
  return out
}

// Recompute the phase-2 lastSeen-write cutover for a circle (off the hot path,
// from the 5s sweep). Stops the Autobase write once every visible member has
// announced a last-known core; reverts the moment an unsupported member appears
// or the keep-writing kill-switch is on. Proposal 2026-06-04 slice 3.
async function updateLastSeenCutover (circleId, base) {
  const wasActive = _lastSeenCutoverCircles.has(circleId)
  let active = false
  let members = []
  let announced = new Set()
  if (!_forceAutobaseLastSeen) {
    try {
      members = await circleVisibleMemberPubkeys(base.view)
      for await (const { key } of base.view.createReadStream({ gt: 'lastknownCore:', lt: 'lastknownCore:~' })) {
        announced.add(key.slice('lastknownCore:'.length))
      }
      active = allMembersAnnouncedCore(members, announced)
    } catch (e) {
      console.warn('[bare] updateLastSeenCutover failed', circleId, e?.message)
      active = false
    }
  }
  // One-shot diagnostic when the gate is held open: show how many members still
  // lack a core announce, so an operator can see why a circle hasn't stopped
  // growing yet (the unsupported peers). Re-armed when cutover later engages.
  if (!active && !_forceAutobaseLastSeen && members.length > 0 && !_cutoverBlockedMarked.has(circleId)) {
    const missing = members.filter((pk) => !announced.has(pk)).length
    if (missing > 0) {
      _cutoverBlockedMarked.add(circleId)
      mark('lastseen:cutover-blocked', { circleId: circleId.slice(0, 8), members: members.length, announced: announced.size, missing })
      reshipTrace()
    }
  }
  if (active === wasActive) return
  if (active) {
    _lastSeenCutoverCircles.add(circleId)
    _cutoverBlockedMarked.delete(circleId) // re-arm the blocked diagnostic
    mark('lastseen:cutover', { circleId: circleId.slice(0, 8), members: members.length })
  } else {
    _lastSeenCutoverCircles.delete(circleId)
    mark('lastseen:cutover-reverted', { circleId: circleId.slice(0, 8), reason: _forceAutobaseLastSeen ? 'kill-switch' : 'member-unsupported' })
  }
  reshipTrace()
}

// Flip the keep-writing kill-switch and persist it. When enabled, the Autobase
// lastSeen write resumes for every circle (cutover reverts on the next sweep).
async function setForceAutobaseLastSeen (enabled) {
  _forceAutobaseLastSeen = !!enabled
  await _localDb.put('config:forceAutobaseLastSeen', { enabled: _forceAutobaseLastSeen, setAt: Date.now() }).catch(() => {})
  if (_forceAutobaseLastSeen) {
    for (const circleId of Array.from(_lastSeenCutoverCircles)) {
      _lastSeenCutoverCircles.delete(circleId)
      mark('lastseen:cutover-reverted', { circleId: circleId.slice(0, 8), reason: 'kill-switch' })
    }
  }
  mark('lastseen:force-autobase', { enabled: _forceAutobaseLastSeen })
  return _forceAutobaseLastSeen
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
    const ch = setupPairChannel({
      conn,
      circleId: circleIdStr,
      base,
      onWriterAdded: (writerKey) => {
        send({ event: 'circle:writer:added', data: { circleId: circleIdStr, writerKey } })
      },
      mark,
    })
    trackCircleChannel(circleIdStr, ch)
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
    let viewRow = null
    const base = _circleBases.get(circleId)
    if (base) { try { viewRow = await base.view.get('circle') } catch (e) { /* view not ready */ } }
    // Defense-in-depth (bugfix 2026-06-19): never emit a seed invite whose
    // circleId disagrees with the founder-written circle.id in our own
    // (decryptable) view. Such a record is a franken (one circle's id glued onto
    // another's bootstrap) and would enroll a phantom duplicate on the blind
    // seeder, which cannot self-validate the binding. Skip it. Only fires on a
    // positive mismatch — an un-replicated view (id undefined) is not blocked.
    if (inviteCircleIdMismatch(circleId, viewRow?.value)) {
      console.warn('[bare] skip seed invite: circleId mismatch', circleId.slice(0, 8))
      continue
    }
    // Prefer the live view name (what the app shows + what tracks renames) over
    // the circles:joined cache, which freezes at join-time on non-renamer
    // devices and otherwise leaks a stale / duplicated name into the seed
    // invite. Falls back to the cache when the view hasn't replicated yet.
    const inviteName = resolveCircleName(name, viewRow)
    const invite = buildSeedInvite({ circleId, name: inviteName, circleKey, bootstrap, inviterPublicKey })
    entries.push({ circleId, name: inviteName, invite })
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
  // updatedAt is the row's LWW clock; returned so circle:seeder:approve can
  // stamp the re-admit notice it pushes to the seeder (2026-06-11-seeder-readmit).
  return { ok: true, circleId, pubkey, reAdmit: existing !== null, updatedAt: unsigned.updatedAt }
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
async function handleSeederAnnounce (circleId, base, { pubkey, label, version }, conn) {
  // Record the seeder's reported build version regardless of admission state
  // (proposal 2026-06-05-seeder-update slice 1). Advisory + in-memory; surfaced
  // by circle:seeders:list for the app's "update available" flag.
  if (typeof pubkey === 'string') {
    if (typeof version === 'string' && version.length > 0) _seederVersions.set(pubkey, version)
    else if (!_seederVersions.has(pubkey)) _seederVersions.set(pubkey, null)
  }
  const existingNode = await base.view.get('seeder:' + pubkey).catch(() => null)
  const existing = existingNode?.value ?? null
  // Already admitted (live, i.e. neither revoked nor left): nothing to admit,
  // but this announce confirms the peer is a live seeder, so hand it our
  // last-known core keys.
  if (existing && existing.revoked !== true && existing.left !== true) {
    mark('admission:dedup', { circleId, seeder: pubkey.slice(0, 8) })
    markConnSeederAndPush(circleId, conn)
    return
  }
  // Already revoked: keep the revocation, re-send the notice, do not admit.
  // Revoke is a member trust decision (durable); re-admission is an explicit
  // Settings action, never a side effect of the seeder reconnecting.
  if (existing && existing.revoked === true) {
    mark('admission:announce-from-revoked', { circleId, seeder: pubkey.slice(0, 8) })
    const entry = conn ? _memberAdmissionChannels.get(conn)?.get(circleId) : null
    if (entry) {
      entry.sendRevoked(typeof existing.revokedAt === 'number' ? existing.revokedAt : null)
    }
    return
  }
  // No row yet — first admission — OR a `left` tombstone whose seeder is now
  // announcing again. Unlike `revoked`, `left` is not a member trust decision
  // (the seeder voluntarily left, or a member tidied a dead entry), so an
  // announce means it's back: auto-(re)admit resurrects it. buildSeederAdmission
  // preserves the original addedBy/addedAt and drops the `left` field, and LWW
  // (fresh updatedAt > leftAt) lets the admit out-date the tombstone.
  // Frictionless auto-admit (proposal 2026-06-17-seeder-leave-propagation).
  if (existing && existing.left === true) {
    mark('admission:announce-from-left', { circleId, seeder: pubkey.slice(0, 8) })
  }
  if (!base.writable) {
    mark('admission:not-writable', { circleId, seeder: pubkey.slice(0, 8) })
    return
  }
  try {
    await approveSeederRow(circleId, pubkey, label ?? undefined)
    mark('admission:auto-admitted', { circleId, seeder: pubkey.slice(0, 8) })
    send({ event: 'seeder:admitted', data: { circleId, pubkey } })
    markConnSeederAndPush(circleId, conn)
  } catch (e) {
    mark('admission:auto-admit-failed', { circleId, err: e?.message ?? String(e) })
  }
}

// Mark a connection's admission entry as a confirmed seeder and immediately
// push the circle's last-known core keys to it (slice 2b).
function markConnSeederAndPush (circleId, conn) {
  const entry = conn ? _memberAdmissionChannels.get(conn)?.get(circleId) : null
  if (!entry) return
  entry.isSeeder = true
  pushLastknownCoresToSeeder(circleId, conn).catch(() => {})
  // Also hand the seeder every writer core key so it mirrors all members, not
  // just the founder's bootstrap (slice 3d).
  try { pushWriterCoresToSeeder(circleId, conn) } catch {}
}

// Member-side handler for a seeder's in-band "left" notice (proposal
// 2026-06-17-seeder-leave-propagation). The seeder operator left this circle,
// so write a `left` tombstone for its row — that hides it from the Seeders
// list entirely (vs `revoked`, which lingers for re-admit). The seeder pubkey
// is the connection's remote identity key; circleId is the trusted channel id.
async function handleSeederLeaveNotice (circleId, base, conn) {
  const pubkey = conn ? _connPubkey.get(conn) : null
  if (typeof pubkey !== 'string' || pubkey.length !== 64) return
  try {
    if (await writeSeederGone(circleId, base, pubkey)) {
      mark('seeder:left-noticed', { circleId, seeder: pubkey.slice(0, 8) })
      send({ event: 'seeder:left', data: { circleId, pubkey } })
    }
  } catch (e) {
    mark('seeder:left-notice-failed', { circleId, err: e?.message ?? String(e) })
  }
}

// Append a member-signed `left` tombstone for a seeder row. Shared by the
// in-band leave notice and the manual circle:seeder:remove IPC. Returns false
// (no-op) when there is no row, it is already left, or we can't write. A row
// that was `revoked` can still be turned into `left` (a revoked seeder the
// user also wants gone from the list) — buildSeederGone drops the revoked
// fields and the fresh updatedAt wins by LWW.
async function writeSeederGone (circleId, base, pubkey) {
  if (!base || !base.writable) return false
  const existingNode = await base.view.get('seeder:' + pubkey).catch(() => null)
  const existing = existingNode?.value ?? null
  if (!existing || existing.left === true) return false
  const byPubkeyHex = b4a.toString(_identity.publicKey, 'hex')
  const unsigned = buildSeederGone({ existing, byPubkeyHex, now: Date.now() })
  if (!unsigned) return false
  const signed = signValue(unsigned, _identity.secretKey)
  await base.append({ type: 'put', key: 'seeder:' + pubkey, value: signed })
  return true
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
// --- Seeder QR pairing (proposal 2026-06-22-seeder-qr-pairing) ---------------
// Seeder shows a QR = a one-time rendezvous topic + its pubkey; the phone scans
// it, joins the rendezvous, and pushes its seed bundle over a one-time
// pearcircle/seeder-pair/1 channel. No copy-paste; works headless/remote.
const SEEDER_PAIR_ENABLED = true                 // kill-switch (proposal §Rollback)
const SEEDER_PAIR_TTL_MS = 5 * 60 * 1000         // seed-side rendezvous lifetime (decision 2)
const SEEDER_PAIR_SCAN_TIMEOUT_MS = 60 * 1000    // phone-side give-up window
let _pairSession = null   // seed mode: { rv, topic, topicHex, ttlTimer }
let _pairScan = null      // member mode: { rv, topic, topicHex, seederKeyHex, timer, resolve }

// Seed side: open the receive channel for an active pairing session on a conn.
function setupSeederPairChannelFor (conn) {
  if (!_pairSession) return
  setupSeederPairChannel({
    conn,
    role: 'seed',
    rv: _pairSession.rv,
    onBundle: async ({ invites }) => {
      const names = []
      let enrolled = 0
      for (const invite of invites) {
        try {
          const r = await enrollSeedInvite({ invite, localDb: _localDb, mountCircle: mountSeederCircle })
          if (r?.circleId) { enrolled++; if (!r.alreadyEnrolled) names.push(r.name || r.circleId.slice(0, 8)) }
        } catch (e) { mark('seeder:pair:enroll-failed', { err: e?.message ?? String(e) }) }
      }
      mark('seeder:pair:enrolled', { enrolled })
      try { send({ event: 'seeder:pair:result', data: { enrolled, names } }) } catch {}
      if (enrolled > 0) closeSeederPairSession('paired') // one-shot: pairing done
      return { enrolled, names }
    },
    mark,
  })
}

// Seed side: mint a fresh rendezvous + join its topic; return the QR link.
// Idempotent - re-opening returns the same live session's link.
async function openSeederPairSession () {
  if (!SEEDER_PAIR_ENABLED) return { error: 'pairing disabled' }
  const seederHex = b4a.toString(_identity.publicKey, 'hex')
  if (_pairSession) {
    return { link: buildSeederPairLink({ rv: _pairSession.rv, seeder: seederHex }), ttlMs: SEEDER_PAIR_TTL_MS, reused: true }
  }
  const rv = generateRendezvousKey()
  const topic = seederPairTopic(rv)
  const topicHex = b4a.toString(topic, 'hex')
  try { _swarm.join(topic, { server: true, client: true }) } catch (e) {
    return { error: 'join failed: ' + (e?.message ?? String(e)) }
  }
  const ttlTimer = setTimeout(() => closeSeederPairSession('ttl'), SEEDER_PAIR_TTL_MS)
  if (typeof ttlTimer.unref === 'function') ttlTimer.unref()
  _pairSession = { rv, topic, topicHex, ttlTimer }
  for (const conn of _seederActiveConns) setupSeederPairChannelFor(conn)
  mark('seeder:pair:open', { ttlMs: SEEDER_PAIR_TTL_MS })
  return { link: buildSeederPairLink({ rv, seeder: seederHex }), ttlMs: SEEDER_PAIR_TTL_MS }
}

function closeSeederPairSession (reason) {
  if (!_pairSession) return
  const s = _pairSession; _pairSession = null
  try { clearTimeout(s.ttlTimer) } catch {}
  try { _swarm.leave(s.topic) } catch {}
  mark('seeder:pair:closed', { reason })
}

// Member side: finish a scan (success or timeout), leave the rendezvous, resolve.
function finishPairScan (result) {
  if (!_pairScan) return
  const s = _pairScan; _pairScan = null
  try { clearTimeout(s.timer) } catch {}
  try { _swarm.leave(s.topic) } catch {}
  mark('seeder:pair:scan-finished', { ok: !!result.ok })
  try { s.resolve(result) } catch {}
}

// Member side: on a rendezvous connection, push the bundle ONLY if the
// authenticated remote pubkey equals the scanned seeder pubkey (the security
// anchor - circle secrets never go to an impostor who merely knows the topic).
function maybeSetupPairScanChannel (conn, remotePubkeyHex) {
  const session = _pairScan
  if (!session) return
  if (remotePubkeyHex !== session.seederKeyHex) {
    mark('seeder:pair:wrong-peer', { got: (remotePubkeyHex || '?').slice(0, 8), want: session.seederKeyHex.slice(0, 8) })
    return
  }
  setupSeederPairChannel({
    conn,
    role: 'member',
    rv: session.rv,
    getBundle: async () => {
      const { entries } = await collectSeedInvites()
      return entries.map((e) => e.invite)
    },
    onAck: async ({ enrolled, names }) => {
      // Follow the seeder so all FUTURE circles auto-push over the normal
      // circle-topic sync channels (no re-pairing). Same row shape as
      // circle:seeder:follow:set.
      try { await _localDb.put('seederfollow:' + session.seederKeyHex, { pubkey: session.seederKeyHex, since: Date.now() }) } catch {}
      mark('seeder:pair:acked', { enrolled })
      finishPairScan({ ok: true, enrolled, names, seeder: session.seederKeyHex })
    },
    mark,
  })
}

function onSeederSwarmConnection (conn, info) {
  try { _store.replicate(conn) } catch (e) {
    console.warn('[bare] seeder replicate failed', e?.message)
  }
  // Track for post-mount admission-channel opening (auto-follow enrolls
  // circles after a connection already exists).
  _seederActiveConns.add(conn)
  conn.once('close', () => {
    _seederActiveConns.delete(conn)
    _seederAdmissionChannels.delete(conn)
  })
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
    const handle = setupSeederAdmissionChannel({
      conn,
      role: 'seed',
      circleId,
      bootstrap: enrollment?.bootstrap,
      seederPubkey: seederPubkeyHex,
      label: enrollment?.label,
      version: _seederVersion,
      onRevoked: handleSeederRevocationNotice,
      onAdmitted: handleSeederAdmittedNotice,
      onLastknownCores: handleSeederLastknownCores,
      onWriterCores: handleSeederWriterCores,
      mark,
    })
    trackSeederAdmissionChannel(conn, circleId, handle)
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

  // One-time pairing receive channel, only while a pairing session is open
  // (the seeder is on the rendezvous topic only then). Proposal 2026-06-22.
  if (_pairSession) setupSeederPairChannelFor(conn)
}

// --- Stale-connection shedding (proposal 2026-06-01) ------------------------
// Addresses the "location lag while moving" limitation (TODO Bugs): a moving
// device's Hyperswarm socket dies on a network change without firing
// `network:changed`, and the dead socket lingers in the swarm's connection set
// until UDX's slow internal timeout, blocking a fresh connection and therefore
// replication of the fresh position. An earlier discovery.refresh() attempt
// failed because a new connection can't form while the dead one still occupies
// the set.
//
// HyperDHT already sends a 5s keepalive (empty frame) on every connection, but
// no secret-stream-level `timeout` is set, so dead-detection falls through to
// UDX. Two levers, both tunable:
//   1) PRIMARY: arm a secret-stream setTimeout on every connection. Inbound
//      data (incl. the peer's 5s keepalives) refreshes it, so a LIVE link
//      never trips; a DEAD link trips after STALE_CONN_TIMEOUT_MS and the
//      socket is destroyed, letting Hyperswarm redial a fresh one.
//   2) SECONDARY: a one-shot sendKeepAlive() nudge on demand (foreground +
//      movement) to solicit traffic and help the peer converge.
// On-device validated 2026-05-31 (drop at the 15s timeout, prompt redial when
// the peer was reachable, no lag observed while moving). STALE_CONN_PROBE_ENABLED
// is a kill-switch: flip to false to fall back to stock UDX-timeout behavior.
const STALE_CONN_PROBE_ENABLED = true
const STALE_CONN_TIMEOUT_MS = 15000   // > 2x the 5s DHT keepalive, so live links are safe
const CONN_PROBE_DEBOUNCE_MS = 3000   // min spacing between on-demand probes
let _lastConnProbeAt = 0

function armStaleConnTimeout (conn) {
  if (!STALE_CONN_PROBE_ENABLED || !STALE_CONN_TIMEOUT_MS) return
  if (typeof conn.setTimeout !== 'function') return
  try { conn.setTimeout(STALE_CONN_TIMEOUT_MS) } catch {}
}

// Solicit traffic on every active connection now (debounced). Does NOT reset
// the per-connection timeout (that would push detection out); it only writes
// an empty keepalive frame so the link exchanges data promptly.
function probeConnections (reason) {
  if (!STALE_CONN_PROBE_ENABLED) return
  const now = Date.now()
  if (now - _lastConnProbeAt < CONN_PROBE_DEBOUNCE_MS) return
  _lastConnProbeAt = now
  let probed = 0
  for (const conn of _activeConns) {
    if (typeof conn.sendKeepAlive !== 'function') continue
    try { conn.sendKeepAlive(); probed++ } catch {}
  }
  if (probed > 0) mark('conn:probe', { reason, probed })
}
// ----------------------------------------------------------------------------

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
  if (replicate) { _store.replicate(conn); _replicatingConns.add(conn) }
  _activeConns.add(conn)
  _connPubkey.set(conn, remotePublicKey)
  // Drop this socket fast if it goes silent (proposal 2026-06-01).
  armStaleConnTimeout(conn)
  registerPairNotify(conn)
  registerLiveNotify(conn)

  // info.topics is asymmetric on real-DHT connections: the lookup side may
  // have it populated, the announce side often does not. Setting up the
  // pair channel for every known circle is safe — protomux only matches
  // when both sides open the same protocol+id, and unmatched channels
  // don't affect corestore replication.
  for (const [circleId, base] of _circleBases) {
    const ch = setupPairChannel({
      conn,
      circleId,
      base,
      onWriterAdded: (writerKey) => {
        send({ event: 'circle:writer:added', data: { circleId, writerKey } })
      },
      mark,
    })
    trackCircleChannel(circleId, ch)
    // Seeder admission receiver. Proposal 2026-05-19 slice 3d. Unmatched
    // channels (peer isn't a seeder) close harmlessly. The announce
    // handler dedupes / auto-approves / emits seeder:announced.
    //
    // revokedNotice: if this circle has revoked the remote peer as a
    // seeder, the channel pushes a content-blind revocation notice on
    // open so the seeder's dashboard stops listing the circle (proposal
    // 2026-05-21). Non-seeder peers have no seeder:{pubkey} row, so
    // revocationNoticeFor returns null and nothing is sent.
    setupMemberAdmissionChannel(conn, circleId, base).catch(() => {})
    // Ephemeral live-position channel (proposal 2026-06-04 phase 1).
    setupLiveChannelFor(conn, circleId)
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

  // Seeder-pairing: if a scan is in progress and this connection's authenticated
  // remote is the scanned seeder, push the bundle. Proposal 2026-06-22.
  if (_pairScan) maybeSetupPairScanChannel(conn, remotePublicKey)

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
    _replicatingConns.delete(conn)
    _memberAdmissionChannels.delete(conn)
    liveChannelDropConn(conn)
    _connPubkey.delete(conn)
    for (const circleId of matchedCircleIds) {
      const peers = _circlePeers.get(circleId)
      if (peers) peers.delete(remotePublicKey)
      mark('peer:disconnected', { circleId, remote: remotePublicKey.slice(0, 8) })
      send({ event: 'peer:disconnected', data: { circleId, remotePublicKey } })
    }
  })
  conn.on('error', (err) => {
    const msg = err?.message ?? String(err)
    // Distinguish our timeout-driven drop (proposal 2026-06-01) from other
    // errors so the on-device trace can confirm stale sockets are being shed.
    if (msg.includes('timed out')) {
      mark('conn:stale-dropped', { remote: remotePublicKey.slice(0, 8), timeoutMs: STALE_CONN_TIMEOUT_MS })
    }
    mark('peer:error', { remote: remotePublicKey.slice(0, 8), err: msg })
  })
}

// --- Store maintenance: bound the RocksDB write-ahead log ------------------
// The corestore backend (rocksdb-native) only flushes its in-memory memtable
// to an on-disk SST when the write buffer fills (the 64 MB default) or on a
// clean close. A location-sharing app appends lastSeen on every fix, so on a
// device that's actively moving the WAL grows fast -- meanwhile the app is far
// more often OS-killed or swiped away than closed cleanly, so the 64 MB
// auto-flush is usually the FIRST flush a busy device ever attempts. Replaying
// a 60 MB+ WAL on the next cold start (plus rebuilding the Autobase view on top
// of it) blows memory and trips Android's 5 s ANR watchdog before the
// post-recovery flush can finish, wedging the app in a crash loop where Circles
// never load (root cause, device 4fc221b3 -- a 62 MB WAL of 202k entries, ~80%
// lastSeen overwrites/deletes).
//
// Fix: flush the memtable to SST on a fixed cadence and whenever the app
// backgrounds. Each flush truncates the WAL, so cold-start replay stays cheap
// and no single flush is ever large enough to lose the ANR race. Flushing an
// empty memtable is a RocksDB no-op (creates no stray SST), so the idle cost is
// ~zero. This is the canonical lever -- Corestore.suspend() flushes via the
// same `storage.db.flush()` call. Belt to the lastSeen-ephemeral fix's braces:
// this bounds the damage from any high-frequency write path, present or future.
// --- Circle config export / recreate (proposal 2026-06-17) ------------------
// Read a circle's curated config (name + Places + per-circle toggles) for
// export or recreate. Reads the on-disk view directly (no base.update(), same
// cold-boot rationale as snapshotCircle / place:list).
async function readCircleConfigForExport (circleId) {
  const base = _circleBases.get(circleId)
  if (!base) throw new Error('unknown circle: ' + circleId)
  const local = await _localDb.get('circles:joined:' + circleId)
  const name = local?.value?.name
  if (typeof name !== 'string') throw new Error('circle has no local name')
  const places = []
  for await (const { value } of base.view.createReadStream({ gt: 'place:', lt: 'place:~' })) {
    if (value && !isDeleted(value)) {
      places.push({ name: value.name, lat: value.lat, lon: value.lon, radiusMeters: value.radiusMeters })
    }
  }
  const tripRow = await _localDb.get('trips:sharing:' + circleId)
  return {
    name,
    places,
    settings: {
      sharingDefault: getCircleSharing(circleId).enabled === true,
      tripSharing: tripRow?.value?.enabled === true,
    },
  }
}

// Create a brand-new circle from a validated config, reusing the live
// circle:create + place:create + toggle handlers so the result is
// indistinguishable from a hand-made circle. Returns the create result.
async function createCircleFromConfig ({ name, places, settings }) {
  const created = await handlers['circle:create']({ name })
  for (const p of places) {
    await handlers['place:create']({ circleId: created.circleId, name: p.name, lat: p.lat, lon: p.lon, radiusMeters: p.radiusMeters })
  }
  await handlers['sharing:set']({ circleId: created.circleId, enabled: settings.sharingDefault === true })
  await handlers['trips:sharing:set']({ circleId: created.circleId, enabled: settings.tripSharing === true })
  return created
}

const STORE_FLUSH_INTERVAL_MS = 5 * 60 * 1000
let _storeFlushTimer = null

const flushStore = createStoreFlusher({
  getStore: () => _store,
  mark,
  warn: (...args) => console.warn(...args),
})

function startStoreFlushTimer () {
  if (_storeFlushTimer) return
  _storeFlushTimer = setInterval(() => { flushStore('interval') }, STORE_FLUSH_INTERVAL_MS)
}

// Durability ordering (proposal 2026-06-27 item 4 / decision 5b). The interval
// flush above leaves up to 5 min (or until the 64 MB write buffer fills) where
// a just-appended writer block lives only in the WAL — if a crash loses the WAL
// (the bad_alloc boot wedge), that block is gone locally but peers may already
// hold it, leaving us behind the network on our own core: the truncation that
// the rewind guard then has to clean up. Shrink that window: schedule a
// coalesced flush ~1.5s after a writer append. Coalesced (not debounced/reset)
// so a burst of appends still flushes within ~1.5s of the FIRST one, bounding
// the durability gap regardless of append rate. Reuses the small-frequent
// flusher, so it never grows into the giant first-flush that wedged boot.
const DURABILITY_FLUSH_MS = 1500
let _durabilityFlushTimer = null
function scheduleDurabilityFlush () {
  if (_durabilityFlushTimer) return
  _durabilityFlushTimer = setTimeout(() => {
    _durabilityFlushTimer = null
    flushStore('writer-append').catch(() => {})
  }, DURABILITY_FLUSH_MS)
  if (_durabilityFlushTimer && _durabilityFlushTimer.unref) _durabilityFlushTimer.unref()
}

// Full-keyspace RocksDB compaction to reclaim dead SST left by overwritten
// lastSeen and the trip / transition / seeder retention deletes (storage
// audit 2026-06-22). Far heavier than a flush, so: one compaction per
// session delayed off the cold-start path, then a slow daily cadence. Never
// per-write. Shared by member + seed mode (seed mode accrues the most dead
// SST via retention clears).
const STORE_COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000
const STORE_COMPACT_BOOT_DELAY_MS = 90 * 1000
let _storeCompactTimer = null

const compactStore = createStoreCompactor({
  getStore: () => _store,
  mark,
  warn: (...args) => console.warn(...args),
})

function startStoreCompactTimer () {
  if (_storeCompactTimer) return
  // Delayed boot compaction runs after the fire-and-forget retention sweeps
  // at init:done, so it reclaims their fresh deletes without competing with
  // worklet startup.
  setTimeout(() => { compactStore('boot') }, STORE_COMPACT_BOOT_DELAY_MS)
  _storeCompactTimer = setInterval(() => { compactStore('interval') }, STORE_COMPACT_INTERVAL_MS)
}

async function init ({ dataDir, mode, version } = {}, attempt = 0) {
  if (typeof version === 'string' && version.length > 0) _seederVersion = version.slice(0, 64)
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

  // Install fault handlers before any circle/seeder core opens: the global
  // conflict seatbelt + the per-core 'conflict' watcher (proposal
  // 2026-06-27-fork-conflict-recovery). Covers both member and seed modes.
  installFaultHandlers()

  // Start bounding the WAL as soon as the store is open, before the heavy
  // Autobase mount. Runs in both member and seed modes (both share _store).
  startStoreFlushTimer()
  // Schedule the periodic dead-SST reclaim (delayed boot pass + daily).
  startStoreCompactTimer()

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
      version: _seederVersion,
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
      // On-demand retention sweep (launcher "Run sweep now"). Runs both the
      // bootstrap-core and per-member writer-core sweeps so a just-changed
      // retention policy applies immediately, without waiting for the 24h
      // interval or a restart.
      runRetentionSweeps: async () => ({
        bootstrap: await runOneSeederRetentionSweep(),
        writer: await runOneSeederWriterRetentionSweep(),
      }),
      // Seeder QR pairing (proposal 2026-06-22): open mints a rendezvous +
      // returns the QR link; close tears the session down.
      openPairSession: openSeederPairSession,
      closePairSession: closeSeederPairSession,
    })

    // Mirror persisted seeder:revoked:* rows into the in-memory set so the
    // per-block download hook can clear a revocation when replication
    // resumes (proposal 2026-05-21 question 4). Loaded before the remount
    // loop because mountSeederCircle starts core.download() right away.
    const revokedAtBoot = await loadRevokedCircles(_localDb)
    for (const [cid, row] of revokedAtBoot) {
      _seederRevokedCircles.add(cid)
      // Seed the LWW clock from the persisted revokedAt so a stale notice that
      // arrives right after boot is ordered against the revoke we last applied,
      // not treated as fresh (proposal 2026-06-11-seeder-readmit).
      if (row && typeof row.revokedAt === 'number' && Number.isFinite(row.revokedAt)) {
        _seederFlagTs.set(cid, row.revokedAt)
      }
    }
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

    // Re-open each persisted per-member last-known core so a restart keeps
    // serving offline last-known (proposal 2026-06-04-lastseen-ephemeral 2b).
    // Only for circles that actually remounted; orphaned rows are skipped.
    let lastknownReopened = 0
    for await (const { value } of _localDb.createReadStream({
      gt: 'seeder:lastknownCore:', lt: 'seeder:lastknownCore:~',
    })) {
      if (!value || !value.circleId || !value.pubkey || !value.coreKey) continue
      const entry = _seederCircles.get(value.circleId)
      if (!entry) continue
      try {
        await openSeederLastknownCore(entry, value.circleId, value.pubkey, value.coreKey)
        lastknownReopened++
      } catch (e) {
        console.warn('[bare] seeder lastknown reopen failed', value.circleId, e?.message)
      }
    }
    if (lastknownReopened > 0) mark('seeder:lastknown-reopened', { count: lastknownReopened })

    // Re-open each persisted per-member writer core so a restart keeps mirroring
    // every member's contributions, not just the bootstrap (proposal 2026-05-19
    // slice 3d). Only for circles that actually remounted; orphans are skipped.
    let writerReopened = 0
    for await (const { value } of _localDb.createReadStream({
      gt: 'seeder:writerCore:', lt: 'seeder:writerCore:~',
    })) {
      if (!value || !value.circleId || !value.coreKey) continue
      const entry = _seederCircles.get(value.circleId)
      if (!entry) continue
      if (entry.core && b4a.toString(entry.core.key, 'hex') === value.coreKey) continue
      try {
        await openSeederWriterCore(entry, value.circleId, value.pubkey, value.coreKey)
        writerReopened++
      } catch (e) {
        console.warn('[bare] seeder writer-core reopen failed', value.circleId, e?.message)
      }
    }
    if (writerReopened > 0) mark('seeder:writer-reopened', { count: writerReopened })

    // Schedule the retention sweep. Once on boot to claw back disk from
    // anything that aged past the cutoff while the seeder was down, then
    // on a 24h cadence. Fire-and-forget per the existing trip-prune
    // pattern; pure helper handles all the I/O.
    const SEEDER_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
    runOneSeederRetentionSweep().then((r) => mark('seeder:retention:boot', r))
      .catch((e) => console.warn('[bare] seeder retention boot failed', e?.message))
    runOneSeederWriterRetentionSweep().then((r) => mark('seeder:writer-retention:boot', r))
      .catch((e) => console.warn('[bare] seeder writer retention boot failed', e?.message))
    setInterval(() => {
      runOneSeederRetentionSweep().then((r) => mark('seeder:retention:interval', r))
        .catch((e) => console.warn('[bare] seeder retention interval failed', e?.message))
      runOneSeederWriterRetentionSweep().then((r) => mark('seeder:writer-retention:interval', r))
        .catch((e) => console.warn('[bare] seeder writer retention interval failed', e?.message))
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

  // Persisted degraded flags (proposal 2026-06-03c). A circle whose
  // append/read timed out in a prior session persisted circleDegraded:{id}.
  // Re-arm the in-memory skip so needsRepair survives the reboot and appends
  // to the wedged base are skipped (keeping the worklet responsive). We do NOT
  // auto-rebuild on boot: the read/append bounding already prevents a freeze,
  // so the UI stays reachable and the user drives the (writer-key-changing)
  // strong repair from the Repair button. Recovery is therefore never an
  // automatic loop.
  for await (const { key } of _localDb.createReadStream({
    gt: 'circleDegraded:', lt: 'circleDegraded:~',
  })) {
    _degradedCircles.add(key.slice('circleDegraded:'.length))
  }
  if (_degradedCircles.size) mark('circle:degraded-persisted', { count: _degradedCircles.size })

  // A repair can take a long time, so it may span an app restart. Re-arm the
  // in-flight repairing state so the "Repairing…" indicator persists; the
  // circles:getAll poll clears it once the rebuilt base is writable again.
  for await (const { key } of _localDb.createReadStream({
    gt: 'circleRepairing:', lt: 'circleRepairing:~',
  })) {
    _repairingCircles.add(key.slice('circleRepairing:'.length))
  }
  if (_repairingCircles.size) mark('circle:repairing-persisted', { count: _repairingCircles.size })

  // Rejoin all known circle topics and mount their Autobases. Pre-existing
  // local records (from prior launches) need their swarm topics re-announced
  // and their Autobases reopened on every boot. Mount at the record's
  // rebuildGen so a previously-repaired circle opens its fresh namespace, not
  // the orphaned corrupt one.
  for await (const { value } of _localDb.createReadStream({
    gt: 'circles:joined:',
    lt: 'circles:joined:~',
  })) {
    if (!value || !value.circleId) continue
    if (value.bootstrap) {
      const rebuildGen = typeof value.rebuildGen === 'number' ? value.rebuildGen : 0
      try {
        await mountCircleAutobase(value.circleId, value.bootstrap, value.encryptionKey, { rebuildGen })
      } catch (e) {
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
  // Restore each place's persisted inside/outside classification (proposal
  // 2026-05-30) so the first location:update after a wake can recover a
  // crossing that happened while suspended/force-quit. A place with no
  // persisted row stays null and re-baselines silently on the first fix, so
  // a genuine first-ever cold start while inside a Place still fires no
  // spurious "arrived". This runs before _initialized flips, so it always
  // completes before any location:update is processed.
  _circlePlaces.clear()
  _lastAppendedKind.clear()
  for (const [circleId, base] of _circleBases) {
    try {
      for await (const { value } of base.view.createReadStream({ gt: 'place:', lt: 'place:~' })) {
        if (value && !isDeleted(value)) {
          trackPlace(circleId, value)
          await restorePersistedClassification(circleId, value.id)
        }
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
    for (const [circleId, base] of _circleBases) {
      // Local + idempotent: must run regardless of peer connectivity so a
      // fresh-joined or just-became-writable circle publishes our rows even
      // before a peer shows up. Each self-guards / skips fast when already done.
      autoAppendMemberRow(circleId).catch(() => {})
      autoAppendSelfLastSeen(circleId).catch(() => {})
      // Publish our last-known core key once (idempotent, proposal 2026-06-04 2a).
      announceLastKnownCore(circleId).catch(() => {})
      // Append any crossing that was detected while the writer wasn't ready
      // (native region wake before the autobase finished opening/rebuilding).
      // No-op unless something is queued for this circle (proposal 2026-07-01).
      flushPendingTransitions(circleId, base).catch(() => {})
      // Re-push the OS region set once per writable transition, so a
      // registration that went stale while the writer was read-only self-heals.
      if (base.writable && !_regionsPushedForWriter.has(circleId)) {
        _regionsPushedForWriter.add(circleId)
        schedulePushRegionsToShell()
      } else if (!base.writable) {
        _regionsPushedForWriter.delete(circleId)
      }
      // Recompute the phase-2 lastSeen-write cutover (slice 3). Cheap two-range
      // view read; its inputs only move via apply or our own announce above.
      updateLastSeenCutover(circleId, base).catch(() => {})
      // Peer-dependent convergence work: a view scan + opening peer cores +
      // background tip fetches, and pushes to connected seeders. All no-ops
      // without a live peer, so skip the whole block for circles with none
      // (storage/sync audit 2026-06-22). Re-runs as soon as a peer connects
      // (_circlePeers populated in onSwarmConnection); the read-path also kicks
      // refreshPeerLastKnown on every snapshot while the UI is open.
      if (_circlePeers.get(circleId)?.size > 0) {
        refreshPeerLastKnown(circleId).catch(() => {})
        // Push any newly-known last-known core keys to connected seeders (2b).
        repushLastknownCoresToSeeders(circleId).catch(() => {})
        // Push any newly-added writer core keys to connected seeders (slice 3d).
        try { repushWriterCoresToSeeders(circleId) } catch {}
      }
    }
  }, 5000)

  // Load per-circle sharing state (default visible per circle). Mutes
  // with expired timestamps fire immediately via armCircleExpiryTimer.
  // Also migrates and clears any legacy global `sharing` row.
  try { await loadPersistedSharing() } catch (e) {
    console.warn('[bare] loadPersistedSharing failed', e?.message)
  }

  // Restore the keep-writing kill-switch (proposal 2026-06-04 slice 3). Default
  // off (cutover allowed). The 5s sweep computes per-circle cutover from here.
  try {
    const row = await _localDb.get('config:forceAutobaseLastSeen').catch(() => null)
    _forceAutobaseLastSeen = !!row?.value?.enabled
    if (_forceAutobaseLastSeen) mark('lastseen:force-autobase', { enabled: true, source: 'boot' })
  } catch (e) { console.warn('[bare] load forceAutobaseLastSeen failed', e?.message) }

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

  // Durable peer-trip notification dedup + first-run baseline (proposal
  // 2026-06-11-peer-trip-notification-freshness). Must run before peer trips
  // can apply, so the relaxed freshness window doesn't re-notify history.
  await loadTripNotifyState()

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
  // Transition retention sweep, same boot + 6h-cadence shape as trips
  // (storage audit 2026-06-22). Equally cheap and never blocks boot.
  pruneOldTransitions().then((r) => mark('transition:prune:boot', r))
    .catch((e) => console.warn('[bare] pruneOldTransitions boot failed', e?.message))
  setInterval(() => {
    pruneOldTransitions().then((r) => mark('transition:prune:interval', r))
      .catch((e) => console.warn('[bare] pruneOldTransitions interval failed', e?.message))
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
