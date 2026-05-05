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
const { setupPairChannel } = require('./pair')
const { signValue, verifyValue } = require('./lib/sign')
const { haversineMeters, classify } = require('./lib/geofence')

// Reject values stamped more than 5 minutes in the future against the local
// clock (proposal §5). Catches replay/forgery and clock skew on the writer.
const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000

// Avatar base64 cap. Per DECISIONS 2026-05-03 the byte-budget is ~30KB,
// which is ~40KB after base64 inflation. We leave a small headroom.
const AVATAR_MAX_BASE64 = 42000

let _store = null
let _localDb = null
let _identity = null
let _swarm = null
let _initialized = false

const _circlePeers = new Map()    // circleId → Set<remotePublicKeyHex>
const _topicToCircle = new Map()  // topicHex → circleId
const _circleBases = new Map()    // circleId → Autobase instance
let _selfLastSeen = null          // latest signed location for own pubkey, used by the home map's empty state
let _sharingEnabled = true        // local privacy/battery toggle; when false location:update is dropped. Persisted in _localDb under `sharing`. Loaded on init.
// In-process geofence state: every place across every circle, with the
// most recent inside/outside classification. checkPlaceTransitions runs
// on every location:update, computes haversine distances, and fires
// transitions when classification flips. lastClassification === null is
// the "haven't seen a location yet" state and lets the next observation
// inside fire an initial-trigger enter (matching INITIAL_TRIGGER_ENTER).
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
}

function untrackPlace (circleId, placeId) {
  _circlePlaces.delete(circleId + '|' + placeId)
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

  'identity:get': async () => {
    if (!_identity) return { publicKey: null, ready: false }
    return { publicKey: b4a.toString(_identity.publicKey, 'hex'), ready: true }
  },

  'profile:get': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const row = await _localDb.get('profile')
    return row ? row.value : null
  },

  'profile:set': async ({ displayName, avatar } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof displayName !== 'string') throw new Error('displayName must be a string')
    const trimmed = displayName.trim().slice(0, 64)
    if (trimmed.length === 0) throw new Error('displayName must be non-empty')
    // avatar: base64 JPEG string, ~30KB encoded ceiling per DECISIONS
    // 2026-05-03 (~40KB after base64 inflation). null/undefined clears
    // the avatar; anything else is silently dropped at apply time on
    // peers but we reject up-front to surface the error to the user.
    let avatarValue
    if (avatar === null || avatar === undefined) {
      avatarValue = null
    } else if (typeof avatar !== 'string') {
      throw new Error('avatar must be a base64 string or null')
    } else if (avatar.length > AVATAR_MAX_BASE64) {
      throw new Error('avatar too large after compression; pick a smaller photo')
    } else {
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
      apply: applyCircleNodes,
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
      apply: applyCircleNodes,
      valueEncoding: 'json',
    })
    await base.ready()
    _circleBases.set(circleId, base)

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

    joinCircleTopic(circleId, circleKey)

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

  'sharing:get': async () => {
    if (!_initialized) throw new Error('worklet not initialized')
    const row = await _localDb.get('sharing')
    const enabled = row?.value?.enabled !== false  // default: true
    return { enabled }
  },

  'sharing:set': async ({ enabled } = {}) => {
    if (!_initialized) throw new Error('worklet not initialized')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean')
    await _localDb.put('sharing', { enabled, setAt: Date.now() })
    _sharingEnabled = enabled
    send({ event: 'sharing:changed', data: { enabled } })
    return { ok: true, enabled }
  },

  'location:update': async ({ lat, lon, accuracy, ts, speed } = {}) => {
    if (!_initialized) return { ok: false, reason: 'not_initialized' }
    // Sharing toggle gate: when off, drop location updates entirely.
    // The native foreground service is also stopped by the shell, so
    // typically nothing reaches this path while disabled — but the
    // service can take a moment to wind down, and the worklet may
    // still receive a queued event during that window.
    if (!_sharingEnabled) return { ok: false, reason: 'sharing_disabled' }
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return { ok: false, reason: 'invalid_coords' }
    }
    const ourKey = b4a.toString(_identity.publicKey, 'hex')
    const stamp = typeof ts === 'number' ? ts : Date.now()
    if (stamp > Date.now() + FUTURE_TS_TOLERANCE_MS) {
      return { ok: false, reason: 'future_ts' }
    }
    const value = signValue({
      pubkey: ourKey,
      lat,
      lon,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      ts: stamp,
      speed: typeof speed === 'number' ? speed : null,
      v: 1,
    }, _identity.secretKey)
    _selfLastSeen = value

    let written = 0
    for (const [, base] of _circleBases) {
      if (!base.writable) continue
      try {
        await base.append({ type: 'put', key: 'lastSeen:' + ourKey, value })
        written++
      } catch {
        // base closed mid-flight, etc.
      }
    }

    // After lastSeen lands, run the JS-side geofence check. Any flips
    // produce additional transition appends (and bump lastSeen again,
    // but the second write is byte-identical so the view is unchanged).
    await checkPlaceTransitions(lat, lon, accuracy, stamp)

    return { ok: true, written, pubkey: ourKey }
  },
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

