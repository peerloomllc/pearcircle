import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import maplibregl from 'maplibre-gl'
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css'
import { colors, typography, spacing, radius } from './theme.js'
import { FONT_CSS } from './fonts.js'
import { Image as ImageIcon, GearSix, Info as InfoIcon, CaretDown, ShareNetwork, PersonSimpleWalk, CarProfile, PencilSimple, Trash, SignOut, BellSimple, BellSimpleSlash, NavigationArrow, AirplaneTilt } from '@phosphor-icons/react'
import { motionState } from '../lib/motion.js'
import { formatDistance, formatDuration, formatSpeed, formatTripDate, polylineSvgPath, polylineGeoJson } from '../lib/tripFormat.js'
import motionWalkingUrl from '../../assets/images/motion_walking.png'
import motionDrivingUrl from '../../assets/images/motion_driving.png'

// Inject the Manrope @font-face once per WebView load. Mirrors PearCal's
// pattern so the family resolves before any styled element renders.
if (typeof document !== 'undefined' && !document.getElementById('pearcircle-font-styles')) {
  const styleEl = document.createElement('style')
  styleEl.id = 'pearcircle-font-styles'
  styleEl.textContent = FONT_CSS
  document.head.appendChild(styleEl)
}

// Motion-badge pulse keyframe injected once. Used by the walking / driving
// sticker overlay on member pins. Subtle scale-only animation so it reads
// as breathing rather than throbbing; sticker artwork stays crisp.
if (typeof document !== 'undefined' && !document.getElementById('pearcircle-motion-pulse')) {
  const styleEl = document.createElement('style')
  styleEl.id = 'pearcircle-motion-pulse'
  styleEl.textContent = `@keyframes pearcircle-motion-pulse {
    0%   { transform: scale(0.95); }
    50%  { transform: scale(1.08); }
    100% { transform: scale(0.95); }
  }`
  document.head.appendChild(styleEl)
}

// Focus-pin spin keyframe. Drives the rotating cyan conic-gradient ring
// that surrounds the selected member's avatar. The avatar itself stays
// stationary (the ring is a sibling element behind it), so only the
// gradient halo rotates.
if (typeof document !== 'undefined' && !document.getElementById('pearcircle-focus-spin')) {
  const styleEl = document.createElement('style')
  styleEl.id = 'pearcircle-focus-spin'
  styleEl.textContent = `@keyframes pearcircle-focus-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }`
  document.head.appendChild(styleEl)
}
import QRCode from 'qrcode'

// Lazy proxy: window.pear is installed by main.jsx but App.jsx is imported
// before that assignment runs. Resolve through window at call time.
const pear = {
  call: (...args) => window.pear.call(...args),
  on: (...args) => window.pear.on(...args),
}

// Tactile feedback helper. Fire-and-forget: a missed haptic is never a
// reason to block the visible action that triggered it. Kinds match the
// shell's `shell:haptic` IPC handler:
//   light | medium | heavy  -> impact
//   warn  | success         -> notification
function haptic (kind) {
  try { pear.call('shell:haptic', { kind }) } catch {}
}

// Module-level LIFO stack for hardware-back handlers. Each component
// that wants to claim back uses useBackHandler() to push its handler
// while it's "active" (sheet open, focus set, etc.). The shell's
// BackHandler emits a `back:pressed` event; App walks this stack
// from the top (most recently pushed = innermost UI), and the first
// handler to return true consumes the event. If none consume, App
// falls through to `shell:exitApp`. Mirrors React's render-order
// nesting so an inner sheet/modal naturally dismisses first.
const _backStack = []
function useBackHandler (handler, active = true) {
  const handlerRef = useRef(handler)
  useEffect(() => { handlerRef.current = handler }, [handler])
  useEffect(() => {
    if (!active) return
    const wrapped = () => handlerRef.current?.()
    _backStack.push(wrapped)
    return () => {
      const i = _backStack.lastIndexOf(wrapped)
      if (i >= 0) _backStack.splice(i, 1)
    }
  }, [active])
}

// Inject MapLibre's stylesheet exactly once per page. esbuild's
// --loader:.css=text drops the CSS into the JS bundle as a string so we
// can stamp it into a <style> tag at runtime - we have no separate CSS
// pipeline.
let _mapLibreCssInjected = false
function ensureMapLibreCss () {
  if (_mapLibreCssInjected) return
  const styleEl = document.createElement('style')
  styleEl.textContent = maplibreCss
  document.head.appendChild(styleEl)
  _mapLibreCssInjected = true
}

// OpenFreeMap is a free, key-less, OSM-based MapLibre style. Default
// fallback when there's no override in AsyncStorage. The user can swap
// to Protomaps or any other MapLibre-style URL via Settings -> Map tiles
// without rebuilding the app.
const DEFAULT_TILE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

export function App () {
  const [view, setView] = useState({ name: 'home' })
  const [identity, setIdentity] = useState(null)
  const [profile, setProfile] = useState(null)
  const [sharing, setSharing] = useState({ enabled: true, expiresAt: null })
  // Sheet stack overlays the home view rather than navigating to a
  // full-page route. Shape: null | { name, ...data }. Names so far:
  //   settings | about | create | join | invite
  const [sheet, setSheet] = useState(null)
  const closeSheet = useCallback(() => setSheet(null), [])
  // Back gesture closes the current overlay (settings / about / create /
  // join / invite). Only active while a sheet is open so it doesn't sit
  // in _backStack at idle. ConfirmSheet (a nested BottomSheet) registers
  // its own handler when mounted, so back inside an open Settings sheet
  // dismisses the ConfirmSheet first, then on the next back this fires
  // to close Settings.
  useBackHandler(useCallback(() => {
    if (!sheet) return false
    // Trip detail → back to the trips list (preserve list scroll/state),
    // matches the in-sheet ‹ button.
    if (sheet.name === 'tripDetail') { setSheet({ name: 'trips' }); return true }
    closeSheet()
    return true
  }, [sheet, closeSheet]), !!sheet)
  // Owner-tear-down notice queue (proposal amendment 2026-05-07 §1).
  // The worklet emits `circle:deleted` when an owner's tombstone lands;
  // we show one alert per circle, then call circle:cleanup-deleted to
  // free local state. Stored as an array because two circles could
  // theoretically be deleted in quick succession.
  const [deletedNotices, setDeletedNotices] = useState([])
  // MapLibre style URL. Hydrated from AsyncStorage (via shell:tileStyle:get)
  // on mount; passed down to HomeMapView -> CircleMap so the map can hot-
  // swap on edit. Settings -> Map tiles writes through both AsyncStorage
  // and this state via setTileStyleUrlAndPersist.
  const [tileStyleUrl, setTileStyleUrl] = useState(DEFAULT_TILE_STYLE_URL)
  const setTileStyleUrlAndPersist = useCallback(async (url) => {
    const next = url == null || url === '' ? null : url
    try { await pear.call('shell:tileStyle:set', { url: next }) } catch {}
    setTileStyleUrl(next ?? DEFAULT_TILE_STYLE_URL)
  }, [])
  // Distance unit preference for the Trips list / detail. Hydrated from
  // AsyncStorage on mount; default 'km'. Trip records always store meters,
  // we just format on the way out.
  const [distanceUnit, setDistanceUnit] = useState('km')
  const setDistanceUnitAndPersist = useCallback(async (unit) => {
    const next = unit === 'miles' ? 'miles' : 'km'
    try { await pear.call('shell:distanceUnit:set', { unit: next }) } catch {}
    setDistanceUnit(next)
  }, [])

  const refresh = useCallback(async () => {
    const [id, pr, sh] = await Promise.all([
      pear.call('identity:get'),
      pear.call('profile:get'),
      pear.call('sharing:get').catch(() => ({ enabled: true, expiresAt: null })),
    ])
    setIdentity(id)
    setProfile(pr ?? null)
    setSharing({
      enabled: sh?.enabled !== false,
      expiresAt: typeof sh?.expiresAt === 'number' ? sh.expiresAt : null,
    })
  }, [])

  useEffect(() => {
    refresh()
    // Pull the persisted tile-style override (if any). Failures fall back
    // to the default; a missing override is normal on first launch.
    pear.call('shell:tileStyle:get').then((r) => {
      if (r?.url && typeof r.url === 'string') setTileStyleUrl(r.url)
    }).catch(() => {})
    pear.call('shell:distanceUnit:get').then((r) => {
      if (r?.unit === 'miles' || r?.unit === 'km') setDistanceUnit(r.unit)
    }).catch(() => {})
    pear.on('ready', refresh)
    pear.on('sharing:changed', ({ enabled, expiresAt }) => {
      setSharing({
        enabled: enabled !== false,
        expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
      })
    })
    pear.on('deeplink:invite', ({ url }) => {
      if (typeof url === 'string') setSheet({ name: 'join', invite: url })
    })
    // Notification taps from the shell route here so any current view
    // (Profile, Join, etc.) gets superseded by home with focus state.
    // seq forces a new prop reference even on repeat-taps of the same
    // member so HomeMapView's effect re-fires.
    pear.on('notification:focus', ({ circleId, pubkey }) => {
      if (typeof circleId !== 'string' || typeof pubkey !== 'string') return
      setView({ name: 'home', selectCircle: circleId, focus: { circleId, pubkey, seq: Date.now() } })
    })
    // Owner deleted a peer's circle. Worklet has already filtered its
    // own emit so this only fires on peers, not the owner themselves.
    // Queue a one-shot notice; user dismissal triggers the cleanup IPC.
    pear.on('circle:deleted', ({ circleId, circleName }) => {
      if (typeof circleId !== 'string') return
      setDeletedNotices((prev) => {
        if (prev.some((n) => n.circleId === circleId)) return prev
        return [...prev, { circleId, circleName: circleName || 'Circle' }]
      })
    })
    // Light tactile feedback on every button tap. Capture-phase listener
    // so it fires before any onClick handler stops propagation. Buttons
    // that fire a stronger haptic (data-haptic="warn", "medium", etc.)
    // opt out so the user feels one buzz per tap, not a double-tap.
    // Disabled buttons skip the haptic since the visible action also won't fire.
    const onAnyClick = (e) => {
      const btn = e.target.closest('button')
      if (!btn || btn.disabled) return
      if (btn.dataset.haptic) return
      haptic('light')
    }
    document.addEventListener('click', onAnyClick, true)

    // Hardware-back precedence chain. Walk the LIFO _backStack from the
    // top; first handler to return true consumes the event (closes a
    // sheet, clears focus, etc.). If nothing consumes it, ask the shell
    // to exit the app. The shell registers BackHandler in app/index.tsx
    // and relays here via the back:pressed event.
    pear.on('back:pressed', () => {
      for (let i = _backStack.length - 1; i >= 0; i--) {
        try { if (_backStack[i]() === true) return } catch {}
      }
      pear.call('shell:exitApp').catch(() => {})
    })
    return () => { document.removeEventListener('click', onAnyClick, true) }
  }, [refresh])

  // Dismiss the head notice: tell the worklet to free local state, then
  // pop it from the queue.
  const dismissDeletedNotice = useCallback(async (circleId) => {
    try { await pear.call('circle:cleanup-deleted', { circleId }) } catch {}
    setDeletedNotices((prev) => prev.filter((n) => n.circleId !== circleId))
    refresh()
  }, [refresh])

  // Single place that flips the sharing toggle: persist in worklet,
  // start/stop the native foreground service. UI subscribers see the
  // sharing:changed event and re-render. Errors surface to the caller
  // so the ProfileView toggle can show them. expiresAt is a future ms
  // timestamp for time-bounded mute; null/omitted = indefinite.
  const setSharingEnabled = useCallback(async (enabled, expiresAt = null) => {
    await pear.call('sharing:set', { enabled, expiresAt })
    if (enabled) {
      await pear.call('shell:location:start').catch(() => null)
    } else {
      await pear.call('shell:location:stop').catch(() => null)
    }
  }, [])

  // All non-home views live as sheets now. The home (map) view is the
  // base; everything else slides up over it.
  const onCircleCreated = useCallback((circleId) => {
    refresh()
    if (circleId) setView({ name: 'home', selectCircle: circleId })
  }, [refresh])
  const onCircleJoined = useCallback((circleId) => {
    refresh()
    if (circleId) setView({ name: 'home', selectCircle: circleId })
    setSheet(null)
  }, [refresh])

  return (
    <>
      <HomeMapView
        key={view.selectCircle ?? 'all'}
        identity={identity}
        profile={profile}
        sharing={sharing.enabled}
        tileStyleUrl={tileStyleUrl}
        setView={setView}
        setSheet={setSheet}
        initialSelectedCircleId={view.selectCircle ?? null}
        initialFocus={view.focus ?? null}
      />
      <SheetContainer open={sheet?.name === 'settings'}>
        <ProfileView
          active={sheet?.name === 'settings'}
          profile={profile}
          sharing={sharing}
          setSharing={setSharingEnabled}
          tileStyleUrl={tileStyleUrl}
          setTileStyleUrl={setTileStyleUrlAndPersist}
          distanceUnit={distanceUnit}
          setDistanceUnit={setDistanceUnitAndPersist}
          onClose={closeSheet}
          onSaved={refresh}
        />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'trips'}>
        <TripsView
          active={sheet?.name === 'trips'}
          distanceUnit={distanceUnit}
          tileStyleUrl={tileStyleUrl}
          onOpenTrip={(startTs) => setSheet({ name: 'tripDetail', startTs })}
          onClose={closeSheet}
        />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'tripDetail'}>
        {sheet?.name === 'tripDetail' && (
          <TripDetailView
            startTs={sheet.startTs}
            distanceUnit={distanceUnit}
            tileStyleUrl={tileStyleUrl}
            onBack={() => setSheet({ name: 'trips' })}
          />
        )}
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'about'}>
        <AboutView onClose={closeSheet} />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'create'}>
        <CreateView onClose={closeSheet} onCreated={onCircleCreated} setSheet={setSheet} />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'join'}>
        <JoinView onClose={closeSheet} onJoined={onCircleJoined} initialInvite={sheet?.name === 'join' ? sheet.invite : undefined} />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'invite'}>
        {sheet?.name === 'invite' && (
          <InviteShareView circleId={sheet.circleId} circleName={sheet.circleName} onClose={closeSheet} />
        )}
      </SheetContainer>
      {deletedNotices.length > 0 && (
        <CircleDeletedNotice
          circleName={deletedNotices[0].circleName}
          onDismiss={() => dismissDeletedNotice(deletedNotices[0].circleId)}
        />
      )}
    </>
  )
}

// Modal alert shown when a peer's circle is torn down by its owner.
// One-shot per circle: dismiss runs circle:cleanup-deleted on the
// worklet side which frees local state and removes the circle from the
// dropdown / sheets. zIndex sits above SheetContainer (100) and the
// BottomSheet (200) so the user can't miss it. Brand-aligned plain
// styling — no icons, no extra chrome.
function CircleDeletedNotice ({ circleName, onDismiss }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
      padding: spacing.lg,
    }}>
      <div style={{
        background: colors.surface.elevated,
        borderRadius: radius.lg,
        padding: spacing.lg,
        maxWidth: 400, width: '100%',
        border: `1px solid ${colors.border}`,
      }}>
        <div style={{ ...typography.heading, color: colors.text.primary, marginBottom: spacing.sm }}>
          Circle deleted
        </div>
        <div style={{ ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg }}>
          The owner deleted the circle <strong style={{ color: colors.text.primary, fontWeight: 400 }}>{circleName}</strong>. It's been removed from your circles.
        </div>
        <button
          onClick={onDismiss}
          style={{
            width: '100%', padding: '12px', borderRadius: radius.md,
            background: colors.accent, color: colors.text.onPrimary,
            border: 'none', cursor: 'pointer',
            fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
          }}>
          OK
        </button>
      </div>
    </div>
  )
}

// Slide-up overlay container. Always mounted so the closing animation
// has content to slide; pointer-events gate interaction. Children stay
// in DOM when closed (a touch wasteful for ProfileView's effects, but
// avoids a remount-and-relayout per open).
function SheetContainer ({ open, children }) {
  return (
    <div
      aria-hidden={!open}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: colors.surface.base,
        transform: open ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 280ms cubic-bezier(0.32, 0.72, 0, 1)',
        pointerEvents: open ? 'auto' : 'none',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {children}
    </div>
  )
}

function CreateView ({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const submit = async () => {
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    const r = await pear.call('circle:create', { name: name.trim() })
    setCreating(false)
    if (r?.invite) {
      setResult(r)
      onCreated(r.circleId)
    } else {
      setError('Could not create circle')
    }
  }

  const finish = () => {
    setName('')
    setResult(null)
    setError(null)
    onClose()
  }

  if (result) {
    return (
      <div style={s.screen}>
        <BackBar onBack={finish} title={result.name} />
        <p style={s.muted}>Circle created. Share the QR code or paste the link:</p>
        <QrImage text={result.invite} />
        <textarea style={s.inviteBox} readOnly value={result.invite} onFocus={(e) => e.target.select()} />
        <ShareButton text={result.invite} />
        <button style={s.primaryBtn} onClick={finish}>Done</button>
      </div>
    )
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={onClose} title='New Circle' />
      <label style={s.label}>Circle name</label>
      {/* No autoFocus here on purpose: CreateView lives in an always-
          mounted SheetContainer (translated off-screen when closed), and
          Android WebView defers autoFocus on hidden inputs until the
          first user gesture, then fires it on whatever the user tapped
          first - which surfaced as the keyboard opening on the first
          pin tap after cold start. Tapping the input is one extra step
          when the sheet does open, which is fine. */}
      <input
        style={s.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='Smith Family'
        maxLength={64}
      />
      <button style={s.primaryBtn} disabled={!name.trim() || creating} onClick={submit}>
        {creating ? 'Creating...' : 'Create'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

// Sheet for sharing an invite to an existing circle. Fetches the invite
// link on open via circle:invite (which rebuilds it deterministically
// from the local joined-record) and renders the same QR/copy/share UI
// CreateView's result state uses.
function InviteShareView ({ circleId, circleName, onClose }) {
  const [invite, setInvite] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!circleId) return
    let cancelled = false
    pear.call('circle:invite', { circleId })
      .then((r) => { if (!cancelled) setInvite(r?.invite ?? null) })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)) })
    return () => { cancelled = true }
  }, [circleId])
  return (
    <div style={s.screen}>
      <BackBar onBack={onClose} title={circleName ?? 'Invite'} />
      {error && <p style={s.error}>{error}</p>}
      {!error && !invite && <p style={s.muted}>Building invite...</p>}
      {invite && (
        <>
          <p style={s.muted}>Share the QR code or paste the link to invite someone to this circle.</p>
          <QrImage text={invite} />
          <textarea style={s.inviteBox} readOnly value={invite} onFocus={(e) => e.target.select()} />
          <ShareButton text={invite} />
        </>
      )}
    </div>
  )
}

