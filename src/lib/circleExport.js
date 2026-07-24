// Circle config export / import (proposal 2026-06-17-circle-recreate-export-import).
// Serializes the hand-curated, low-volume parts of a circle - its name, Places
// and the per-circle toggles - so an owner can recreate a circle on a fresh
// empty Autobase (shedding accumulated oplog history) or carry the config to a
// file, without re-entering every Place by hand.
//
// Deliberately carries NO members (each rejoins with their own identity), NO
// history (a fresh oplog is the point) and NO keys/ids (import always mints a
// brand-new circle). Pure functions, no worklet state, so the round-trip and
// the validation bounds are unit-testable on their own.

const { clampPlaceRadius } = require('./geofence')

const EXPORT_TYPE = 'pearcircle.circle-export'
const EXPORT_V = 1

// Bounds on what an envelope may CARRY. Deliberately looser than the live
// place:create floor (MIN_PLACE_RADIUS_M = 150 since #139): files exported from
// circles built before that floor legitimately hold Places down to 10m, and
// rejecting them would make old exports unimportable. The create path
// (createCircleFromConfig in bare.js) clamps each radius up to the floor before
// it calls place:create, so a sub-floor value here can never produce a row the
// normal write paths would reject.
const NAME_MAX = 64
const PLACE_RADIUS_MIN = 10
const PLACE_RADIUS_MAX = 10000
const MAX_PLACES = 500 // bound import size; far above any real circle's Place count

function validName (s) {
  return typeof s === 'string' && s.trim().length > 0 && s.length <= NAME_MAX
}

// Build the export envelope from a circle's live config. `places` entries may
// carry extra fields (id, createdBy, createdAt); only the curated four survive.
// `now` is injectable for deterministic tests.
function buildExport ({ name, places = [], settings = {} } = {}, now = Date.now()) {
  return {
    type: EXPORT_TYPE,
    v: EXPORT_V,
    exportedAt: now,
    circle: { name },
    places: places.map((p) => ({
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      radiusMeters: p.radiusMeters,
    })),
    settings: {
      sharingDefault: settings.sharingDefault === true,
      tripSharing: settings.tripSharing === true,
    },
  }
}

// Validate + normalize an import payload. Returns { ok: true, value } with a
// clean config ready to feed the create-new-circle path, or { ok: false, error }.
// Rejects unknown type/version and any out-of-bounds field rather than clamping,
// so a malformed or hostile file can't silently seed a degenerate circle.
function validateImport (payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'not an object' }
  if (payload.type !== EXPORT_TYPE) return { ok: false, error: 'wrong type' }
  if (payload.v !== EXPORT_V) return { ok: false, error: 'unsupported version: ' + payload.v }

  const circle = payload.circle
  if (!circle || !validName(circle.name)) return { ok: false, error: 'invalid circle name' }

  const rawPlaces = payload.places
  if (!Array.isArray(rawPlaces)) return { ok: false, error: 'places must be an array' }
  if (rawPlaces.length > MAX_PLACES) return { ok: false, error: 'too many places' }

  const places = []
  for (let i = 0; i < rawPlaces.length; i++) {
    const p = rawPlaces[i]
    if (!p || typeof p !== 'object') return { ok: false, error: 'place ' + i + ' not an object' }
    if (!validName(p.name)) return { ok: false, error: 'place ' + i + ' invalid name' }
    if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) return { ok: false, error: 'place ' + i + ' invalid lat' }
    if (!Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) return { ok: false, error: 'place ' + i + ' invalid lon' }
    if (!Number.isFinite(p.radiusMeters) || p.radiusMeters < PLACE_RADIUS_MIN || p.radiusMeters > PLACE_RADIUS_MAX) {
      return { ok: false, error: 'place ' + i + ' invalid radiusMeters' }
    }
    places.push({ name: p.name.trim(), lat: p.lat, lon: p.lon, radiusMeters: p.radiusMeters })
  }

  const s = payload.settings || {}
  return {
    ok: true,
    value: {
      name: circle.name.trim(),
      places,
      settings: {
        sharingDefault: s.sharingDefault === true,
        tripSharing: s.tripSharing === true,
      },
    },
  }
}

// Decide what to do with each Place before it is copied into a NEW circle
// (recreate or import). Splits the list into `copy` (normalized, guaranteed to
// satisfy the live place:create bounds) and `skipped` (with a reason).
//
// Exists because the copy used to be verbatim and all-or-nothing: one Place the
// current place:create rejects threw, and the throw escaped AFTER the new
// circle had already been created and persisted, leaving the owner with a
// nameless duplicate in their list, no invite and no migration nudge for the
// members. The dominant case is the radius floor - the Add Place default was
// 100m until #139 raised the floor to 150m, so nearly every circle created
// before 2026-07-01 holds Places the current handler refuses. Those are clamped
// up rather than dropped; only a Place that is unusable on its own terms (no
// name, no coordinates) is skipped.
function planPlaceCopy (places = []) {
  const copy = []
  const skipped = []
  for (const p of Array.isArray(places) ? places : []) {
    const radiusMeters = clampPlaceRadius(p?.radiusMeters)
    let reason = null
    if (!p || typeof p !== 'object') reason = 'not an object'
    else if (!validName(p.name)) reason = 'invalid name'
    else if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) reason = 'invalid lat'
    else if (!Number.isFinite(p.lon) || p.lon < -180 || p.lon > 180) reason = 'invalid lon'
    else if (radiusMeters === null) reason = 'invalid radiusMeters'
    if (reason) {
      skipped.push({ name: typeof p?.name === 'string' ? p.name : '', reason })
      continue
    }
    copy.push({ name: p.name.trim(), lat: p.lat, lon: p.lon, radiusMeters })
  }
  return { copy, skipped }
}

module.exports = { buildExport, validateImport, planPlaceCopy, EXPORT_TYPE, EXPORT_V, NAME_MAX, MAX_PLACES }