async function appendLastSeen (base, lat, lon, accuracy, ts) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
  const ourKey = b4a.toString(_identity.publicKey, 'hex')
  const value = signValue({
    pubkey: ourKey,
    lat,
    lon,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    ts,
    v: 1,
  }, _identity.secretKey)
  await base.append({ type: 'put', key: 'lastSeen:' + ourKey, value })
}

async function checkPlaceTransitions (lat, lon, accuracy, ts) {
  for (const state of _circlePlaces.values()) {
    const base = _circleBases.get(state.circleId)
    if (!base || !base.writable) continue
    const dist = haversineMeters(lat, lon, state.lat, state.lon)
    const result = classify(dist, state.radiusMeters, state.lastClassification)
    state.lastClassification = result.classification
    if (!result.kind) continue
    try {
      await appendTransition(base, state.placeId, result.kind, ts)
      await appendLastSeen(base, lat, lon, accuracy, ts)
    } catch (e) {
      console.warn('[bare] failed to append transition', e?.message)
    }
  }
}

async function snapshotCircle (circleId, base) {
  await base.update()
  const view = base.view
  const circleRow = await view.get('circle')
  const members = []
  for await (const { key, value } of view.createReadStream({ gt: 'member:', lt: 'member:~' })) {
    members.push({ key, value })
  }
  const lastSeen = {}
  for await (const { key, value } of view.createReadStream({ gt: 'lastSeen:', lt: 'lastSeen:~' })) {
    const pubkey = key.slice('lastSeen:'.length)
    lastSeen[pubkey] = value
  }
  const places = []
  for await (const { value } of view.createReadStream({ gt: 'place:', lt: 'place:~' })) {
    if (value && !isDeleted(value)) places.push(value)
  }
  // Most recent 50 transitions, newest first. Reverse-stream the
  // ts-prefixed keys so we don't have to load the whole range.
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
  if (!_swarm) return
  const topic = topicForCircleKey(circleKey)
  const topicHex = b4a.toString(topic, 'hex')
  if (_topicToCircle.has(topicHex)) return
  _topicToCircle.set(topicHex, circleId)
  if (!_circlePeers.has(circleId)) _circlePeers.set(circleId, new Set())
  _swarm.join(topic, { server: true, client: true })
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

async function applyCircleNodes (nodes, view, base) {
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
      // `circle`: owner-write only — bootstrap writer authored or ignored
      if (op.key === 'circle') {
        const fromHex = b4a.toString(node.from.key, 'hex')
        if (fromHex !== bootstrapHex) continue
        await view.put('circle', op.value)
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
        // Track for in-process geofence checks. We don't have a base→circleId
        // reverse map, so look up the circleId by walking _circleBases. Cheap.
        // A delete tombstone (deleted: true) untracks instead, so the next
        // location:update can't fire transitions against a deleted place.
        for (const [cid, b] of _circleBases) {
          if (b === base) {
            if (isDeleted(incoming)) untrackPlace(cid, incoming.id)
            else trackPlace(cid, incoming)
            break
          }
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
        continue
      }
      // Other prefixes (presence, removed) not yet wired — silently
      // dropped.
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
    apply: applyCircleNodes,
    valueEncoding: 'json',
  })
  await base.ready()
  _circleBases.set(circleId, base)
  return base
}

function onSwarmConnection (conn, info) {
  // Pipe corestore replication first so cores can negotiate before we
  // emit peer:connected — UI typically calls circle:get right after that
  // event and we want the view to be fresh.
  _store.replicate(conn)

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
    send({ event: 'peer:connected', data: { circleId, remotePublicKey } })
  }
  conn.on('close', () => {
    for (const circleId of matchedCircleIds) {
      const peers = _circlePeers.get(circleId)
      if (peers) peers.delete(remotePublicKey)
      send({ event: 'peer:disconnected', data: { circleId, remotePublicKey } })
    }
  })
  conn.on('error', () => { /* swallow; close fires too */ })
}

async function init ({ dataDir } = {}, attempt = 0) {
  if (_initialized) {
    send({ event: 'ready', data: { publicKey: b4a.toString(_identity.publicKey, 'hex') } })
    return
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('init requires { dataDir: string }')
  }

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

  _swarm = new Hyperswarm({ keyPair: _identity })
  _swarm.on('connection', onSwarmConnection)

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

  // Populate the in-process geofence tracker from each circle's current
  // view. Places landing later via apply branch will be added there too.
  // Initial classification is null so the first location:update fires an
  // initial-trigger enter if the user is already inside the radius.
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

  // Load the persisted sharing toggle. Default true so existing
  // installs keep behaving as before; an explicit `enabled: false`
  // record from a prior session restores the muted state.
  try {
    const row = await _localDb.get('sharing')
    if (row?.value?.enabled === false) _sharingEnabled = false
  } catch {}

  _initialized = true
  send({ event: 'ready', data: { publicKey: b4a.toString(_identity.publicKey, 'hex'), sharingEnabled: _sharingEnabled } })
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