function JoinView ({ onClose, onJoined, initialInvite }) {
  const [invite, setInvite] = useState(initialInvite ?? '')
  // Reseed the invite field when the parent re-opens the sheet with a
  // fresh deep-link URL. Without this the textarea sticks to whatever
  // the user last typed.
  useEffect(() => {
    if (typeof initialInvite === 'string') setInvite(initialInvite)
  }, [initialInvite])
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState(null)

  const onScan = async () => {
    setError(null)
    try {
      const text = await pear.call('shell:scanQr')
      if (typeof text === 'string' && text.length > 0) setInvite(text)
    } catch (err) {
      setError('Scan failed: ' + (err?.message ?? err))
    }
  }

  const submit = async () => {
    if (!invite.trim()) return
    setJoining(true)
    setError(null)
    try {
      const r = await pear.call('circle:join', { invite: invite.trim() })
      setJoining(false)
      if (r?.circleId) {
        onJoined(r.circleId)
      } else {
        setError('Invalid invite')
      }
    } catch (e) {
      setJoining(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={onClose} title='Join Circle' />
      <label style={s.label}>Paste invite link</label>
      <textarea
        style={s.textarea}
        value={invite}
        onChange={(e) => setInvite(e.target.value)}
        placeholder='https://peerloomllc.com/circle/join?...'
        rows={4}
      />
      <button style={s.secondaryBtn} onClick={onScan}>
        Scan QR code
      </button>
      <button style={{ ...s.primaryBtn, marginTop: spacing.md }} disabled={!invite.trim() || joining} onClick={submit}>
        {joining ? 'Joining...' : 'Join'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

// Merge per-circle snapshots into one view-model. Members are deduped by
// pubkey (keep the row with the latest joinedAt); lastSeen by pubkey too
// (newest ts wins). Places carry their circleId so per-place actions
// (fire transition, future delete) know where to write. Transitions are
// flattened across circles and sorted desc by ts for the latest-per-
// pubkey lookup.
function mergeCircleSnapshots (circles) {
  const memberMap = new Map()
  const lastSeen = {}
  const presence = {}
  const places = []
  const transitions = []
  for (const c of circles ?? []) {
    if (!c || c.error) continue
    for (const m of c.members ?? []) {
      const pubkey = m.value?.pubkey
      if (!pubkey) continue
      const existing = memberMap.get(pubkey)
      const incomingJoinedAt = m.value?.joinedAt ?? 0
      const existingJoinedAt = existing?.value?.joinedAt ?? 0
      if (!existing || incomingJoinedAt > existingJoinedAt) memberMap.set(pubkey, m)
    }
    for (const [pubkey, seen] of Object.entries(c.lastSeen ?? {})) {
      const existing = lastSeen[pubkey]
      if (!existing || (seen?.ts ?? 0) > (existing?.ts ?? 0)) lastSeen[pubkey] = seen
    }
    for (const [pubkey, pres] of Object.entries(c.presence ?? {})) {
      const existing = presence[pubkey]
      if (!existing || (pres?.setAt ?? 0) > (existing?.setAt ?? 0)) presence[pubkey] = pres
    }
    for (const p of c.places ?? []) places.push({ ...p, circleId: c.circleId })
    for (const t of c.transitions ?? []) transitions.push({ ...t, circleId: c.circleId })
  }
  transitions.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  return { members: Array.from(memberMap.values()), lastSeen, presence, places, transitions }
}

function HomeMapView ({ identity, profile, sharing, tileStyleUrl, setView, setSheet, initialSelectedCircleId = null, initialFocus = null }) {
  const [circles, setCircles] = useState([])
  const [selfSeen, setSelfSeen] = useState(null)
  const [peerCount, setPeerCount] = useState(0)
  // Per-circle peer pubkey sets (Hyperswarm-level). Filtered to the
  // active-circle subset and unioned for the map's online-dot indicator
  // and any future "live link" affordance. Refreshed on the same cadence
  // as the circle snapshots, plus on peer:connected/disconnected events.
  const [peersByCircle, setPeersByCircle] = useState({})
  const [selectedCircleId, setSelectedCircleId] = useState(initialSelectedCircleId) // null = All
  const [selectedPubkey, setSelectedPubkey] = useState(null) // null = auto-fit-everyone view
  // Member detail sheet visibility, separate from selectedPubkey so
  // dragging the sheet down keeps the focus state (top bar visible,
  // map still flown-to). Tapping the focus bar re-opens.
  const [memberSheetVisible, setMemberSheetVisible] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [showAddPlace, setShowAddPlace] = useState(false)
  const [pendingPlaceCoords, setPendingPlaceCoords] = useState(null) // { lat, lon } from a map long-press, prefilled into AddPlaceForm
  const [editingPlace, setEditingPlace] = useState(null) // { circleId, id, name, radiusMeters } or null
  const [confirmingDeletePlace, setConfirmingDeletePlace] = useState(null) // place object awaiting confirm-sheet decision
  const [deletingPlaceId, setDeletingPlaceId] = useState(null)             // place.id with in-flight place:delete IPC
  const [deleteError, setDeleteError] = useState(null)
  const [transitionError, setTransitionError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Per-device mute set ('{circleId}:{placeId}'). Source of truth is the
  // RN shell; this is a local cache loaded on mount and updated on toggle.
  const [mutedPlaces, setMutedPlaces] = useState(() => new Set())
  const mapApiRef = useRef(null)
  // Set by focusMember just before its flyTo. The auto-recenter
  // effect skips its first run after a focus so we don't override
  // the cinematic flyTo with an immediate panTo. Subsequent lastSeen
  // updates re-pan as expected.
  const justFocusedRef = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const [all, peersResp] = await Promise.all([
        pear.call('circles:getAll'),
        pear.call('circles:peers'),
      ])
      // Defensive filter: hide circles whose owner has marked them
      // deleted. The worklet's init-cleanup sweep usually catches stale
      // tombstones on cold-start, but if a deletion lands mid-session
      // before the user dismisses the notice (or if the event was
      // missed and we haven't restarted yet), this keeps the dropdown,
      // sheets, and map roster in sync with what's actually live.
      // Errored entries are also skipped so one broken circle doesn't
      // poison the home view.
      setCircles((all?.circles ?? []).filter((c) => !c.error && !c.circle?.deleted))
      setSelfSeen(all?.selfLastSeen ?? null)
      const sets = peersResp?.peers ?? {}
      let total = 0
      for (const k of Object.keys(sets)) total += sets[k]?.length ?? 0
      setPeerCount(total)
      setPeersByCircle(sets)
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    pear.on('peer:connected', refresh)
    pear.on('peer:disconnected', refresh)
    pear.on('circle:writer:added', refresh)
    pear.on('ready', refresh)
    // Load mute set from the shell once on mount; toggleMute keeps state
    // in sync after that without re-fetching.
    pear.call('shell:notif:mute:list').then((r) => {
      const arr = r?.mutes
      if (Array.isArray(arr)) setMutedPlaces(new Set(arr))
    }).catch(() => {})
    return () => clearInterval(id)
  }, [refresh])

  const toggleMute = useCallback(async (place) => {
    const key = place.circleId + ':' + place.id
    const next = !mutedPlaces.has(key)
    setMutedPlaces((prev) => {
      const s = new Set(prev)
      if (next) s.add(key)
      else s.delete(key)
      return s
    })
    try {
      await pear.call('shell:notif:mute:set', { circleId: place.circleId, placeId: place.id, muted: next })
    } catch {
      // Roll back on failure so the UI doesn't lie.
      setMutedPlaces((prev) => {
        const s = new Set(prev)
        if (next) s.delete(key)
        else s.add(key)
        return s
      })
    }
  }, [mutedPlaces])

  // If a circle the user filtered to gets removed (left), drop the filter.
  useEffect(() => {
    if (!selectedCircleId) return
    if (!circles.some(c => c.circleId === selectedCircleId)) setSelectedCircleId(null)
  }, [circles, selectedCircleId])

  // If the focused member disappears from the active set (circle filter
  // changed, member left), drop focus so we don't strand a top bar
  // pointing at no one. Also drop focus if the focused member mutes
  // their sharing — the top bar would otherwise show stale info while
  // the pin disappears under it.
  useEffect(() => {
    if (!selectedPubkey) return
    const active = selectedCircleId
      ? circles.filter(c => c.circleId === selectedCircleId)
      : circles
    const present = active.some(c =>
      (c.members ?? []).some(m => m.value?.pubkey === selectedPubkey),
    ) || selectedPubkey === identity?.publicKey
    if (!present) { setSelectedPubkey(null); return }
    if (selectedPubkey === identity?.publicKey) return
    const muted = active.some(c => effectivePresenceMuted(c.presence?.[selectedPubkey]))
    if (muted) setSelectedPubkey(null)
  }, [circles, selectedCircleId, selectedPubkey, identity])

  // Pick the active subset based on the current filter.
  const activeCircles = selectedCircleId
    ? circles.filter(c => c.circleId === selectedCircleId)
    : circles
  const merged = mergeCircleSnapshots(activeCircles)

  // Union of pubkeys currently connected via Hyperswarm in any of the
  // active circles. Drives the green online-dot indicator on pin avatars.
  const connectedPubkeys = useMemo(() => {
    const set = new Set()
    for (const c of activeCircles) {
      const arr = peersByCircle?.[c.circleId]
      if (!arr) continue
      for (const pk of arr) set.add(pk)
    }
    return set
  }, [activeCircles, peersByCircle])

  // Inject self into the map even when the user has no circles yet
  // (zero-circle empty state) or hasn't appeared in any circle's lastSeen
  // yet, so the map is never blank.
  const myPubkey = identity?.publicKey
  const data = useMemo(() => {
    const out = { ...merged, lastSeen: { ...merged.lastSeen } }
    // Hide muted members' pins by stripping their lastSeen. Other UI
    // surfaces (member list) still see them via merged.presence so we
    // can show "Sharing paused". Self is exempted — even when paused,
    // I want to see my own pin at its frozen-last-known position.
    // Expired mutes (expiresAt < now) are NOT filtered — once the
    // mute has expired the peer is implicitly visible again per
    // proposal §4, even before they've written a fresh visible row.
    for (const [pubkey, pres] of Object.entries(merged.presence ?? {})) {
      if (pubkey === myPubkey) continue
      if (effectivePresenceMuted(pres)) delete out.lastSeen[pubkey]
    }
    if (myPubkey && selfSeen && !out.lastSeen[myPubkey]) {
      out.lastSeen[myPubkey] = selfSeen
    }
    if (myPubkey && !out.members.some(m => m.value?.pubkey === myPubkey)) {
      out.members.push({
        key: 'member:' + myPubkey,
        value: {
          pubkey: myPubkey,
          displayName: profile?.displayName ?? 'You',
          avatar: profile?.avatar ?? null,
          joinedAt: 0,
        },
      })
    }
    return out
  }, [merged, myPubkey, selfSeen, profile])

  const placesById = {}
  for (const p of data.places ?? []) placesById[p.id] = p

  const latestTransition = {}
  for (const t of data.transitions ?? []) {
    if (t?.pubkey && !latestTransition[t.pubkey]) latestTransition[t.pubkey] = t
  }

  const memberCount = data.members.length
  const placeCount = data.places.length
  const isSingleCircle = activeCircles.length === 1
  // Where to write per-place / per-circle actions. With "All" selected
  // and multiple circles we don't have a single target for membership-
  // post / read-only-warning lines. Place creation handles the
  // multi-circle case via writableCircles below.
  const actionTargetCircleId = isSingleCircle ? activeCircles[0]?.circleId : null
  const actionTargetWritable = isSingleCircle ? !!activeCircles[0]?.writable : false
  // Circles the user can write a new place to in the current scope.
  // Filtered view = at most one; All view = every writable circle.
  // The AddPlaceForm shows a picker when this list has more than one.
  const writableCircles = activeCircles.filter(c => c.writable)

  const fireTransition = useCallback(async (place, kind) => {
    setTransitionError(null)
    try {
      const seen = myPubkey ? data?.lastSeen?.[myPubkey] : null
      // Each place carries its own circleId from the merge step, so
      // transitions land on the right autobase even in "All" mode.
      await pear.call('geofence:transition', {
        circleId: place.circleId,
        placeId: place.id,
        kind,
        lat: seen?.lat ?? place.lat,
        lon: seen?.lon ?? place.lon,
      })
      await refresh()
    } catch (e) {
      setTransitionError(String(e?.message ?? e))
    }
  }, [data, myPubkey, refresh])

  const focusMember = useCallback((pubkey) => {
    if (!pubkey) return
    setSelectedPubkey(pubkey)
    setMemberSheetVisible(true)
    setMenuOpen(false)
    setSheetOpen(false)
    const seen = data.lastSeen?.[pubkey]
    if (seen) {
      justFocusedRef.current = true
      mapApiRef.current?.flyTo({
        center: [seen.lon, seen.lat], zoom: 16, duration: 1100,
      })
    }
  }, [data])

  // Two-stage pin / edge-indicator tap (user TODO 2026-05-08): the first
  // tap on an unfocused pin is focus-only (camera flyTo + top-bar swap)
  // so the user can see where the person is without the bottom sheet
  // immediately covering half the map; a second tap on the already-
  // focused pin opens the detail sheet -- BUT only if the member is
  // still in view. If the user has panned / zoomed away, the second tap
  // recenters back on the member instead, so finding-them-again takes
  // priority over the sheet. Roster-row taps and the notification:focus
  // path keep using `focusMember` directly because there's no camera-
  // intermediate state to show in those flows.
  const onPinTap = useCallback((pubkey) => {
    if (!pubkey) return
    const seen = data.lastSeen?.[pubkey]
    const isAlreadyFocused = selectedPubkey === pubkey
    if (isAlreadyFocused) {
      const inView = seen ? mapApiRef.current?.isInView([seen.lon, seen.lat]) : true
      if (!inView && seen) {
        // Panned away -- recenter, leave the sheet closed (or as-is) so
        // the next tap can do the open-sheet thing once they're back in
        // frame. Don't toggle memberSheetVisible here; the user already
        // saw the pin, they're just bringing the camera back to it.
        justFocusedRef.current = true
        mapApiRef.current?.flyTo({
          center: [seen.lon, seen.lat], zoom: 16, duration: 1100,
        })
        return
      }
      if (!memberSheetVisible) setMemberSheetVisible(true)
      return
    }
    setSelectedPubkey(pubkey)
    setMemberSheetVisible(false)
    setMenuOpen(false)
    setSheetOpen(false)
    if (seen) {
      justFocusedRef.current = true
      mapApiRef.current?.flyTo({
        center: [seen.lon, seen.lat], zoom: 16, duration: 1100,
      })
    }
  }, [selectedPubkey, memberSheetVisible, data])

  const clearFocus = useCallback(() => {
    setSelectedPubkey(null)
    setMemberSheetVisible(false)
    mapApiRef.current?.fitAll()
  }, [])

  // Back gesture clears member focus and returns the camera to the all-
  // fit baseline. Only active while a member is focused, so back at
  // idle (no sheets, no focus) falls through to shell:exitApp. Member
  // detail sheet (a BottomSheet) registers a handler of its own that
  // pops first if it's open.
  useBackHandler(useCallback(() => {
    if (!selectedPubkey) return false
    clearFocus()
    return true
  }, [selectedPubkey, clearFocus]), !!selectedPubkey)

  // Notification-tap focus delivered via prop from App. Each tap arrives
  // with a fresh seq so we can detect new taps even on repeat-tap of the
  // same member. focusMember changes whenever `data` updates (its
  // useCallback deps) which would re-fire this effect spuriously; the
  // seq ref guards against that. Placed after focusMember's declaration
  // to avoid a TDZ ReferenceError on the deps array at render time.
  const lastAppliedFocusSeq = useRef(null)
  useEffect(() => {
    if (!initialFocus?.pubkey) return
    if (initialFocus.seq === lastAppliedFocusSeq.current) return
    lastAppliedFocusSeq.current = initialFocus.seq ?? null
    if (initialFocus.circleId) setSelectedCircleId(initialFocus.circleId)
    focusMember(initialFocus.pubkey)
  }, [initialFocus, focusMember])

  // Long-press on the map opens the add-place form pre-filled with
  // the touched coords. The form picks (or asks for) the target
  // circle from `writableCircles`, so this works in both filtered
  // and "All circles" modes as long as the user is a writer
  // somewhere. No-op when the user has no writable circle (read-only
  // joiner, pending writer-add, etc).
  const onMapLongPress = useCallback(([lng, lat]) => {
    if (writableCircles.length === 0) return
    setEditingPlace(null)
    setPendingPlaceCoords({ lat, lon: lng })
    setShowAddPlace(true)
    setSheetOpen(true)
  }, [writableCircles])

  // Dismissing the bottom sheet (scrim tap or drag-to-close) cancels
  // any pending add/edit/delete-confirm flow, so reopening the sheet
  // is a fresh state. Without this the user gets the surprise of
  // returning to a half-filled edit form they thought they'd dismissed.
  useEffect(() => {
    if (sheetOpen) return
    setEditingPlace(null)
    setShowAddPlace(false)
    setPendingPlaceCoords(null)
    setConfirmingDeletePlace(null)
    setDeleteError(null)
    setTransitionError(null)
  }, [sheetOpen])

  const deletePlace = useCallback(async (place) => {
    setDeleteError(null)
    setDeletingPlaceId(place.id)
    try {
      await pear.call('place:delete', { circleId: place.circleId, placeId: place.id })
      setConfirmingDeletePlace(null)
      // Close any open edit form pointing at the just-deleted place.
      setEditingPlace((cur) => (cur && cur.id === place.id ? null : cur))
      await refresh()
    } catch (e) {
      setDeleteError(String(e?.message ?? e))
    } finally {
      setDeletingPlaceId(null)
    }
  }, [refresh])

  // Auto-recenter on the focused member's location updates. Tracks
  // their lastSeen.ts so the effect fires only when a genuinely new
  // update arrives (data refreshes every 3s but ts only bumps when
  // the worklet writes a new lastSeen). Skips the first run after
  // focusMember so the initial cinematic flyTo isn't immediately
  // overridden by a panTo.
  const focusedSeenTs = selectedPubkey ? (data.lastSeen?.[selectedPubkey]?.ts ?? null) : null
  useEffect(() => {
    if (!selectedPubkey) return
    if (justFocusedRef.current) {
      justFocusedRef.current = false
      return
    }
    const seen = data.lastSeen?.[selectedPubkey]
    if (!seen) return
    mapApiRef.current?.panTo([seen.lon, seen.lat], { duration: 600 })
  }, [selectedPubkey, focusedSeenTs])

  // Resolve the focused member's display fields from whichever circle
  // carries the freshest row. Falls back to "you" when the user has
  // focused themselves but no circle row exists yet.
  const selectedMember = (() => {
    if (!selectedPubkey) return null
    const m = data.members.find(x => x.value?.pubkey === selectedPubkey)
    const seen = data.lastSeen?.[selectedPubkey]
    return {
      pubkey: selectedPubkey,
      displayName: m?.value?.displayName ?? (selectedPubkey === myPubkey ? 'You' : short(selectedPubkey)),
      avatar: m?.value?.avatar,
      seen,
    }
  })()

  // Title is the current filter label.
  const filterLabel = selectedCircleId
    ? (activeCircles[0]?.circle?.name ?? '...')
    : (circles.length === 0 ? 'PearCircle' : circles.length === 1 ? (circles[0]?.circle?.name ?? '...') : 'All circles')

  return (
    <div style={s.mapFirstRoot}>
      <div style={s.mapFill}>
        <CircleMap
          ref={mapApiRef}
          data={data}
          selectedPubkey={selectedPubkey}
          connectedPubkeys={connectedPubkeys}
          myPubkey={myPubkey}
          tileStyleUrl={tileStyleUrl}
          onMemberClick={onPinTap}
          onLongPress={onMapLongPress}
        />
      </div>

      {/* Slide-down member-focus top bar. Always mounted so the slide
          animation has content; hidden above the viewport when no member
          is focused. */}
      <div
        aria-hidden={!selectedMember}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          paddingTop: `calc(env(safe-area-inset-top, 24px) + 8px)`,
          paddingLeft: 12, paddingRight: 12, paddingBottom: 8,
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', gap: 8,
          transform: selectedMember ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          zIndex: 6,
          pointerEvents: selectedMember ? 'auto' : 'none',
        }}
      >
        {selectedMember && (
          <>
            <button type='button' style={s.iconBtn} onClick={clearFocus} aria-label='Back to all'>‹</button>
            <button
              type='button'
              onClick={() => setMemberSheetVisible(true)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 8,
                background: 'transparent', border: 'none', padding: 0,
                color: colors.text.primary, cursor: 'pointer', textAlign: 'left',
                fontFamily: typography.fontFamily,
              }}
              aria-label='Open member detail'
            >
              <Avatar base64={selectedMember.avatar} label={selectedMember.displayName} size={32} />
              <div style={s.focusName}>{selectedMember.displayName}</div>
            </button>
            {/* Battery, motion, freshness, and recent transitions live in the
                MemberDetailSheet — this header is just an at-a-glance
                back-to-all affordance, with a tap to reopen the sheet. */}
          </>
        )}
      </div>

      {/* Tap-outside scrim for the pill menu, separate from member-sheet
          dismissal so closing the menu doesn't disturb other UI state. */}
      {menuOpen && !selectedMember && <div style={s.menuScrim} onClick={() => setMenuOpen(false)} />}

      {/* Floating circle pill + menu. Hidden entirely while a member is
          focused — the focus bar owns the top area and the dropdown
          isn't useful with the member detail sheet covering the map.
          Animates opacity for a soft cross-fade. */}
      <div
        aria-hidden={!!selectedMember}
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + 12px)`,
          left: '50%',
          transform: 'translate(-50%, 0)',
          width: 240, maxWidth: 'calc(100vw - 32px)',
          opacity: selectedMember ? 0 : 1,
          pointerEvents: selectedMember ? 'none' : 'auto',
          transition: 'opacity 200ms ease',
          // Above the scrim (z 9) so dropdown items are clickable; the
          // scrim only catches taps outside the pill+menu container.
          zIndex: 20,
        }}
      >
        <button
          type='button'
          onClick={() => setMenuOpen((m) => !m)}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 14px',
            background: 'rgba(26,26,26,0.92)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: `1px solid ${colors.border}`,
            borderRadius: radius.full,
            color: colors.text.primary,
            fontFamily: typography.fontFamily,
            fontSize: 14, fontWeight: 300,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>{filterLabel}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', color: colors.text.secondary, transform: menuOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }}>
            <CaretDown size={11} weight='thin' />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4, color: colors.text.secondary }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: peerCount > 0 ? '#7ec77a' : '#555' }} />
            <span style={{ fontSize: 12 }}>{peerCount}</span>
          </span>
        </button>

        {/* Always-mounted menu, animates open/close. Keeps width matched
            to the pill since they share the parent container. */}
        <div
          aria-hidden={!menuOpen || !!selectedMember}
          style={{
            position: 'absolute', top: 44, left: 0, right: 0,
            background: colors.surface.card,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.lg,
            padding: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            transform: menuOpen && !selectedMember ? 'translateY(0)' : 'translateY(-6px)',
            opacity: menuOpen && !selectedMember ? 1 : 0,
            pointerEvents: menuOpen && !selectedMember ? 'auto' : 'none',
            transition: 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1), opacity 180ms',
            zIndex: 10,
          }}
        >
          {circles.length > 1 && (
            <button
              style={{ ...s.menuItem, ...(selectedCircleId === null ? s.menuItemActive : null) }}
              onClick={() => { setSelectedCircleId(null); setMenuOpen(false) }}
            >
              All circles
            </button>
          )}
          {circles.map((c) => (
            <div key={c.circleId} style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
              <button
                style={{ ...s.menuItem, ...(selectedCircleId === c.circleId ? s.menuItemActive : null), flex: 1 }}
                onClick={() => { setSelectedCircleId(c.circleId); setMenuOpen(false) }}
              >
                {c.circle?.name ?? '...'}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setSheet({ name: 'invite', circleId: c.circleId, circleName: c.circle?.name ?? 'Circle' })
                }}
                aria-label='Share invite'
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 36, padding: 0,
                  background: 'transparent', color: colors.text.secondary,
                  border: 'none', borderRadius: 6, cursor: 'pointer',
                }}>
                <ShareNetwork size={16} weight='thin' />
              </button>
            </div>
          ))}
          {circles.length > 0 && <div style={s.menuDivider} />}
          <button
            style={s.menuItem}
            onClick={() => { setMenuOpen(false); setSheet({ name: 'create' }) }}
          >
            + Create Circle
          </button>
          <button
            style={s.menuItem}
            onClick={() => { setMenuOpen(false); setSheet({ name: 'join' }) }}
          >
            + Join Circle
          </button>
        </div>
      </div>

      {/* Floating gear (Settings) bottom-left, info (About) bottom-right.
          Same circular FAB style; sit above the bottom sheet handle and
          below the sheet itself. Sharing-paused indicator overlays the
          gear so the user notices when they're not broadcasting. */}
      <button
        type='button'
        onClick={() => setSheet({ name: 'settings' })}
        aria-label='Settings'
        style={{
          position: 'absolute',
          left: 16,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + 16px)`,
          width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${colors.border}`,
          color: colors.text.primary,
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          zIndex: 5,
        }}
      >
        <GearSix size={22} weight='thin' />
        {!sharing && (
          <span
            style={{
              position: 'absolute', top: -2, right: -2,
              width: 12, height: 12, borderRadius: '50%',
              background: colors.error, border: `2px solid ${colors.surface.card}`,
              pointerEvents: 'none',
            }}
            title='Sharing paused'
            aria-label='Sharing paused'
          />
        )}
      </button>
      <button
        type='button'
        onClick={() => setSheet({ name: 'about' })}
        aria-label='About'
        style={{
          position: 'absolute',
          right: 16,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + 16px)`,
          width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${colors.border}`,
          color: colors.text.primary,
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          zIndex: 5,
        }}
      >
        <InfoIcon size={22} weight='thin' />
      </button>
      {/* Find-me FAB stacked above the About FAB. Plain camera helper:
          tap = flyTo self's last-known coords, no focus-mode change, no
          sheet. Dimmed/no-op when we don't have a fix yet (selfSeen is
          null on cold-start before the first location:update). */}
      <button
        type='button'
        onClick={() => {
          if (!selfSeen) return
          mapApiRef.current?.flyTo({
            center: [selfSeen.lon, selfSeen.lat], zoom: 16, duration: 1100,
          })
        }}
        aria-label={selfSeen ? 'Center on my location' : 'Waiting for your location'}
        title={selfSeen ? 'Center on my location' : 'Waiting for your location'}
        style={{
          position: 'absolute',
          right: 16,
          bottom: `calc(env(safe-area-inset-bottom, 0px) + 72px)`,
          width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${colors.border}`,
          color: colors.text.primary,
          cursor: selfSeen ? 'pointer' : 'default',
          opacity: selfSeen ? 1 : 0.5,
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          zIndex: 5,
        }}
      >
        <NavigationArrow size={22} weight='thin' />
      </button>

      {circles.length === 0 ? (
        <div style={s.emptyHint}>
          You're not in any circles yet. Use the menu above to create one or join via an invite link.
        </div>
      ) : (
        <button style={s.fab} onClick={() => setSheetOpen(true)}>
          Members ({memberCount}) · Places ({placeCount})
        </button>
      )}

      {selectedMember && memberSheetVisible && (
        <MemberDetailSheet
          member={selectedMember}
          presence={data.presence?.[selectedPubkey] ?? null}
          transitions={data.transitions}
          placesById={placesById}
          isSelf={selectedPubkey === myPubkey}
          onOpenTrips={() => {
            setMemberSheetVisible(false)
            setSheet({ name: 'trips' })
          }}
          onClose={() => setMemberSheetVisible(false)}
        />
      )}

      {sheetOpen && (
        <BottomSheet onClose={() => setSheetOpen(false)}>
          <h3 style={s.h3}>Members ({memberCount})</h3>
          {memberCount === 0 ? (
            <p style={s.muted}>No members visible yet. Waiting for sync...</p>
          ) : (
            <ul style={s.memberList}>
              {data.members.map(m => {
                const pubkey = m.value?.pubkey ?? ''
                const seen = data.lastSeen?.[pubkey]
                const pres = data.presence?.[pubkey]
                const isPaused = effectivePresenceMuted(pres) && pubkey !== myPubkey
                const t = latestTransition?.[pubkey]
                const tPlaceName = t ? placesById?.[t.placeId]?.name : null
                return (
                  <MemberRow
                    key={m.key}
                    member={m}
                    seen={seen}
                    isPaused={isPaused}
                    transition={t}
                    transitionPlaceName={tPlaceName}
                    onFocus={focusMember}
                  />
                )
              })}
            </ul>
          )}

          <h3 style={s.h3}>Places ({placeCount})</h3>
          {placeCount === 0 ? (
            <p style={s.muted}>No places yet.</p>
          ) : (
            <ul style={s.memberList}>
              {data.places.map(p => {
                const placeCircle = circles.find(c => c.circleId === p.circleId)
                const placeWritable = !!placeCircle?.writable
                const muteKey = p.circleId + ':' + p.id
                const isMuted = mutedPlaces.has(muteKey)
                const isDeleting = deletingPlaceId === p.id
                const focusOn = (e) => {
                  // Don't trigger if a debug button inside the row was tapped.
                  if (e.target.closest('button')) return
                  // Imperative call: avoids any state-batching weirdness
                  // around the same-render BottomSheet unmount.
                  mapApiRef.current?.flyTo({
                    center: [p.lon, p.lat], zoom: 16, duration: 1100,
                  })
                  setSheetOpen(false)
                }
                return (
                  <li key={p.circleId + ':' + p.id} style={{ ...s.memberItem, cursor: 'pointer' }} onClick={focusOn}>
                    <div style={s.placeRowHeader}>
                      <div style={s.memberName}>{p.name}</div>
                      <div style={s.placeRowActions}>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleMute(p) }}
                          title={isMuted ? 'Unmute notifications' : 'Mute notifications'}
                          aria-label={isMuted ? 'Unmute notifications' : 'Mute notifications'}
                          style={{
                            ...iconBtnStyle({ disabled: false }),
                            color: isMuted ? '#fc9' : colors.text.secondary,
                            borderColor: isMuted ? '#5a3f1f' : colors.border,
                            background: isMuted ? '#3a2a14' : 'transparent',
                          }}>
                          {isMuted
                            ? <BellSimpleSlash size={18} weight="regular" />
                            : <BellSimple size={18} weight="regular" />}
                        </button>
                        {placeWritable && (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditingPlace({
                                  circleId: p.circleId,
                                  id: p.id,
                                  name: p.name,
                                  radiusMeters: p.radiusMeters,
                                })
                                setShowAddPlace(false)
                                setConfirmingDeletePlace(null)
                              }}
                              disabled={isDeleting}
                              title="Edit place"
                              aria-label="Edit place"
                              style={iconBtnStyle({ disabled: isDeleting })}>
                              <PencilSimple size={18} weight="regular" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmingDeletePlace(p) }}
                              disabled={isDeleting}
                              title="Delete place"
                              aria-label="Delete place"
                              style={iconBtnStyle({ disabled: isDeleting, destructive: true })}>
                              <Trash size={18} weight="regular" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div style={s.placeRadiusLine}>{Math.round(p.radiusMeters)}m radius</div>
                    {placeWritable && (
                      <div style={s.transitionBtns}>
                        <button style={s.smallBtn} onClick={() => fireTransition(p, 'enter')}>
                          Fire enter (debug)
                        </button>
                        <button style={s.smallBtn} onClick={() => fireTransition(p, 'exit')}>
                          Fire exit (debug)
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {transitionError && <p style={s.error}>{transitionError}</p>}
          {deleteError && <p style={s.error}>{deleteError}</p>}

          {editingPlace && (
            <EditPlaceForm
              key={editingPlace.circleId + ':' + editingPlace.id}
              initial={editingPlace}
              onCancel={() => setEditingPlace(null)}
              onSaved={async () => { setEditingPlace(null); await refresh() }}
            />
          )}
          {!editingPlace && writableCircles.length > 0 && showAddPlace && (
            <AddPlaceForm
              key={pendingPlaceCoords ? `lp:${pendingPlaceCoords.lat}:${pendingPlaceCoords.lon}` : 'manual'}
              circles={writableCircles}
              myLastSeen={myPubkey ? data.lastSeen?.[myPubkey] : null}
              initialCoords={pendingPlaceCoords}
              onCancel={() => { setShowAddPlace(false); setPendingPlaceCoords(null) }}
              onAdded={async () => { setShowAddPlace(false); setPendingPlaceCoords(null); await refresh() }}
            />
          )}
          {actionTargetCircleId && !actionTargetWritable && (
            <p style={s.muted}>Read-only until owner adds you as a writer.</p>
          )}
          {confirmingDeletePlace && (
            <ConfirmSheet
              title="Delete place?"
              message={<>Delete <strong>{confirmingDeletePlace.name}</strong>? Members will stop getting notifications about arrivals at and departures from this place. This cannot be undone.</>}
              confirmLabel="Delete"
              destructive
              busy={deletingPlaceId === confirmingDeletePlace.id}
              onConfirm={() => deletePlace(confirmingDeletePlace)}
              onClose={() => { if (deletingPlaceId !== confirmingDeletePlace.id) setConfirmingDeletePlace(null) }}
            />
          )}
        </BottomSheet>
      )}
    </div>
  )
}

function EditPlaceForm ({ initial, onCancel, onSaved }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [radius, setRadius] = useState(initial?.radiusMeters != null ? String(initial.radiusMeters) : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setError(null)
    const radNum = parseFloat(radius)
    if (!name.trim()) { setError('Name is required'); return }
    if (!Number.isFinite(radNum) || radNum < 10 || radNum > 10000) { setError('Radius must be between 10 and 10000 metres'); return }
    setSubmitting(true)
    try {
      const r = await pear.call('place:update', {
        circleId: initial.circleId,
        placeId: initial.id,
        name: name.trim(),
        radiusMeters: radNum,
      })
      setSubmitting(false)
      if (r?.ok) onSaved()
      else setError('Could not save place')
    } catch (e) {
      setSubmitting(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.section}>
      <h3 style={{ ...s.h3, margin: '0 0 8px 0' }}>Edit place</h3>
      <label style={s.label}>Name</label>
      <input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='Home' maxLength={64} autoFocus />
      <label style={s.label}>Radius (metres)</label>
      <input style={s.input} value={radius} onChange={(e) => setRadius(e.target.value)} inputMode='numeric' placeholder='100' />
      <button style={s.primaryBtn} disabled={submitting} onClick={submit}>
        {submitting ? 'Saving...' : 'Save changes'}
      </button>
      <button style={s.secondaryBtn} onClick={onCancel}>Cancel</button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

function AddPlaceForm ({ circles, myLastSeen, initialCoords, onCancel, onAdded }) {
  // Coords are picked by the map: either explicit (long-press on a
  // spot) or implicit (the user's current location). Typing lat/lon
  // is gone — the map is the canonical way to pick where a place
  // lives.
  const coords = initialCoords ?? (
    myLastSeen?.lat != null && myLastSeen?.lon != null
      ? { lat: myLastSeen.lat, lon: myLastSeen.lon, source: 'current' }
      : null
  )
  // Target circle: when the user has exactly one writable circle in
  // scope we auto-pick it; otherwise they choose from the list.
  // `circles` is non-empty when this form is shown (gated upstream).
  const [targetCircleId, setTargetCircleId] = useState(
    circles.length === 1 ? circles[0].circleId : null,
  )
  const [name, setName] = useState('')
  const [radius, setRadius] = useState('100')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setError(null)
    if (!targetCircleId) {
      setError('Pick which circle the place belongs to.')
      return
    }
    if (!coords) {
      setError('No location picked. Long-press the map or wait for your current location.')
      return
    }
    const radNum = parseFloat(radius)
    if (!name.trim()) { setError('Name is required'); return }
    if (!Number.isFinite(radNum) || radNum < 10 || radNum > 10000) { setError('Radius must be between 10 and 10000 metres'); return }
    setSubmitting(true)
    try {
      const r = await pear.call('place:create', {
        circleId: targetCircleId,
        name: name.trim(),
        lat: coords.lat,
        lon: coords.lon,
        radiusMeters: radNum,
      })
      setSubmitting(false)
      if (r?.ok) onAdded()
      else setError('Could not save place')
    } catch (e) {
      setSubmitting(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.section}>
      {!coords && (
        <div style={s.coordsMissing}>
          Long-press the map to pick a spot, or wait for your current location.
        </div>
      )}
      {circles.length > 1 && (
        <>
          <label style={s.label}>Add to circle</label>
          <div style={s.durationRow}>
            {circles.map(c => (
              <button
                key={c.circleId}
                style={{
                  ...s.durationBtn,
                  ...(targetCircleId === c.circleId
                    ? { background: '#243237', color: '#7ec4cf', borderColor: '#7ec4cf' }
                    : null),
                }}
                onClick={() => setTargetCircleId(c.circleId)}
              >
                {c.circle?.name ?? '...'}
              </button>
            ))}
          </div>
        </>
      )}
      <label style={s.label}>Name</label>
      <input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='Home' maxLength={64} autoFocus />
      <label style={s.label}>Radius (metres)</label>
      <input style={s.input} value={radius} onChange={(e) => setRadius(e.target.value)} inputMode='numeric' placeholder='100' />
      <button style={s.primaryBtn} disabled={submitting || !coords || !targetCircleId} onClick={submit}>
        {submitting ? 'Saving...' : 'Save place'}
      </button>
      <button style={s.secondaryBtn} onClick={onCancel}>Cancel</button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

// Reverse-geocode a lat/lon to a "road, locality" label via the
// public Nominatim (OpenStreetMap) endpoint. Used to add a "near X"
// hint to member rows when there's no recent Place transition to show.
//
// Privacy note: each unique 4-decimal-place coordinate (~11m grid) is
// queried once per session via plain HTTPS to nominatim.openstreetmap.org.
// That host learns the rough position of any visible member when the
// user opens the bottom sheet. The map tile host already learns the
// user's viewport; this is a strictly smaller leak (specific points
// vs. tile tiles around them). No coordinates are persisted or logged
// beyond the in-memory cache that lives for the lifetime of the
// process. If we want stricter privacy later, swap this to a
// self-hosted Nominatim, run it through the bare worklet, or drop the
// feature.
//
// Usage policy: Nominatim allows ~1 req/sec for shared use. We
// serialize lookups through a single global queue and pace them at
// 1.1s. Repeat lookups for the same grid cell short-circuit on cache.
const _geocodeCache = new Map()    // key → label (string|null) once resolved
const _geocodeWaiters = new Map()  // key → array of (label) callbacks
let _geocodeBusy = false

function geocodeKey (lat, lon) {
  return Math.round(lat * 10000) / 10000 + ':' + Math.round(lon * 10000) / 10000
}

async function processGeocodeQueue () {
  if (_geocodeBusy) return
  let nextKey = null
  for (const k of _geocodeWaiters.keys()) {
    if (!_geocodeCache.has(k)) { nextKey = k; break }
  }
  if (nextKey == null) return
  _geocodeBusy = true
  const [lat, lon] = nextKey.split(':').map(parseFloat)
  let label = null
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=' + lat + '&lon=' + lon
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (r.ok) {
      const data = await r.json()
      const a = data?.address ?? {}
      const road = a.road || a.pedestrian || a.footway
      const where = a.suburb || a.neighbourhood || a.city || a.town || a.village || a.hamlet
      label = [road, where].filter(Boolean).join(', ') || null
    }
  } catch {}
  _geocodeCache.set(nextKey, label)
  const waiters = _geocodeWaiters.get(nextKey) || []
  _geocodeWaiters.delete(nextKey)
  for (const cb of waiters) {
    try { cb(label) } catch {}
  }
  setTimeout(() => { _geocodeBusy = false; processGeocodeQueue() }, 1100)
}

// Per-member memo of (last lat/lon we fetched for this member, the
// label we got back). Hysteresis: as long as the member's current
// position is within HYSTERESIS_M of the memoized point, we keep
// showing the memoized label even when fresh lastSeen rows arrive
// with slightly different coords. Without this, GPS jitter at the
// 5-30s update cadence flips the displayed label between nearby
// suburbs/streets that Nominatim resolves differently.
const _memberGeocodeMemo = new Map() // pubkey → { lat, lon, label }
const HYSTERESIS_M = 100

function useReverseGeocodeForMember (pubkey, lat, lon, enabled) {
  const [label, setLabel] = useState(() => _memberGeocodeMemo.get(pubkey)?.label ?? null)
  useEffect(() => {
    if (!enabled) return
    if (!pubkey || typeof lat !== 'number' || typeof lon !== 'number') return
    const memo = _memberGeocodeMemo.get(pubkey)
    if (memo && haversineMeters(memo.lat, memo.lon, lat, lon) < HYSTERESIS_M) {
      // Stay with the memoized label — they haven't actually moved.
      setLabel(memo.label)
      return
    }
    const key = geocodeKey(lat, lon)
    const onResult = (newLabel) => {
      _memberGeocodeMemo.set(pubkey, { lat, lon, label: newLabel })
      setLabel(newLabel)
    }
    if (_geocodeCache.has(key)) {
      onResult(_geocodeCache.get(key))
      return
    }
    const list = _geocodeWaiters.get(key) || []
    list.push(onResult)
    _geocodeWaiters.set(key, list)
    processGeocodeQueue()
    return () => {
      const cur = _geocodeWaiters.get(key)
      if (!cur) return
      const idx = cur.indexOf(onResult)
      if (idx >= 0) cur.splice(idx, 1)
      if (cur.length === 0) _geocodeWaiters.delete(key)
    }
  }, [pubkey, lat, lon, enabled])
  return enabled ? label : null
}

// A presence row with state==='muted' is only effectively muted
// while expiresAt is in the future (or absent — meaning indefinite).
// An expired mute reads as visible: the writing peer's app may have
// died before they could append the resume row themselves, so the
// reader handles the rollover. Proposal §3 / §4: "until expiresAt
// passes or the user toggles back to visible".
function effectivePresenceMuted (pres, now = Date.now()) {
  if (!pres || pres.state !== 'muted') return false
  if (typeof pres.expiresAt !== 'number') return true
  return pres.expiresAt > now
}

// Earth-distance haversine in metres. Used by the marker tween logic
// to decide animate-vs-snap on each lastSeen update.
function haversineMeters (lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = (d) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// Tween parameters for marker movement between consecutive lastSeen
// updates. TWEEN_MS is the animation duration; TWEEN_MAX_METERS is the
// distance threshold above which we snap rather than animate (a multi-
// kilometre teleport at 700ms looks worse than the snap, and almost
// always means GPS resync after a tunnel or a debug-button warp, not a
// real movement worth visualizing).
const TWEEN_MS = 700
const TWEEN_MAX_METERS = 500

// Approximate a geofence circle as a 64-vertex polygon in lat/lon space.
// Earth-as-sphere math is fine for radii up to a few km; the polygon
// would distort visibly at very high latitudes, but PearCircle places
// are home/work/park sized, not continental.
function circlePolygon (lat, lon, radiusMeters, steps = 64) {
  const dLat = radiusMeters / 111320
  const dLon = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180))
  const ring = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    ring.push([lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)])
  }
  ring.push(ring[0])
  return ring
}

const CircleMap = React.forwardRef(function CircleMap (
  { data, selectedPubkey, connectedPubkeys, myPubkey, tileStyleUrl, onMemberClick, onLongPress },
  apiRef,
) {
  // Initial style at mount time. We can't read this from a ref/prop on
  // every map instantiation (the map mounts once), so we pin it to the
  // value at first render and rely on the dedicated setStyle effect
  // below to swap on subsequent edits.
  const initialStyleRef = useRef(tileStyleUrl || DEFAULT_TILE_STYLE_URL)
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const fittedRef = useRef(false)
  const dataRef = useRef(data)
  const onMemberClickRef = useRef(onMemberClick)
  const onLongPressRef = useRef(onLongPress)
  // Per-pubkey marker state: { marker, lng, lat, anim? }. lng/lat is
  // the position the marker is currently displayed at (mid-tween or
  // settled). anim is { start, duration, fromLng, fromLat, toLng,
  // toLat } while a tween is running, null when settled.
  const markerStatesRef = useRef(new Map())
  const rafRef = useRef(null)
  const [mapReadyTick, setMapReadyTick] = useState(0)

  // Keep refs current so the layer click handler (registered once on
  // load) and the imperative fitAll always see the latest props.
  useEffect(() => { onMemberClickRef.current = onMemberClick }, [onMemberClick])
  useEffect(() => { onLongPressRef.current = onLongPress }, [onLongPress])
  useEffect(() => { dataRef.current = data }, [data])

  // Expose imperative flyTo/panTo/fitAll to the parent. Direct camera
  // moves avoid state/effect round-trips that could be batched or
  // dropped.
  React.useImperativeHandle(apiRef, () => ({
    flyTo: (opts) => {
      const m = mapRef.current
      if (!m) return
      // Reset bearing/pitch on every auto-camera move so the user
      // always lands north-up after focusing a member or place. The
      // spread lets callers override if a future feature wants to
      // preserve the current orientation.
      const full = { bearing: 0, pitch: 0, ...opts }
      try { m.flyTo(full) } catch { try { m.jumpTo({ center: full.center, zoom: full.zoom, bearing: 0, pitch: 0 }) } catch {} }
    },
    panTo: (coords, opts) => {
      const m = mapRef.current
      if (!m) return
      try { m.panTo(coords, { duration: 600, ...opts }) } catch {}
    },
    fitAll: () => {
      const m = mapRef.current
      const d = dataRef.current
      if (!m || !d) return
      const coords = []
      for (const mem of d.members ?? []) {
        const pubkey = mem.value?.pubkey
        const seen = pubkey ? d.lastSeen?.[pubkey] : null
        if (seen) coords.push([seen.lon, seen.lat])
      }
      if (coords.length > 0) fitTo(m, coords)
      else if (d.places?.length > 0) fitTo(m, d.places.map(p => [p.lon, p.lat]))
    },
    // Used by the two-stage pin tap (App.onPinTap): when the user taps a
    // pin or edge indicator for an already-focused member, we check
    // whether the member is currently visible. If yes, the second tap
    // opens the detail sheet; if no (user panned/zoomed away), we
    // recenter first and the detail sheet only opens on a follow-up tap.
    isInView: ([lng, lat]) => {
      const m = mapRef.current
      if (!m || !Number.isFinite(lng) || !Number.isFinite(lat)) return false
      try { return m.getBounds().contains([lng, lat]) } catch { return false }
    },
  }), [])

  // Single rAF loop driving all in-flight marker tweens. Started
  // lazily by ensureRaf when a new tween is scheduled; stops itself
  // when no animations remain so we don't burn frames at idle.
  const ensureRaf = useCallback(() => {
    if (rafRef.current != null) return
    const tick = () => {
      const now = performance.now()
      let stillAnimating = false
      for (const state of markerStatesRef.current.values()) {
        if (!state.anim) continue
        const t = Math.min(1, (now - state.anim.start) / state.anim.duration)
        const lng = state.anim.fromLng + (state.anim.toLng - state.anim.fromLng) * t
        const lat = state.anim.fromLat + (state.anim.toLat - state.anim.fromLat) * t
        state.marker.setLngLat([lng, lat])
        state.lng = lng
        state.lat = lat
        if (t >= 1) state.anim = null
        else stillAnimating = true
      }
      rafRef.current = stillAnimating ? requestAnimationFrame(tick) : null
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // One-time map init. Sources/layers are added on the 'load' event so
  // setData calls in the data-sync effect below always find them.
  useEffect(() => {
    ensureMapLibreCss()
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initialStyleRef.current,
      center: [0, 0],
      zoom: 1.5,
      attributionControl: false,
    })
    mapRef.current = map

    map.on('load', () => {
      map.addSource('places', { type: 'geojson', data: emptyFC() })
      // Place geofences only render at neighborhood-or-closer zoom.
      // Below that, a fixed-size pin is much larger than the place's
      // pixel radius, which made the pin look like it had drifted
      // outside the place. Fading the geofence out keeps the pin (the
      // persistent "where is X" indicator) the only thing the user
      // sees at city/country zoom; the geofence reappears as you zoom
      // back in to street level.
      map.addLayer({
        id: 'places-fill', type: 'fill', source: 'places',
        paint: {
          'fill-color': '#7ec4cf',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 14, 0.18],
        },
      })
      map.addLayer({
        id: 'places-stroke', type: 'line', source: 'places',
        paint: {
          'line-color': '#7ec4cf',
          'line-width': 2,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 14, 1],
        },
      })
      // Member pins are HTML markers (pear bubbles with avatar inside),
      // managed in the data-sync effect below. Markers handle their own
      // click events.
      //
      // Long-press detection: maplibre's `contextmenu` event isn't
      // reliable in Android/iOS WebView (the OS-level long-press menu
      // for text selection often preempts it, fires haptic feedback,
      // and swallows the contextmenu event). We track touchstart +
      // touchmove + touchend ourselves with a 500ms timer that
      // cancels on movement > 10px or release. unproject() converts
      // the touch point to lng/lat at the moment the timer fires.
      const canvas = map.getCanvas()
      // -webkit-touch-callout: none suppresses the iOS/Android
      // long-press callout on the canvas so the WebView doesn't fight
      // for the gesture.
      canvas.style.webkitTouchCallout = 'none'
      let pressState = null
      const clearPress = () => {
        if (pressState?.timer) clearTimeout(pressState.timer)
        pressState = null
      }
      const onTouchStart = (e) => {
        if (e.touches.length !== 1) { clearPress(); return }
        const t = e.touches[0]
        const rect = canvas.getBoundingClientRect()
        const x = t.clientX - rect.left
        const y = t.clientY - rect.top
        pressState = {
          x, y,
          timer: setTimeout(() => {
            try {
              const ll = map.unproject([x, y])
              onLongPressRef.current?.([ll.lng, ll.lat])
            } catch {}
            pressState = null
          }, 500),
        }
      }
      const onTouchMove = (e) => {
        if (!pressState) return
        if (e.touches.length !== 1) { clearPress(); return }
        const t = e.touches[0]
        const rect = canvas.getBoundingClientRect()
        const dx = (t.clientX - rect.left) - pressState.x
        const dy = (t.clientY - rect.top) - pressState.y
        if (Math.hypot(dx, dy) > 10) clearPress()
      }
      canvas.addEventListener('touchstart', onTouchStart, { passive: true })
      canvas.addEventListener('touchmove', onTouchMove, { passive: true })
      canvas.addEventListener('touchend', clearPress, { passive: true })
      canvas.addEventListener('touchcancel', clearPress, { passive: true })

      setMapReadyTick(t => t + 1)
    })

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      for (const state of markerStatesRef.current.values()) state.marker.remove()
      markerStatesRef.current.clear()
      map.remove()
    }
  }, [])

  // Hot-swap the MapLibre style when the user changes the tile-provider
  // override in Settings. Skips on mount (the initial style is set in
  // the map constructor) and any time the URL didn't actually change.
  // setStyle clears layers/sources from the previous style, so the data-
  // sync effect below re-runs on the next style-load to repopulate the
  // place rings, member markers, etc.
  useEffect(() => {
    const map = mapRef.current
    const want = tileStyleUrl || DEFAULT_TILE_STYLE_URL
    if (!map || want === initialStyleRef.current) return
    initialStyleRef.current = want
    fittedRef.current = false // re-fit after the new style finishes loading
    try { map.setStyle(want) } catch (e) { console.warn('setStyle failed', e?.message) }
  }, [tileStyleUrl])

  // Sync features and member markers whenever data or selection
  // changes. Wait for the style to finish loading on the first call.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !data) return
    const apply = () => {
      syncFeatures(map, data, fittedRef)
      syncMembers(map, data, selectedPubkey, connectedPubkeys, myPubkey, markerStatesRef.current, onMemberClickRef, ensureRaf)
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [data, selectedPubkey, connectedPubkeys, myPubkey, ensureRaf])

  return (
    <div style={s.mapWrap}>
      <div ref={containerRef} style={s.mapCanvas} />
      <EdgeIndicators
        map={mapRef.current}
        ready={mapReadyTick > 0}
        members={data?.members ?? []}
        lastSeen={data?.lastSeen ?? {}}
        selectedPubkey={selectedPubkey}
        onSelect={onMemberClick}
      />
      <div style={s.mapAttribution}>© OpenStreetMap contributors</div>
    </div>
  )
})

// Off-screen members get a clamped avatar pinned to the viewport edge
// with a small arrow pointing outward in their direction. Subscribes to
// the map's move/zoom/resize events so positions track the camera.
// Top inset clears the floating top bar; bottom inset clears the FAB.
function EdgeIndicators ({ map, ready, members, lastSeen, selectedPubkey, onSelect }) {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!map || !ready) return
    const rerender = () => setTick(t => (t + 1) % 1_000_000)
    map.on('move', rerender)
    map.on('zoom', rerender)
    map.on('resize', rerender)
    rerender()
    return () => {
      map.off('move', rerender)
      map.off('zoom', rerender)
      map.off('resize', rerender)
    }
  }, [map, ready])

  if (!map || !ready) return null
  const canvas = map.getCanvas()
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return null

  // TOP/BOTTOM/SIDE define the rect the indicator gets *clamped* into when
  // shown, so it doesn't tuck under the focus bar / FABs. They are NOT
  // the on-screen test -- a pin can sit under the top bar and still be
  // mostly visible, and we don't want to double up with an indicator.
  // PIN_HALF covers the avatar (size/2 = 36 for selected) plus the motion
  // badge's ~9px overhang to the right; using one symmetric value is a
  // tiny over-correction on directions without overhang, which is fine.
  const TOP = 80
  const BOTTOM = 96
  const SIDE = 32
  const PIN_HALF = 40
  const cx = w / 2
  const cy = (TOP + (h - BOTTOM)) / 2
  const halfW = w / 2 - SIDE
  const halfH = (h - TOP - BOTTOM) / 2
  if (halfW <= 0 || halfH <= 0) return null

  const indicators = []
  for (const m of members) {
    const pubkey = m.value?.pubkey
    if (!pubkey) continue
    const seen = lastSeen?.[pubkey]
    if (!seen) continue
    let p
    try { p = map.project([seen.lon, seen.lat]) } catch { continue }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    // Only show the indicator once the pin's bounding box has fully
    // cleared the canvas in some direction. A pin whose center is even
    // 1px inside the screen still has 39px of avatar visible, so the
    // user can see it -- no indicator needed.
    const onScreen = p.x >= -PIN_HALF && p.x <= w + PIN_HALF
                  && p.y >= -PIN_HALF && p.y <= h + PIN_HALF
    if (onScreen) continue

    const dx = p.x - cx
    const dy = p.y - cy
    if (dx === 0 && dy === 0) continue
    const t = Math.min(halfW / Math.max(Math.abs(dx), 1e-6), halfH / Math.max(Math.abs(dy), 1e-6))
    const ex = cx + dx * t
    const ey = cy + dy * t
    const angle = Math.atan2(dy, dx) * 180 / Math.PI
    indicators.push({
      pubkey,
      name: m.value?.displayName ?? short(pubkey),
      avatar: m.value?.avatar,
      x: ex, y: ey, angle,
      selected: pubkey === selectedPubkey,
    })
  }

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
      {indicators.map(i => (
        <button
          key={i.pubkey}
          onClick={() => onSelect?.(i.pubkey)}
          style={{
            position: 'absolute',
            left: i.x - 22, top: i.y - 22,
            width: 44, height: 44,
            border: 'none', padding: 0, background: 'transparent',
            pointerEvents: 'auto', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label={'Focus ' + i.name}
        >
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            border: '2px solid ' + (i.selected ? '#7ec4cf' : '#fc7'),
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            background: '#1a1a1a',
            overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Avatar base64={i.avatar} label={i.name} size={28} />
          </div>
          <div style={{
            position: 'absolute',
            // Place the arrow's base (its transform-origin at local 0,5)
            // 18px from button center in the angle direction, so the
            // notch sits just outside the 32px avatar ring.
            left: 22 + Math.cos(i.angle * Math.PI / 180) * 18,
            top: 17 + Math.sin(i.angle * Math.PI / 180) * 18,
            width: 0, height: 0,
            borderLeft: '7px solid ' + (i.selected ? '#7ec4cf' : '#fc7'),
            borderTop: '5px solid transparent',
            borderBottom: '5px solid transparent',
            transform: `rotate(${i.angle}deg)`,
            transformOrigin: '0 5px',
          }} />
        </button>
      ))}
    </div>
  )
}

function emptyFC () {
  return { type: 'FeatureCollection', features: [] }
}

function syncFeatures (map, data, fittedRef) {
  const placeFeatures = (data.places ?? []).map(p => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [circlePolygon(p.lat, p.lon, p.radiusMeters)] },
    properties: { name: p.name },
  }))
  map.getSource('places')?.setData({ type: 'FeatureCollection', features: placeFeatures })

  if (fittedRef.current) return
  // Fit to where the people are. Including places in the bounds drags
  // the view to anywhere a stale or far-away test place was set; the
  // map should center on members so "where is everyone" is the default
  // glance. Users can pan to see distant places. If no members have a
  // location yet, fall back to places so we at least show something
  // useful instead of a globe view.
  const memberCoords = []
  for (const m of data.members ?? []) {
    const pubkey = m.value?.pubkey
    const seen = pubkey ? data.lastSeen?.[pubkey] : null
    if (seen) memberCoords.push([seen.lon, seen.lat])
  }
  if (memberCoords.length > 0) {
    fittedRef.current = true
    fitTo(map, memberCoords)
  } else if (data.places && data.places.length > 0) {
    fittedRef.current = true
    fitTo(map, data.places.map(p => [p.lon, p.lat]))
  }
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function buildBubbleElement (clickRef) {
  const root = document.createElement('div')
  // MapLibre owns the transform that places the marker at the
  // projected lat/lon (set on every move/zoom event). The element
  // must be position: absolute with top/left at the canvas-container
  // origin so the transform offsets from (0, 0). MapLibre's
  // .maplibregl-marker CSS class sets these, but explicit inline
  // styles guard against CSS-load timing (and also override anything
  // the WebView's user-agent sheet might inject for divs).
  root.style.position = 'absolute'
  root.style.top = '0'
  root.style.left = '0'
  root.style.cursor = 'pointer'
  root.style.userSelect = 'none'
  root.style.webkitUserSelect = 'none'
  root.addEventListener('click', (e) => {
    e.stopPropagation()
    const pk = root.dataset.pubkey
    if (pk) clickRef.current?.(pk)
  })
  return root
}

// Circular avatar badge anchored at the lat/lon. We tried a pear /
// speech-bubble silhouette via inline SVG, an SVG positioned absolute
// inside the marker, an SVG sitting in normal flow, and an SVG used
// as a CSS background-image data URL. Every form caused a
// zoom-dependent southward drift in MapLibre Marker positioning. A
// plain div with the same dimensions and no SVG positions correctly
// at every zoom, so we ship the bubble as a flat circular badge: the
// avatar is the location indicator, with a colored ring for contrast
// and a drop-shadow for depth. Selected state grows the badge and
// swaps to a cyan ring with a glow halo.
function renderBubble (root, member, selected, last, connected) {
  const pubkey = member.value?.pubkey ?? ''
  const size = selected ? 72 : 60
  const ring = selected ? 4 : 3
  // Selected state's ring is the rotating conic-gradient (rendered as a
  // sibling below). Non-selected uses a thin static dark border on the
  // avatar div for a clean edge against bright map tiles.
  const ringColor = '#1a1a1a'

  const avatar = member.value?.avatar
  const label = member.value?.displayName ?? '?'
  const src = avatarSrc(avatar)
  const inner = src
    ? `<img src="${escapeHtml(src)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" />`
    : `<div style="width:100%;height:100%;background:#2a3a3f;color:#cfe;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.42)}px;font-weight:400;font-family:${typography.fontFamily};">${escapeHtml(initialsFor(label))}</div>`

  // Battery overlay: small horizontal rectangle hanging just below the
  // bottom edge of the avatar circle. Pure DOM (no SVG) per the
  // renderBubble saga — SVG inside markers caused zoom-dependent drift.
  // Position is absolute so it doesn't affect the root's bounding box,
  // which is what MapLibre transforms; pointer-events: none keeps the
  // whole marker click-target the avatar.
  const batt = (typeof last?.battery === 'number' && last.battery >= 0 && last.battery <= 100)
    ? Math.round(last.battery) : null
  const battColor = batt == null ? null : (batt < 20 ? '#e57373' : batt < 50 ? '#ffb74d' : '#81c784')
  const battHtml = batt == null ? '' : (
    `<div style="position:absolute;z-index:2;bottom:-5px;left:50%;transform:translateX(-50%);width:30px;height:14px;background:#1a1a1a;border:1px solid #888;border-radius:3px;box-sizing:border-box;overflow:hidden;pointer-events:none;">` +
    `<div style="width:${batt}%;height:100%;background:${battColor};"></div>` +
    `</div>`
  )

  // Motion overlay: hand-illustrated sticker (walking shoe / car) inside
  // a dark circular badge anchored at the top-right of the avatar. Dark
  // backdrop boosts the cyan strokes against bright map tiles. Plain DOM
  // (no SVG — renderBubble saga). Subtle pulse keyframe (defined once at
  // module load) reads as breathing motion since the sticker itself is
  // static. "Still" renders nothing so resting members don't get a glyph
  // cluttering the pin.
  const motion = motionState(last?.speed)
  // Walking / driving have hand-drawn PNG stickers; flying uses a plain
  // unicode airplane glyph (no PNG asset yet, and SVG inside markers is
  // off-limits per the renderBubble saga). Still renders nothing.
  const motionUrl = motion === 'walking' ? motionWalkingUrl
                  : motion === 'driving' ? motionDrivingUrl
                  : null
  // Negative animation-delay aligns the pulse to wall-clock so it stays
  // in phase across the periodic innerHTML rewrites in syncMembers
  // (otherwise the animation restarts at 0% every refresh and looks choppy).
  // Same trick is applied to the focus-ring spin below.
  const pulseDelay = -((Date.now() % 1600) / 1000)
  const spinDelay = -((Date.now() % 2400) / 1000)
  const motionInner = motionUrl != null
    ? `<img src="${motionUrl}" alt="" style="width:27px;height:auto;display:block;" />`
    : motion === 'flying'
      ? `<span style="font-size:22px;line-height:1;color:${colors.text.primary};font-family:${typography.fontFamily};">&#9992;</span>`
      : ''
  const motionHtml = motionInner === '' ? '' : (
    `<div style="position:absolute;z-index:2;top:-6px;right:-9px;width:36px;height:36px;background:#0f1417;border:1px solid #2a3338;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.5);pointer-events:none;animation:pearcircle-motion-pulse 1.6s ease-in-out infinite;animation-delay:${pulseDelay}s;transform-origin:center;">` +
    motionInner +
    `</div>`
  )

  // Root carries positioning and the drop-shadow; the inner div carries
  // the circular clip + ring border. This restructure lets the battery
  // badge overflow below without being clipped by the avatar's circle.
  root.dataset.pubkey = pubkey
  root.style.width = size + 'px'
  root.style.height = size + 'px'
  root.style.borderRadius = '0'
  root.style.overflow = 'visible'
  root.style.boxSizing = 'border-box'
  root.style.border = 'none'
  root.style.background = 'transparent'
  root.style.filter = selected
    ? 'drop-shadow(0 0 10px rgba(126,196,207,0.7)) drop-shadow(0 2px 4px rgba(0,0,0,0.4))'
    : 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))'
  // Rotating focus ring: only present when selected. Sits behind the
  // avatar as a positioned sibling (DOM-order first); inset:-${ring}px
  // makes it extend that many pixels beyond root, so only the ring band
  // around the avatar shows the gradient. The avatar itself doesn't
  // rotate because the spin animation is on the ring element only.
  // Conic distribution: a soft cyan blob occupying ~quarter of the
  // circumference, dark elsewhere, so the cyan reads as a moving
  // highlight rather than a full halo.
  const focusRingHtml = selected ? (
    `<div style="position:absolute;z-index:0;inset:-${ring}px;border-radius:50%;background:conic-gradient(from 0deg, #1a1a1a 0%, #7ec4cf 25%, #1a1a1a 50%, #1a1a1a 100%);animation:pearcircle-focus-spin 2.4s linear infinite;animation-delay:${spinDelay}s;pointer-events:none;"></div>`
  ) : ''

  // Avatar inner div: when selected, no internal border (the rotating
  // ring takes over the visual); when non-selected, the thin dark edge
  // keeps the pin readable on bright tiles.
  const avatarBorder = selected ? 'none' : `${ring}px solid ${ringColor}`

  // Connection-status dot at the top-left of the avatar. Green when the
  // peer is currently connected via Hyperswarm, grey when not. Suppressed
  // for self (connected === null) since the affordance is "are they
  // online" and you're always online to yourself. Top-left because the
  // motion glyph lives at top-right and the battery hangs below. Plain
  // DOM (no SVG) per the renderBubble saga.
  const onlineHtml = connected === null ? '' : (
    `<div style="position:absolute;z-index:3;top:-1px;left:-1px;width:14px;height:14px;border-radius:50%;background:${connected ? '#7ec77a' : '#666'};border:2px solid #0d0d0d;box-sizing:border-box;pointer-events:none;"></div>`
  )

  root.innerHTML =
    focusRingHtml +
    `<div style="position:relative;z-index:1;width:100%;height:100%;border-radius:50%;overflow:hidden;border:${avatarBorder};background:#fc7;box-sizing:border-box;">${inner}</div>` +
    battHtml +
    motionHtml +
    onlineHtml
}

function syncMembers (map, data, selectedPubkey, connectedPubkeys, myPubkey, states, clickRef, ensureRaf) {
  const seen = new Set()
  for (const m of data?.members ?? []) {
    const pubkey = m.value?.pubkey
    if (!pubkey) continue
    const last = data.lastSeen?.[pubkey]
    if (!last) continue
    seen.add(pubkey)

    let state = states.get(pubkey)
    if (!state) {
      const el = buildBubbleElement(clickRef)
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      marker.setLngLat([last.lon, last.lat]).addTo(map)
      state = { marker, lng: last.lon, lat: last.lat, anim: null }
      states.set(pubkey, state)
    } else {
      // Tween from where the marker currently sits (mid-animation
      // values are honored) to the new lastSeen. Distance-cap to
      // avoid weird teleport animations: a multi-kilometre jump is
      // almost always GPS resync after a tunnel or a debug warp, and
      // animating it across the map looks worse than the snap.
      const dist = haversineMeters(state.lat, state.lng, last.lat, last.lon)
      if (dist > TWEEN_MAX_METERS) {
        state.marker.setLngLat([last.lon, last.lat])
        state.lng = last.lon
        state.lat = last.lat
        state.anim = null
      } else if (dist > 0.5) {
        state.anim = {
          start: performance.now(),
          duration: TWEEN_MS,
          fromLng: state.lng,
          fromLat: state.lat,
          toLng: last.lon,
          toLat: last.lat,
        }
        ensureRaf()
      }
      // else: position unchanged within ~0.5m, skip the tween.
    }
    // null = self (no dot at all); true/false = remote member's link state
    const connected = pubkey === myPubkey ? null : !!connectedPubkeys?.has(pubkey)
    renderBubble(state.marker.getElement(), m, pubkey === selectedPubkey, last, connected)
  }

  for (const [pubkey, state] of states) {
    if (!seen.has(pubkey)) {
      state.marker.remove()
      states.delete(pubkey)
    }
  }
}

function fitTo (map, lonLatPairs) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const [lo, la] of lonLatPairs) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo
  }
  if (!isFinite(minLat)) return
  // Use flyTo for a Life360-style cinematic descent: camera arcs up,
  // glides over, and settles. cameraForBounds gives us the destination
  // center/zoom; passing those to flyTo (rather than fitBounds with
  // animate: true) lets us tune the curve for the arc effect. Bearing
  // and pitch are reset so the auto-fit always settles north-up.
  const opts = { duration: 1400, curve: 1.42, essential: true, bearing: 0, pitch: 0 }
  if (minLat === maxLat && minLon === maxLon) {
    map.flyTo({ center: [minLon, minLat], zoom: 14, ...opts })
    return
  }
  const cam = map.cameraForBounds(
    [[minLon, minLat], [maxLon, maxLat]],
    { padding: 60, maxZoom: 16, bearing: 0 },
  )
  if (cam) map.flyTo({ center: cam.center, zoom: cam.zoom, ...opts })
}

// Circles section in Settings. Lists every circle the user is in,
// surfaces the user's role (owner/member), and offers per-circle
// rename (owner), delete (owner), and leave (non-owner) actions.
// Buttons are icon affordances; destructive actions (delete, leave)
// route through a ConfirmSheet rather than a two-tap prime so the
// user has a moment to read what they're about to do (and what it
// affects). Rename keeps its inline-edit mode, just triggered by
// the pencil icon. Calls circle:delete / circle:leave / circle:rename
// IPCs (proposal 2026-05-07); success drops the row locally and fires
// onChanged so the home view's circles:getAll poll picks up the rest.
function CirclesSection ({ active = true, onChanged }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmingFor, setConfirmingFor] = useState(null) // circle object pending confirm
  const [pending, setPending] = useState(null)             // circleId with in-flight IPC
  const [error, setError] = useState(null)
  // Rename state: which circle is being edited, its draft name, and a
  // saving flag. Single edit at a time keeps the row layout simple.
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [savingRename, setSavingRename] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [id, snap] = await Promise.all([
        pear.call('identity:get'),
        pear.call('circles:getAll'),
      ])
      const ourKey = id?.publicKey ?? ''
      const next = (snap?.circles ?? [])
        .filter(c => !c.error && !c.circle?.deleted)
        .map(c => ({
          circleId: c.circleId,
          name: c.circle?.name ?? '...',
          isOwner: c.circle?.ownerKey === ourKey,
          memberCount: (c.members ?? []).length,
        }))
      setList(next)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Refresh on activation (sheet opens) so renames / leaves / new joins
  // since the previous open are visible. Plus a slow poll while active
  // so peer-side renames during a session also land. SheetContainer
  // keeps this component mounted across opens, so without an explicit
  // active signal the data would freeze at first-mount.
  useEffect(() => {
    if (!active) return
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [active, refresh])

  const performAction = async (c) => {
    setPending(c.circleId)
    setError(null)
    try {
      const ipc = c.isOwner ? 'circle:delete' : 'circle:leave'
      const r = await pear.call(ipc, { circleId: c.circleId })
      if (!r?.ok) throw new Error('Could not ' + (c.isOwner ? 'delete' : 'leave') + ' circle')
      setList(prev => prev.filter(x => x.circleId !== c.circleId))
      setConfirmingFor(null)
      onChanged?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setPending(null)
    }
  }

  const startRename = (c) => {
    setEditingId(c.circleId)
    setEditName(c.name)
    setError(null)
  }
  const cancelRename = () => {
    setEditingId(null)
    setEditName('')
  }
  const saveRename = async () => {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) return
    setSavingRename(true)
    setError(null)
    try {
      const r = await pear.call('circle:rename', { circleId: editingId, name: trimmed })
      const finalName = r?.name || trimmed
      setList(prev => prev.map(x => x.circleId === editingId ? { ...x, name: finalName } : x))
      setEditingId(null)
      setEditName('')
      onChanged?.()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingRename(false)
    }
  }

  if (loading || list.length === 0) return null

  return (
    <>
      <h2 style={s.h2}>Circles</h2>
      <p style={s.muted}>
        Delete a circle you own to remove it for everyone. Leave a circle to remove only your copy.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: `${spacing.sm}px 0 0 0` }}>
        {list.map(c => {
          const isPending = pending === c.circleId
          const isEditing = editingId === c.circleId
          if (isEditing) {
            // Edit mode: input replaces name + count column; Save / Cancel
            // replace the action button. Disabled while saving so a
            // double-tap doesn't fire two renames.
            const canSave = !!editName.trim() && editName.trim() !== c.name && !savingRename
            return (
              <li key={c.circleId} style={{
                display: 'flex', alignItems: 'center', gap: spacing.sm,
                padding: `${spacing.sm}px 0`,
                borderBottom: `1px solid ${colors.divider}`,
              }}>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={64}
                  disabled={savingRename}
                  style={{
                    flex: 1, minWidth: 0,
                    padding: `${spacing.xs + 2}px ${spacing.sm}px`,
                    background: colors.surface.input,
                    color: colors.text.primary,
                    border: `1px solid ${colors.border}`,
                    borderRadius: radius.md,
                    fontFamily: typography.fontFamily, fontSize: 14,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={saveRename}
                  disabled={!canSave}
                  style={{
                    padding: '8px 14px', borderRadius: radius.md,
                    background: canSave ? colors.accent : 'transparent',
                    color: canSave ? colors.text.onPrimary : colors.text.muted,
                    border: `1px solid ${canSave ? colors.accent : colors.border}`,
                    cursor: canSave ? 'pointer' : 'default',
                    fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400,
                    whiteSpace: 'nowrap',
                  }}>
                  {savingRename ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={cancelRename}
                  disabled={savingRename}
                  style={{
                    padding: '8px 14px', borderRadius: radius.md,
                    background: 'transparent', color: colors.text.secondary,
                    border: `1px solid ${colors.border}`, cursor: 'pointer',
                    fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 300,
                    whiteSpace: 'nowrap',
                  }}>
                  Cancel
                </button>
              </li>
            )
          }
          return (
            <li key={c.circleId} style={{
              display: 'flex', alignItems: 'center', gap: spacing.sm,
              padding: `${spacing.sm}px 0`,
              borderBottom: `1px solid ${colors.divider}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...typography.body, color: colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                <div style={{ ...typography.caption, color: colors.text.secondary }}>
                  {c.isOwner ? 'You own this · ' : ''}{c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
                </div>
              </div>
              {c.isOwner && (
                <button
                  onClick={() => startRename(c)}
                  disabled={isPending}
                  title="Rename"
                  aria-label="Rename"
                  style={iconBtnStyle({ disabled: isPending })}>
                  <PencilSimple size={18} weight="regular" />
                </button>
              )}
              <button
                onClick={() => setConfirmingFor(c)}
                disabled={isPending}
                title={c.isOwner ? 'Delete circle' : 'Leave circle'}
                aria-label={c.isOwner ? 'Delete circle' : 'Leave circle'}
                style={iconBtnStyle({ disabled: isPending, destructive: true })}>
                {c.isOwner
                  ? <Trash size={18} weight="regular" />
                  : <SignOut size={18} weight="regular" />}
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p style={s.error}>{error}</p>}
      {confirmingFor && (
        <ConfirmSheet
          title={confirmingFor.isOwner ? 'Delete circle?' : 'Leave circle?'}
          message={confirmingFor.isOwner
            ? <>Delete <strong>{confirmingFor.name}</strong>? This removes the circle for everyone in it. This cannot be undone.</>
            : <>Leave <strong>{confirmingFor.name}</strong>? You will stop sharing with this circle. You can rejoin later if someone shares the invite again.</>}
          confirmLabel={confirmingFor.isOwner ? 'Delete' : 'Leave'}
          destructive
          busy={pending === confirmingFor.circleId}
          onConfirm={() => performAction(confirmingFor)}
          onClose={() => { if (pending !== confirmingFor.circleId) setConfirmingFor(null) }}
        />
      )}
    </>
  )
}

// Icon button styling shared by the Settings rows. 36x36 square,
// transparent fill with a subtle border, fades + flips cursor when
// disabled. Destructive variant tints the icon error-red; the border
// stays neutral so the row reads calm at rest (the loud confirmation
// happens in the sheet, not the row).
function iconBtnStyle ({ disabled = false, destructive = false } = {}) {
  return {
    width: 36, height: 36,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, borderRadius: radius.md,
    background: 'transparent',
    color: destructive ? colors.error : colors.text.secondary,
    border: `1px solid ${colors.border}`,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
}

function ProfileView ({ active = true, profile, sharing, setSharing, tileStyleUrl, setTileStyleUrl, distanceUnit = 'km', setDistanceUnit, onClose, onSaved }) {
  const [name, setName] = useState(profile?.displayName ?? '')
  const [editingName, setEditingName] = useState(false)
  // null = unchanged from server; '' = explicitly cleared; string = new value
  const [avatar, setAvatar] = useState(null)
  const [saving, setSaving] = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  const [sharingError, setSharingError] = useState(null)
  const [togglingSharing, setTogglingSharing] = useState(false)
  // Battery-optimization state. supported=null means we haven't
  // queried yet; supported=false means iOS / pre-Doze and the row
  // hides. exempt=true means the OS won't pause our foreground
  // service during idle.
  const [battery, setBattery] = useState({ supported: null, exempt: false })
  const [batteryError, setBatteryError] = useState(null)
  // Re-render once a second while a mute has an active expiresAt so
  // the countdown ticks. Stops once the expiry passes.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (sharing.enabled || !sharing.expiresAt) return
    const id = setInterval(() => setNowTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [sharing.enabled, sharing.expiresAt])
  const fileRef = useRef(null)

  // Query battery exemption on mount and on app:state=active so the
  // row updates after the user dismisses the system dialog without
  // the activity being torn down.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const r = await pear.call('shell:battery:isExempt')
        if (!cancelled) setBattery({ supported: !!r?.supported, exempt: !!r?.exempt })
      } catch {
        if (!cancelled) setBattery({ supported: false, exempt: false })
      }
    }
    refresh()
    pear.on('app:state', ({ state }) => { if (state === 'active') refresh() })
    return () => { cancelled = true }
  }, [])

  const requestBatteryExempt = async () => {
    setBatteryError(null)
    try {
      const r = await pear.call('shell:battery:requestExempt')
      if (!r?.ok) setBatteryError(r?.error ?? 'Could not open battery settings.')
    } catch (e) {
      setBatteryError(String(e?.message ?? e))
    }
  }

  const stopSharing = async (durationMs) => {
    setSharingError(null)
    setTogglingSharing(true)
    try {
      const expiresAt = typeof durationMs === 'number' ? Date.now() + durationMs : null
      await setSharing(false, expiresAt)
    } catch (e) {
      setSharingError(String(e?.message ?? e))
    }
    setTogglingSharing(false)
  }
  const resumeSharing = async () => {
    setSharingError(null)
    setTogglingSharing(true)
    try {
      await setSharing(true, null)
    } catch (e) {
      setSharingError(String(e?.message ?? e))
    }
    setTogglingSharing(false)
  }

  // Avatar saves immediately on pick or remove (PearCal flow). Local
  // `avatar` state holds the in-flight optimistic value until profile
  // refreshes; on success we clear it so the next render reads from
  // the server-side profile prop.
  const commitAvatar = async (value) => {
    setError(null)
    setPhotoSaving(true)
    setAvatar(value === null ? '' : value) // optimistic preview
    try {
      const r = await pear.call('profile:set', { displayName: profile?.displayName ?? name, avatar: value })
      if (r?.ok) {
        onSaved()
        setAvatar(null) // hand back to server-side profile prop
      } else {
        setError('Could not save photo')
        setAvatar(null)
      }
    } catch (e) {
      setError(String(e?.message ?? e))
      setAvatar(null)
    }
    setPhotoSaving(false)
  }

  const onPickFile = async (e) => {
    setError(null)
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    try {
      const dataUrl = await readFileDataUrl(file)
      const mime = file.type || ''
      const isAnimated = ANIMATED_MIMES.includes(mime)
      const cap = isAnimated ? AVATAR_ANIMATED_MAX_B64 : AVATAR_STATIC_MAX_B64
      const b64Len = dataUrlBase64Length(dataUrl)
      // For animated formats: store raw up to the larger budget so
      // GIF/WebP keep their frames. Canvas would flatten to a single
      // frame, so there's no useful fallback when oversized.
      if (isAnimated) {
        if (b64Len > cap) {
          setError('Animated avatar is too large. Try one under ~375KB.')
          return
        }
        await commitAvatar(dataUrl)
        return
      }
      // Static format: raw if it fits, else canvas-compress to JPEG.
      if (b64Len <= cap) {
        await commitAvatar(dataUrl)
        return
      }
      const compressed = await compressToAvatar(dataUrl)
      if (dataUrlBase64Length(compressed) > AVATAR_STATIC_MAX_B64) {
        setError('Image is still too large after compression. Try a different photo.')
        return
      }
      await commitAvatar(compressed)
    } catch (err) {
      setError('Could not load that image: ' + (err?.message ?? err))
    }
  }

  const removePhoto = () => commitAvatar(null)

  const saveName = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    setError(null)
    try {
      // Bare-side preserves existing avatar when the key is omitted.
      const r = await pear.call('profile:set', { displayName: trimmed })
      setSaving(false)
      if (r?.ok) {
        setSavedAt(Date.now())
        setEditingName(false)
        onSaved()
      } else {
        setError('Could not save name')
      }
    } catch (e) {
      setSaving(false)
      setError(String(e?.message ?? e))
    }
  }

  const previewBase64 = avatar !== null && avatar !== '' ? avatar : profile?.avatar
  const hasAvatar = typeof previewBase64 === 'string' && previewBase64.length > 0
  const displayName = profile?.displayName ?? '?'

  return (
    <div style={s.screen}>
      <BackBar onBack={onClose} title='Settings' />

      {/* Avatar header — centered, PearCal pattern. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xl }}>
        <div style={{
          width: 88, height: 88, borderRadius: radius.full,
          background: '#2a3a3f', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: photoSaving ? 0.5 : 1, transition: 'opacity 0.2s',
        }}>
          {hasAvatar ? (
            <img src={avatarSrc(previewBase64)} alt='avatar' style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ ...s.avatarFallback, fontSize: 36 }}>{initialsFor(displayName)}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: spacing.sm }}>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={photoSaving}
            style={{
              flex: 1, minWidth: 96,
              fontSize: 12, padding: `${spacing.xs + 1}px ${spacing.md + 2}px`,
              borderRadius: radius.md, border: `1px solid ${colors.border}`,
              background: 'transparent', color: colors.text.primary,
              cursor: 'pointer', fontWeight: 300, fontFamily: typography.fontFamily,
              opacity: photoSaving ? 0.5 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.xs + 1,
            }}>
            <ImageIcon size={14} weight='thin' /> Photo
          </button>
          {hasAvatar && (
            <button
              onClick={removePhoto}
              disabled={photoSaving}
              style={{
                flex: 1, minWidth: 96,
                fontSize: 12, padding: `${spacing.xs + 1}px ${spacing.md + 2}px`,
                borderRadius: radius.md, border: '1px solid #d45f7a',
                background: 'transparent', color: '#d45f7a',
                cursor: 'pointer', fontWeight: 300, fontFamily: typography.fontFamily,
                opacity: photoSaving ? 0.5 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type='file' accept='image/*' style={{ display: 'none' }} onChange={onPickFile} />

        {editingName ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            style={{
              fontSize: 18, fontWeight: 300, textAlign: 'center', background: 'transparent',
              fontFamily: typography.fontFamily, border: `1px solid ${colors.border}`,
              borderRadius: radius.md, padding: `${spacing.xs + 2}px ${spacing.md}px`,
              color: colors.text.primary, outline: 'none',
            }}
          />
        ) : (
          <span style={{ fontSize: 20, fontWeight: 300, color: colors.text.primary }}>{displayName}</span>
        )}
        <button
          onClick={editingName ? saveName : () => { setName(profile?.displayName ?? ''); setEditingName(true) }}
          disabled={saving || (editingName && !name.trim())}
          style={{
            fontSize: 13, padding: `${spacing.xs + 1}px ${spacing.base}px`,
            borderRadius: radius.md, border: `1px solid ${colors.border}`,
            background: 'transparent', color: colors.text.primary,
            cursor: 'pointer', fontWeight: 300, fontFamily: typography.fontFamily,
            opacity: saving ? 0.6 : 1,
          }}>
          {saving ? 'Saving...' : editingName ? 'Save Name' : 'Edit Name'}
        </button>
      </div>

      {savedAt && <p style={s.muted}>Saved. Members in your circles will see the new profile shortly.</p>}
      {error && <p style={s.error}>{error}</p>}

      <h2 style={s.h2}>Location sharing</h2>
      {sharing.enabled ? (
        <>
          <p style={s.muted}>
            Your location is being shared with the circles you're in.
          </p>
          <button style={s.dangerBtn} disabled={togglingSharing} onClick={() => stopSharing(null)}>
            {togglingSharing ? 'Stopping...' : 'Stop sharing'}
          </button>
          <p style={{ ...s.muted, marginTop: 16, marginBottom: 6 }}>Or pause briefly:</p>
          <div style={s.durationRow}>
            <button style={s.durationBtn} disabled={togglingSharing} onClick={() => stopSharing(15 * 60_000)}>15 min</button>
            <button style={s.durationBtn} disabled={togglingSharing} onClick={() => stopSharing(60 * 60_000)}>1 hour</button>
            <button style={s.durationBtn} disabled={togglingSharing} onClick={() => stopSharing(4 * 60 * 60_000)}>4 hours</button>
          </div>
        </>
      ) : (
        <>
          <p style={s.muted}>
            {sharing.expiresAt
              ? `Sharing paused. Resumes in ${formatRemaining(sharing.expiresAt - Date.now())}.`
              : 'Sharing is paused. Other members see your last known location until you resume.'}
          </p>
          <button style={s.primaryBtn} disabled={togglingSharing} onClick={resumeSharing}>
            {togglingSharing ? 'Resuming...' : 'Resume sharing'}
          </button>
        </>
      )}
      {sharingError && <p style={s.error}>{sharingError}</p>}

      <CirclesSection active={active} onChanged={onSaved} />

      {battery.supported && (
        <>
          <h2 style={s.h2}>Battery optimization</h2>
          {battery.exempt ? (
            <p style={s.muted}>
              Battery optimization is off for PearCircle. Location sharing
              should keep working through extended idle.
            </p>
          ) : (
            <>
              <p style={s.muted}>
                Battery optimization is on. Android may pause location sharing
                during long idle periods (overnight, in a meeting), so peers
                won't see your updates until your phone wakes. Disabling this
                for PearCircle keeps sharing reliable but uses slightly more
                battery.
              </p>
              <button style={s.secondaryBtn} onClick={requestBatteryExempt}>
                Disable battery optimization
              </button>
            </>
          )}
          {batteryError && <p style={s.error}>{batteryError}</p>}
        </>
      )}

      <TileStyleSection url={tileStyleUrl} onChange={setTileStyleUrl} />

      <DistanceUnitSection unit={distanceUnit} onChange={setDistanceUnit} />
    </div>
  )
}

function DistanceUnitSection ({ unit, onChange }) {
  const cur = unit === 'miles' ? 'miles' : 'km'
  const btn = (label, value) => (
    <button
      onClick={() => { if (cur !== value) onChange?.(value) }}
      style={{
        flex: 1, padding: '10px', borderRadius: radius.sm,
        background: cur === value ? colors.accent : 'transparent',
        color: cur === value ? colors.text.onPrimary : colors.text.primary,
        border: `1px solid ${cur === value ? colors.accent : colors.border}`,
        cursor: 'pointer',
        fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
      }}
    >
      {label}
    </button>
  )
  return (
    <>
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginTop: spacing.lg, marginBottom: spacing.sm }}>Distance unit</h2>
      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.sm }}>
        Used to display trip distances. Stored data is unchanged.
      </p>
      <div style={{ display: 'flex', gap: spacing.sm }}>
        {btn('Kilometers', 'km')}
        {btn('Miles', 'miles')}
      </div>
    </>
  )
}

// Map-tiles section in Settings. The default is OpenFreeMap; advanced
// users can paste any MapLibre style JSON URL (e.g. their own Protomaps
// or self-hosted server) and the map hot-swaps without a relaunch.
// Reset clears the override so we fall back to DEFAULT_TILE_STYLE_URL.
function TileStyleSection ({ url, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(url ?? '')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const isCustom = !!url && url !== DEFAULT_TILE_STYLE_URL

  const startEdit = () => {
    setDraft(url ?? DEFAULT_TILE_STYLE_URL)
    setError(null)
    setEditing(true)
  }
  const cancelEdit = () => {
    setEditing(false)
    setError(null)
  }
  const validate = (s) => {
    const t = (s ?? '').trim()
    if (!t) return 'URL is required'
    if (!/^https?:\/\//i.test(t)) return 'URL must start with http:// or https://'
    return null
  }
  const save = async () => {
    const err = validate(draft)
    if (err) { setError(err); return }
    setBusy(true)
    try {
      await onChange(draft.trim())
      setEditing(false)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      await onChange(null)
      setEditing(false)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 style={s.h2}>Map tiles</h2>
      <p style={s.muted}>
        The map fetches tile imagery from this MapLibre style URL.
        Default is OpenFreeMap, an OpenStreetMap-based service. Change
        this if the default is unavailable or you want to point at your
        own provider.
      </p>
      {!editing && (
        <>
          <div style={{
            ...typography.caption, color: colors.text.secondary,
            background: colors.surface.input,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            padding: `${spacing.sm}px ${spacing.md}px`,
            wordBreak: 'break-all',
            marginBottom: spacing.sm,
            fontFamily: typography.monoFamily,
          }}>
            {url || DEFAULT_TILE_STYLE_URL}
            {!isCustom && (
              <span style={{ color: colors.text.muted, marginLeft: spacing.xs }}>(default)</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: spacing.sm }}>
            <button style={{ ...s.secondaryBtn, marginTop: 0, boxSizing: 'border-box' }} onClick={startEdit}>
              Edit URL
            </button>
            {isCustom && (
              <button style={{ ...s.secondaryBtn, marginTop: 0, boxSizing: 'border-box' }} onClick={reset} disabled={busy}>
                Reset to default
              </button>
            )}
          </div>
        </>
      )}
      {editing && (
        <>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='https://...'
            spellCheck={false}
            autoCapitalize='off'
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: `${spacing.sm}px ${spacing.md}px`,
              background: colors.surface.input,
              color: colors.text.primary,
              border: `1px solid ${colors.border}`,
              borderRadius: radius.md,
              fontFamily: typography.monoFamily, fontSize: 13,
              outline: 'none',
              marginBottom: spacing.sm,
            }}
          />
          <div style={{ display: 'flex', gap: spacing.sm }}>
            <button style={{ ...s.primaryBtn, boxSizing: 'border-box' }} onClick={save} disabled={busy}>
              {busy ? 'Saving...' : 'Save'}
            </button>
            <button style={{ ...s.secondaryBtn, marginTop: 0, boxSizing: 'border-box' }} onClick={cancelEdit} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <p style={s.error}>{error}</p>}
    </>
  )
}

// AboutView mirrors PearGuard's AboutTab pattern: brand header, plain
// prose sections explaining the model, a couple of action buttons. No
// donation flow yet (PearCircle hasn't shipped to stores; can layer in
// later with the same iOS guideline 3.1.1 gating PearGuard uses).
function AboutView ({ onClose }) {
  const share = async () => {
    try {
      await pear.call('shell:share', {
        title: 'PearCircle',
        text: 'PearCircle - private peer-to-peer location sharing. No accounts, no servers, no subscriptions.\n\nhttps://peerloomllc.com/pearcircle/',
      })
    } catch {}
  }
  const sectionTitle = { ...typography.subheading, color: colors.text.primary, margin: `${spacing.lg}px 0 ${spacing.sm}px 0` }
  const body = { ...typography.body, color: colors.text.secondary, lineHeight: 1.6, margin: `0 0 ${spacing.md}px 0` }
  const card = {
    background: colors.surface.card,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.lg,
    padding: spacing.base,
    marginBottom: spacing.md,
  }
  return (
    <div style={s.screen}>
      <BackBar onBack={onClose} title='About' />

      <div style={{ ...card, textAlign: 'center', padding: spacing.xl }}>
        <div style={{ ...typography.display, color: colors.primary, fontWeight: 400, marginBottom: spacing.xs }}>PearCircle</div>
        <div style={{ ...typography.caption, color: colors.text.muted }}>Private. Peer-to-Peer. No Servers.</div>
      </div>

      <div style={card}>
        <h3 style={sectionTitle}>What this is</h3>
        <p style={body}>
          PearCircle is a peer-to-peer location-sharing app. You form
          private circles with people you trust, share live location, and
          get notified when someone arrives at or leaves a Place.
        </p>
        <p style={body}>
          There are no accounts, no servers, no subscriptions. Your circle's
          data lives on the devices in the circle and syncs directly between
          them over the internet or your local network.
        </p>
      </div>

      <div style={card}>
        <h3 style={sectionTitle}>How it works</h3>
        <p style={body}>
          PearCircle is built on the Holepunch P2P stack: each circle is an
          append-only log shared between members, replicated peer-to-peer
          via Hyperswarm. Membership is gated by signed invites; new members
          join by scanning a QR code or tapping a deep link.
        </p>
        <p style={body}>
          Location updates are signed by your device's key and replicated
          to other circle members. Geofence transitions ("arrived at Home",
          "left Work") are computed locally on each device.
        </p>
      </div>

      <div style={card}>
        <h3 style={sectionTitle}>Privacy</h3>
        <p style={body}>
          Because there are no servers, no third party sees your location
          or who's in your circles. Members of a circle see each other's
          shared location while sharing is on; toggle Stop sharing to pause
          broadcasting at any time. Place names are local to the circle.
        </p>
        <p style={body}>
          The "near X" labels in member rows use OpenStreetMap's Nominatim
          service to translate coordinates into place names. The coordinates
          you share with peers do not pass through any third party.
        </p>
      </div>

      <button style={s.secondaryBtn} onClick={share}>Share PearCircle</button>

      <p style={{ ...typography.micro, color: colors.text.muted, textAlign: 'center', marginTop: spacing.xl }}>
        Part of PeerLoom &middot; v0.1.0
      </p>
    </div>
  )
}

function formatRemaining (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'a moment'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return totalSec + 's'
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return totalMin + ' min'
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  return mins === 0 ? hours + 'h' : hours + 'h ' + mins + 'm'
}

// Two caps mirror PearGuard's pattern:
// - Static formats (JPEG/PNG that's not APNG): ~42KB after compression
//   to a 96x96 JPEG. Replication-cheap.
// - Animated formats (GIF, WebP that may be animated): up to ~500KB
//   stored raw to preserve animation, since canvas re-encoding would
//   flatten to a single frame.
// Bare's cap is the larger 500KB ceiling; the UI enforces the
// stricter per-format budget below.
const AVATAR_STATIC_MAX_B64 = 42000
const AVATAR_ANIMATED_MAX_B64 = 500_000
const ANIMATED_MIMES = ['image/gif', 'image/webp']
// Legacy name retained for the canvas compression helper that still
// targets the static cap.
const AVATAR_MAX_BASE64 = AVATAR_STATIC_MAX_B64

// The avatar field on member rows can be either:
// - A full data URL (`data:image/<mime>;base64,...`) — current format,
//   covers JPEG/PNG/GIF/WebP including animated GIF.
// - A raw base64 string — legacy v1 format, treated as JPEG.
// avatarSrc returns whatever can go into an <img src=>.
function avatarSrc (avatar) {
  if (typeof avatar !== 'string' || avatar.length === 0) return null
  return avatar.startsWith('data:') ? avatar : 'data:image/jpeg;base64,' + avatar
}

function dataUrlBase64Length (dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const i = dataUrl.indexOf(',')
  return i < 0 ? 0 : dataUrl.length - i - 1
}

function readFileDataUrl (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

// Center-square-cover crop to 96x96 then JPEG-compress. Reduces quality
// in steps if the encoded result is over the byte budget; gives up at
// quality 0.4 and lets the caller surface a friendly error.
function compressToAvatar (dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const size = 96
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const sw = img.naturalWidth
      const sh = img.naturalHeight
      const cropSize = Math.min(sw, sh)
      const sx = (sw - cropSize) / 2
      const sy = (sh - cropSize) / 2
      ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, size, size)
      const qualities = [0.85, 0.75, 0.65, 0.55, 0.45]
      for (const q of qualities) {
        const url = canvas.toDataURL('image/jpeg', q)
        const b64Len = url.length - (url.indexOf(',') + 1)
        if (b64Len <= AVATAR_MAX_BASE64) { resolve(url); return }
      }
      // Fall through: return the lowest-quality version even if oversized;
      // bare will reject and the UI will message the user.
      resolve(canvas.toDataURL('image/jpeg', 0.45))
    }
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
}

function initialsFor (label) {
  const trimmed = (label || '').trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/).slice(0, 2)
  return parts.map(p => p[0].toUpperCase()).join('')
}

// Member-detail sheet that slides up when a member pin is tapped. Keeps
// the top focus bar around as an at-a-glance status header (per the UX
// pick); this sheet adds rich detail (avatar, name, battery, motion,
// presence, last seen with absolute + relative + reverse-geo, recent
// transitions filtered to this member, "Focus on map" / "Get directions"
// actions). Built on the same BottomSheet primitive as the members /
// places list. Closing only hides the sheet; the focus state lives on
// the parent so the user can re-open via tap-on-focus-bar without
// re-flying the map.
function MemberDetailSheet ({ member, presence, transitions, placesById, isSelf = false, onOpenTrips, onClose }) {
  const seen = member?.seen
  const isPaused = effectivePresenceMuted(presence)
  // Reverse-geocode label only when there's a fresh location and the
  // user isn't muted; reuses the same hysteresis-aware hook the row
  // version uses so the label stays stable across periodic refreshes.
  const geoLabel = useReverseGeocodeForMember(
    member?.pubkey || '',
    seen?.lat,
    seen?.lon,
    !!seen && !isPaused,
  )
  if (!member) return null

  const memberTransitions = (transitions ?? []).filter((t) => t.pubkey === member.pubkey)
  const motion = motionState(seen?.speed)
  const motionLabel = motion === 'walking' ? 'Walking'
                    : motion === 'driving' ? 'Driving'
                    : motion === 'flying' ? 'Flying'
                    : motion === 'still' ? 'Stationary'
                    : null

  const openDirections = async () => {
    if (typeof seen?.lat !== 'number' || typeof seen?.lon !== 'number') return
    const label = encodeURIComponent(member.displayName || 'destination')
    // Universal geo: URI; Android resolves it to the default maps app.
    // iOS support comes when shell:openUrl learns to swap to maps:// on Apple.
    const url = `geo:${seen.lat},${seen.lon}?q=${seen.lat},${seen.lon}(${label})`
    try { await pear.call('shell:openUrl', { url }) } catch {}
  }

  return (
    <BottomSheet onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.base }}>
        <Avatar base64={member.avatar} label={member.displayName} size={80} />
        <h2 style={{ ...typography.heading, margin: 0, color: colors.text.primary }}>{member.displayName}</h2>
        {isPaused && (
          <div style={{ ...typography.caption, color: colors.text.secondary }}>Sharing paused</div>
        )}
      </div>

      {!isPaused && seen && (motionLabel || typeof seen.battery === 'number') && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: spacing.lg, alignItems: 'center', paddingBottom: spacing.base, borderBottom: `1px solid ${colors.border}` }}>
          {typeof seen.battery === 'number' && <BatteryBadge level={seen.battery} />}
          {motionLabel && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: colors.text.secondary }}>
              {motion === 'walking' && <PersonSimpleWalk size={18} weight='thin' />}
              {motion === 'driving' && <CarProfile size={18} weight='thin' />}
              {motion === 'flying' && <AirplaneTilt size={18} weight='thin' />}
              <span style={typography.body}>{motionLabel}</span>
            </span>
          )}
        </div>
      )}

      <h3 style={{ ...typography.caption, color: colors.text.secondary, margin: `${spacing.base}px 0 ${spacing.sm}px`, textTransform: 'uppercase', letterSpacing: 0.5 }}>Last seen</h3>
      {seen ? (
        <div style={{ ...typography.body, color: colors.text.primary, lineHeight: 1.6 }}>
          <div>{formatAbsoluteTime(seen.ts)} · <LiveOrAge ts={seen.ts} /></div>
          {geoLabel && <div style={{ color: colors.text.secondary }}>near {geoLabel}</div>}
          {Number.isFinite(seen.accuracy) && (
            <div style={{ ...typography.caption, color: colors.text.muted }}>±{Math.round(seen.accuracy)} m accuracy</div>
          )}
        </div>
      ) : (
        <div style={{ ...typography.body, color: colors.text.muted }}>No location yet</div>
      )}

      <h3 style={{ ...typography.caption, color: colors.text.secondary, margin: `${spacing.lg}px 0 ${spacing.sm}px`, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent activity</h3>
      {memberTransitions.length === 0 ? (
        <div style={{ ...typography.body, color: colors.text.muted }}>No recent transitions.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {memberTransitions.slice(0, 5).map((t, i) => {
            const placeName = placesById?.[t.placeId]?.name ?? 'a place'
            return (
              <li key={`${t.ts}:${t.placeId}:${i}`} style={{ padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}`, ...typography.body, color: colors.text.primary }}>
                <div>{t.kind === 'enter' ? 'arrived at ' : 'left '}<strong style={{ fontWeight: 400 }}>{placeName}</strong></div>
                <div style={{ ...typography.caption, color: colors.text.secondary }}>{formatAbsoluteTime(t.ts)} · {ageLabel(t.ts)}</div>
              </li>
            )
          })}
        </ul>
      )}

      {isSelf ? (
        <div style={{ marginTop: spacing.lg }}>
          <button
            onClick={onOpenTrips}
            style={{
              width: '100%', padding: '12px', borderRadius: radius.md,
              background: colors.accent, color: colors.text.onPrimary,
              border: 'none', cursor: 'pointer',
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
            }}
          >
            View my trips
          </button>
        </div>
      ) : (
        <div style={{ marginTop: spacing.lg }}>
          <button
            onClick={openDirections}
            disabled={!seen}
            style={{
              width: '100%', padding: '12px', borderRadius: radius.md,
              background: colors.accent, color: colors.text.onPrimary,
              border: 'none', cursor: seen ? 'pointer' : 'default',
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
              opacity: seen ? 1 : 0.5,
            }}
          >
            Get directions
          </button>
        </div>
      )}
    </BottomSheet>
  )
}

// Trip-row thumbnail. Prefers the rendered map snapshot from
// useTripThumbnails (real OSM tiles + polyline baked in by MapLibre);
// falls back to an SVG-only route shape while the snapshot is still
// being prepared (or if rendering fails outright).
function MiniRoutePreview ({ polyline, dataUrl, width = 80, height = 60 }) {
  if (dataUrl) {
    return (
      <img
        src={dataUrl} width={width} height={height} alt=''
        style={{ borderRadius: radius.sm, flexShrink: 0, display: 'block' }}
      />
    )
  }
  const d = polylineSvgPath(polyline, width, height, 4)
  return (
    <svg
      width={width} height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ background: colors.surface.card, borderRadius: radius.sm, flexShrink: 0 }}
    >
      {d ? (
        <path d={d} fill='none' stroke={colors.accent} strokeWidth={2} strokeLinecap='round' strokeLinejoin='round' />
      ) : null}
    </svg>
  )
}

// Off-screen MapLibre instance that renders each trip into its hidden
// canvas, captures the result via toDataURL(), and yields a map of
// { [startTs]: dataURL }. Sequential rendering keeps tile-fetch
// pressure low and avoids WebGL-context-limit pitfalls. The fallback
// SVG in MiniRoutePreview shows immediately while these stream in.
function useTripThumbnails (trips, tileStyleUrl) {
  const [thumbs, setThumbs] = useState({})
  const keyList = useMemo(
    () => (trips ? trips.map(t => t.startTs).filter(Boolean).join(',') : ''),
    [trips],
  )
  useEffect(() => { setThumbs({}) }, [tileStyleUrl])

  useEffect(() => {
    if (!trips || trips.length === 0) return
    let cancelled = false
    let map = null
    let container = null
    const run = async () => {
      ensureMapLibreCss()
      container = document.createElement('div')
      container.style.cssText = 'position:fixed;left:-10000px;top:0;width:160px;height:120px;visibility:hidden;pointer-events:none;'
      document.body.appendChild(container)
      map = new maplibregl.Map({
        container,
        style: tileStyleUrl || DEFAULT_TILE_STYLE_URL,
        attributionControl: false,
        interactive: false,
        // Required so getCanvas().toDataURL() returns the rendered frame
        // instead of a cleared buffer.
        preserveDrawingBuffer: true,
      })
      await new Promise((resolve) => map.once('load', resolve))
      if (cancelled) return
      map.addSource('thumb', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: 'thumb-line', type: 'line', source: 'thumb',
        paint: { 'line-color': colors.accent, 'line-width': 3, 'line-opacity': 0.95 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })
      // Snapshot is taken from `thumbs` at effect-run time; subsequent
      // setThumbs calls inside the loop can't filter live, so we use the
      // captured-at-start list. Already-rendered entries from a prior
      // run get re-rendered on style change but skipped on simple
      // trip-list refreshes (the dep `keyList` doesn't change unless a
      // trip is added/removed).
      for (const trip of trips) {
        if (cancelled) break
        if (thumbs[trip.startTs]) continue
        const geo = polylineGeoJson(trip.polyline)
        if (geo.geometry.coordinates.length < 2) continue
        const src = map.getSource('thumb')
        if (!src) break
        src.setData(geo)
        const lons = geo.geometry.coordinates.map(c => c[0])
        const lats = geo.geometry.coordinates.map(c => c[1])
        const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]]
        try { map.fitBounds(bounds, { padding: 12, duration: 0, animate: false }) } catch { continue }
        await new Promise((resolve) => map.once('idle', resolve))
        if (cancelled) break
        try {
          const dataUrl = map.getCanvas().toDataURL('image/png')
          setThumbs((prev) => ({ ...prev, [trip.startTs]: dataUrl }))
        } catch (e) {
          console.warn('[trips] thumbnail capture failed', e?.message)
        }
      }
    }
    run().catch((e) => console.warn('[trips] thumbnail renderer failed', e?.message))
    return () => {
      cancelled = true
      try { map?.remove() } catch {}
      try { container?.remove() } catch {}
    }
  }, [keyList, tileStyleUrl])

  return thumbs
}

// Self-only trip history list. Pulls trips from the local Hyperbee via
// the worklet's `trips:list` IPC; refreshes on `trip:completed` events
// so a trip that finalizes while the sheet is open appears at the top.
// Per-member visibility for circle-mates is queued as a T3 amendment in
// TODO.md -- requires moving the trip records into the per-circle
// autobase so they replicate.
function TripsView ({ active, distanceUnit, tileStyleUrl, onOpenTrip, onClose }) {
  const [trips, setTrips] = useState(null)
  const [error, setError] = useState(null)
  const thumbs = useTripThumbnails(active && trips ? trips : null, tileStyleUrl)

  const refresh = useCallback(async () => {
    try {
      const r = await pear.call('trips:list')
      const list = Array.isArray(r?.trips) ? r.trips : []
      list.sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0))
      setTrips(list)
      setError(null)
    } catch (e) {
      setError(e?.message || 'Failed to load trips')
      setTrips([])
    }
  }, [])

  // Refresh on mount and whenever the sheet is reopened. The
  // `trip:completed` listener registers once at component lifetime;
  // pear.on has no unsubscribe in this codebase, so we gate the
  // refresh on the latest `active` value via a ref so stale-closure
  // refreshes don't fire while the sheet is hidden.
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => {
    pear.on('trip:completed', () => { if (activeRef.current) refresh() })
  }, [refresh])
  useEffect(() => {
    if (active) refresh()
  }, [active, refresh])

  return (
    <div style={{
      padding: spacing.lg,
      paddingTop: `calc(env(safe-area-inset-top, 24px) + ${spacing.base}px)`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg }}>
        <h1 style={{ ...typography.heading, margin: 0, color: colors.text.primary }}>My trips</h1>
        <button
          onClick={onClose}
          style={{
            background: 'transparent', border: 'none', color: colors.text.secondary,
            fontSize: 24, cursor: 'pointer', padding: '4px 8px',
          }}
          aria-label='Close'
        >×</button>
      </div>

      {trips == null && (
        <div style={{ ...typography.body, color: colors.text.muted }}>Loading…</div>
      )}
      {trips != null && trips.length === 0 && !error && (
        <div style={{ ...typography.body, color: colors.text.muted, lineHeight: 1.6 }}>
          No trips yet. Drives over 1 minute and 100 m show up here automatically.
        </div>
      )}
      {error && (
        <div style={{ ...typography.body, color: colors.error }}>{error}</div>
      )}

      {trips != null && trips.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {trips.map((t) => (
            <li key={t.startTs}>
              <button
                onClick={() => onOpenTrip(t.startTs)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: spacing.base,
                  padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}`,
                  background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <MiniRoutePreview polyline={t.polyline} dataUrl={thumbs[t.startTs]} width={80} height={60} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...typography.body, color: colors.text.primary }}>
                    {formatTripDate(t.startTs)}
                  </div>
                  <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2 }}>
                    {formatDistance(t.distanceMeters, distanceUnit)} · {formatDuration(t.durationMs)}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Full-screen detail for one trip: header with the formatted date,
// stat row, and a MapLibre map filling the rest of the sheet with the
// route polyline rendered and bounds-fitted. Loads its own copy of the
// trip from the worklet to avoid prop-drilling the list through the
// sheet stack; the local Hyperbee read is sub-ms.
function TripDetailView ({ startTs, distanceUnit, tileStyleUrl, onBack }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const [trip, setTrip] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    pear.call('trips:list').then((r) => {
      if (cancelled) return
      const found = (r?.trips ?? []).find(t => t.startTs === startTs)
      if (!found) setError('Trip not found')
      else setTrip(found)
    }).catch((e) => {
      if (!cancelled) setError(e?.message || 'Failed to load trip')
    })
    return () => { cancelled = true }
  }, [startTs])

  useEffect(() => {
    if (!trip || !containerRef.current) return
    ensureMapLibreCss()
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: tileStyleUrl || DEFAULT_TILE_STYLE_URL,
      attributionControl: false,
      interactive: true,
    })
    mapRef.current = map

    const onLoad = () => {
      const geo = polylineGeoJson(trip.polyline)
      map.addSource('trip', { type: 'geojson', data: geo })
      map.addLayer({
        id: 'trip-line',
        type: 'line',
        source: 'trip',
        paint: {
          'line-color': colors.accent,
          'line-width': 4,
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })
      // Endpoint markers help orient the user when the polyline is short
      // or doubles back on itself.
      const coords = geo.geometry.coordinates
      if (coords.length >= 2) {
        const start = coords[0]
        const end = coords[coords.length - 1]
        new maplibregl.Marker({ color: colors.text.muted }).setLngLat(start).addTo(map)
        new maplibregl.Marker({ color: colors.accent }).setLngLat(end).addTo(map)
        const lons = coords.map(c => c[0])
        const lats = coords.map(c => c[1])
        const minLon = Math.min(...lons), maxLon = Math.max(...lons)
        const minLat = Math.min(...lats), maxLat = Math.max(...lats)
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40, duration: 0 })
      }
    }

    map.on('load', onLoad)
    return () => {
      try { map.remove() } catch {}
      mapRef.current = null
    }
  }, [trip, tileStyleUrl])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: `${spacing.base}px ${spacing.lg}px`,
        paddingTop: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', gap: spacing.sm,
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent', border: 'none', color: colors.text.primary,
            fontSize: 22, cursor: 'pointer', padding: '4px 8px',
          }}
          aria-label='Back'
        >‹</button>
        <div style={{ flex: 1 }}>
          <div style={{ ...typography.body, color: colors.text.primary }}>
            {trip ? formatTripDate(trip.startTs) : '…'}
          </div>
          {trip && (
            <div style={{ ...typography.caption, color: colors.text.secondary }}>
              {formatDistance(trip.distanceMeters, distanceUnit)} · {formatDuration(trip.durationMs)}
              {formatSpeed(trip.maxSpeedMps, distanceUnit)
                ? ` · max ${formatSpeed(trip.maxSpeedMps, distanceUnit)}`
                : ''}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: spacing.lg, ...typography.body, color: colors.error }}>{error}</div>
      )}
      <div ref={containerRef} style={{ flex: 1, minHeight: 320, background: colors.surface.base }} />
    </div>
  )
}

// Today / Yesterday / "Mar 5" prefix + locale-formatted time. Used by
// the member detail sheet for last-seen and transitions; pairs with
// `ageLabel` for the relative version next to it.
function formatAbsoluteTime (ts) {
  if (typeof ts !== 'number') return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
}

// Slide-up modal sheet, ported from pearcal-native/src/ui/App.jsx:5777.
// Tap-to-dismiss on the scrim; drag the handle down >60px to close.
// onClose runs after the slide-out finishes so the parent can unmount.
function BottomSheet ({ onClose, children, zIndex = 200 }) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const touchStartY = useRef(null)
  const DURATION = 280

  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 20)
    return () => clearTimeout(id)
  }, [])

  const close = useCallback(() => {
    setClosing((c) => {
      if (c) return c
      setTimeout(() => onClose(), DURATION)
      return true
    })
  }, [onClose])

  // Hardware back closes the sheet. Returns true so the back-stack walk
  // stops here -- nested sheets stack naturally (most-recently-mounted
  // is at the top of _backStack, so it gets first crack). Skipped while
  // already in the closing animation so a second back during the slide-
  // out doesn't cascade into the next handler too early.
  useBackHandler(useCallback(() => {
    if (closing) return true
    close()
    return true
  }, [closing, close]))

  const onHandleTouchStart = (e) => { touchStartY.current = e.touches[0].clientY }
  const onHandleTouchMove = (e) => {
    if (touchStartY.current === null) return
    const dy = e.touches[0].clientY - touchStartY.current
    // Medium impact haptic on swipe-down dismissal so the gesture has a
    // tactile "released" feel. Scrim taps also close but don't fire
    // haptics -- that's a lighter intent and shouldn't buzz.
    if (dy > 60) { touchStartY.current = null; haptic('medium'); close() }
  }

  const translateY = (!visible || closing) ? '100%' : '0%'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: visible && !closing ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
        transition: `background ${DURATION}ms ease`,
      }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 600,
          background: '#1a1a1a',
          color: '#eee',
          borderRadius: '20px 20px 0 0',
          maxHeight: '85dvh', overflowY: 'auto', overflowX: 'hidden',
          padding: '0 16px 32px',
          transform: `translateY(${translateY})`,
          transition: `transform ${DURATION}ms cubic-bezier(0.32,0.72,0,1)`,
          WebkitOverflowScrolling: 'touch',
          boxSizing: 'border-box',
        }}
      >
        <div
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onClick={close}
          style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px', cursor: 'pointer' }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#444' }} />
        </div>
        {children}
      </div>
    </div>
  )
}

// Generic confirmation sheet for destructive actions (delete circle,
// leave circle, delete place, etc). Built on the BottomSheet primitive
// so the dim layer + slide animation + swipe-down dismissal come for
// free, and so confirms stack naturally above any underlying sheet
// (zIndex 250 sits above the default BottomSheet zIndex 200).
//
// Props:
//   title          — short prompt shown as the sheet's heading
//   message        — body copy (string or JSX) explaining what'll happen
//   confirmLabel   — verb on the destructive button (e.g. "Delete")
//   destructive    — when true, confirm button uses the error color
//   busy           — disables both buttons + swaps confirm label to "..."
//   onConfirm      — called when the destructive button is tapped
//   onClose        — called for cancel / scrim tap / swipe-down
function ConfirmSheet ({ title, message, confirmLabel = 'Confirm', destructive = true, busy = false, onConfirm, onClose }) {
  const accentColor = destructive ? colors.error : colors.accent
  return (
    <BottomSheet onClose={onClose} zIndex={250}>
      <h2 style={{
        margin: `${spacing.sm}px 0 ${spacing.xs}px`,
        fontSize: 18, fontWeight: 400, color: colors.text.primary,
      }}>
        {title}
      </h2>
      <div style={{ ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg }}>
        {message}
      </div>
      <div style={{ display: 'flex', gap: spacing.sm }}>
        <button
          onClick={onClose}
          disabled={busy}
          style={{
            flex: 1, padding: '12px 16px', borderRadius: radius.md,
            background: 'transparent', color: colors.text.secondary,
            border: `1px solid ${colors.border}`,
            cursor: busy ? 'default' : 'pointer',
            fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 400,
            opacity: busy ? 0.5 : 1,
          }}>
          Cancel
        </button>
        <button
          data-haptic={destructive ? 'warn' : 'light'}
          onClick={() => {
            // Warn-level notification haptic on destructive commits
            // (delete-circle, leave-circle, place-delete) -- the
            // data-haptic attribute opts this button out of the global
            // light-tick so the user feels one warn buzz, not light+warn.
            if (destructive) haptic('warn')
            onConfirm?.()
          }}
          disabled={busy}
          style={{
            flex: 1, padding: '12px 16px', borderRadius: radius.md,
            background: accentColor,
            color: '#fff',
            border: `1px solid ${accentColor}`,
            cursor: busy ? 'default' : 'pointer',
            fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 500,
            opacity: busy ? 0.7 : 1,
          }}>
          {busy ? '...' : confirmLabel}
        </button>
      </div>
    </BottomSheet>
  )
}

// Single member row in the bottom sheet's roster. Pulled out as its
// own component so the useReverseGeocode hook has a stable call site
// per row (otherwise hook ordering would shift with the members list).
function MemberRow ({ member, seen, isPaused, transition, transitionPlaceName, onFocus }) {
  const pubkey = member.value?.pubkey ?? ''
  const displayName = member.value?.displayName ?? short(pubkey)
  const focusable = !!seen && !isPaused
  // Only fetch a "near X" label when there's no recent transition
  // explaining where they are (and they're not paused). Saves
  // requests and keeps the row stable when transitions are fresh.
  // Per-member hysteresis prevents GPS-jitter-driven flicker.
  const geoLabel = useReverseGeocodeForMember(
    pubkey,
    seen?.lat,
    seen?.lon,
    !!seen && !transition && !isPaused,
  )
  return (
    <li
      style={{ ...s.memberItem, cursor: focusable ? 'pointer' : 'default' }}
      onClick={focusable ? () => onFocus(pubkey) : undefined}
    >
      <div style={s.memberRow}>
        <Avatar base64={member.value?.avatar} label={displayName} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
              <div style={{ ...s.memberName, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
              {!isPaused && <MotionGlyph speed={seen?.speed} size={14} />}
            </div>
            {!isPaused && <BatteryBadge level={seen?.battery} />}
          </div>
          {isPaused ? (
            <div style={s.lastSeenMuted}>Sharing paused</div>
          ) : transition ? (
            <div style={s.status}>
              {transition.kind === 'enter' ? 'arrived at ' : 'left '}
              {transitionPlaceName ?? '(unknown place)'}
              {' · '}{ageLabel(transition.ts)}
            </div>
          ) : seen ? (
            <div style={s.lastSeen}>
              {geoLabel ? 'near ' + geoLabel + ' · ' : ''}
              <LiveOrAge ts={seen.ts} />
            </div>
          ) : (
            <div style={s.lastSeenMuted}>no location yet</div>
          )}
        </div>
      </div>
    </li>
  )
}

// Walking / driving glyph derived from lastSeen.speed (m/s). Returns
// null for null / negative / "still" so most rows render no glyph and
// only the in-motion ones get an icon. Used inline next to the member's
// displayName in the bottom-sheet roster and the focus bar.
function MotionGlyph ({ speed, size = 14 }) {
  const state = motionState(speed)
  if (state !== 'walking' && state !== 'driving' && state !== 'flying') return null
  const Icon = state === 'walking' ? PersonSimpleWalk
             : state === 'driving' ? CarProfile
             : AirplaneTilt
  return (
    <Icon
      size={size}
      weight='thin'
      aria-label={state}
      style={{ color: colors.text.secondary, flexShrink: 0 }}
    />
  )
}

// Inline-SVG battery indicator with a fill that scales with the level
// and a color band: green > 50, amber 20-50, red < 20. Sits on the
// member row's title line so it stays visible regardless of subtitle
// state (paused / transition / lastSeen / no-loc-yet).
function BatteryBadge ({ level }) {
  if (typeof level !== 'number' || !Number.isFinite(level)) return null
  const pct = Math.max(0, Math.min(100, Math.round(level)))
  const color = pct < 20 ? '#e57373' : pct < 50 ? '#ffb74d' : '#81c784'
  const fillW = (pct / 100) * 12  // inner area width is 12 (between x=2 and x=14)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8, flexShrink: 0 }}>
      <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden="true">
        <rect x="0.5" y="0.5" width="15" height="9" rx="1.5" fill="none" stroke="#888" strokeWidth="1"/>
        <rect x="16" y="3" width="2" height="4" rx="0.5" fill="#888"/>
        <rect x="2" y="2" width={fillW} height="6" fill={color}/>
      </svg>
      <span style={{ fontSize: 12, color: pct < 20 ? '#e57373' : '#aaa', fontVariantNumeric: 'tabular-nums', minWidth: 30, textAlign: 'right', display: 'inline-block' }}>{pct}%</span>
    </span>
  )
}

function Avatar ({ base64, label, size = 28 }) {
  const px = size + 'px'
  const src = avatarSrc(base64)
  if (src) {
    return (
      <img
        src={src}
        alt=''
        style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <div style={{
      width: px, height: px, borderRadius: '50%', flexShrink: 0,
      background: '#2a3a3f', color: '#cfe', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.42), fontWeight: 400, fontFamily: typography.fontFamily,
    }}>{initialsFor(label)}</div>
  )
}

function BackBar ({ onBack, title }) {
  return (
    <header style={s.header}>
      <button style={s.iconBtn} onClick={onBack} aria-label='Back'>‹</button>
      <h1 style={{ ...s.h1, textAlign: 'center' }}>{title}</h1>
      <span style={{ width: 32 }} />
    </header>
  )
}

function QrImage ({ text, size = 240 }) {
  const [dataUrl, setDataUrl] = useState(null)
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(text, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setDataUrl(url) })
      .catch(() => { if (!cancelled) setDataUrl(null) })
    return () => { cancelled = true }
  }, [text, size])
  return (
    <div style={s.qrWrap}>
      {dataUrl
        ? <img src={dataUrl} style={{ width: size, height: size, display: 'block' }} alt='Invite QR code' />
        : <div style={{ width: size, height: size, background: '#222' }} />}
    </div>
  )
}

function ShareButton ({ text, title = 'Join my PearCircle' }) {
  const click = async () => {
    // Route through the shell rather than the WebView's Web Share API.
    // The WebView runs with about:blank as the base URL and that isn't
    // reliably treated as a secure context, so navigator.share tends to
    // fail silently. The shell uses React Native's Share, which always
    // opens the OS share sheet.
    try { await pear.call('shell:share', { text, title }) } catch {}
  }
  return (
    <button style={s.secondaryBtn} onClick={click}>
      Share join link
    </button>
  )
}

// Sub-minute precision is noise — every refresh poll otherwise flips
// "5s ago" → "8s ago" → "2s ago" without conveying anything new. Bucket
// anything under a minute as "just now" and coarsen everything else
// to whole minutes / hours / days.
function ageLabel (ts) {
  if (typeof ts !== 'number') return ''
  const ms = Date.now() - ts
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago'
  return Math.floor(ms / 86_400_000) + 'd ago'
}

// Replaces sub-minute "updated Xs ago" churn with a stable green-dot
// "Live" pill while ts is fresh, then falls back to coarser "Xm ago".
// Used for lastSeen freshness; transitions keep ageLabel since they're
// past events and "Live" wouldn't be the right framing.
const LIVE_THRESHOLD_MS = 60_000
function LiveOrAge ({ ts, prefix = 'updated ' }) {
  if (typeof ts !== 'number') return null
  const fresh = (Date.now() - ts) < LIVE_THRESHOLD_MS
  if (fresh) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7ec77a', display: 'inline-block' }} />
        Live
      </span>
    )
  }
  return <>{prefix}{ageLabel(ts)}</>
}

function short (s) {
  if (!s || typeof s !== 'string') return '...'
  if (s.length <= 12) return s
  return s.slice(0, 8) + '...' + s.slice(-4)
}

const s = {
  screen: { paddingLeft: spacing.base, paddingRight: spacing.base, paddingTop: `calc(env(safe-area-inset-top, 24px) + ${spacing.base}px)`, paddingBottom: spacing.xxxl + spacing.base, color: colors.text.primary, background: colors.surface.base, minHeight: '100vh', fontFamily: typography.fontFamily, boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  h1: { fontSize: typography.display.fontSize, margin: 0, flex: 1, fontWeight: typography.display.fontWeight },
  h2: { fontSize: 18, margin: `${spacing.xl}px 0 ${spacing.sm}px 0`, fontWeight: 400 },
  h3: { fontSize: typography.subheading.fontSize, margin: `${spacing.lg}px 0 ${spacing.sm}px 0`, fontWeight: typography.subheading.fontWeight, color: colors.text.secondary },
  idLine: { color: colors.text.muted, margin: `${spacing.xs}px 0 ${spacing.base}px 0`, fontSize: typography.caption.fontSize, fontFamily: typography.monoFamily },
  profileBtn: { display: 'flex', alignItems: 'center', gap: spacing.md, width: '100%', padding: `${spacing.sm + 2}px ${spacing.md}px`, margin: `${spacing.xs}px 0 ${spacing.base}px 0`, background: colors.surface.input, border: `1px solid ${colors.border}`, borderRadius: radius.md, color: colors.text.primary, textAlign: 'left', cursor: 'pointer', fontSize: typography.caption.fontSize },
  idName: { color: colors.text.primary, fontFamily: typography.fontFamily, fontWeight: 400, fontSize: typography.body.fontSize },
  idNeedName: { color: colors.accent, fontFamily: typography.fontFamily, fontWeight: 400, fontSize: typography.body.fontSize },
  idMuted: { color: colors.text.muted, fontFamily: typography.monoFamily },
  actions: { display: 'flex', flexDirection: 'column', gap: spacing.sm, marginBottom: spacing.sm },
  primaryBtn: { width: '100%', padding: `${spacing.md + 2}px ${spacing.base}px`, background: colors.primary, color: colors.text.onPrimary, border: 'none', borderRadius: radius.lg, fontSize: typography.subheading.fontSize, fontWeight: typography.subheading.fontWeight, cursor: 'pointer' },
  secondaryBtn: { width: '100%', padding: `${spacing.md + 2}px ${spacing.base}px`, background: colors.surface.elevated, color: colors.text.primary, border: `1px solid ${colors.border}`, borderRadius: radius.lg, fontSize: typography.subheading.fontSize, fontWeight: 400, cursor: 'pointer', marginTop: spacing.sm },
  dangerBtn: { width: '100%', padding: `${spacing.md + 2}px ${spacing.base}px`, background: '#5a1f1f', color: '#fcc', border: '1px solid #7a2a2a', borderRadius: radius.lg, fontSize: typography.subheading.fontSize, fontWeight: typography.subheading.fontWeight, cursor: 'pointer' },
  durationRow: { display: 'flex', gap: spacing.sm },
  durationBtn: { flex: 1, padding: `${spacing.sm + 2}px ${spacing.sm}px`, background: colors.surface.input, color: colors.text.secondary, border: `1px solid ${colors.border}`, borderRadius: radius.md, fontSize: typography.body.fontSize, cursor: 'pointer' },
  sharingOffDot: { position: 'absolute', right: -2, bottom: -2, width: 12, height: 12, borderRadius: radius.full, background: colors.error, border: `2px solid ${colors.surface.card}`, pointerEvents: 'none' },
  iconBtn: { width: 32, height: 32, padding: 0, background: 'none', color: colors.text.secondary, border: 'none', fontSize: 22, cursor: 'pointer' },
  circleList: { listStyle: 'none', padding: 0, margin: 0 },
  circleItem: { padding: spacing.base - 2, background: colors.surface.card, borderRadius: radius.lg, marginBottom: spacing.sm, cursor: 'pointer' },
  circleName: { fontSize: typography.subheading.fontSize, fontWeight: 400 },
  circleMeta: { fontSize: typography.micro.fontSize, color: colors.text.muted, marginTop: 2, fontFamily: typography.monoFamily },
  label: { fontSize: typography.caption.fontSize, color: colors.text.secondary, display: 'block', marginBottom: 6, marginTop: spacing.sm },
  input: { width: '100%', padding: spacing.md, background: colors.surface.card, color: colors.text.primary, border: `1px solid ${colors.border}`, borderRadius: radius.md, fontSize: typography.subheading.fontSize, marginBottom: spacing.base, boxSizing: 'border-box' },
  textarea: { width: '100%', padding: spacing.md, background: colors.surface.card, color: colors.text.primary, border: `1px solid ${colors.border}`, borderRadius: radius.md, fontSize: typography.body.fontSize, fontFamily: typography.monoFamily, resize: 'vertical', marginBottom: spacing.base, boxSizing: 'border-box' },
  inviteBox: { width: '100%', padding: spacing.md, background: colors.surface.card, color: '#9cf', border: `1px solid ${colors.border}`, borderRadius: radius.md, fontSize: typography.micro.fontSize, fontFamily: typography.monoFamily, resize: 'vertical', marginBottom: spacing.md, minHeight: 80, boxSizing: 'border-box' },
  muted: { color: colors.text.muted, fontSize: typography.body.fontSize },
  error: { color: '#f77', marginTop: spacing.sm, fontSize: typography.body.fontSize },
  section: { background: colors.surface.card, padding: spacing.md, borderRadius: radius.lg, marginBottom: spacing.md },
  row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: typography.body.fontSize },
  memberList: { listStyle: 'none', padding: 0, margin: 0 },
  memberItem: { padding: spacing.md, background: colors.surface.card, borderRadius: radius.lg, marginBottom: spacing.sm },
  memberRow: { display: 'flex', alignItems: 'flex-start', gap: spacing.md },
  memberName: { fontSize: 15, fontWeight: 400 },
  placeRowHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  placeRowActions: { display: 'flex', gap: 6, flexShrink: 0 },
  placeRadiusLine: { fontSize: typography.micro.fontSize, color: colors.text.muted, marginTop: spacing.xs, fontFamily: typography.monoFamily },
  coordsMissing: { fontSize: typography.caption.fontSize, color: '#fa9', padding: `${spacing.sm}px ${spacing.md}px`, background: '#2a1f0f', border: '1px solid #4a3520', borderRadius: radius.md, marginBottom: spacing.md, lineHeight: 1.4 },
  avatarRow: { display: 'flex', alignItems: 'center', gap: spacing.base, marginBottom: spacing.base },
  avatarPreview: { width: 96, height: 96, borderRadius: radius.full, overflow: 'hidden', background: '#2a3a3f', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' },
  avatarFallback: { color: '#cfe', fontSize: 36, fontWeight: 400, fontFamily: typography.fontFamily },
  lastSeen: { fontSize: typography.micro.fontSize, color: '#9cf', marginTop: spacing.xs, fontFamily: typography.monoFamily },
  lastSeenMuted: { fontSize: typography.micro.fontSize, color: '#555', marginTop: spacing.xs, fontStyle: 'italic' },
  status: { fontSize: typography.caption.fontSize, color: '#cfc', marginTop: spacing.xs, fontWeight: 400 },
  transitionBtns: { display: 'flex', gap: spacing.sm, marginTop: spacing.sm },
  smallBtn: { flex: 1, padding: `${spacing.sm}px ${spacing.sm + 2}px`, background: colors.surface.elevated, color: colors.text.secondary, border: `1px solid ${colors.border}`, borderRadius: radius.sm + 2, fontSize: typography.micro.fontSize, cursor: 'pointer' },
  mapWrap: { position: 'relative', height: '100%', width: '100%', background: '#0a0a0a' },
  mapCanvas: { height: '100%', width: '100%' },
  mapAttribution: { position: 'absolute', bottom: 4, right: 6, fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: radius.sm, pointerEvents: 'none' },
  mapFirstRoot: { position: 'fixed', inset: 0, color: '#eee', background: '#111', fontFamily: '-apple-system, system-ui, Roboto, sans-serif', overflow: 'hidden' },
  mapFill: { position: 'absolute', inset: 0 },
  mapTopBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px',
    paddingTop: 'calc(env(safe-area-inset-top, 24px) + 8px)',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
  },
  mapTitle: { fontSize: 18, margin: 0, flex: 1, fontWeight: 400, color: '#eee' },
  peerBadge: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#bbb', padding: '4px 8px' },
  peerDot: { width: 8, height: 8, borderRadius: '50%' },
  fab: {
    position: 'absolute',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
    left: '50%', transform: 'translateX(-50%)',
    padding: '10px 18px',
    background: 'rgba(26,26,26,0.92)', color: colors.text.primary,
    border: `1px solid ${colors.border}`, borderRadius: 999,
    fontSize: 14, fontWeight: 300,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
    zIndex: 5, cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: typography.fontFamily,
  },
  dropdownBtn: {
    display: 'flex', alignItems: 'center', gap: 6, flex: 1,
    padding: '6px 10px', background: 'transparent', color: '#eee',
    border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 400,
    cursor: 'pointer', textAlign: 'left',
  },
  dropdownLabel: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dropdownChevron: { fontSize: 12, color: '#888' },
  focusTextCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  focusName: { fontSize: 15, fontWeight: 400, color: '#eee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  focusSub: { fontSize: 12, color: '#9cf', fontFamily: 'monospace' },
  avatarBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
  },
  menuScrim: {
    position: 'fixed', inset: 0, zIndex: 9, background: 'transparent',
  },
  menu: {
    position: 'absolute', top: 'calc(env(safe-area-inset-top, 24px) + 56px)', left: 12,
    background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 10,
    padding: 6, minWidth: 220, maxWidth: 'calc(100% - 24px)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 10,
  },
  menuItem: {
    display: 'block', width: '100%', padding: '10px 12px',
    background: 'transparent', color: '#eee', border: 'none', borderRadius: 6,
    fontSize: 14, textAlign: 'left', cursor: 'pointer',
  },
  menuItemActive: { background: '#243237', color: '#7ec4cf', fontWeight: 400 },
  menuDivider: { height: 1, background: '#2a2a2a', margin: '6px 4px' },
  qrWrap: { display: 'flex', justifyContent: 'center', padding: 12, background: '#fff', borderRadius: 12, marginBottom: 12 },
  emptyHint: {
    position: 'absolute', left: 16, right: 16,
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
    padding: 14, background: 'rgba(26,26,26,0.92)',
    borderRadius: 10, color: '#ccc', fontSize: 14, lineHeight: 1.4,
    zIndex: 5,
  },
}
