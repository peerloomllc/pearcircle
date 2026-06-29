import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import maplibregl from 'maplibre-gl'
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css'
import { colors, colorsRaw, typography, spacing, radius } from './theme.js'
import { FONT_CSS } from './fonts.js'
import { Image as ImageIcon, GearSix, Info as InfoIcon, CaretDown, ShareNetwork, PersonSimpleWalk, CarProfile, PencilSimple, Trash, SignOut, BellSimple, BellSimpleSlash, NavigationArrow, AirplaneTilt, ArrowSquareOut, Lightning, CurrencyDollar, BookOpen, EnvelopeSimple, Bug, UsersThree, Palette, Wrench, MapTrifold, Broadcast, ArrowsClockwise, Export as ExportIcon, DownloadSimple, House, Briefcase, GraduationCap, Barbell, Storefront, Tree, FirstAid, ForkKnife, MapPin, CheckCircle, Warning } from '@phosphor-icons/react'
import { motionState } from '../lib/motion.js'
import { liveStatus } from '../lib/liveStatus.js'
import { formatDistance, formatDuration, formatSpeed, formatTripDate, polylineSvgPath, polylineGeoJson } from '../lib/tripFormat.js'
import {
  computeClusters,
  clusterKey,
  computeRingOffsets,
} from '../lib/fanOut.js'
import { isNewer as isSeederVersionNewer } from '../lib/seederUpdateCheck.js'
import { OnboardingFlow } from './components/OnboardingFlow.jsx'
import { Tour } from './components/Tour.jsx'
import appConfig from '../../app.json'

const APP_VERSION = appConfig?.expo?.version ?? '0.0.0'
import { downloadRegion, estimateTilesInBbox } from './lib/regionDownload.js'

// Steps for the post-onboarding spotlight tour. Anchors resolve in
// App's main JSX via [data-tour="..."]; missing anchors fall through
// to a centered tooltip in Tour.jsx (e.g. the welcome step has no
// anchor on purpose, so it floats over the map).
const TOUR_STEPS = [
  {
    anchor: '__no-anchor__',
    title: 'This is your map',
    body: 'Pins show people in your circles. Yours shows up here too once your location starts coming in.',
  },
  {
    anchor: '__no-anchor__',
    title: 'Drop a Place',
    body: 'Long-press anywhere on the map to add a Place. Anyone in that circle gets notified when someone arrives or leaves it.',
  },
  {
    anchor: 'menu-button',
    title: 'Your circles live here',
    body: 'Tap to switch between circles, invite people, or jump into Settings and your profile.',
    placement: 'bottom',
  },
  {
    anchor: 'members-fab',
    title: 'Members and places',
    body: 'Open this to see everyone in the active circle, add a Place, and get notified when people arrive or leave.',
    placement: 'top',
  },
  {
    anchor: '__no-anchor__',
    title: 'Keep your circle in sync',
    body: "A seeder is an always-on computer that keeps your circle's locations and history synced even when everyone's phone is off. It's optional but handy. Set one up any time from Settings.",
  },
]
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

// Native time picker (Sync reminder reminder-time field). The <input type=time>
// control renders inconsistently across WebViews and inline React styles can't
// reach its shadow pseudo-elements, so we strip the native chrome and draw our
// own caret (see SyncReminderSection) for pixel-identical layout on both:
//  - iOS (WKWebView) gives the value pseudo an intrinsic min-width / right
//    alignment that clips the digits on a narrow iPhone screen. appearance:none
//    + left-aligning the value pseudo lets it shrink to the container. The
//    native wheel picker still opens on tap (appearance:none doesn't suppress
//    it on iOS), so we lose nothing.
//  - Android (Chromium) draws ::-webkit-calendar-picker-indicator hard against
//    the content edge; hiding it lets our own caret control the right buffer.
if (typeof document !== 'undefined' && !document.getElementById('pearcircle-time-input')) {
  const styleEl = document.createElement('style')
  styleEl.id = 'pearcircle-time-input'
  styleEl.textContent = `
    input[type="time"] { text-align: left; min-width: 0; }
    input[type="time"]::-webkit-date-and-time-value { text-align: left; margin: 0; min-width: 0; }
    input[type="time"]::-webkit-calendar-picker-indicator { display: none; }
    input[type="time"]::-webkit-inner-spin-button { display: none; -webkit-appearance: none; }
  `
  document.head.appendChild(styleEl)
}

// Theme palette. CSS variables on :root provide the dark default (matches
// pre-theme behavior, no flash on cold start). [data-theme="light"]
// overrides every variable in the light palette. JS toggles by setting
// document.documentElement.setAttribute('data-theme', 'light' | 'dark').
//
// Inline styles in this file reference these via the colors export from
// theme.js -- e.g. `colors.text.primary` resolves to `var(--color-text-primary)`.
// Non-CSS contexts (MapLibre paint props, marker conic-gradients, anything
// that needs a literal hex) read the raw values via colorsRaw / themeColor()
// helpers; those won't auto-update on theme switch but have either a
// theme-neutral palette already or get refreshed via setPaintProperty.
if (typeof document !== 'undefined' && !document.getElementById('pearcircle-theme-vars')) {
  const styleEl = document.createElement('style')
  styleEl.id = 'pearcircle-theme-vars'
  styleEl.textContent = `
    :root {
      --color-primary: #9FE15A;
      --color-primary-dark: #5BAF3A;
      --color-accent: #7ec4cf;
      --color-error: #ef5350;
      --color-warn: #ffb74d;
      --color-success: #7ec77a;
      --color-text-primary: #f0f0f0;
      --color-text-secondary: #a0a0a0;
      --color-text-muted: #666666;
      --color-text-on-primary: #0a1f23;
      --color-surface-base: #0d0d0d;
      --color-surface-card: #1a1a1a;
      --color-surface-elevated: #252525;
      --color-surface-input: #1c1c1c;
      --color-border: #2a2a2a;
      --color-divider: #222222;
    }
    [data-theme="light"] {
      --color-primary: #5BAF3A;
      --color-primary-dark: #3F8A26;
      --color-accent: #3a8a99;
      --color-error: #c62828;
      --color-warn: #b8730f;
      --color-success: #2e7d32;
      --color-text-primary: #1a1916;
      --color-text-secondary: #5a5a5a;
      --color-text-muted: #999999;
      --color-text-on-primary: #ffffff;
      --color-surface-base: #f7f5f0;
      --color-surface-card: #ffffff;
      --color-surface-elevated: #fafafa;
      --color-surface-input: #f0ede8;
      --color-border: #e0ddd5;
      --color-divider: #ececec;
    }
  `
  document.head.appendChild(styleEl)
  // Default to dark until persisted preference loads. App's effect calls
  // setTheme() with the persisted value (or system pref) once known.
  document.documentElement.setAttribute('data-theme', 'dark')
}

// Set the data-theme attribute on the root element. Effective immediately
// for everything reading var(--color-*) in inline styles. MapLibre layers
// don't respond to CSS var changes; refreshMapTheme() handles those.
function setTheme (mode) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark')
}

// Read a CSS variable's resolved value. Used by code that needs a literal
// hex (MapLibre paint props, canvas rendering). Caller must call again
// after setTheme() to get the current-mode value.
function themeColor (name) {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
import QRCode from 'qrcode'

// Lazy proxy: window.pear is installed by main.jsx but App.jsx is imported
// before that assignment runs. Resolve through window at call time.
const pear = {
  call: (...args) => window.pear.call(...args),
  on: (...args) => window.pear.on(...args),
}

// Bounded IPC call (UX audit item b). pear.call awaits the worklet's reply with
// no ceiling, so a wedged worklet pins the caller -- and any button spinner --
// forever. Race against a 10s timeout; on a timeout retry once (a transient
// stall / GC pause), then throw a labelled IPC_TIMEOUT the caller surfaces and
// recovers from (finally re-enables the control). A *real* worklet error (the
// reply rejected) is surfaced immediately without retrying.
//
// retries defaults to 1 (safe for idempotent reads / deterministic rebuilds).
// Pass retries:0 for non-idempotent writes like circle:create where a retry
// after a slow-but-successful first attempt would duplicate the side effect.
async function callWithTimeout (method, args, { timeoutMs = 10_000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let timer
    try {
      return await Promise.race([
        pear.call(method, args),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('__ipc_timeout__')), timeoutMs) }),
      ])
    } catch (e) {
      if (e?.message !== '__ipc_timeout__') throw e // real worklet error: don't retry
      // timed out: fall through to retry if attempts remain
    } finally {
      clearTimeout(timer)
    }
  }
  const err = new Error(method + ' timed out')
  err.code = 'IPC_TIMEOUT'
  throw err
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
// Shown in place of a circle name before its `circle` row has replicated
// (the joined record exists a beat before the name syncs). Beats a bare
// "..." in the pill, the circle switcher, and the Settings list.
const CIRCLE_NAME_PENDING = 'Loading…'

// Sharing state helpers. Worklet returns either:
//   { sharing: { [circleId]: { enabled, expiresAt } }, anyEnabled }
// or (legacy shape we still tolerate) the per-circle object directly.
function toSharingState (resp) {
  const raw = resp?.sharing && typeof resp.sharing === 'object' ? resp.sharing : {}
  const map = {}
  for (const [cid, v] of Object.entries(raw)) {
    map[cid] = {
      enabled: v?.enabled !== false,
      expiresAt: typeof v?.expiresAt === 'number' ? v.expiresAt : null,
    }
  }
  return {
    map,
    anyEnabled: resp?.anyEnabled !== false,
    anyPaused: anyPausedFrom(map),
  }
}
function anyPausedFrom (map) {
  for (const v of Object.values(map)) if (v && v.enabled === false) return true
  return false
}
function getCircleSharing (state, circleId) {
  return state.map[circleId] ?? { enabled: true, expiresAt: null }
}

export function App () {
  const [view, setView] = useState({ name: 'home' })
  const [identity, setIdentity] = useState(null)
  const [profile, setProfile] = useState(null)
  // Per-circle sharing state. Shape: { map, anyEnabled, anyPaused }.
  //   map[circleId] = { enabled, expiresAt }
  //   anyEnabled  - at least one circle is sharing
  //   anyPaused   - at least one circle is muted (drives the red dot
  //                 on the settings gear)
  // Missing circle in the map reads as "enabled, no expiry" so newly
  // mounted circles render correctly before refresh fires.
  const [sharing, setSharing] = useState({ map: {}, anyEnabled: true, anyPaused: false })
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
    // Any sheet that stashed a returnTo (e.g. seeders opened from Settings)
    // restores the previous sheet so the hardware/swipe back gesture mirrors
    // the in-sheet ‹ button instead of jumping to root.
    if (sheet.returnTo) { setSheet(sheet.returnTo); return true }
    closeSheet()
    return true
  }, [sheet, closeSheet]), !!sheet)
  // Owner-tear-down notice queue (proposal amendment 2026-05-07 §1).
  // The worklet emits `circle:deleted` when an owner's tombstone lands;
  // we show one alert per circle, then call circle:cleanup-deleted to
  // free local state. Stored as an array because two circles could
  // theoretically be deleted in quick succession.
  const [deletedNotices, setDeletedNotices] = useState([])
  // Member-side migration nudge (proposal 2026-06-17 slice 3/4). The owner of a
  // recreated circle posts an owner-signed `supersede:` record into the OLD
  // circle carrying the new invite; we surface it as a "your group moved"
  // prompt with one-tap join + leave-old. dismissedNudgesRef holds new-circle
  // ids the user tapped "Later" on, so they don't re-pop within the session
  // (they reappear on next launch — persistent until the user joins or leaves,
  // per the proposal's open-question resolution).
  const [migrationNudge, setMigrationNudge] = useState(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const dismissedNudgesRef = useRef(new Set())
  // iOS Always-location flow state. permissionStatus tracks the latest
  // status published by the shell ('always' | 'whenInUse' | 'denied' |
  // 'restricted' | 'notDetermined' | 'unknown'); the home banner reads
  // it to decide whether to show the "Open Settings" nudge. Default to
  // 'always' so Android and pre-status-emit iOS don't show the banner.
  // primingVisible drives the one-time priming modal that runs before
  // the iOS system dialog; setPrimingVisible(true) on permission:prime,
  // setPrimingVisible(false) once the user taps Continue (after shell
  // confirms the IPC handoff). bannerDismissed is per-session so the
  // banner doesn't keep nagging within a single launch.
  const [permissionStatus, setPermissionStatus] = useState('always')
  const [primingVisible, setPrimingVisible] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  // Android Doze battery-optimization exemption. supported=null while
  // we probe (avoids a banner-flash on cold start); supported=false on
  // iOS and pre-Doze Android (banner + onboarding step suppress).
  // exempt=true means the OS won't pause our foreground service during
  // long idle. Re-probed when the app returns to foreground so the user
  // dismissing the system dialog (which leaves the activity intact)
  // updates the UI without a full mount. batteryBannerDismissed is
  // per-session, mirroring the iOS permission banner.
  const [battery, setBattery] = useState({ supported: null, exempt: false })
  const [batteryBannerDismissed, setBatteryBannerDismissed] = useState(false)
  // GrapheneOS / de-Googled Android: the OS network-location provider can be
  // off, which freezes a stationary indoor phone's shared position. The shell
  // emits networkLocation:status on foreground (Android only; the event never
  // fires on iOS). Combined with the user's own location being stale, this
  // drives a dismissible banner. Default off = no banner until we hear
  // otherwise, so no cold-start flash.
  const [networkLocationOff, setNetworkLocationOff] = useState(false)
  const [networkBannerDismissed, setNetworkBannerDismissed] = useState(false)
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
  // Two-week donation reminder (PearCal/PearGuard parity). Skipped on
  // iOS per App Store guideline 3.1.1; on Android, set true at mount
  // when the shell reports {shown:false, elapsedMs >= 14 days}.
  const [donateReminderVisible, setDonateReminderVisible] = useState(false)
  // MapLibre style URL. Hydrated from AsyncStorage (via shell:tileStyle:get)
  // on mount; passed down to HomeMapView -> CircleMap so the map can hot-
  // swap on edit. Settings -> Map tiles writes through both AsyncStorage
  // and this state via setTileStyleUrlAndPersist.
  const [tileStyleUrl, setTileStyleUrl] = useState(DEFAULT_TILE_STYLE_URL)
  // Publish on window so the region downloader (lives in a sibling
  // module, not in the React tree) can discover the active tile
  // source URL without prop-drilling.
  useEffect(() => { window.__pearTileStyleUrl = tileStyleUrl }, [tileStyleUrl])
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
  // Theme mode preference. CSS variables in the pearcircle-theme-vars
  // <style> block resolve via document.documentElement[data-theme="..."],
  // which setTheme() flips. Hydrated from AsyncStorage on mount; default
  // dark (matches the pre-toggle look). Persists via shell:theme:set.
  const [themeMode, setThemeMode] = useState('dark')
  const setThemeModeAndPersist = useCallback(async (mode) => {
    const next = mode === 'light' ? 'light' : 'dark'
    setTheme(next)
    try { await pear.call('shell:theme:set', { theme: next }) } catch {}
    setThemeMode(next)
  }, [])
  // First-run onboarding state. Both flags hydrate from AsyncStorage
  // (shell:onboarding:get) on mount; `loaded` gates the modal so we
  // don't flash it on cold start before the IPC resolves. Order of
  // operations is: OnboardingFlow shows first (welcome + name + pair
  // choice), on complete it flips both flags so the Tour fires next
  // over the live map UI, on tour done/skip the tour flag clears.
  const [onboardingComplete, setOnboardingComplete] = useState(true)
  const [tourPending, setTourPending] = useState(false)
  const [onboardingLoaded, setOnboardingLoaded] = useState(false)
  // Status bar icon tint: light (white) icons on dark surfaces, dark
  // icons on the bare map view. The bare map area is the only place
  // where the status bar sits over a light background; every other
  // overlay we mount -- sheets, banners, onboarding/tour scrims, the
  // priming and donation modals -- is darkly colored, so they all
  // need the default light icons to stay legible. The floating menu
  // pill on the home view sits BELOW the status bar (safe-area-inset
  // + 12px), so it doesn't enter the icon-overlap area.
  useEffect(() => {
    const bannerShowing =
      permissionStatus !== 'always' &&
      permissionStatus !== 'unknown' &&
      permissionStatus !== 'notDetermined' &&
      !bannerDismissed
    const batteryBannerShowing =
      battery.supported === true &&
      !battery.exempt &&
      !batteryBannerDismissed
    const overlayShowing =
      !!sheet ||
      primingVisible ||
      donateReminderVisible ||
      (onboardingLoaded && !onboardingComplete) ||
      tourPending ||
      bannerShowing ||
      batteryBannerShowing
    const style = overlayShowing ? 'light' : 'dark'
    pear.call('shell:statusBar:set', { style }).catch(() => {})
  }, [sheet, primingVisible, donateReminderVisible, onboardingLoaded, onboardingComplete, tourPending, permissionStatus, bannerDismissed, battery.supported, battery.exempt, batteryBannerDismissed])
  const persistOnboarding = useCallback(async (patch) => {
    try { await pear.call('shell:onboarding:set', patch) } catch {}
  }, [])

  const refresh = useCallback(async () => {
    const [id, pr, sh] = await Promise.all([
      pear.call('identity:get'),
      pear.call('profile:get'),
      pear.call('sharing:get').catch(() => ({ sharing: {}, anyEnabled: true })),
    ])
    setIdentity(id)
    setProfile(pr ?? null)
    setSharing(toSharingState(sh))
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
    pear.call('shell:theme:get').then((r) => {
      const mode = r?.theme === 'light' ? 'light' : 'dark'
      setTheme(mode)
      setThemeMode(mode)
    }).catch(() => {})
    pear.call('shell:onboarding:get').then((r) => {
      setOnboardingComplete(!!r?.complete)
      setTourPending(!!r?.tourPending)
      setOnboardingLoaded(true)
    }).catch(() => { setOnboardingLoaded(true) })
    pear.on('ready', refresh)
    pear.on('sharing:changed', ({ circleId, enabled, expiresAt, anyEnabled }) => {
      // Merge the per-circle update into the local map without losing
      // sibling circles' state. anyEnabled rides on the event from the
      // worklet so we don't have to recompute against stale state.
      setSharing((prev) => {
        const map = { ...prev.map }
        if (typeof circleId === 'string') {
          map[circleId] = {
            enabled: enabled !== false,
            expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
          }
        }
        return {
          map,
          anyEnabled: anyEnabled !== false,
          anyPaused: anyPausedFrom(map),
        }
      })
    })
    // iOS Always-location priming flow. Shell sends `permission:prime`
    // before the first system dialog (notDetermined state) so we can
    // explain why Always is needed. After the user picks (Always /
    // WhenInUse / Don't Allow / Allow Once), shell publishes the
    // resulting status via `permission:status` so the home banner
    // can nudge declined / stuck users toward Settings.
    pear.on('permission:prime', () => {
      setPrimingVisible(true)
    })
    pear.on('permission:status', ({ status }) => {
      if (typeof status === 'string') setPermissionStatus(status)
    })
    // Android network-location provider state (off = potential frozen
    // position on GrapheneOS). Only emitted on Android; iOS never fires it.
    pear.on('networkLocation:status', ({ enabled }) => {
      if (typeof enabled === 'boolean') setNetworkLocationOff(!enabled)
    })
    // Pull the current status once on mount. The shell also emits on
    // startUpdates and on AppState.active, but on a cold launch the
    // shell's emit fires before the WebView finishes loading and the
    // injectJavaScript silently drops — so without this pull the banner
    // only appeared after the first background/foreground cycle.
    pear.call('shell:permission:status').then((r) => {
      if (r && typeof r.status === 'string') setPermissionStatus(r.status)
    }).catch(() => {})
    // Same cold-boot pull for the network-location provider, so the banner
    // can appear on a fresh launch with network location already off (the
    // shell's app:state emit would otherwise be dropped before mount).
    pear.call('shell:location:networkEnabled').then((r) => {
      if (r && typeof r.enabled === 'boolean') setNetworkLocationOff(!r.enabled)
    }).catch(() => {})
    // Two-week donation reminder check. Skipped on iOS per App Store
    // policy 3.1.1 (same gating as the About page's Support section).
    const isIOSPlatform = typeof window !== 'undefined' && window.__pearPlatform === 'ios'
    if (!isIOSPlatform) {
      const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
      pear.call('shell:donateReminder:get').then((r) => {
        if (!r || r.shown) return
        if (typeof r.elapsedMs === 'number' && r.elapsedMs >= FOURTEEN_DAYS_MS) {
          setDonateReminderVisible(true)
        }
      }).catch(() => {})
    }
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
        return [...prev, { circleId, circleName: circleName || 'Circle', kind: 'deleted' }]
      })
    })
    // Owner removed us from a circle (proposal 2026-05-03 §3). The
    // worklet emits this when a removed:{ourPubkey} tombstone lands.
    // Same one-shot notice + cleanup path as circle:deleted.
    pear.on('circle:removed-self', ({ circleId, circleName }) => {
      if (typeof circleId !== 'string') return
      setDeletedNotices((prev) => {
        if (prev.some((n) => n.circleId === circleId)) return prev
        return [...prev, { circleId, circleName: circleName || 'Circle', kind: 'removed' }]
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

  // Poll for migration nudges: any circle we're a non-owner member of that
  // carries a supersede record pointing at a circle we have NOT joined yet.
  // Light poll (every 8s while no nudge is showing) — supersede records are
  // rare and low-volume, and the worklet read is cheap.
  useEffect(() => {
    const ourKey = identity?.publicKey
    if (!ourKey) return
    let cancelled = false
    const scan = async () => {
      if (migrationNudge) return // one at a time; don't churn while one is up
      try {
        const snap = await pear.call('circles:getAll')
        if (cancelled) return
        const circles = (snap?.circles ?? []).filter(c => !c.error && !c.circle?.deleted)
        const joinedIds = new Set(circles.map(c => c.circleId))
        for (const c of circles) {
          // The owner of the old circle authored the record and already holds
          // the new circle — no nudge for them.
          if (c.circle?.ownerKey === ourKey) continue
          for (const sp of (c.supersedes ?? [])) {
            if (!sp?.newCircleId || !sp?.invite) continue
            if (joinedIds.has(sp.newCircleId)) continue
            if (dismissedNudgesRef.current.has(sp.newCircleId)) continue
            setMigrationNudge({
              oldCircleId: c.circleId,
              oldName: c.circle?.name || 'your circle',
              newCircleId: sp.newCircleId,
              name: sp.name || c.circle?.name || 'the circle',
              invite: sp.invite,
            })
            return
          }
        }
      } catch {}
    }
    scan()
    const id = setInterval(scan, 8000)
    return () => { cancelled = true; clearInterval(id) }
  }, [identity, migrationNudge])

  // Join the new circle then leave the old one (one-tap migration). On any
  // failure we surface nothing destructive: the leave only runs after a
  // successful join, so a member never loses the old circle without the new.
  const acceptMigration = useCallback(async () => {
    if (!migrationNudge) return
    setMigrationBusy(true)
    try {
      await pear.call('circle:join', { invite: migrationNudge.invite })
      try { await pear.call('circle:leave', { circleId: migrationNudge.oldCircleId }) } catch {}
      setMigrationNudge(null)
      refresh()
    } catch (e) {
      // Leave the nudge up so the user can retry; surface via a deleted-style
      // notice would be noisy, so we just keep the modal and stop the spinner.
      console.warn('[ui] migration join failed', e?.message ?? e)
    } finally {
      setMigrationBusy(false)
    }
  }, [migrationNudge, refresh])

  const dismissMigration = useCallback(() => {
    if (migrationNudge) dismissedNudgesRef.current.add(migrationNudge.newCircleId)
    setMigrationNudge(null)
  }, [migrationNudge])

  // Dismiss the head notice: tell the worklet to free local state, then
  // pop it from the queue.
  const dismissDeletedNotice = useCallback(async (circleId) => {
    try { await pear.call('circle:cleanup-deleted', { circleId }) } catch {}
    setDeletedNotices((prev) => prev.filter((n) => n.circleId !== circleId))
    refresh()
  }, [refresh])

  // Flip the sharing toggle for a single circle. UI subscribers see
  // the sharing:changed event and re-render. The shell listens for the
  // same event and starts/stops the native foreground location service
  // when `anyEnabled` flips, so UI no longer toggles FGS directly.
  // expiresAt is a future ms timestamp for time-bounded mute;
  // null/omitted = indefinite.
  const setSharingForCircle = useCallback(async (circleId, enabled, expiresAt = null) => {
    await pear.call('sharing:set', { circleId, enabled, expiresAt })
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
        sharing={!sharing.anyPaused}
        tileStyleUrl={tileStyleUrl}
        setView={setView}
        setSheet={setSheet}
        initialSelectedCircleId={view.selectCircle ?? null}
        initialFocus={view.focus ?? null}
        permissionStatus={permissionStatus}
        bannerDismissed={bannerDismissed}
        onPermissionBannerDismiss={() => setBannerDismissed(true)}
        battery={battery}
        batteryBannerDismissed={batteryBannerDismissed}
        onBatteryBannerDismiss={() => setBatteryBannerDismissed(true)}
        onOpenBatteryAdvanced={() => setSheet({ name: 'settings', expand: 'battery' })}
        networkLocationOff={networkLocationOff}
        networkBannerDismissed={networkBannerDismissed}
        onNetworkBannerDismiss={() => setNetworkBannerDismissed(true)}
        tourActive={onboardingLoaded && onboardingComplete && tourPending && !sheet}
      />
      <SheetContainer open={sheet?.name === 'settings'}>
        <ProfileView
          active={sheet?.name === 'settings'}
          profile={profile}
          sharing={sharing}
          setSharingForCircle={setSharingForCircle}
          tileStyleUrl={tileStyleUrl}
          setTileStyleUrl={setTileStyleUrlAndPersist}
          distanceUnit={distanceUnit}
          setDistanceUnit={setDistanceUnitAndPersist}
          themeMode={themeMode}
          setThemeMode={setThemeModeAndPersist}
          battery={battery}
          initialExpand={sheet?.name === 'settings' ? sheet.expand : null}
          onClose={closeSheet}
          onSaved={refresh}
        />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'trips'}>
        <TripsView
          active={sheet?.name === 'trips'}
          ownerPubkey={sheet?.name === 'trips' ? sheet.ownerPubkey : null}
          myPubkey={identity?.publicKey ?? null}
          ownerName={sheet?.name === 'trips' ? sheet.ownerName : null}
          distanceUnit={distanceUnit}
          tileStyleUrl={tileStyleUrl}
          onOpenTrip={(startTs) => setSheet({
            name: 'tripDetail',
            startTs,
            ownerPubkey: sheet?.name === 'trips' ? sheet.ownerPubkey : null,
            ownerName: sheet?.name === 'trips' ? sheet.ownerName : null,
            returnTo: { name: 'trips', ownerPubkey: sheet?.name === 'trips' ? sheet.ownerPubkey : null, ownerName: sheet?.name === 'trips' ? sheet.ownerName : null },
          })}
          onClose={closeSheet}
        />
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'tripDetail'}>
        {sheet?.name === 'tripDetail' && (
          <TripDetailView
            startTs={sheet.startTs}
            ownerPubkey={sheet.ownerPubkey ?? null}
            myPubkey={identity?.publicKey ?? null}
            ownerName={sheet.ownerName ?? null}
            distanceUnit={distanceUnit}
            tileStyleUrl={tileStyleUrl}
            onBack={() => setSheet(sheet.returnTo ?? { name: 'trips' })}
          />
        )}
      </SheetContainer>
      <SheetContainer open={sheet?.name === 'about'}>
        <AboutView
          onClose={closeSheet}
          initialExpand={sheet?.name === 'about' ? sheet.expand : null}
          onReplayOnboarding={() => {
            setOnboardingComplete(false)
            setTourPending(false)
            persistOnboarding({ complete: false, tourPending: false })
          }}
        />
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
          kind={deletedNotices[0].kind}
          onDismiss={() => dismissDeletedNotice(deletedNotices[0].circleId)}
        />
      )}
      {migrationNudge && (
        <MigrationNudgeModal
          nudge={migrationNudge}
          busy={migrationBusy}
          onJoin={acceptMigration}
          onLater={dismissMigration}
        />
      )}
      {primingVisible && (
        <PermissionPrimingModal
          onContinue={async () => {
            // Fire-and-forget; we close the modal optimistically. The
            // status emit from the shell will arrive shortly after the
            // user picks an option in the iOS system dialog and will
            // drive any subsequent banner.
            setPrimingVisible(false)
            try { await pear.call('shell:permission:proceed') } catch {}
          }}
        />
      )}
      {donateReminderVisible && (
        <DonationReminderModal
          onDismiss={async () => {
            setDonateReminderVisible(false)
            try { await pear.call('shell:donateReminder:setShown') } catch {}
          }}
          onDonate={async () => {
            setDonateReminderVisible(false)
            try { await pear.call('shell:donateReminder:setShown') } catch {}
            // Hand the user to the About sheet with Support-development
            // pre-expanded. The shared lightning flow lives there
            // (canOpenURL probe → lightning: URI or wallet picker).
            setSheet({ name: 'about', expand: 'support' })
          }}
        />
      )}
      {/* First-run onboarding (welcome → name → create/join). Gated on
          the hydrated AsyncStorage flag so we don't flash on cold start
          before the IPC resolves. */}
      {onboardingLoaded && !onboardingComplete && (
        <OnboardingFlow
          profile={profile}
          battery={battery}
          onCreate={() => setSheet({ name: 'create' })}
          onJoin={() => setSheet({ name: 'join' })}
          onComplete={() => {
            setOnboardingComplete(true)
            setTourPending(true)
            persistOnboarding({ complete: true, tourPending: true })
          }}
          onSkip={() => {
            setOnboardingComplete(true)
            setTourPending(true)
            persistOnboarding({ complete: true, tourPending: true })
          }}
        />
      )}
      {/* Spotlight tour over the live map UI. Runs once after onboarding;
          the "Reset onboarding" entry in About re-arms both flags. */}
      {onboardingLoaded && onboardingComplete && tourPending && !sheet && (
        <Tour
          steps={TOUR_STEPS}
          onDone={() => {
            setTourPending(false)
            persistOnboarding({ tourPending: false })
          }}
          onSkip={() => {
            setTourPending(false)
            persistOnboarding({ tourPending: false })
          }}
        />
      )}
    </>
  )
}

// Two-week donation reminder modal (PearCal/PearGuard parity). Mounted
// at App scope and triggered once when the install is at least 14 days
// old and the user hasn't already dismissed. Skipped on iOS at the
// trigger layer per App Store guideline 3.1.1 — there's no donation
// surface on iOS yet so a prompt would be both off-policy and
// dead-end. Donate routes through the same lightning-address flow
// AboutView uses (lightning: URI if a wallet handler is registered,
// fallback wallet picker if not). All three buttons (Donate / Maybe
// later / Already donated) dismiss + persist shown=true so the modal
// only fires once per install.
function DonationReminderModal ({ onDismiss, onDonate }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 360,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.75)',
      padding: spacing.lg,
    }}>
      <div style={{
        width: '100%', maxWidth: 360,
        background: colors.surface.card,
        borderRadius: radius.lg,
        padding: `${spacing.lg + 8}px ${spacing.lg}px`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: spacing.base,
        textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 52, lineHeight: 1 }}>⚡</div>
        <div style={{ ...typography.heading, margin: 0, color: colors.text.primary }}>
          Enjoying PearCircle?
        </div>
        <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.6, margin: 0 }}>
          PearCircle is free and open source with no ads, accounts, or subscriptions. If you've received value from it, consider returning value to support development.
        </div>
        <button
          onClick={onDonate}
          style={{
            width: '100%', padding: '13px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.md,
            fontFamily: typography.fontFamily, fontSize: 15, fontWeight: 400,
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
          }}
        >
          Donate
        </button>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', color: colors.text.muted,
            fontSize: 13, fontWeight: 400, cursor: 'pointer',
            fontFamily: typography.fontFamily, padding: '4px',
          }}
        >
          Maybe later
        </button>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', color: colors.text.muted,
            fontSize: 13, fontWeight: 400, cursor: 'pointer',
            fontFamily: typography.fontFamily, padding: '4px',
          }}
        >
          Already donated ✓
        </button>
      </div>
    </div>
  )
}

// One-shot priming modal that runs before the iOS Always-location
// system dialog (Apple lets us trigger that dialog ONCE per install,
// so we set expectations carefully first). Plain card centered over a
// dim scrim, single Continue button. Skipped on Android (no equivalent
// permission tier) and on iOS for users whose status is already
// determined.
function PermissionPrimingModal ({ onContinue }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 350,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)',
      padding: spacing.lg,
    }}>
      <div style={{
        width: '100%', maxWidth: 360,
        background: colors.surface.card,
        borderRadius: radius.lg,
        padding: spacing.lg,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ ...typography.heading, margin: `0 0 ${spacing.base}px`, color: colors.text.primary }}>
          Location access
        </h2>
        <p style={{ ...typography.body, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.base, lineHeight: 1.5 }}>
          PearCircle uses your location to share live position with your circles and notify them when you arrive at or leave the Places you've set.
        </p>
        <p style={{ ...typography.body, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.base, lineHeight: 1.5 }}>
          On the next screen, choose <strong style={{ color: colors.text.primary, fontWeight: 400 }}>Always</strong> so sharing keeps working when the app is in the background. <strong style={{ color: colors.text.primary, fontWeight: 400 }}>While Using App</strong> works too, but sharing pauses whenever you leave the app.
        </p>
        <p style={{ ...typography.body, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.lg, lineHeight: 1.5 }}>
          PearCircle will also ask for <strong style={{ color: colors.text.primary, fontWeight: 400 }}>Motion &amp; Fitness</strong> access. It uses this to notice when you start moving so the map stays fresh without keeping GPS on while you are still.
        </p>
        <button
          onClick={onContinue}
          style={{
            width: '100%', padding: '12px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.md,
            fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 400,
            cursor: 'pointer',
          }}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

// In-app banner shown at the top of the map when iOS location permission
// is below 'always' (and not dismissed for the session). Apple permits
// deep-linking to the app's Settings entry via openSettingsURLString,
// which is what shell:openSettings does. The banner stays dismissable
// because some users genuinely don't want Always — we explain it once
// and trust them.
function PermissionBanner ({ status, onOpenSettings, onDismiss }) {
  const headline = status === 'denied' || status === 'restricted'
    ? 'Location turned off'
    : 'Sharing pauses when the app is closed'
  const body = status === 'denied' || status === 'restricted'
    ? "PearCircle can't share your location. Turn it on in Settings to keep your circles in sync."
    : "You've allowed location only while using the app. Set it to Always so sharing keeps running in the background."
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
      padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
      background: 'rgba(26,26,26,0.92)',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      {/* Dismiss × stays absolutely positioned in the top-right corner
          so the headline + body + button can center within the full
          banner width without being shifted by the close button. */}
      <button
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
          right: spacing.sm,
          background: 'transparent', border: 'none', color: colors.text.secondary,
          fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
        }}
      >×</button>
      <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
        <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>{headline}</div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>{body}</div>
        <button
          onClick={onOpenSettings}
          style={{
            display: 'inline-block',
            marginTop: spacing.sm,
            padding: '6px 14px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.sm,
            fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400,
            cursor: 'pointer',
          }}
        >
          Open Settings
        </button>
      </div>
    </div>
  )
}

// Android-only banner shown at the top of the map when Doze battery
// optimization is still on for PearCircle. Tapping the action opens
// the in-app Settings sheet with the Advanced section pre-expanded,
// where the existing "Disable battery optimization" button fires the
// system dialog. Routing through the in-app surface (vs deep-linking
// straight to the OS dialog) teaches the user where the toggle lives
// for future re-enables and keeps the recovery path discoverable
// after dismissal.
function BatteryOptBanner ({ onOpenSettings, onDismiss }) {
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
      padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
      background: 'rgba(26,26,26,0.92)',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <button
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
          right: spacing.sm,
          background: 'transparent', border: 'none', color: colors.text.secondary,
          fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
        }}
      >×</button>
      <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
        <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>Battery optimization is on</div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
          Android may pause background sharing during long idle. Turn it off for PearCircle to keep your circle in sync.
        </div>
        <button
          onClick={onOpenSettings}
          style={{
            display: 'inline-block',
            marginTop: spacing.sm,
            padding: '6px 14px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.sm,
            fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400,
            cursor: 'pointer',
          }}
        >
          Open Settings
        </button>
      </div>
    </div>
  )
}

// Show the network-location nudge only when the user's own position has been
// stale this long (1h). Gating on staleness, not just "network off", keeps it
// from nagging de-Googled users who are mobile / near a window and fine.
const NETWORK_BANNER_STALE_MS = 60 * 60 * 1000

// Freshness window for the map pin's tri-state dot (UX audit item d). A
// connected peer whose last fix is newer than this shows green ("live"),
// older shows amber ("stale but online"). 2 min is more forgiving than the
// row label's 60s LIVE_THRESHOLD_MS since periodic location updates can space
// out, and we don't want a moving peer's dot flickering amber between fixes.
const PIN_FRESH_MS = 2 * 60 * 1000

// Consecutive 3s-refresh failures before the "Sync interrupted" banner shows
// (~15s of a continuously-throwing worklet). High enough that a one-off hiccup
// or a brief reconnection blip stays silent (console.warn only).
const SYNC_FAIL_BANNER_THRESHOLD = 5

// Android-only banner for de-Googled ROMs (notably GrapheneOS) where the OS
// network-location provider is off, so a stationary indoor phone can't get a
// fix and its shared position freezes. Surfaced only when the user's own
// location has actually gone stale. Network location is a deliberate privacy
// choice on these ROMs, so the copy is informational and honest about the
// tradeoff rather than prescriptive, and the banner is dismissible.
function NetworkLocationBanner ({ onOpenSettings, onDismiss }) {
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
      padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
      background: 'rgba(26,26,26,0.92)',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <button
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
          right: spacing.sm,
          background: 'transparent', border: 'none', color: colors.text.secondary,
          fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
        }}
      >×</button>
      <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
        <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>Your location isn't updating</div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
          Network location is off, so your phone can't place you indoors without GPS. Open Settings, then turn on <strong style={{ fontWeight: 500, color: colors.text.primary }}>Location services &rarr; Network location</strong> to be seen again.
        </div>
        <button
          onClick={onOpenSettings}
          style={{
            display: 'inline-block',
            marginTop: spacing.sm,
            padding: '6px 14px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.sm,
            fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400,
            cursor: 'pointer',
          }}
        >
          Open Location settings
        </button>
      </div>
    </div>
  )
}

// Top-of-map notice when the home refresh has failed repeatedly (worklet
// wedged / IPC stalled), so the map is showing last-good data that may be
// silently frozen (UX audit item f). No action button -- there's nothing the
// user can tap to fix a wedged worklet -- just an honest "data may be stale"
// signal. Dismissible per session; re-arms automatically once a poll succeeds.
function SyncInterruptedBanner ({ onDismiss }) {
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
      padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
      background: 'rgba(26,26,26,0.92)',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <button
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
          right: spacing.sm,
          background: 'transparent', border: 'none', color: colors.text.secondary,
          fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
        }}
      >×</button>
      <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
        <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>Sync interrupted</div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
          Can't reach the background service, so locations may be out of date. Reopen the app if this persists.
        </div>
      </div>
    </div>
  )
}

// Top-of-map nudge when one or more circles are wedged (needsRepair) and not
// already repairing. Primary, discoverable surface for the rebuild -- the
// per-avatar member-sheet button is too hidden for most users to find. The
// action opens a confirm-with-explainer first (repair pauses sharing and
// rebuilds from peers), it isn't a one-tap toggle. Dismissible per session;
// the persisted degraded flag re-surfaces it next launch.
function RepairBanner ({ count, circleName, onRepair, onDismiss }) {
  const headline = count > 1 ? `${count} circles need repair` : `${circleName || 'A circle'} needs repair`
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
      padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
      background: 'rgba(26,26,26,0.92)',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <button
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
          right: spacing.sm,
          background: 'transparent', border: 'none', color: colors.text.secondary,
          fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
        }}
      >×</button>
      <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
        <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>{headline}</div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
          {count > 1 ? 'Their data is stuck' : "This circle's data is stuck"}, so members' locations may be out of sync. Repairing rebuilds {count > 1 ? 'them' : 'it'} from your peers.
        </div>
        <button
          onClick={onRepair}
          style={{
            display: 'inline-block', marginTop: spacing.sm, padding: '6px 14px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.sm,
            fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400, cursor: 'pointer',
          }}
        >
          Repair
        </button>
      </div>
    </div>
  )
}

// How long an in-process repair may run before we stop promising it will
// finish and escalate to "leave and rejoin". A healthy re-sync converges well
// under this; the wedges that never converge (oplog bloat, forked view) would
// otherwise spin "Repairing…" forever.
const REPAIR_ESCALATE_MS = 75_000

// Indeterminate "Repairing…" indicator. circle:repair returns in seconds but
// the actual re-sync from the seeder + writer re-admission run async and can
// take a long time, so this persists (via the worklet's `repairing` flag)
// until the rebuilt base is functional again. While it's progressing there's
// no action; once it crosses REPAIR_ESCALATE_MS (escalated) we tell the user
// some wedges can't be repaired and point them at leave + rejoin.
function RepairingBanner ({ count, circleName, needsRestart = false, escalated = false, onResolve }) {
  const target = count > 1 ? `${count} circles` : (circleName || 'circle')
  const bannerStyle = {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
    padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
    background: 'rgba(26,26,26,0.92)',
    borderBottom: `1px solid ${colors.border}`,
  }
  // Escalated: the re-sync isn't converging. Some wedges (stuck/bloated or
  // forked data) can't be rebuilt from peers; the reliable fix is to leave the
  // circle and rejoin from a fresh invite. Not shown for the restart-staged
  // case, which still has a real path ("reopen the app").
  if (escalated && !needsRestart) {
    return (
      <div style={bannerStyle}>
        <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>
            Repair is taking longer than usual
          </div>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
            Some stuck data can't be rebuilt this way. If {count > 1 ? 'a circle' : (circleName || 'the circle')} still looks out of sync, leave it and rejoin from a fresh invite (ask the circle's owner to send a new one).
          </div>
          {onResolve && (
            <button
              onClick={onResolve}
              style={{
                display: 'inline-block', marginTop: spacing.sm, padding: '6px 14px',
                background: colors.primary, color: colors.text.onPrimary,
                border: 'none', borderRadius: radius.sm,
                fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400, cursor: 'pointer',
              }}
            >
              Open circle settings
            </button>
          )}
        </div>
      </div>
    )
  }
  const label = needsRestart
    ? `Finishing repair of ${target}`
    : (count > 1 ? `Repairing ${count} circles…` : `Repairing ${circleName || 'circle'}…`)
  const sub = needsRestart
    ? 'Reopen the app to finish repairing.'
    : 'This can take a while. Your circle will catch up in the background.'
  return (
    <div style={bannerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: `0 ${spacing.lg}px` }}>
        {!needsRestart && (
          <span style={{
            width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${colors.border}`, borderTopColor: colors.primary,
            animation: 'pearcircle-focus-spin 0.8s linear infinite', display: 'inline-block',
          }} />
        )}
        <div style={{ textAlign: needsRestart ? 'center' : 'left' }}>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>{label}</div>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
            {sub}
          </div>
        </div>
      </div>
    </div>
  )
}

// Confirm-with-explainer before a rebuild, since it pauses sharing and runs a
// long re-sync. Repairs every wedged circle on confirm.
function RepairConfirmModal ({ circles, onConfirm, onCancel }) {
  const single = circles.length === 1
  const name = single ? (circles[0]?.circle?.name || 'this circle') : `${circles.length} circles`
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 360,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.7)', padding: spacing.lg,
    }}>
      <div style={{
        width: '100%', maxWidth: 360,
        background: colors.surface.card, borderRadius: radius.lg,
        padding: spacing.lg, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ ...typography.heading, margin: `0 0 ${spacing.base}px`, color: colors.text.primary }}>
          Repair {name}?
        </h2>
        <p style={{ ...typography.body, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.base, lineHeight: 1.5 }}>
          This rebuilds {single ? 'the circle' : 'these circles'} from your peers to fix the stuck data. Your sharing pauses briefly and it can take a while to catch up. Your identity and history are kept.
        </p>
        <div style={{ display: 'flex', gap: spacing.sm, marginTop: spacing.base }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: '12px', background: 'transparent',
              color: colors.text.secondary, border: `1px solid ${colors.border}`,
              borderRadius: radius.md, fontFamily: typography.fontFamily, fontSize: 14, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: '12px', background: colors.primary, color: colors.text.onPrimary,
              border: 'none', borderRadius: radius.md, fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 400, cursor: 'pointer',
            }}
          >
            Repair
          </button>
        </div>
      </div>
    </div>
  )
}

// Modal alert shown when a circle leaves the user involuntarily: the
// owner deleted it (kind 'deleted', circle:deleted) or the owner removed
// this member (kind 'removed', circle:removed-self). One-shot per circle:
// dismiss runs circle:cleanup-deleted on the worklet side which frees
// local state and removes the circle from the dropdown / sheets. zIndex
// sits above SheetContainer (100) and the BottomSheet (200) so the user
// can't miss it. Brand-aligned plain styling — no icons, no extra chrome.
function CircleDeletedNotice ({ circleName, kind = 'deleted', onDismiss }) {
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
          {kind === 'removed' ? 'Removed from circle' : 'Circle deleted'}
        </div>
        <div style={{ ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg }}>
          {kind === 'removed'
            ? <>You were removed from the circle <strong style={{ color: colors.text.primary, fontWeight: 400 }}>{circleName}</strong>. It's been removed from your circles. You can rejoin if you still have an invite link.</>
            : <>The owner deleted the circle <strong style={{ color: colors.text.primary, fontWeight: 400 }}>{circleName}</strong>. It's been removed from your circles.</>}
        </div>
        <button
          onClick={onDismiss}
          style={{
            width: '100%', padding: '12px', borderRadius: radius.md,
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', cursor: 'pointer',
            fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
          }}>
          OK
        </button>
      </div>
    </div>
  )
}

// Member-side migration nudge (proposal 2026-06-17). Shown when the owner of a
// circle we're in has recreated it on a fresh Autobase: one tap joins the new
// circle and leaves the old, so the member never silently faces two same-named
// circles. "Later" defers within the session.
function MigrationNudgeModal ({ nudge, busy = false, onJoin, onLater }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)', padding: spacing.lg,
    }}>
      <div style={{
        background: colors.surface.elevated, borderRadius: radius.lg,
        padding: spacing.lg, maxWidth: 400, width: '100%',
        border: `1px solid ${colors.border}`,
      }}>
        <div style={{ ...typography.heading, color: colors.text.primary, marginBottom: spacing.sm }}>
          Your group moved
        </div>
        <div style={{ ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg }}>
          The owner recreated <strong style={{ color: colors.text.primary, fontWeight: 400 }}>{nudge.name}</strong> on a fresh start. Join the new circle to keep sharing — your old copy is left behind automatically.
        </div>
        <button
          data-haptic='light'
          onClick={onJoin}
          disabled={busy}
          style={{
            width: '100%', padding: '12px', borderRadius: radius.md,
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', cursor: busy ? 'default' : 'pointer',
            fontFamily: typography.fontFamily, fontWeight: 500, fontSize: 14,
            opacity: busy ? 0.7 : 1, marginBottom: spacing.sm,
          }}>
          {busy ? 'Joining...' : 'Join the new circle'}
        </button>
        <button
          onClick={onLater}
          disabled={busy}
          style={{
            width: '100%', padding: '12px', borderRadius: radius.md,
            background: 'transparent', color: colors.text.secondary,
            border: `1px solid ${colors.border}`, cursor: busy ? 'default' : 'pointer',
            fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
            opacity: busy ? 0.5 : 1,
          }}>
          Later
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
    try {
      // retries:0 -- circle:create is non-idempotent; a retry after a slow but
      // successful first attempt would create a duplicate circle (item b).
      const r = await callWithTimeout('circle:create', { name: name.trim() }, { retries: 0 })
      if (r?.invite) {
        setResult(r)
        onCreated(r.circleId)
      } else {
        setError('Could not create circle')
      }
    } catch (e) {
      setError(e?.code === 'IPC_TIMEOUT'
        ? 'Creating the circle is taking too long. Please try again.'
        : 'Could not create circle')
    } finally {
      setCreating(false)
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
        <button style={{ ...s.primaryBtn, marginTop: spacing.md }} onClick={finish}>Done</button>
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
    callWithTimeout('circle:invite', { circleId })
      .then((r) => { if (!cancelled) setInvite(r?.invite ?? null) })
      .catch((e) => { if (!cancelled) setError(e?.code === 'IPC_TIMEOUT' ? 'Loading the invite is taking too long. Please reopen this sheet.' : String(e?.message ?? e)) })
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

// iOS-style sliding toggle switch. Fires a light haptic on flip. Used
// for the seeder auto-follow control; reusable for any boolean setting.
function ToggleSwitch ({ on, onChange, disabled = false }) {
  return (
    <button
      role='switch'
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        haptic('light')
        onChange?.(!on)
      }}
      style={{
        width: 44, height: 26, flexShrink: 0, padding: 0,
        position: 'relative', borderRadius: radius.full,
        background: on ? colors.primary : colors.surface.input,
        border: `1px solid ${on ? colors.primary : colors.border}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 20 : 2,
        width: 20, height: 20, borderRadius: '50%',
        background: on ? colors.text.onPrimary : colors.text.secondary,
        transition: 'left 0.15s ease, background 0.15s ease',
      }} />
    </button>
  )
}

// Top-level seeder management. Proposal amendment 2026-05-19 (global
// seeder setup): one section, not a per-circle thing. "Set up a seeder
// device" mints seed invites for every encrypted circle at once (no
// encryption key in any of them — that's the privacy boundary); the
// list shows each admitted seeder device grouped across its circles.
function SeedersSection ({ active = true }) {
  const [seeders, setSeeders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [bundle, setBundle] = useState(null)
  const [bundleInfo, setBundleInfo] = useState(null)
  const [minting, setMinting] = useState(false)
  const [confirmingRevoke, setConfirmingRevoke] = useState(null)
  const [confirmingRemove, setConfirmingRemove] = useState(null)
  const [pending, setPending] = useState(null)
  // Latest published seeder release tag, fetched once from GitHub so we can flag
  // out-of-date seeders (proposal 2026-06-05-seeder-update slice 2). The phone
  // does the compare; the seeder wire stays unchanged (it only reports its own
  // version). Best-effort: a fetch failure just means no "update available" hint.
  const [latestVersion, setLatestVersion] = useState(null)
  // QR pairing (proposal 2026-06-22): scan the seeder's "Pair a phone" QR and
  // push our circles to it over P2P, no copy-paste.
  const [pairing, setPairing] = useState(false)
  const [pairResult, setPairResult] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const r = await pear.call('seeders:listAll')
      setSeeders(r?.seeders ?? [])
      setError(null)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [])

  const scanSeeder = useCallback(async () => {
    setError(null); setPairResult(null)
    let text
    try {
      text = await pear.call('shell:scanQr')
    } catch (e) { setError('Scan failed: ' + (e?.message ?? e)); return }
    if (typeof text !== 'string' || text.trim().length === 0) return // cancelled
    setPairing(true)
    try {
      const r = await pear.call('seeder:pair:scan', { link: text.trim() })
      if (r?.ok) { setPairResult(r); refresh() }
      else setError(r?.error || 'Pairing failed')
    } catch (e) {
      const m = String(e?.message ?? e)
      setError(/invalid pairing link/i.test(m)
        ? 'That QR is not a seeder pairing code.'
        : (/timed out/i.test(m)
          ? "Could not reach the seeder. Make sure its dashboard is showing the QR, then try again."
          : m))
    } finally { setPairing(false) }
  }, [refresh])

  useEffect(() => {
    if (!active) return
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [active, refresh])

  // Fetch the latest published seeder version once per open of the section.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    fetch('https://api.github.com/repos/peerloomllc/pearcircle/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        if (cancelled || !rel?.tag_name) return
        setLatestVersion(String(rel.tag_name).replace(/^v/i, ''))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [active])

  const mintBundle = async () => {
    setMinting(true)
    setError(null)
    try {
      const r = await callWithTimeout('circle:invite:seed:all')
      if (!r?.bundle) {
        setBundle(null)
        setError('No encrypted circles yet. Seed invites need a circle created with encryption.')
      } else {
        setBundle(r.bundle)
        setBundleInfo({ count: r.invites?.length ?? 0, skipped: r.skipped ?? 0 })
      }
    } catch (e) {
      setError(e?.code === 'IPC_TIMEOUT' ? 'Minting the seed invite is taking too long. Please try again.' : String(e?.message ?? e))
    } finally {
      setMinting(false)
    }
  }

  // Revocation is per-circle at the protocol level; "revoke everywhere"
  // loops circle:seeder:revoke across every live circle this device seeds.
  const revokeEverywhere = async (seeder) => {
    setPending(seeder.pubkey)
    try {
      for (const circle of seeder.circles) {
        if (circle.revoked) continue
        await pear.call('circle:seeder:revoke', { circleId: circle.circleId, pubkey: seeder.pubkey })
      }
      await refresh()
      setConfirmingRevoke(null)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setPending(null)
    }
  }

  // Re-admit a seeder for every circle it was revoked from. Mirror of
  // revokeEverywhere — loops circle:seeder:approve. Re-admission must be an
  // explicit action: a revoked seeder no longer auto-re-admits when it
  // re-announces (proposal 2026-05-21 amendment, durable revocation).
  const reAdmit = async (seeder) => {
    setPending(seeder.pubkey)
    setError(null)
    try {
      for (const circle of seeder.revokedCircles) {
        await pear.call('circle:seeder:approve', { circleId: circle.circleId, pubkey: seeder.pubkey })
      }
      await refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setPending(null)
    }
  }

  // Forget a seeder device entirely (proposal 2026-06-17-seeder-leave
  // -propagation): writes a `left` tombstone for every circle it's in (live or
  // revoked) so it disappears from this list. The reliable fallback for a seeder
  // that left while no member was connected, so the in-band notice was missed.
  // If the same seeder ever reconnects + re-announces, it auto-re-admits fresh.
  const removeEverywhere = async (seeder) => {
    setPending(seeder.pubkey)
    setError(null)
    try {
      for (const circle of seeder.circles) {
        try { await pear.call('circle:seeder:remove', { circleId: circle.circleId, pubkey: seeder.pubkey }) } catch {}
      }
      await refresh()
      setConfirmingRemove(null)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setPending(null)
    }
  }

  const toggleFollow = async (seeder) => {
    setError(null)
    try {
      await pear.call('circle:seeder:follow:set', { pubkey: seeder.pubkey, enabled: !seeder.followed })
      await refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    }
  }

  const openURL = (url) => { try { pear.call('shell:openUrl', { url }) } catch {} }

  // Each seeder device, with its circles split into live and revoked. A
  // fully-revoked device stays in the list so the user can re-admit it —
  // durable revocation (proposal 2026-05-21 amendment) makes re-admission
  // an explicit action, so the row must remain reachable.
  const seederRows = seeders
    .map((sd) => ({
      ...sd,
      liveCircles: (sd.circles ?? []).filter((c) => !c.revoked),
      revokedCircles: (sd.circles ?? []).filter((c) => c.revoked),
    }))
    .filter((sd) => sd.liveCircles.length + sd.revokedCircles.length > 0)

  return (
    <div>
      <p style={s.muted}>
        A seeder is an always-on computer (a Raspberry Pi, an old laptop, a spare
        desktop) that keeps a copy of your circles' encrypted data. Without one, a
        circle only syncs while two members have the app open at the same moment.
        A seeder closes that gap, so everyone's locations and history stay current
        even when all the phones are asleep. It never receives the encryption key,
        so it cannot read anything it stores.
      </p>
      <p style={s.muted}>
        Install the free PearCircle Seeder app (macOS, Windows or Linux) on that
        computer, then set up a device below to link it to your circles.
      </p>
      {pairResult ? (
        <div style={{ ...s.section, textAlign: 'center' }}>
          <p style={{ margin: 0, color: colors.text.primary, fontSize: typography.body.fontSize }}>
            Paired! Now seeding {pairResult.enrolled} {pairResult.enrolled === 1 ? 'circle' : 'circles'}
            {Array.isArray(pairResult.names) && pairResult.names.length > 0 ? ` (${pairResult.names.join(', ')})` : ''}.
          </p>
          <button
            onClick={() => setPairResult(null)}
            style={{
              width: '100%', marginTop: spacing.sm, padding: `${spacing.sm + 2}px`,
              background: 'transparent', color: colors.text.primary,
              border: `1px solid ${colors.text.muted}`, borderRadius: radius.md,
              cursor: 'pointer', fontFamily: typography.fontFamily, fontSize: 14,
            }}>
            Done
          </button>
        </div>
      ) : (
        <>
          <button onClick={scanSeeder} disabled={pairing} style={s.primaryBtn}>
            {pairing ? 'Pairing...' : 'Scan seeder QR'}
          </button>
          <p style={{ ...s.muted, textAlign: 'center', marginTop: spacing.sm, marginBottom: 0 }}>
            On the seeder's dashboard, tap "Pair a phone" and scan the code.
          </p>
        </>
      )}
      <button
        onClick={mintBundle}
        disabled={minting}
        style={{
          width: '100%', marginTop: spacing.sm, padding: `${spacing.sm + 2}px`,
          background: 'transparent', color: colors.text.primary,
          border: `1px solid ${colors.text.muted}`, borderRadius: radius.md,
          cursor: 'pointer', fontFamily: typography.fontFamily, fontSize: 14,
        }}>
        {minting ? 'Building invites...' : 'Or set up by pasting an invite'}
      </button>
      <button
        onClick={() => openURL('https://github.com/peerloomllc/pearcircle/releases')}
        style={{
          width: '100%', marginTop: spacing.sm, padding: `${spacing.sm + 2}px`,
          background: 'transparent', color: colors.text.primary,
          border: `1px solid ${colors.text.muted}`, borderRadius: radius.md,
          cursor: 'pointer', fontFamily: typography.fontFamily, fontSize: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
        }}>
        Download the seeder app <ArrowSquareOut size={14} weight='thin' />
      </button>
      {error && <p style={s.error}>{error}</p>}

      {bundle && (
        <div style={{ marginTop: spacing.md }}>
          <p style={s.muted}>
            This bundle carries a seed invite for {bundleInfo?.count ?? 0}{' '}
            {bundleInfo?.count === 1 ? 'circle' : 'circles'}
            {bundleInfo?.skipped > 0
              ? ` (${bundleInfo.skipped} legacy circle${bundleInfo.skipped === 1 ? '' : 's'} skipped — only encrypted circles can use a seeder)`
              : ''}.
            Send it to your seeder device and paste it into the PearCircle Seeder app. Each
            circle's members still approve the seeder before it can replicate.
          </p>
          <textarea style={s.inviteBox} readOnly value={bundle} onFocus={(e) => e.target.select()} />
          <ShareButton text={bundle} title='Set up a PearCircle seeder' />
          <button
            onClick={() => { setBundle(null); setBundleInfo(null) }}
            style={{
              width: '100%', marginTop: spacing.sm, padding: `${spacing.sm + 2}px`,
              background: 'transparent', color: colors.text.primary,
              border: `1px solid ${colors.text.muted}`, borderRadius: radius.md,
              cursor: 'pointer', fontFamily: typography.fontFamily, fontSize: 14,
            }}>
            Done
          </button>
        </div>
      )}

      {loading && <p style={{ ...s.muted, marginTop: spacing.md }}>Loading...</p>}
      {!loading && seederRows.length === 0 && (
        <p style={{ ...s.muted, marginTop: spacing.md }}>
          No seeders admitted yet. Set one up above, then approve it when it announces.
        </p>
      )}
      {seederRows.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: `${spacing.md}px 0 0 0` }}>
          {seederRows.map((seeder) => {
            const isPending = pending === seeder.pubkey
            const labelLine = seeder.label || ('Seeder ' + seeder.pubkey.slice(0, 8))
            const liveNames = seeder.liveCircles.map((c) => c.name).join(', ')
            const revokedNames = seeder.revokedCircles.map((c) => c.name).join(', ')
            return (
              <li key={seeder.pubkey} style={{
                padding: `${spacing.sm}px 0`,
                borderBottom: `1px solid ${colors.divider}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...typography.body, color: colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {labelLine}
                    </div>
                    {seeder.liveCircles.length > 0 && (
                      <div style={{ ...typography.caption, color: colors.text.secondary }}>
                        Seeding {seeder.liveCircles.length} {seeder.liveCircles.length === 1 ? 'circle' : 'circles'}: {liveNames}
                      </div>
                    )}
                    {seeder.revokedCircles.length > 0 && (
                      <div style={{ ...typography.caption, color: colors.warn }}>
                        Revoked from {seeder.revokedCircles.length} {seeder.revokedCircles.length === 1 ? 'circle' : 'circles'}: {revokedNames}
                      </div>
                    )}
                    {/* Seeder build version + update flag (proposal 2026-06-05
                        -seeder-update slices 1+2). A non-null version shows the
                        build, and an "update available" hint when the latest
                        published release is newer; null means connected but on a
                        pre-version (out-of-date) build; undefined means not seen
                        this session, so we say nothing. */}
                    {typeof seeder.version === 'string' && (
                      isSeederVersionNewer(latestVersion, seeder.version) ? (
                        <div style={{ ...typography.caption, color: colors.warn }}>
                          Version {seeder.version} — update available (v{latestVersion})
                        </div>
                      ) : (
                        <div style={{ ...typography.caption, color: colors.text.secondary }}>
                          Version {seeder.version}{latestVersion ? ' — up to date' : ''}
                        </div>
                      )
                    )}
                    {seeder.version === null && (
                      <div style={{ ...typography.caption, color: colors.warn }}>
                        Version unknown — update recommended
                      </div>
                    )}
                  </div>
                  {seeder.liveCircles.length > 0 && (
                    <button
                      onClick={() => setConfirmingRevoke(seeder)}
                      disabled={isPending}
                      title='Revoke seeder'
                      aria-label='Revoke seeder'
                      style={iconBtnStyle({ disabled: isPending, destructive: true })}>
                      <Trash size={18} weight='regular' />
                    </button>
                  )}
                </div>
                {seeder.revokedCircles.length > 0 && (
                  <button
                    onClick={() => reAdmit(seeder)}
                    disabled={isPending}
                    style={{
                      width: '100%', marginTop: spacing.sm, padding: `${spacing.sm + 2}px`,
                      background: 'transparent', color: colors.text.primary,
                      border: `1px solid ${colors.text.muted}`, borderRadius: radius.md,
                      cursor: isPending ? 'not-allowed' : 'pointer', opacity: isPending ? 0.5 : 1,
                      fontFamily: typography.fontFamily, fontSize: 14,
                    }}>
                    {isPending ? 'Working...' : (seeder.revokedCircles.length === 1 ? 'Re-admit' : 'Re-admit all')}
                  </button>
                )}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: spacing.sm, marginTop: spacing.sm,
                }}>
                  <span style={{ ...typography.caption, color: colors.text.secondary }}>
                    Auto-follow new circles
                  </span>
                  <ToggleSwitch
                    on={!!seeder.followed}
                    disabled={isPending}
                    onChange={() => toggleFollow(seeder)}
                  />
                </div>
                {/* Forget this seeder entirely. Distinct from Revoke (which
                    keeps it listed for re-admit): Remove clears it from the
                    list. Use it for a seeder that left on its own. */}
                <button
                  onClick={() => setConfirmingRemove(seeder)}
                  disabled={isPending}
                  style={{
                    marginTop: spacing.sm, padding: 0,
                    background: 'transparent', border: 'none',
                    color: colors.text.muted, cursor: isPending ? 'not-allowed' : 'pointer',
                    fontFamily: typography.fontFamily, fontSize: 12, textDecoration: 'underline',
                  }}>
                  Remove from list
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {confirmingRevoke && (
        <ConfirmSheet
          title='Revoke seeder?'
          message={<>
            Revoke <strong>{confirmingRevoke.label || ('Seeder ' + confirmingRevoke.pubkey.slice(0, 8))}</strong> from
            all {confirmingRevoke.liveCircles.length} of its {confirmingRevoke.liveCircles.length === 1 ? 'circle' : 'circles'}?
            Members will refuse to replicate to it within seconds. You can re-admit it
            later from this list.
          </>}
          confirmLabel='Revoke'
          destructive
          busy={pending === confirmingRevoke.pubkey}
          onConfirm={() => revokeEverywhere(confirmingRevoke)}
          onClose={() => { if (pending !== confirmingRevoke.pubkey) setConfirmingRevoke(null) }}
        />
      )}
      {confirmingRemove && (
        <ConfirmSheet
          title='Remove seeder?'
          message={<>
            Remove <strong>{confirmingRemove.label || ('Seeder ' + confirmingRemove.pubkey.slice(0, 8))}</strong> from
            this list entirely? Use this when the seeder has stopped running or you took it off your circles.
            If it ever reconnects and announces again, it'll come back automatically.
          </>}
          confirmLabel='Remove'
          destructive
          busy={pending === confirmingRemove.pubkey}
          onConfirm={() => removeEverywhere(confirmingRemove)}
          onClose={() => { if (pending !== confirmingRemove.pubkey) setConfirmingRemove(null) }}
        />
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
  // Set when the worklet reports we re-joined a circle we're already in
  // (idempotent join, alreadyJoined: true). We still let the user open it,
  // but with a clear "already a member" notice instead of a silent
  // fake-success that looks identical to a fresh join.
  const [already, setAlready] = useState(null) // { circleId, name } | null

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
        if (r.alreadyJoined) {
          setAlready({ circleId: r.circleId, name: typeof r.name === 'string' && r.name ? r.name : null })
        } else {
          onJoined(r.circleId)
        }
      } else if (r?.error) {
        // Surface the worklet's real reason. The most common non-parse failure
        // is a circleId/circle mismatch (a malformed or stale invite).
        setError(/does not match/i.test(r.error)
          ? "This invite doesn't match the circle. It may be malformed or out of date."
          : r.error)
      } else {
        setError('Invalid invite')
      }
    } catch (e) {
      setJoining(false)
      setError(String(e?.message ?? e))
    }
  }

  if (already) {
    return (
      <div style={s.screen}>
        <BackBar onBack={onClose} title='Join Circle' />
        <div style={s.section}>
          <p style={{ fontSize: typography.subheading.fontSize, fontWeight: typography.subheading.fontWeight, marginTop: 0, marginBottom: spacing.sm }}>
            You're already a member
          </p>
          <p style={{ fontSize: typography.body.fontSize, color: colors.text.secondary, margin: 0 }}>
            {already.name ? `You've already joined "${already.name}".` : "You've already joined this circle."}
          </p>
        </div>
        <button style={s.primaryBtn} onClick={() => onJoined(already.circleId)}>
          {already.name ? `Open ${already.name}` : 'Open circle'}
        </button>
      </div>
    )
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

function HomeMapView ({ identity, profile, sharing, tileStyleUrl, setView, setSheet, initialSelectedCircleId = null, initialFocus = null, permissionStatus = 'always', bannerDismissed = false, onPermissionBannerDismiss = () => {}, battery = { supported: null, exempt: false }, batteryBannerDismissed = false, onBatteryBannerDismiss = () => {}, onOpenBatteryAdvanced = () => {}, networkLocationOff = false, networkBannerDismissed = false, onNetworkBannerDismiss = () => {}, tourActive = false }) {
  const [circles, setCircles] = useState([])
  const [selfSeen, setSelfSeen] = useState(null)
  // Circle-repair banner state. repairConfirmOpen gates the explainer modal;
  // repairBannerDismissed hides the needs-repair nudge for the session (it
  // re-surfaces next launch since the worklet persists the degraded flag).
  const [repairConfirmOpen, setRepairConfirmOpen] = useState(false)
  const [repairBannerDismissed, setRepairBannerDismissed] = useState(false)
  // Repair watchdog: a normal re-sync converges, but a wedge whose cause is in
  // the replicated data (lastSeen oplog bloat or a forked view) never becomes
  // writable, so "Repairing…" would spin forever with no completion. After
  // REPAIR_ESCALATE_MS of an in-process repair still unfinished, flip to
  // "leave and rejoin" guidance. The staged-for-restart case is excluded (it
  // has its own "reopen the app" message). See the watchdog effect below.
  const [repairEscalated, setRepairEscalated] = useState(false)
  // Consecutive failures of the 3s home refresh. A wedged worklet makes every
  // circles:getAll throw; the catch used to swallow it silently, so the UI
  // froze on last-good data with no hint (UX audit item f). Count failures and,
  // after SYNC_FAIL_BANNER_THRESHOLD in a row (~15s at the 3s cadence), surface
  // a dismissible "Sync interrupted" banner. Reset to 0 on the first success.
  const [syncFailCount, setSyncFailCount] = useState(0)
  const [syncBannerDismissed, setSyncBannerDismissed] = useState(false)
  // peerCount used to be a separate piece of state, summed across every
  // circle's peersByCircle entry — which double-counted a peer in N
  // circles and never narrowed to the active filter. It's now derived
  // from `connectedPubkeys` further down so the pill stays in sync with
  // the green dots on the pins.
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
  const [menuOpen, setMenuOpen] = useState(false)
  // Per-device mute set ('{circleId}:{placeId}'). Source of truth is the
  // RN shell; this is a local cache loaded on mount and updated on toggle.
  const [mutedPlaces, setMutedPlaces] = useState(() => new Set())
  const mapApiRef = useRef(null)
  // True while an avatar cluster is fanned out into its equidistant ring.
  // CircleMap owns the actual expand state (a ref driving the off-React
  // layout loop); this mirror lets the hardware-back handler take
  // precedence and collapse the fan-out before clearing focus / exiting.
  const [clusterSpread, setClusterSpread] = useState(false)
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
      setPeersByCircle(peersResp?.peers ?? {})
      // Healthy poll: clear any failure streak + re-arm the banner so a future
      // wedge can surface again after a recovery (UX audit item f).
      setSyncFailCount(0)
      setSyncBannerDismissed(false)
    } catch (e) {
      console.warn('[ui] home refresh failed (worklet may be wedged):', e?.message ?? e)
      setSyncFailCount((c) => c + 1)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    pear.on('peer:connected', refresh)
    pear.on('peer:disconnected', refresh)
    pear.on('circle:writer:added', refresh)
    // Repair lifecycle: refresh promptly so the needs-repair / Repairing…
    // banners flip without waiting for the next ~3s poll.
    pear.on('circle:degraded', refresh)
    pear.on('circle:repairing', refresh)
    pear.on('circle:repaired', refresh)
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
  // Guard against cold-start: when circles haven't loaded yet (refresh is
  // async) the array is empty and would falsely match "circle was removed".
  // Notification-tap routes set selectedCircleId before circles arrive, so
  // dropping it here would lose the requested filter.
  useEffect(() => {
    if (!selectedCircleId) return
    if (circles.length === 0) return
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

  // Auto-zoom flag — pill click handlers set this; the effect after
  // `data` is built consumes it. Decl here so the click handlers below
  // can mutate the ref; effect lives further down to avoid a TDZ on
  // `data`.
  const pendingCircleAutoZoomRef = useRef(false)

  // Pick the active subset based on the current filter.
  const activeCircles = selectedCircleId
    ? circles.filter(c => c.circleId === selectedCircleId)
    : circles
  const merged = mergeCircleSnapshots(activeCircles)

  // Pubkeys we currently have a Hyperswarm connection with, restricted
  // to members of the active circles. Drives the green online-dot
  // indicator on pin avatars.
  //
  // We take the UNION of `peersByCircle` across every circle and then
  // INTERSECT with the active circles' member lists, rather than just
  // reading `peersByCircle[activeCircle]` directly. Why: when two
  // peers share more than one circle, Hyperswarm gives them ONE
  // underlying connection and the announce side often sees an empty
  // or partial `info.topics` list. So our worklet may have tracked
  // the peer under only one of the shared circles' topic sets even
  // though the live connection covers all of them. The
  // union-then-intersect recovers the truth: "connected to this peer
  // AND they're a member of the circle I'm viewing."
  const connectedPubkeys = useMemo(() => {
    const anywhereConnected = new Set()
    for (const cid in peersByCircle ?? {}) {
      for (const pk of peersByCircle[cid] ?? []) anywhereConnected.add(pk)
    }
    const activeMembers = new Set()
    for (const c of activeCircles) {
      for (const m of c.members ?? []) {
        const pk = m.value?.pubkey
        if (pk) activeMembers.add(pk)
      }
    }
    const out = new Set()
    for (const pk of anywhereConnected) {
      if (activeMembers.has(pk)) out.add(pk)
    }
    return out
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
    // Overlay our own freshest fix (the worklet's in-memory `_selfLastSeen`,
    // delivered out-of-band via circles:getAll). Freshest-ts wins, NOT
    // fill-if-absent: after the phase-2 lastSeen cutover engages the worklet
    // stops dual-writing our own `lastSeen:{self}` to the Autobase view, and
    // neither the live channel (drops self-echoes) nor the last-known core
    // refresh (skips self) puts our own row back into the snapshot. So the
    // snapshot carries a FROZEN self entry, and a fill-if-absent guard let it
    // shadow the live `selfSeen` -- pinning our own marker + "last seen" string
    // to the moment cutover engaged while peers saw us live. Compare ts so the
    // fresh value wins. (regression from proposal 2026-06-04 slice 3)
    if (myPubkey && selfSeen) {
      const cur = out.lastSeen[myPubkey]
      if (!cur || (selfSeen.ts ?? 0) > (cur.ts ?? 0)) out.lastSeen[myPubkey] = selfSeen
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

  // Auto-zoom to fit the new circle's members when the user picks one
  // from the floating pill. The pill click handlers set the flag above;
  // this effect consumes it after `data` has rebuilt for the new filter
  // (and after the focus-drop effect has had a chance to null out a
  // now-orphan selectedPubkey). Skipping while a member is focused
  // leaves the camera on whoever the user is following; clearFocus()
  // already calls fitAll on its own when they back out. Deep-link
  // paths (initialFocus → setSelectedCircleId) do not set this flag,
  // so focusMember's own flyTo isn't fought.
  useEffect(() => {
    if (!pendingCircleAutoZoomRef.current) return
    if (selectedPubkey) return
    pendingCircleAutoZoomRef.current = false
    mapApiRef.current?.fitAll()
  }, [data, selectedPubkey])

  // Collapse any fanned-out avatar cluster when the active circle changes.
  // The expanded cluster's key was computed from the previous circle's
  // members, so after a pill switch the fan would otherwise linger (and
  // orphan against markers that no longer exist) while the camera zooms to
  // the new group. Unconditional and independent of the auto-zoom guard
  // above so it also fires when a member is focused. collapseCluster no-ops
  // when nothing is spread, including the initial mount.
  useEffect(() => {
    mapApiRef.current?.collapseCluster()
  }, [selectedCircleId])

  const placesById = {}
  for (const p of data.places ?? []) placesById[p.id] = p

  const latestTransition = {}
  for (const t of data.transitions ?? []) {
    if (t?.pubkey && !latestTransition[t.pubkey]) latestTransition[t.pubkey] = t
  }

  const memberCount = data.members.length
  const placeCount = data.places.length
  const isSingleCircle = activeCircles.length === 1
  // Repair surfaces span ALL circles (a wedged circle may not be the selected
  // one). A repair in flight (repairing) or staged-for-restart (repairStaged)
  // takes priority over the needs-repair nudge.
  const repairingCircles = circles.filter((c) => c.repairing || c.repairStaged)
  const repairStagedPending = repairingCircles.some((c) => c.repairStaged)
  const needRepairCircles = circles.filter((c) => c.needsRepair && !c.repairing && !c.repairStaged)

  // Repair watchdog: arm a one-shot timer while an in-process repair runs; if it
  // hasn't cleared (the circle never becomes writable) by REPAIR_ESCALATE_MS,
  // flip repairEscalated so the banner offers leave + rejoin instead of an
  // endless spinner. Resets whenever the repair clears or staging changes.
  const repairInProgress = repairingCircles.length > 0 && !repairStagedPending
  useEffect(() => {
    if (!repairInProgress) { setRepairEscalated(false); return }
    setRepairEscalated(false)
    const id = setTimeout(() => setRepairEscalated(true), REPAIR_ESCALATE_MS)
    return () => clearTimeout(id)
  }, [repairInProgress])

  // Single top-of-map banner slot (UX audit item a). Exactly one banner renders
  // at top:0, chosen by priority so they can never stack (previously each
  // rendered independently with ad-hoc pairwise guards, so e.g. a repair nudge
  // could pile on a battery banner). Order: permission > battery > network >
  // repairing > repair > sync. Everything is suppressed during the tour.
  const permissionBannerEligible = permissionStatus !== 'always' && permissionStatus !== 'unknown' && permissionStatus !== 'notDetermined' && !bannerDismissed
  const batteryBannerEligible = battery.supported === true && !battery.exempt && !batteryBannerDismissed
  const networkBannerEligible = networkLocationOff && !networkBannerDismissed && (!selfSeen || (Date.now() - (selfSeen.ts ?? 0)) > NETWORK_BANNER_STALE_MS)
  const repairingBannerEligible = repairingCircles.length > 0
  const repairBannerEligible = !repairBannerDismissed && needRepairCircles.length > 0
  const syncBannerEligible = syncFailCount >= SYNC_FAIL_BANNER_THRESHOLD && !syncBannerDismissed
  const topBanner = tourActive ? null
    : permissionBannerEligible ? 'permission'
    : batteryBannerEligible ? 'battery'
    : networkBannerEligible ? 'network'
    : repairingBannerEligible ? 'repairing'
    : repairBannerEligible ? 'repair'
    : syncBannerEligible ? 'sync'
    : null

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

  // When focusMember runs but the peer's lastSeen hasn't replicated yet
  // (typically cold-start notification tap before the first lastSeen
  // append arrives), the flyTo is silently skipped. Stash the pubkey so
  // the effect below can finish the flyTo when data.lastSeen catches up.
  // Cleared on a successful immediate flyTo, on focus change, or after
  // a one-shot retry budget elapses.
  const pendingFlyForPubkeyRef = useRef(null)
  // openSheet defaults to true to preserve the member-list-row-tap UX
  // (tapping a row asks for member detail). Notification-tap routing
  // passes openSheet=false so the user lands at the primary-focus state
  // (avatar centered + top bar) without the sheet covering the map.
  const focusMember = useCallback((pubkey, { openSheet = true } = {}) => {
    if (!pubkey) return
    setSelectedPubkey(pubkey)
    setMemberSheetVisible(openSheet)
    setMenuOpen(false)
    setSheetOpen(false)
    const seen = data.lastSeen?.[pubkey]
    if (seen) {
      justFocusedRef.current = true
      pendingFlyForPubkeyRef.current = null
      mapApiRef.current?.flyTo({
        center: [seen.lon, seen.lat], zoom: 16, duration: 1100,
      })
    } else {
      pendingFlyForPubkeyRef.current = pubkey
    }
  }, [data])

  // Cold-start notification-tap retry. Watches data.lastSeen for the
  // pending pubkey and flies once it lands. Cleared when the user
  // changes focus or clears focus.
  useEffect(() => {
    const pending = pendingFlyForPubkeyRef.current
    if (!pending) return
    if (pending !== selectedPubkey) { pendingFlyForPubkeyRef.current = null; return }
    const seen = data.lastSeen?.[pending]
    if (!seen) return
    pendingFlyForPubkeyRef.current = null
    justFocusedRef.current = true
    mapApiRef.current?.flyTo({
      center: [seen.lon, seen.lat], zoom: 16, duration: 1100,
    })
  }, [data, selectedPubkey])

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

  // Back-gesture precedence on the map. A fanned-out avatar cluster
  // collapses back to its stacked pile FIRST -- that's the user's mental
  // "back" out of fan-out, and it must win over the focus-clear / camera-
  // refit (and over the shell's zoom-out / exit-app fallthrough). Only when
  // nothing is spread does back clear member focus and refit to the all-fit
  // baseline. Both arms are gated by `active` so back at idle (no fan-out,
  // no focus, no sheets) falls through to shell:exitApp. The member detail
  // sheet (a BottomSheet) registers a handler of its own that pops first.
  useBackHandler(useCallback(() => {
    if (clusterSpread && mapApiRef.current?.collapseCluster()) return true
    if (selectedPubkey) { clearFocus(); return true }
    return false
  }, [clusterSpread, selectedPubkey, clearFocus]), clusterSpread || !!selectedPubkey)

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
    focusMember(initialFocus.pubkey, { openSheet: false })
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

  // The single circle we own when exactly one is in view -- the only
  // context where "Remove from circle" is unambiguous. Hidden in the
  // merged "All circles" view, same single-circle gate as rename /
  // delete.
  const ownedCircleForRemoval =
    isSingleCircle && activeCircles[0]?.circle?.ownerKey === myPubkey
      ? activeCircles[0]
      : null

  // Title is the current filter label. A selectedCircleId can outlive its
  // circle (e.g. right after leaving the last circle), so resolve the name
  // from the live snapshot and fall through to the no-/multi-circle labels
  // when it's gone -- otherwise the pill shows a bare "..." placeholder.
  // CIRCLE_NAME_PENDING covers a circle whose `circle` row hasn't replicated
  // yet (name arrives a beat after the join).
  const selectedCircleName = selectedCircleId ? activeCircles[0]?.circle?.name : null
  const filterLabel = selectedCircleName
    || (circles.length === 0
          ? 'No circles'
          : circles.length === 1
            ? (circles[0]?.circle?.name || CIRCLE_NAME_PENDING)
            : 'All circles')

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
          onClusterSpreadChange={setClusterSpread}
        />
        {/* Waiting-for-location cue. When nothing is on the map yet (no self
            fix and no visible peers, so data.lastSeen is empty) the camera
            sits at the country-level US default; dim it and label the empty
            state instead of showing a bare map. pointer-events:none keeps it
            purely visual. Clears the instant any pin appears. */}
        {Object.keys(data.lastSeen || {}).length === 0 && (
          <div style={s.mapWaiting}>
            <span style={s.mapWaitingText}>Getting your location…</span>
          </div>
        )}
      </div>

      {/* iOS Always-location nudge banner. Shows when permission is
          below 'always' and the user hasn't dismissed it this session.
          Apple's openSettingsURLString deep-link is the one supported
          recovery path once the system dialog has been answered (it
          can only show once per install). Suppressed for notDetermined:
          before the user has been prompted at least once, iOS's Settings
          page for the app omits the Location row entirely, so "Open
          Settings" lands on a page where there's nothing to change. The
          PermissionPrime modal handles notDetermined; the banner picks
          up once status moves to whenInUse / denied / restricted. */}
      {/* iOS Always-location nudge. Apple's openSettingsURLString deep-link
          is the one supported recovery path once the system dialog has been
          answered. Suppressed for notDetermined (the PermissionPrime modal
          handles that) since iOS omits the Location row pre-prompt. */}
      {topBanner === 'permission' && (
        <PermissionBanner
          status={permissionStatus}
          onOpenSettings={() => { pear.call('shell:openSettings').catch(() => {}) }}
          onDismiss={onPermissionBannerDismiss}
        />
      )}

      {/* Android Doze nudge banner. */}
      {topBanner === 'battery' && (
        <BatteryOptBanner
          onOpenSettings={onOpenBatteryAdvanced}
          onDismiss={onBatteryBannerDismiss}
        />
      )}

      {/* GrapheneOS / de-Googled network-location nudge. Gated on STALENESS,
          not just "network off": a de-Googled user who is mobile or near a
          window is fine, so we only surface it when their own location has
          actually gone stale (or never arrived). */}
      {topBanner === 'network' && (
        <NetworkLocationBanner
          onOpenSettings={() => { pear.call('shell:location:openSettings').catch(() => {}) }}
          onDismiss={onNetworkBannerDismiss}
        />
      )}

      {/* Circle-repair surfaces. A repair in flight (Repairing…) takes
          priority over the needs-repair nudge. The nudge is the discoverable
          entry point; tapping Repair opens the confirm-with-explainer. */}
      {topBanner === 'repairing' && (
        <RepairingBanner
          count={repairingCircles.length}
          circleName={repairingCircles[0]?.circle?.name}
          needsRestart={repairStagedPending}
          escalated={repairEscalated}
          onResolve={() => setSheet({ name: 'settings', expand: 'circles' })}
        />
      )}
      {topBanner === 'repair' && (
        <RepairBanner
          count={needRepairCircles.length}
          circleName={needRepairCircles[0]?.circle?.name}
          onRepair={() => setRepairConfirmOpen(true)}
          onDismiss={() => setRepairBannerDismissed(true)}
        />
      )}

      {/* Worklet-wedged sync notice (UX audit item f). Lowest banner priority
          (item a): the setup nudges + the more specific repair surface win the
          single slot first. */}
      {topBanner === 'sync' && (
        <SyncInterruptedBanner onDismiss={() => setSyncBannerDismissed(true)} />
      )}
      {repairConfirmOpen && needRepairCircles.length > 0 && (
        <RepairConfirmModal
          circles={needRepairCircles}
          onCancel={() => setRepairConfirmOpen(false)}
          onConfirm={() => {
            setRepairConfirmOpen(false)
            for (const c of needRepairCircles) {
              pear.call('circle:repair', { circleId: c.circleId }).catch(() => {})
            }
          }}
        />
      )}



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
          // Use raw (dark-mode) border on these map-overlay surfaces so
          // light mode doesn't render a light border on a dark fab.
          borderBottom: `1px solid ${colorsRaw.border}`,
          color: colorsRaw.text.primary,
          display: 'flex', alignItems: 'center', gap: 8,
          transform: selectedMember ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 250ms cubic-bezier(0.32, 0.72, 0, 1)',
          zIndex: 6,
          pointerEvents: selectedMember ? 'auto' : 'none',
        }}
      >
        {selectedMember && (
          <>
            {/* Inline color override on the back arrow + name: this whole
                bar is theme-stable (dark fab over light tiles), so we
                pin to the raw dark-mode text color rather than letting
                colors.text.primary flip dark in light mode. */}
            <button
              type='button'
              style={{ ...s.iconBtn, color: colorsRaw.text.primary }}
              onClick={clearFocus}
              aria-label='Back to all'
            >‹</button>
            <button
              type='button'
              onClick={() => setMemberSheetVisible(true)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 8,
                background: 'transparent', border: 'none', padding: 0,
                color: colorsRaw.text.primary, cursor: 'pointer', textAlign: 'left',
                fontFamily: typography.fontFamily,
              }}
              aria-label='Open member detail'
            >
              <Avatar base64={selectedMember.avatar} label={selectedMember.displayName} size={32} />
              <div style={{ ...s.focusName, color: colorsRaw.text.primary }}>{selectedMember.displayName}</div>
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
        data-tour='menu-button'
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
            // Map-overlay surface stays dark-themed regardless of UI mode
            // (the map tiles below are usually light); raw values keep
            // text/border legible in both themes.
            border: `1px solid ${colorsRaw.border}`,
            borderRadius: radius.full,
            color: colorsRaw.text.primary,
            fontFamily: typography.fontFamily,
            fontSize: 14, fontWeight: 300,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>{filterLabel}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', color: colorsRaw.text.secondary, transform: menuOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }}>
            <CaretDown size={11} weight='thin' />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4, color: colors.text.secondary }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: connectedPubkeys.size > 0 ? colors.success : colors.text.muted }} />
            <span style={{ fontSize: 12 }}>{connectedPubkeys.size}</span>
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
              onClick={() => {
                if (selectedCircleId !== null) pendingCircleAutoZoomRef.current = true
                setSelectedCircleId(null)
                setMenuOpen(false)
              }}
            >
              All circles
            </button>
          )}
          {[...circles].sort((a, b) => byName(a.circle?.name, b.circle?.name)).map((c) => (
            <div key={c.circleId} style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
              <button
                style={{ ...s.menuItem, ...(selectedCircleId === c.circleId ? s.menuItemActive : null), flex: 1 }}
                onClick={() => {
                  if (selectedCircleId !== c.circleId) pendingCircleAutoZoomRef.current = true
                  setSelectedCircleId(c.circleId)
                  setMenuOpen(false)
                }}
              >
                {c.circle?.name || CIRCLE_NAME_PENDING}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setSheet({ name: 'invite', circleId: c.circleId, circleName: c.circle?.name || 'Circle' })
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
          bottom: `calc(max(env(safe-area-inset-bottom, 0px), var(--android-nav-inset, 0px)) + 16px)`,
          width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          // Map-overlay FAB: theme-stable since it floats over light tiles.
          border: `1px solid ${colorsRaw.border}`,
          color: colorsRaw.text.primary,
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
          bottom: `calc(max(env(safe-area-inset-bottom, 0px), var(--android-nav-inset, 0px)) + 16px)`,
          width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${colorsRaw.border}`,
          color: colorsRaw.text.primary,
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
          bottom: `calc(max(env(safe-area-inset-bottom, 0px), var(--android-nav-inset, 0px)) + 72px)`,
          width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(26,26,26,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${colorsRaw.border}`,
          color: colorsRaw.text.primary,
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
        <button data-tour='members-fab' style={s.fab} onClick={() => setSheetOpen(true)}>
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
          connected={connectedPubkeys.has(selectedPubkey)}
          canRemove={!!ownedCircleForRemoval && selectedPubkey !== myPubkey}
          circleNameForRemoval={ownedCircleForRemoval?.circle?.name ?? 'this circle'}
          needsRepair={isSingleCircle && !!activeCircles[0]?.needsRepair}
          onRepair={async () => {
            if (!actionTargetCircleId) return
            const r = await pear.call('circle:repair', { circleId: actionTargetCircleId })
            if (!r?.ok) throw new Error('Repair failed')
          }}
          onRemove={async () => {
            const r = await pear.call('circle:remove', {
              circleId: ownedCircleForRemoval.circleId,
              pubkey: selectedPubkey,
            })
            if (!r?.ok) throw new Error('Could not remove member')
            setMemberSheetVisible(false)
            setSelectedPubkey(null)
          }}
          onOpenTrips={() => {
            setMemberSheetVisible(false)
            const isSelf = selectedPubkey === myPubkey
            setSheet({
              name: 'trips',
              ownerPubkey: isSelf ? null : selectedPubkey,
              ownerName: isSelf ? null : (data.members.find(m => m.value?.pubkey === selectedPubkey)?.value?.displayName || null),
            })
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
              {[...data.members].sort((a, b) => byName(a.value?.displayName, b.value?.displayName)).map(m => {
                const pubkey = m.value?.pubkey ?? ''
                const seen = data.lastSeen?.[pubkey]
                const pres = data.presence?.[pubkey]
                const isPaused = effectivePresenceMuted(pres) && pubkey !== myPubkey
                const t = latestTransition?.[pubkey]
                const tPlaceName = t ? placesById?.[t.placeId]?.name : null
                const curPlaceName = !isPaused && !t ? currentPlaceFor(seen, data.places)?.name ?? null : null
                return (
                  <MemberRow
                    key={m.key}
                    member={m}
                    seen={seen}
                    isPaused={isPaused}
                    transition={t}
                    transitionPlaceName={tPlaceName}
                    currentPlaceName={curPlaceName}
                    connected={connectedPubkeys.has(pubkey)}
                    isSelf={pubkey === myPubkey}
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
                  // Don't fly the camera if a row-internal button (mute,
                  // edit, delete) was tapped.
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
                            color: isMuted ? colors.warn : colors.text.secondary,
                            borderColor: isMuted ? colors.warn : colors.border,
                            background: 'transparent',
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
                  </li>
                )
              })}
            </ul>
          )}
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

// Predefined Places: quick-add presets for the add-Place form, plus name-based
// icon inference so a place (and the "at X" member-row indicator) gets a
// recognizable glyph. UI-only — no Place-record field, so a place renamed to
// something unrecognized just falls back to the generic pin. First match wins.
const PLACE_PRESETS = [
  { label: 'Home', Icon: House },
  { label: 'Work', Icon: Briefcase },
  { label: 'School', Icon: GraduationCap },
  { label: 'Gym', Icon: Barbell },
  { label: 'Store', Icon: Storefront },
  { label: 'Park', Icon: Tree },
  { label: 'Friends', Icon: UsersThree },
  { label: 'Doctor', Icon: FirstAid },
]
const PLACE_ICON_RULES = [
  { re: /\b(home|house|casa|apartment|apt|condo)\b/, Icon: House },
  { re: /\b(work|office|job|hq)\b/, Icon: Briefcase },
  { re: /\b(school|college|university|campus|class|daycare|preschool)\b/, Icon: GraduationCap },
  { re: /\b(gym|fitness|workout|crossfit|yoga)\b/, Icon: Barbell },
  { re: /\b(store|shop|mall|market|grocery|groceries|errand|errands)\b/, Icon: Storefront },
  { re: /\b(park|playground|trail|garden)\b/, Icon: Tree },
  { re: /\b(doctor|dentist|clinic|hospital|medical|pharmacy|vet)\b/, Icon: FirstAid },
  { re: /\b(restaurant|cafe|coffee|diner|bar|pub|eatery)\b/, Icon: ForkKnife },
  { re: /\b(airport)\b/, Icon: AirplaneTilt },
  { re: /\b(friend|friends)\b/, Icon: UsersThree },
]
function placeIconFor (name) {
  const n = (name || '').toLowerCase()
  for (const r of PLACE_ICON_RULES) if (r.re.test(n)) return r.Icon
  return null
}
// Inline place glyph for a place name; generic pin fallback so both recognized
// and unrecognized places read as "a place". Sized/colored for the row text.
function PlaceIcon ({ name, size = 13 }) {
  const Icon = placeIconFor(name) || MapPin
  return <Icon size={size} weight='fill' style={{ color: colors.text.secondary, flexShrink: 0 }} />
}
// The place (across visible circles) whose geofence currently contains a
// member's last position; smallest-radius match wins. Pure client-side
// point-in-circle over data the UI already has — no transition/replication
// dependency, so it works even when transitions lag.
function currentPlaceFor (seen, places) {
  if (!seen || seen.lat == null || seen.lon == null || !Array.isArray(places)) return null
  let best = null
  for (const p of places) {
    if (p?.lat == null || p?.lon == null || !(p?.radiusMeters > 0)) continue
    if (haversineMeters(seen.lat, seen.lon, p.lat, p.lon) <= p.radiusMeters) {
      if (!best || p.radiusMeters < best.radiusMeters) best = p
    }
  }
  return best
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
            {[...circles].sort((a, b) => byName(a.circle?.name, b.circle?.name)).map(c => (
              <button
                key={c.circleId}
                style={{
                  ...s.durationBtn,
                  ...(targetCircleId === c.circleId
                    ? { background: colors.surface.elevated, color: colors.primary, borderColor: colors.primary }
                    : null),
                }}
                onClick={() => setTargetCircleId(c.circleId)}
              >
                {c.circle?.name || CIRCLE_NAME_PENDING}
              </button>
            ))}
          </div>
        </>
      )}
      <label style={s.label}>Name</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 8 }}>
        {PLACE_PRESETS.map(({ label, Icon }) => {
          const active = name.trim().toLowerCase() === label.toLowerCase()
          return (
            <button
              key={label}
              onClick={() => setName(label)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                padding: '6px 4px', borderRadius: radius.sm, cursor: 'pointer',
                fontFamily: typography.fontFamily, fontSize: 13, whiteSpace: 'nowrap', minWidth: 0,
                background: active ? colors.surface.elevated : 'transparent',
                color: active ? colors.primary : colors.text.secondary,
                border: `1px solid ${active ? colors.primary : colors.border}`,
              }}
            >
              <Icon size={14} style={{ flexShrink: 0 }} /> {label}
            </button>
          )
        })}
      </div>
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
// Duration of the layout-offset ease used when a cluster expands into a
// ring, collapses back to a stack, or rotates its cycling front. Short
// so the spread feels snappy rather than floaty.
const OFFSET_TWEEN_MS = 320
// Spread-cluster connectors reuse the avatar focus-ring palette: the
// brand green and its dark companion (see renderBubble's conic-gradient
// focus ring). Each spoke is a green->dark gradient running from the
// avatar pin in to the cored hub, and the hub is a dark core ringed in
// the same green. Literal hex (SVG presentation attributes, not CSS
// vars) and theme-independent, matching the focus ring.
const PIN_GREEN = '#9FE15A'
const PIN_DARK = '#1a1a1a'
// Spoke pulse: a green band travels pin -> hub -> pin on this period.
const SPOKE_PULSE_MS = 2400
// Green band half-width as a fraction of the spoke's length.
const SPOKE_BAND_W = 0.16
// Expanded-cluster ring geometry. The fanned avatars sit on a regular
// k-gon around the shared hub. Two knobs:
//  - SPREAD_GAP < 1 pulls adjacent avatars in until they overlap a little
//    (1 = exactly tangent; 1.5 was the old airy spread). A slight overlap
//    reads as "same spot" while each face stays tappable.
//  - SPREAD_MIN_RADIUS floors the ring so the avatars never close over the
//    centre. The hub halo is r=9 and a non-selected avatar is 60px (r=30),
//    so a 40px floor leaves 40-30=10px of clearance: the hub/vertex stays
//    visible between the bubbles even where they overlap each other.
const SPREAD_GAP = 0.95
const SPREAD_MIN_RADIUS = 40

// Build the gradient stops for a spoke's traveling band. bandPos in
// [0, 1] is the band centre along the gradient (0 = avatar pin end, 1 =
// hub end). Offsets stay ascending and clamped, so it is a green blip on
// an otherwise dark line that we slide by re-emitting per frame.
function spokeBandStops (bandPos) {
  const lo = Math.max(0, bandPos - SPOKE_BAND_W)
  const hi = Math.min(1, bandPos + SPOKE_BAND_W)
  const mid = Math.max(lo, Math.min(hi, bandPos))
  return (
    `<stop offset="0" stop-color="${PIN_DARK}" />` +
    `<stop offset="${lo.toFixed(3)}" stop-color="${PIN_DARK}" />` +
    `<stop offset="${mid.toFixed(3)}" stop-color="${PIN_GREEN}" />` +
    `<stop offset="${hi.toFixed(3)}" stop-color="${PIN_DARK}" />` +
    `<stop offset="1" stop-color="${PIN_DARK}" />`
  )
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

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
  { data, selectedPubkey, connectedPubkeys, myPubkey, tileStyleUrl, onMemberClick, onLongPress, onClusterSpreadChange },
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
  // Two-stage avatar clustering (collapsed stack -> tap -> equidistant
  // ring -> tap one -> focus + sheet). expandedClusterRef holds the
  // clusterKey of the single cluster currently spread open, or null.
  // cycleTickRef advances on a 3s interval so collapsed stacks rotate
  // which member is the visible front. leaderSvgRef is the screen-space
  // overlay that draws faint lines from each spread avatar back to its
  // true location (ring offsets are pixel-space, so this can't be a
  // GeoJSON layer). markerTapRef routes a marker tap to either expand
  // its cluster or focus the member.
  const expandedClusterRef = useRef(null)
  const cycleTickRef = useRef(0)
  const leaderSvgRef = useRef(null)
  const markerTapRef = useRef(null)
  const layoutCtxRef = useRef(null)
  const onClusterSpreadChangeRef = useRef(onClusterSpreadChange)

  // Keep refs current so the layer click handler (registered once on
  // load) and the imperative fitAll always see the latest props.
  useEffect(() => { onMemberClickRef.current = onMemberClick }, [onMemberClick])
  useEffect(() => { onLongPressRef.current = onLongPress }, [onLongPress])
  useEffect(() => { onClusterSpreadChangeRef.current = onClusterSpreadChange }, [onClusterSpreadChange])
  useEffect(() => { dataRef.current = data }, [data])

  // Single mutation point for the spread-cluster ref: keep the off-React
  // layout ref and the parent's reactive mirror in lockstep so the back
  // handler activates/deactivates exactly when the fan-out opens/closes.
  // Stable identity ([] deps) so the once-registered map-click handler and
  // the imperative collapse can capture it safely.
  const setExpandedCluster = useCallback((key) => {
    expandedClusterRef.current = key
    onClusterSpreadChangeRef.current?.(!!key)
  }, [])

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
    // Collapse a fanned-out cluster back to its stacked pile. Returns true
    // when there was a spread cluster to close (so the back handler knows
    // whether it consumed the gesture), false otherwise.
    collapseCluster: () => {
      if (!expandedClusterRef.current) return false
      setExpandedCluster(null)
      applyLayout(mapRef.current, markerStatesRef.current, layoutCtxRef.current)
      ensureRaf()
      return true
    },
    // Stable handle: setExpandedCluster and ensureRaf are stable useCallbacks,
    // so the factory's closures stay valid for the map's lifetime. Keep the
    // deps array empty -- listing ensureRaf here evaluates it during render,
    // before its `const` below, which is a temporal-dead-zone ReferenceError.
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
        // Position tween (lastSeen -> lastSeen movement).
        if (state.anim) {
          const t = Math.min(1, (now - state.anim.start) / state.anim.duration)
          const lng = state.anim.fromLng + (state.anim.toLng - state.anim.fromLng) * t
          const lat = state.anim.fromLat + (state.anim.toLat - state.anim.fromLat) * t
          state.marker.setLngLat([lng, lat])
          state.lng = lng
          state.lat = lat
          if (t >= 1) state.anim = null
          else stillAnimating = true
        }
        // Layout-offset ease (collapse <-> expand, cycling reshuffle).
        if (state.offAnim) {
          const t = Math.min(1, (now - state.offAnim.start) / state.offAnim.duration)
          const e = easeOutCubic(t)
          const dx = state.offAnim.from[0] + (state.offAnim.to[0] - state.offAnim.from[0]) * e
          const dy = state.offAnim.from[1] + (state.offAnim.to[1] - state.offAnim.from[1]) * e
          state.layoutOffset = [dx, dy]
          state.marker.setOffset([dx, dy])
          if (t >= 1) state.offAnim = null
          else stillAnimating = true
        }
      }
      // Recompute targets from the (possibly mid-tween) positions and
      // redraw leader lines against the eased offsets.
      applyLayout(mapRef.current, markerStatesRef.current, layoutCtxRef.current)
      for (const state of markerStatesRef.current.values()) {
        if (state.offAnim) { stillAnimating = true; break }
      }
      // Keep the loop alive while a cluster is spread so the spoke pulse
      // (drawn each frame in drawLeaderLines) keeps animating. Stops on
      // collapse, when expandedClusterRef clears.
      if (layoutCtxRef.current?.expandedClusterRef?.current) stillAnimating = true
      rafRef.current = stillAnimating ? requestAnimationFrame(tick) : null
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // Shared context handed to the imperative layout helpers. Built from
  // stable refs/callbacks, so the object identity changing per render is
  // harmless (helpers read .current fields at call time).
  layoutCtxRef.current = {
    expandedClusterRef,
    cycleTickRef,
    leaderSvgRef,
    ensureRaf,
    // Called when applyLayout auto-dissolves the spread cluster (zoom-in or
    // members separating) so the parent's mirror clears without a tap.
    onCollapse: () => onClusterSpreadChangeRef.current?.(false),
  }

  // Route a marker tap. If the tapped avatar sits in a collapsed cluster
  // of 2+, the first tap spreads that cluster into a ring (and collapses
  // any other open cluster). Otherwise -- a solo pin, or a member of the
  // already-expanded cluster -- it falls through to the normal focus +
  // detail-sheet flow.
  const handleMarkerTap = useCallback((pubkey) => {
    const map = mapRef.current
    const states = markerStatesRef.current
    if (!map || !pubkey) return
    const points = []
    for (const [pk, st] of states) {
      let p
      try { p = map.project([st.lng, st.lat]) } catch { continue }
      points.push({ id: pk, x: p.x, y: p.y })
    }
    const bucket = computeClusters(points).find((ids) => ids.includes(pubkey))
    if (bucket && bucket.length >= 2) {
      const key = clusterKey(bucket)
      if (expandedClusterRef.current !== key) {
        setExpandedCluster(key)
        applyLayout(map, states, layoutCtxRef.current)
        ensureRaf()
        return
      }
    }
    onMemberClickRef.current?.(pubkey)
  }, [setExpandedCluster, ensureRaf])
  markerTapRef.current = handleMarkerTap

  // One-time map init. Sources/layers are added on the 'load' event so
  // setData calls in the data-sync effect below always find them.
  useEffect(() => {
    ensureMapLibreCss()
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initialStyleRef.current,
      // Default to a country-level view of the contiguous US rather than
      // [0,0] (Null Island, ocean off Africa) for the brief window before a
      // self/member fix lands. The auto-fit / flyTo below takes over the
      // moment there's anything to show; this only persists in the genuine
      // "no location yet" empty state, paired with the waiting overlay.
      // zoom 2 shows ~70° of longitude on a phone, so both coasts (~-124..-67)
      // are visible with margin; 3+ was too tight (only a few central states).
      center: [-98.58, 39.83],
      zoom: 2,
      attributionControl: false,
    })
    mapRef.current = map

    // Publish the current viewport on every move/zoom so the offline
    // tile downloader can pick up the user's current view without
    // prop-drilling a map ref into Settings.
    const publishViewport = () => {
      try {
        const b = map.getBounds()
        window.__pearMapViewport = {
          bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
          center: [map.getCenter().lng, map.getCenter().lat],
          zoom: map.getZoom(),
        }
      } catch {}
    }
    map.on('moveend', publishViewport)
    map.on('zoomend', publishViewport)
    publishViewport()

    // Re-lay-out overlapping member avatars on camera moves; zoom changes
    // which avatars collide in screen space. Also redraws leader lines so
    // an expanded cluster's connectors track the camera.
    map.on('move', () => applyLayout(map, markerStatesRef.current, layoutCtxRef.current))

    // A tap on empty map collapses the open cluster (marker taps
    // stopPropagation, so this only fires for the map background -- which
    // also covers re-tapping the empty centre of a spread cluster).
    map.on('click', () => {
      if (expandedClusterRef.current) {
        setExpandedCluster(null)
        applyLayout(map, markerStatesRef.current, layoutCtxRef.current)
        ensureRaf()
      }
    })

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

  // Cycle which member is the visible front of each collapsed stack every
  // 3s, so a pile of avatars reveals everyone in it over time. Cheap: it
  // just advances a counter and re-runs the layout, which cross-fades the
  // new front in (CSS opacity transition) and eases the cascade.
  useEffect(() => {
    const id = setInterval(() => {
      cycleTickRef.current += 1
      applyLayout(mapRef.current, markerStatesRef.current, layoutCtxRef.current)
      ensureRaf()
    }, 3000)
    return () => clearInterval(id)
  }, [ensureRaf])

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
      syncMembers(map, data, selectedPubkey, connectedPubkeys, myPubkey, markerStatesRef.current, markerTapRef, ensureRaf, layoutCtxRef.current)
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [data, selectedPubkey, connectedPubkeys, myPubkey, ensureRaf])

  return (
    <div style={s.mapWrap}>
      <div ref={containerRef} style={s.mapCanvas} />
      {/* Leader lines for a spread cluster. Screen-space overlay because
          ring offsets are pixel-space, not geographic. pointer-events
          none so it never eats map/marker taps. */}
      <svg ref={leaderSvgRef} style={s.leaderOverlay} />
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
            border: '2px solid ' + (i.selected ? colors.accent : '#fc7'),
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            background: colors.surface.card,
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
            borderLeft: '7px solid ' + (i.selected ? colors.accent : '#fc7'),
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
  // Opacity-only transition so a stack's back members fade as the front
  // cycles. Must NOT be `all`: MapLibre animates the element's transform
  // for positioning, and transitioning that would lag the marker behind
  // the camera. The fan-out offset is eased in JS, not via CSS.
  root.style.transition = 'opacity 350ms ease'
  // Two persistent children: `content` is rewritten by renderBubble on
  // each data sync; `badge` (the cluster count) is owned by the layout
  // pass. Keeping them separate means a renderBubble innerHTML rewrite
  // never wipes the badge, and a layout-only update never re-renders the
  // avatar.
  const content = document.createElement('div')
  content.style.position = 'relative'
  content.style.width = '100%'
  content.style.height = '100%'
  const badge = document.createElement('div')
  badge.style.cssText =
    'position:absolute;bottom:-6px;right:-6px;min-width:20px;height:20px;' +
    'padding:0 5px;box-sizing:border-box;border-radius:10px;background:#0f1417;' +
    `border:1px solid #2a3338;color:#cfe;font-size:12px;font-weight:600;` +
    `font-family:${typography.fontFamily};display:none;align-items:center;` +
    'justify-content:center;line-height:1;z-index:4;pointer-events:none;' +
    'box-shadow:0 1px 3px rgba(0,0,0,0.5);'
  root.appendChild(content)
  root.appendChild(badge)
  root._content = content
  root._badge = badge
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
  const battCharging = !!last?.isCharging
  // Charging bolt: unicode glyph centered over the battery rect when
  // plugged in. Pure DOM (no SVG) per the renderBubble saga -- using
  // a unicode character avoids the zoom-dependent drift that bit us
  // last time we tried inline SVG inside a marker.
  const battBoltHtml = (batt == null || !battCharging) ? '' : (
    `<div style="position:absolute;z-index:1;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;line-height:1;color:#fff;text-shadow:0 0 2px rgba(0,0,0,0.9);font-family:${typography.fontFamily};pointer-events:none;">&#9889;</div>`
  )
  const battHtml = batt == null ? '' : (
    `<div style="position:absolute;z-index:2;bottom:-5px;left:50%;transform:translateX(-50%);width:30px;height:14px;background:#1a1a1a;border:1px solid #888;border-radius:3px;box-sizing:border-box;overflow:hidden;pointer-events:none;">` +
    `<div style="width:${batt}%;height:100%;background:${battColor};"></div>` +
    battBoltHtml +
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

  // Root carries the marker size (MapLibre centers the anchor against it)
  // and stays overflow-visible so the badge, glow, and badges can spill
  // past the avatar circle. The `content` child carries the drop-shadow
  // and the avatar visuals; the sibling `badge` (cluster count) is owned
  // by the layout pass, so writing content.innerHTML here never wipes it.
  const content = root._content || root
  root.dataset.pubkey = pubkey
  root.style.width = size + 'px'
  root.style.height = size + 'px'
  root.style.overflow = 'visible'
  root.style.boxSizing = 'border-box'
  content.style.filter = selected
    ? 'drop-shadow(0 0 10px rgba(159,225,90,0.7)) drop-shadow(0 2px 4px rgba(0,0,0,0.4))'
    : 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))'
  // Rotating focus ring: only present when selected. Sits behind the
  // avatar as a positioned sibling (DOM-order first); inset:-${ring}px
  // makes it extend that many pixels beyond root, so only the ring band
  // around the avatar shows the gradient. The avatar itself doesn't
  // rotate because the spin animation is on the ring element only.
  // Conic distribution: a soft brand-green blob occupying ~quarter of
  // the circumference, dark elsewhere, so the green reads as a moving
  // highlight rather than a full halo. Matches the brand color used on
  // primary buttons and toggle pills (colorsRaw.primary). Literal hex
  // rather than var(--color-primary) so the ring stays the dark-mode
  // brand green regardless of the active theme — the dark `#1a1a1a`
  // backdrop in the gradient is tuned for that specific green.
  const focusRingHtml = selected ? (
    `<div style="position:absolute;z-index:0;inset:-${ring}px;border-radius:50%;background:conic-gradient(from 0deg, #1a1a1a 0%, #9FE15A 25%, #1a1a1a 50%, #1a1a1a 100%);animation:pearcircle-focus-spin 2.4s linear infinite;animation-delay:${spinDelay}s;pointer-events:none;"></div>`
  ) : ''

  // Avatar inner div: when selected, no internal border (the rotating
  // ring takes over the visual); when non-selected, the thin dark edge
  // keeps the pin readable on bright tiles.
  const avatarBorder = selected ? 'none' : `${ring}px solid ${ringColor}`

  // Tri-state connection/freshness dot at the top-left of the avatar (UX
  // audit item d). Suppressed for self (connected === null) since the
  // affordance is "are they online" and you're always online to yourself.
  // When connected we also reflect position freshness so green can't imply
  // "current" for a stale fix: green = connected AND fix < PIN_FRESH_MS old,
  // amber = connected but the fix is older / unconfirmed-stale (reuses
  // liveStatus -- the same 3-way as the member row's Live / Reconnecting
  // label), grey = not connected. Top-left because the motion glyph lives at
  // top-right and the battery hangs below. Plain DOM (no SVG) per the
  // renderBubble saga.
  let dotColor = '#666'
  if (connected) {
    dotColor = liveStatus(last?.ts, last?.stale, Date.now(), PIN_FRESH_MS) === 'live' ? '#7ec77a' : '#e0b76a'
  }
  const onlineHtml = connected === null ? '' : (
    `<div style="position:absolute;z-index:3;top:-1px;left:-1px;width:14px;height:14px;border-radius:50%;background:${dotColor};border:2px solid #0d0d0d;box-sizing:border-box;pointer-events:none;"></div>`
  )

  content.innerHTML =
    focusRingHtml +
    `<div style="position:relative;z-index:1;width:100%;height:100%;border-radius:50%;overflow:hidden;border:${avatarBorder};background:#fc7;box-sizing:border-box;">${inner}</div>` +
    battHtml +
    motionHtml +
    onlineHtml
}

// Point a marker at a new layout offset. If it differs from the marker's
// current target, start an eased offAnim from where it sits now so the
// move (collapse <-> expand, cycling reshuffle) animates rather than
// snaps. Returns true if a new ease was started.
function setLayoutTarget (state, target) {
  if (!state.layoutOffset) state.layoutOffset = [0, 0]
  const cur = state.targetOffset
  if (cur && cur[0] === target[0] && cur[1] === target[1]) return false
  state.targetOffset = target
  state.offAnim = {
    start: performance.now(),
    duration: OFFSET_TWEEN_MS,
    from: [state.layoutOffset[0], state.layoutOffset[1]],
    to: [target[0], target[1]],
  }
  return true
}

// Apply the non-positional stack chrome to a marker: stacking order,
// dimming of back members, and the cluster-count badge on the front.
// Guarded so unchanged values don't touch the DOM.
function applyStackMeta (state, meta) {
  const el = state.marker.getElement()
  if (!el) return
  const z = meta.expanded ? 30 : meta.isFront ? 25 : Math.max(1, 15 - meta.rank)
  if (state.metaZ !== z) { el.style.zIndex = String(z); state.metaZ = z }
  // Collapsed back members sit exactly under the front, so hide them
  // outright (opacity 0): only the front avatar shows, and the cycling
  // swap cross-fades the new front in over the old. Expanded members and
  // any front/solo marker are fully opaque.
  const op = (meta.expanded || meta.isFront) ? 1 : 0
  if (state.metaOp !== op) { el.style.opacity = String(op); state.metaOp = op }
  const showBadge = !meta.expanded && meta.isFront && meta.count > 1
  const badge = el._badge
  if (badge) {
    if (showBadge) {
      if (state.metaBadge !== meta.count) { badge.textContent = String(meta.count); state.metaBadge = meta.count }
      if (state.metaBadgeShown !== true) { badge.style.display = 'flex'; state.metaBadgeShown = true }
    } else if (state.metaBadgeShown !== false) {
      badge.style.display = 'none'
      state.metaBadgeShown = false
    }
  }
}

// Draw faint connectors from each spread avatar back to its true shared
// location. Screen-space SVG because the ring uses pixel offsets, not
// geographic coordinates. Cleared when nothing is expanded.
function drawLeaderLines (map, states, ctx) {
  const svg = ctx?.leaderSvgRef?.current
  if (!svg) return
  const key = ctx.expandedClusterRef.current
  if (!key) {
    if (svg.childNodes.length) svg.textContent = ''
    return
  }
  const memberIds = key.split(',')
  // Project member anchors and take their centroid: the shared best-guess
  // centre every spoke radiates from (members sit a few px apart, so any
  // single member's point would leave the spokes not quite meeting).
  const pointMap = new Map()
  for (const id of memberIds) {
    const st = states.get(id)
    if (!st) continue
    let p
    try { p = map.project([st.lng, st.lat]) } catch { continue }
    pointMap.set(id, { x: p.x, y: p.y })
  }
  const c = clusterCentroid(memberIds, pointMap)
  // A green band travels each spoke pin -> hub -> pin, driven by a single
  // clock-derived phase so every spoke pulses in sync (the rAF loop is
  // kept alive while expanded). Each spoke gets its own userSpaceOnUse
  // gradient since directions differ. defs first, then lines, then hub.
  const ph = (performance.now() % SPOKE_PULSE_MS) / SPOKE_PULSE_MS
  // Smooth 0 -> 1 -> 0 (sine) so the band eases at each end.
  const bandPos = (1 - Math.cos(2 * Math.PI * ph)) / 2
  const bandStops = spokeBandStops(bandPos)
  const defs = []
  const lines = []
  // Stop each spoke just shy of the avatar's edge so the line reads as a
  // connector from the shared centre rather than crossing the face.
  const stopShort = 28
  let i = 0
  for (const id of memberIds) {
    const st = states.get(id)
    const own = pointMap.get(id)
    if (!st || !own) continue
    const off = st.layoutOffset || [0, 0]
    // Avatar's current displayed position = its anchor + eased offset.
    const ax = own.x + off[0]
    const ay = own.y + off[1]
    const dx = ax - c.x
    const dy = ay - c.y
    const len = Math.hypot(dx, dy)
    if (len <= stopShort) continue
    const x2 = c.x + dx * (1 - stopShort / len)
    const y2 = c.y + dy * (1 - stopShort / len)
    const gid = `pearcircle-spoke-${i++}`
    // Gradient vector runs avatar-pin (offset 0) -> hub (offset 1); the
    // band centre is at bandPos along it.
    defs.push(
      `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${ax}" y1="${ay}" x2="${c.x}" y2="${c.y}">` +
      bandStops +
      `</linearGradient>`
    )
    // Faint static green underlay keeps the connector visible between
    // pulses; the gradient line carries the moving bright band on top.
    lines.push(`<line x1="${c.x}" y1="${c.y}" x2="${x2}" y2="${y2}" stroke="${PIN_GREEN}" stroke-opacity="0.22" stroke-width="2.5" stroke-linecap="round" />`)
    lines.push(`<line x1="${c.x}" y1="${c.y}" x2="${x2}" y2="${y2}" stroke="url(#${gid})" stroke-width="2.5" stroke-linecap="round" />`)
  }
  // Hub where the spokes meet: a dark core ringed in the brand green,
  // with a faint green halo. Drawn last so it sits on top of the spoke
  // ends, matching the avatar pin's green-on-dark look.
  const hub = lines.length ? (
    `<circle cx="${c.x}" cy="${c.y}" r="9" fill="${PIN_GREEN}" opacity="0.22" />` +
    `<circle cx="${c.x}" cy="${c.y}" r="4.5" fill="${PIN_DARK}" stroke="${PIN_GREEN}" stroke-width="2" />`
  ) : ''
  svg.innerHTML = (defs.length ? `<defs>${defs.join('')}</defs>` : '') + lines.join('') + hub
}

// Screen-space centroid of a cluster's true projected points. Markers in
// a cluster sit at slightly different coordinates (within a bubble
// width), so we pin both the collapsed stack and the expanded ring to
// this shared best-guess centre. That makes a collapsed pile land exactly
// on one another and gives the expanded spokes a common origin to meet
// at.
function clusterCentroid (ids, pointMap) {
  let sx = 0
  let sy = 0
  let n = 0
  for (const id of ids) {
    const p = pointMap.get(id)
    if (!p) continue
    sx += p.x; sy += p.y; n++
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 }
}

// Lay out every cluster: solo markers settle at zero, the one expanded
// cluster fans into an equidistant polygon, and every other multi-member
// cluster collapses into a fully-stacked pile (only the cycling front is
// visible). Offsets are pixel deltas from each marker's own anchor, so
// pinning to the shared centroid means a member's target is
// (centroid - ownPoint) plus its ring slot. Runs on camera moves and
// tween frames; per-state guards keep it cheap. Clears the expanded
// cluster if it no longer overlaps (e.g. the user zoomed in until the
// members separated).
function applyLayout (map, states, ctx) {
  if (!map || !ctx) return
  const points = []
  const pointMap = new Map()
  for (const [pubkey, state] of states) {
    let p
    try { p = map.project([state.lng, state.lat]) } catch { continue }
    points.push({ id: pubkey, x: p.x, y: p.y })
    pointMap.set(pubkey, { x: p.x, y: p.y })
  }
  const buckets = computeClusters(points)
  const liveKeys = new Set()
  for (const ids of buckets) if (ids.length >= 2) liveKeys.add(clusterKey(ids))

  let expandedKey = ctx.expandedClusterRef.current
  if (expandedKey && !liveKeys.has(expandedKey)) {
    // The spread cluster dissolved (zoomed in, or members moved/left).
    ctx.expandedClusterRef.current = null
    expandedKey = null
    ctx.onCollapse?.()
  }

  let startedEase = false
  const cycleTick = ctx.cycleTickRef.current
  for (const ids of buckets) {
    if (ids.length < 2) {
      const st = states.get(ids[0])
      if (!st) continue
      if (setLayoutTarget(st, [0, 0])) startedEase = true
      applyStackMeta(st, { expanded: false, isFront: true, rank: 0, count: 0 })
      continue
    }
    const key = clusterKey(ids)
    const c = clusterCentroid(ids, pointMap)
    if (key === expandedKey) {
      // Tight spread: adjacent avatars sit close (overlapping a little in
      // larger clusters) while the radius floor keeps the centre hub visible
      // between them. See SPREAD_GAP / SPREAD_MIN_RADIUS.
      const ring = computeRingOffsets(ids, { gap: SPREAD_GAP, minRadius: SPREAD_MIN_RADIUS })
      for (const id of ids) {
        const st = states.get(id)
        const own = pointMap.get(id)
        if (!st || !own) continue
        const slot = ring.get(id)
        if (setLayoutTarget(st, [c.x - own.x + slot[0], c.y - own.y + slot[1]])) startedEase = true
        applyStackMeta(st, { expanded: true, isFront: true, rank: 0, count: ids.length })
      }
    } else {
      // Collapsed pile: every member lands exactly on the centroid so
      // only the front shows. The cycle counter rotates which member is
      // the front, cross-fading the pile through everyone over time.
      const front = cycleTick % ids.length
      const ordered = ids.slice(front).concat(ids.slice(0, front))
      ordered.forEach((id, rank) => {
        const st = states.get(id)
        const own = pointMap.get(id)
        if (!st || !own) return
        if (setLayoutTarget(st, [c.x - own.x, c.y - own.y])) startedEase = true
        applyStackMeta(st, { expanded: false, isFront: rank === 0, rank, count: ids.length })
      })
    }
  }

  drawLeaderLines(map, states, ctx)
  if (startedEase) ctx.ensureRaf()
}

function syncMembers (map, data, selectedPubkey, connectedPubkeys, myPubkey, states, clickRef, ensureRaf, ctx) {
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
      state = { marker, lng: last.lon, lat: last.lat, anim: null, layoutOffset: [0, 0], targetOffset: [0, 0], offAnim: null }
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
  applyLayout(map, states, ctx)
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
  // Recreate (proposal 2026-06-17 slice 4): which circle the troubleshooting
  // explainer is open for, an in-flight flag, and the freshly-minted invite to
  // surface once recreate succeeds. File export/import share the same section.
  const [recreatingFor, setRecreatingFor] = useState(null)   // source circle object
  const [recreateBusy, setRecreateBusy] = useState(false)
  const [recreateResult, setRecreateResult] = useState(null) // { name, invite, sourceName }
  // File export/import (proposal 2026-06-17 slice 4). exportingFor opens the
  // coordinate-privacy confirm; busy flags gate double-taps.
  const [exportingFor, setExportingFor] = useState(null)     // circle object
  const [exportBusy, setExportBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [notice, setNotice] = useState(null)                 // transient success line

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
          name: c.circle?.name || CIRCLE_NAME_PENDING,
          isOwner: c.circle?.ownerKey === ourKey,
          memberCount: (c.members ?? []).length,
          // Local recreate links + created date (proposal 2026-06-17 slice 3/4).
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : null,
          recreatedFrom: typeof c.recreatedFrom === 'string' ? c.recreatedFrom : null,
          recreatedTo: typeof c.recreatedTo === 'string' ? c.recreatedTo : null,
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

  // Recreate this circle on a fresh empty Autobase (proposal 2026-06-17). The
  // worklet keeps the name + Places + toggles, mints a new invite, posts the
  // owner-signed migration nudge to the old circle, and links the two locally.
  const performRecreate = async (c) => {
    setRecreateBusy(true)
    setError(null)
    try {
      const r = await pear.call('circle:recreate', { circleId: c.circleId })
      if (!r?.invite) throw new Error('Recreate did not return an invite')
      setRecreatingFor(null)
      setRecreateResult({ name: r.name || c.name, invite: r.invite, sourceName: c.name })
      onChanged?.()
      refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setRecreateBusy(false)
    }
  }

  // Export this circle's curated config (name + Places + toggles) to a JSON
  // file via the OS share sheet. The confirm modal carries the coordinate-
  // privacy note before we hand any Place coordinates to a share target.
  const performExport = async (c) => {
    setExportBusy(true)
    setError(null)
    setNotice(null)
    try {
      const exportObj = await pear.call('circle:export', { circleId: c.circleId })
      const filename = (c.name || 'circle').replace(/\s+/g, '-').toLowerCase() + '.pearcircle.json'
      const r = await pear.call('shell:exportFile', {
        filename,
        contents: JSON.stringify(exportObj, null, 2),
        title: 'Export ' + (c.name || 'circle'),
      })
      if (r && r.ok === false && r.error) throw new Error(r.error)
      setExportingFor(null)
      // r.canceled (no folder picked) leaves no note; a real save confirms it.
      if (r?.ok) setNotice(r.savedToFolder ? `Saved ${filename} to your chosen folder.` : `Exported ${filename}.`)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setExportBusy(false)
    }
  }

  // Import a circle config from a file: pick it, parse, hand the payload to the
  // worklet (which validates + mints a brand-new circle), then surface the new
  // invite via the same success modal recreate uses.
  const performImport = async () => {
    setImportBusy(true)
    setError(null)
    try {
      const picked = await pear.call('shell:importFile')
      if (!picked?.ok) {
        if (picked?.canceled) return
        throw new Error(picked?.error || 'Could not read the file')
      }
      let payload
      try { payload = JSON.parse(picked.contents) }
      catch { throw new Error('That file is not valid JSON') }
      const r = await pear.call('circle:import', { payload })
      if (!r?.invite) throw new Error('Import did not return an invite')
      setRecreateResult({ name: r.name, invite: r.invite, imported: true })
      onChanged?.()
      refresh()
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setImportBusy(false)
    }
  }

  if (loading) return null
  // "Import from file" footer button, shown whether or not the user has any
  // circles (importing always mints a brand-new one).
  const importButton = (
    <div style={{ textAlign: 'center' }}>
      <button
        onClick={performImport}
        disabled={importBusy}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: spacing.xs,
          marginTop: spacing.md, padding: '10px 14px', borderRadius: radius.md,
          background: 'transparent', color: colors.text.secondary,
          border: `1px solid ${colors.border}`, cursor: importBusy ? 'default' : 'pointer',
          fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400,
          opacity: importBusy ? 0.6 : 1,
        }}>
        <DownloadSimple size={16} weight="regular" />
        {importBusy ? 'Importing...' : 'Import circle from file'}
      </button>
    </div>
  )

  if (list.length === 0) {
    return (
      <>
        <p style={s.muted}>
          You're not in any circles yet. Create or join one from the circle menu on the map.
        </p>
        {importButton}
        {error && <p style={s.error}>{error}</p>}
        {recreateResult && (
          <RecreatedInviteModal result={recreateResult} onClose={() => setRecreateResult(null)} />
        )}
      </>
    )
  }

  // Which circles are still present locally — used so a recreate badge only
  // shows while both halves of the pair exist (the owner deletes the old one
  // once members migrate, which retires the "Being replaced" badge).
  const presentIds = new Set(list.map(x => x.circleId))

  return (
    <>
      <p style={s.muted}>
        Delete a circle you own to remove it for everyone. Leave a circle to remove only your copy. If you own a circle, its row also has icons to recreate it on a fresh copy (when it gets slow or cluttered, keeping the name and Places) or export its name, Places and settings to a file you can re-import later.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: `${spacing.sm}px 0 0 0` }}>
        {[...list].sort((a, b) => byName(a.name, b.name)).map(c => {
          const isPending = pending === c.circleId
          const isEditing = editingId === c.circleId
          // "Being replaced": this circle was recreated into another that still
          // exists. "New": this circle came from a recreate of one still present.
          const beingReplaced = !!(c.recreatedTo && presentIds.has(c.recreatedTo))
          const isReplacement = !!(c.recreatedFrom && presentIds.has(c.recreatedFrom))
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
                    background: canSave ? colors.primary : 'transparent',
                    color: canSave ? colors.text.onPrimary : colors.text.muted,
                    border: `1px solid ${canSave ? colors.primary : colors.border}`,
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
                <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs, minWidth: 0 }}>
                  <span style={{ ...typography.body, color: colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || CIRCLE_NAME_PENDING}</span>
                  {beingReplaced && <RecreateBadge label="Being replaced" tone="muted" />}
                  {isReplacement && <RecreateBadge label="New" tone="primary" />}
                </div>
                <div style={{ ...typography.caption, color: colors.text.secondary }}>
                  {c.createdAt ? `Created ${formatCreatedDate(c.createdAt)} · ` : ''}{c.isOwner ? 'You own this · ' : ''}{c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
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
              {c.isOwner && (
                <button
                  onClick={() => { setError(null); setRecreatingFor(c) }}
                  disabled={isPending}
                  title="Recreate circle"
                  aria-label="Recreate circle"
                  style={iconBtnStyle({ disabled: isPending })}>
                  <ArrowsClockwise size={18} weight="regular" />
                </button>
              )}
              {c.isOwner && (
                <button
                  onClick={() => { setError(null); setExportingFor(c) }}
                  disabled={isPending}
                  title="Export circle to file"
                  aria-label="Export circle to file"
                  style={iconBtnStyle({ disabled: isPending })}>
                  <ExportIcon size={18} weight="regular" />
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
      {importButton}
      {error && <p style={s.error}>{error}</p>}
      {notice && <p style={{ ...typography.caption, color: colors.success, marginTop: spacing.sm }}>{notice}</p>}
      {exportingFor && (
        <ConfirmSheet
          title="Export circle to file"
          message={<>
            Save <strong>{exportingFor.name}</strong>'s name, Places and sharing toggles to a file you can re-import later. No keys, members or history are included. You'll pick where it goes (like Downloads) the first time.
            <span style={{ display: 'block', marginTop: spacing.sm, color: colors.error }}>
              This file contains your Place coordinates (like home and work). Only save it somewhere you trust.
            </span>
          </>}
          confirmLabel="Export"
          destructive={false}
          busy={exportBusy}
          onConfirm={() => performExport(exportingFor)}
          onClose={() => { if (!exportBusy) setExportingFor(null) }}
        />
      )}
      {confirmingFor && (() => {
        // Delete-confirmation guard (proposal 2026-06-17): if the owner is
        // about to delete the NEWER half of a recreated pair (the replacement,
        // whose partner old circle still exists), call that out loudly — the
        // two share a name and deleting the new one undoes the recreate.
        const deletingNewer = confirmingFor.isOwner &&
          !!(confirmingFor.recreatedFrom && presentIds.has(confirmingFor.recreatedFrom))
        const created = confirmingFor.createdAt ? `created ${formatCreatedDate(confirmingFor.createdAt)}` : null
        const detail = [created, `${confirmingFor.memberCount} ${confirmingFor.memberCount === 1 ? 'member' : 'members'}`]
          .filter(Boolean).join(' · ')
        return (
          <ConfirmSheet
            title={confirmingFor.isOwner ? 'Delete circle?' : 'Leave circle?'}
            message={confirmingFor.isOwner
              ? <>
                  Delete <strong>{confirmingFor.name}</strong>{detail ? <> ({detail})</> : null}? This removes the circle for everyone in it. This cannot be undone.
                  {deletingNewer && (
                    <span style={{ display: 'block', marginTop: spacing.sm, color: colors.error }}>
                      Heads up: this is the <strong>new</strong> circle you just recreated. Members are migrating to it. You probably meant to delete the older one being replaced.
                    </span>
                  )}
                </>
              : <>Leave <strong>{confirmingFor.name}</strong>? You will stop sharing with this circle. You can rejoin later if someone shares the invite again.</>}
            confirmLabel={confirmingFor.isOwner ? 'Delete' : 'Leave'}
            destructive
            busy={pending === confirmingFor.circleId}
            onConfirm={() => performAction(confirmingFor)}
            onClose={() => { if (pending !== confirmingFor.circleId) setConfirmingFor(null) }}
          />
        )
      })()}
      {recreatingFor && (
        <ConfirmSheet
          title="Recreate Circle"
          message={<>
            Stuck, slow, or cluttered? Recreating rebuilds <strong>{recreatingFor.name}</strong> from scratch while keeping its name and Places. Members rejoin with a fresh invite, and history starts clean.
            <span style={{ display: 'block', marginTop: spacing.sm, color: colors.text.secondary }}>
              The old circle stays put until you delete it, so you can let everyone move over first.
            </span>
          </>}
          confirmLabel="Recreate"
          destructive={false}
          busy={recreateBusy}
          onConfirm={() => performRecreate(recreatingFor)}
          onClose={() => { if (!recreateBusy) setRecreatingFor(null) }}
        />
      )}
      {recreateResult && (
        <RecreatedInviteModal
          result={recreateResult}
          onClose={() => setRecreateResult(null)}
        />
      )}
    </>
  )
}

// Small pill badge that disambiguates the two same-named circles of a
// recreated pair in the Settings list (proposal 2026-06-17 slice 4).
function RecreateBadge ({ label, tone = 'muted' }) {
  const isPrimary = tone === 'primary'
  return (
    <span style={{
      flexShrink: 0,
      fontSize: 10, fontWeight: 500, lineHeight: 1,
      textTransform: 'uppercase', letterSpacing: 0.4,
      padding: '3px 6px', borderRadius: radius.full,
      color: isPrimary ? colors.text.onPrimary : colors.text.secondary,
      background: isPrimary ? colors.primary : colors.surface.input,
      border: `1px solid ${isPrimary ? colors.primary : colors.border}`,
    }}>
      {label}
    </span>
  )
}

// Post-recreate success modal: surfaces the new circle's invite so the owner
// can share it with the members who need to rejoin (proposal 2026-06-17).
function RecreatedInviteModal ({ result, onClose }) {
  return (
    <BottomSheet onClose={onClose} zIndex={250}>
      <h2 style={{ margin: `${spacing.sm}px 0 ${spacing.xs}px`, fontSize: 18, fontWeight: 400, color: colors.text.primary, textAlign: 'center' }}>
        {result.imported ? 'Circle imported' : 'Circle recreated'}
      </h2>
      <div style={{ ...typography.body, color: colors.text.secondary, marginBottom: spacing.md }}>
        {result.imported
          ? <><strong style={{ color: colors.text.primary, fontWeight: 400 }}>{result.name}</strong> was created from your file with the same Places. Share this invite so people can join.</>
          : <><strong style={{ color: colors.text.primary, fontWeight: 400 }}>{result.name}</strong> is rebuilt on a clean slate with the same Places. Share this invite so members rejoin — anyone on the latest app also gets a one-tap "your group moved" nudge. The old circle stays until you delete it.</>}
      </div>
      <QrImage text={result.invite} />
      <textarea style={s.inviteBox} readOnly value={result.invite} onFocus={(e) => e.target.select()} />
      <ShareButton text={result.invite} title={'Join ' + (result.name || 'my PearCircle')} />
      <button
        onClick={onClose}
        style={{
          width: '100%', marginTop: spacing.sm, padding: '12px', borderRadius: radius.md,
          background: 'transparent', color: colors.text.secondary,
          border: `1px solid ${colors.border}`, cursor: 'pointer',
          fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
        }}>
        Done
      </button>
    </BottomSheet>
  )
}

// "Created Jun 17" / "Created Jun 17, 2025" — drops the year only for the
// current calendar year to keep the row caption short.
function formatCreatedDate (ts) {
  if (typeof ts !== 'number') return ''
  const d = new Date(ts)
  const opts = d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }
  return d.toLocaleDateString([], opts)
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

function ProfileView ({ active = true, profile, sharing, setSharingForCircle, tileStyleUrl, setTileStyleUrl, distanceUnit = 'km', setDistanceUnit, themeMode = 'dark', setThemeMode, battery = { supported: null, exempt: false }, initialExpand = null, onClose, onSaved }) {
  const [name, setName] = useState(profile?.displayName ?? '')
  const [editingName, setEditingName] = useState(false)
  // null = unchanged from server; '' = explicitly cleared; string = new value
  const [avatar, setAvatar] = useState(null)
  const [saving, setSaving] = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  const [batteryError, setBatteryError] = useState(null)
  // Collapsible state for the secondary settings groups. Closed by
  // default so first open of Settings is profile + sharing only;
  // user expands what they need. Persists across sheet open/close
  // (SheetContainer keeps the component mounted).
  // Accordion: one section open at a time. openSection is the id of the
  // expanded Collapsible, or null when all are collapsed.
  const [openSection, setOpenSection] = useState(null)
  const toggleSection = (id) => setOpenSection((s) => (s === id ? null : id))
  // Shared sub-section label inside the consolidated Collapsibles (Trips,
  // Staying in sync, Display & map). Set marginTop per use (0 for the first
  // label in a section, spacing.lg/xl to separate later ones).
  const subLabel = { ...typography.caption, color: colors.text.secondary, marginBottom: spacing.sm, fontWeight: 400, textAlign: 'center' }
  // Battery banner / onboarding deep-link signal: when the sheet opens
  // with initialExpand='battery', auto-expand "Staying in sync" (where the
  // battery toggle now lives) and scroll it into view so the user lands on
  // the toggle instead of the top of Settings. One-shot per sheet open.
  const stayingSyncRef = useRef(null)
  const handledInitialExpandRef = useRef(null)
  useEffect(() => {
    if (!active) { handledInitialExpandRef.current = null; return }
    if (!initialExpand || handledInitialExpandRef.current === initialExpand) return
    // 'battery' (home battery banner) -> Staying in sync, scrolled into view.
    // 'circles' (repair-escalation banner) -> Circles, where leave/recreate live.
    const target = initialExpand === 'battery' ? 'stayingSync'
      : initialExpand === 'circles' ? 'circles'
      : null
    if (!target) return
    handledInitialExpandRef.current = initialExpand
    setOpenSection(target)
    if (target === 'stayingSync') {
      requestAnimationFrame(() => {
        try { stayingSyncRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
      })
    }
  }, [active, initialExpand])
  const fileRef = useRef(null)

  const requestBatteryExempt = async () => {
    setBatteryError(null)
    try {
      const r = await pear.call('shell:battery:requestExempt')
      if (!r?.ok) setBatteryError(r?.error ?? 'Could not open battery settings.')
    } catch (e) {
      setBatteryError(String(e?.message ?? e))
    }
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
          setError('Animated avatar is too large. Try one under ~750KB.')
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
                borderRadius: radius.md, border: `1px solid ${colors.error}`,
                background: 'transparent', color: colors.error,
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

      <Collapsible title='Circles' icon={UsersThree} open={openSection === 'circles'} onToggle={() => toggleSection('circles')} maxHeight='1200px'>
        <CirclesSection active={active && openSection === 'circles'} onChanged={onSaved} />
      </Collapsible>

      <Collapsible title='Location sharing' icon={Broadcast} open={openSection === 'locationSharing'} onToggle={() => toggleSection('locationSharing')} maxHeight='1200px'>
        <LocationSharingSection active={active && openSection === 'locationSharing'} sharing={sharing} setSharingForCircle={setSharingForCircle} s={s} />
      </Collapsible>

      {/* Trips: sharing + notifications for trips together. */}
      <Collapsible title='Trips' icon={MapTrifold} open={openSection === 'trips'} onToggle={() => toggleSection('trips')} maxHeight='1800px'>
        <p style={{ ...subLabel, marginTop: 0 }}>Trip sharing</p>
        <TripsSharingSection active={active && openSection === 'trips'} />
        <p style={{ ...subLabel, marginTop: spacing.xl }}>Trip notifications</p>
        <TripNotificationsSection />
      </Collapsible>

      {/* Staying in sync: everything that keeps the no-server P2P backend
          running -- the daily open reminder, boot autostart (Android), and
          the battery exemption. The 'battery' deep-link lands here. */}
      <div ref={stayingSyncRef} />
      <Collapsible title='Staying in sync' icon={ArrowsClockwise} open={openSection === 'stayingSync'} onToggle={() => toggleSection('stayingSync')} maxHeight='2600px'>
        <p style={{ ...subLabel, marginTop: 0 }}>Daily reminder</p>
        <SyncReminderSection />
        <AutostartStatus />
        {battery.supported && (
          <div style={{ marginTop: spacing.lg }}>
            <p style={{ ...subLabel, marginTop: 0 }}>Battery optimization</p>
            {battery.exempt ? (
              <p style={s.muted}>
                Battery optimization is off for PearCircle. Location sharing
                should keep working through extended idle.
              </p>
            ) : (
              <>
                <p style={s.muted}>
                  Battery optimization is on. Android may pause location sharing
                  during long idle periods, so peers won't see your updates until
                  your phone wakes. Disabling this for PearCircle keeps sharing
                  reliable but uses slightly more battery.
                </p>
                <button style={{ ...s.primaryBtn, marginTop: spacing.sm }} onClick={requestBatteryExempt}>
                  Disable battery optimization
                </button>
              </>
            )}
            {batteryError && <p style={s.error}>{batteryError}</p>}
          </div>
        )}
      </Collapsible>

      <Collapsible title='Display & map' icon={Palette} open={openSection === 'display'} onToggle={() => toggleSection('display')} maxHeight='1600px'>
        <p style={{ ...subLabel, marginTop: 0 }}>Theme</p>
        <ThemeToggleSection mode={themeMode} onChange={setThemeMode} />
        <p style={{ ...subLabel, marginTop: spacing.lg }}>Distance unit</p>
        <DistanceUnitSection unit={distanceUnit} onChange={setDistanceUnit} />
        <p style={{ ...subLabel, marginTop: spacing.lg }}>Map tiles</p>
        <TileStyleSection url={tileStyleUrl} onChange={setTileStyleUrl} />
        <TileCacheSection />
      </Collapsible>

      <Collapsible title='Seeders' icon={Broadcast} open={openSection === 'seeders'} onToggle={() => toggleSection('seeders')} maxHeight='1600px'>
        <SeedersSection active={active && openSection === 'seeders'} />
      </Collapsible>

      {/* Advanced is debug-only now (battery moved to Staying in sync, map
          tiles to Display & map), so it only appears on debug builds. Gated
          on window.__pearDebug (set from __DEV__ by the shell). */}
      {typeof window !== 'undefined' && window.__pearDebug && (
        <Collapsible title='Advanced' icon={Wrench} open={openSection === 'advanced'} onToggle={() => toggleSection('advanced')} maxHeight='1200px'>
          <p style={{ ...subLabel, marginTop: 0 }}>Debug</p>
          <button
            style={{ ...s.primaryBtn, marginTop: spacing.sm }}
            onClick={() => { pear.call('trip:debugComplete', { distanceMeters: 1600 }).then((r) => { try { window.alert('Injected test trip (' + Math.round((r?.trip?.distanceMeters ?? 0)) + 'm). Watch peers for a notification.') } catch {} }).catch((e) => { try { window.alert('Inject failed: ' + (e?.message || e)) } catch {} }) }}
          >
            Inject test trip
          </button>
        </Collapsible>
      )}
    </div>
  )
}

function ThemeToggleSection ({ mode, onChange }) {
  const cur = mode === 'light' ? 'light' : 'dark'
  const btn = (label, value) => (
    <button
      onClick={() => { if (cur !== value) onChange?.(value) }}
      style={{
        flex: 1, padding: '10px', borderRadius: radius.sm,
        background: cur === value ? colors.primary : 'transparent',
        color: cur === value ? colors.text.onPrimary : colors.text.primary,
        border: `1px solid ${cur === value ? colors.primary : colors.border}`,
        cursor: 'pointer',
        fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
      }}
    >
      {label}
    </button>
  )
  return (
    <div style={{ display: 'flex', gap: spacing.sm }}>
      {btn('Dark', 'dark')}
      {btn('Light', 'light')}
    </div>
  )
}

// Per-circle location sharing controls. Pause durations are
// 1h / 4h / 8h / 24h; an indefinite Stop is also available. State is
// fed in from App via `sharing` (the worklet drives the source of
// truth) so updates land in this component automatically via the
// sharing:changed event.
function LocationSharingSection ({ active = true, sharing, setSharingForCircle, s }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [pendingCircleId, setPendingCircleId] = useState(null)
  const [expandedCircleId, setExpandedCircleId] = useState(null)
  const [errorByCircle, setErrorByCircle] = useState({})

  // Drive a one-second tick so the "Paused, resumes in 1h 23m" line
  // counts down live. Only spins while at least one circle is paused
  // with an expiresAt; the effect rearms when that condition flips.
  const [, setNowTick] = useState(0)
  const anyTickable = useMemo(() => {
    return list.some((c) => {
      const st = getCircleSharing(sharing, c.circleId)
      return !st.enabled && typeof st.expiresAt === 'number'
    })
  }, [list, sharing])
  useEffect(() => {
    if (!anyTickable) return
    const id = setInterval(() => setNowTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [anyTickable])

  const refresh = useCallback(async () => {
    try {
      const snap = await pear.call('circles:getAll')
      const next = (snap?.circles ?? [])
        .filter((c) => !c.error && !c.circle?.deleted)
        .map((c) => ({ circleId: c.circleId, name: c.circle?.name || CIRCLE_NAME_PENDING }))
      setList(next)
    } catch {
      // Empty list keeps the section in its "no circles yet" copy.
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { if (active) refresh() }, [active, refresh])

  const apply = async (circleId, enabled, expiresAt = null) => {
    setPendingCircleId(circleId)
    setErrorByCircle((prev) => ({ ...prev, [circleId]: null }))
    try {
      await setSharingForCircle(circleId, enabled, expiresAt)
      setExpandedCircleId(null)
    } catch (e) {
      setErrorByCircle((prev) => ({ ...prev, [circleId]: String(e?.message ?? e) }))
    } finally {
      setPendingCircleId(null)
    }
  }

  // Chrome (background, border radius, title) is supplied by the
  // surrounding Collapsible in ProfileView. This component just
  // renders the per-circle pause/resume rows.
  return (
    <>
      {loading ? (
        <p style={{ ...s.muted, marginTop: 0 }}>Loading…</p>
      ) : list.length === 0 ? (
        <p style={{ ...s.muted, marginTop: 0 }}>
          Join or create a circle to start sharing your location.
        </p>
      ) : (
        [...list].sort((a, b) => byName(a.name, b.name)).map((c, idx, sorted) => {
          const st = getCircleSharing(sharing, c.circleId)
          const isPending = pendingCircleId === c.circleId
          const expanded = expandedCircleId === c.circleId
          const err = errorByCircle[c.circleId]
          const last = idx === sorted.length - 1
          return (
            <CircleSharingRow
              key={c.circleId}
              circle={c}
              state={st}
              isPending={isPending}
              expanded={expanded}
              error={err}
              isLast={last}
              onExpand={() => setExpandedCircleId(expanded ? null : c.circleId)}
              onPause={(ms) => apply(c.circleId, false, ms ? Date.now() + ms : null)}
              onResume={() => apply(c.circleId, true, null)}
            />
          )
        })
      )}
    </>
  )
}

const PAUSE_DURATIONS = [
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '4 hours', ms: 4 * 60 * 60_000 },
  { label: '8 hours', ms: 8 * 60 * 60_000 },
  { label: '24 hours', ms: 24 * 60 * 60_000 },
]

function CircleSharingRow ({ circle, state, isPending, expanded, error, isLast, onExpand, onPause, onResume }) {
  const paused = !state.enabled
  const remainingMs = paused && typeof state.expiresAt === 'number' ? state.expiresAt - Date.now() : null
  const subText = paused
    ? (remainingMs && remainingMs > 0
        ? `Paused. Resumes in ${formatRemaining(remainingMs)}.`
        : 'Location sharing stopped. Other members cannot see you on the map.')
    : 'Sharing your live location with this circle.'
  return (
    <div style={{
      padding: `${spacing.sm + 2}px 0`,
      borderBottom: isLast ? 'none' : `1px solid ${colors.divider}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            ...typography.body, color: colors.text.primary,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {circle.name}
          </div>
          <div style={{
            ...typography.caption,
            color: paused ? colors.error : colors.text.secondary,
            marginTop: 2,
          }}>
            {subText}
          </div>
        </div>
        {paused ? (
          <button
            onClick={onResume}
            disabled={isPending}
            style={{
              padding: '8px 14px', borderRadius: radius.sm,
              background: colors.primary, color: colors.text.onPrimary,
              border: `1px solid ${colors.primary}`,
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 13,
              cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.5 : 1,
            }}
          >
            {isPending ? 'Resuming…' : 'Resume'}
          </button>
        ) : (
          <button
            onClick={onExpand}
            disabled={isPending}
            style={{
              padding: '8px 14px', borderRadius: radius.sm,
              background: expanded ? colors.surface.input : 'transparent',
              color: colors.text.primary,
              border: `1px solid ${colors.border}`,
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 13,
              cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.5 : 1,
            }}
          >
            {isPending ? 'Pausing…' : 'Pause'}
          </button>
        )}
      </div>
      {expanded && !paused && (
        <div style={{ marginTop: spacing.sm }}>
          <div style={{ display: 'flex', gap: spacing.xs + 2, flexWrap: 'wrap' }}>
            {PAUSE_DURATIONS.map(({ label, ms }) => (
              <button
                key={label}
                onClick={() => onPause(ms)}
                disabled={isPending}
                style={{
                  flex: '1 1 0', minWidth: 64,
                  padding: `${spacing.sm + 2}px ${spacing.sm}px`,
                  background: colors.surface.input, color: colors.text.primary,
                  border: `1px solid ${colors.text.secondary}`, borderRadius: radius.md,
                  fontSize: typography.body.fontSize, fontWeight: 400,
                  fontFamily: typography.fontFamily,
                  cursor: isPending ? 'default' : 'pointer',
                  opacity: isPending ? 0.5 : 1,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => onPause(null)}
            disabled={isPending}
            style={{
              width: '100%', marginTop: spacing.sm,
              padding: `${spacing.md}px ${spacing.base}px`,
              background: 'transparent', color: colors.error,
              border: `1px solid ${colors.error}`, borderRadius: radius.md,
              fontSize: 13, fontWeight: 400, fontFamily: typography.fontFamily,
              cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.5 : 1,
            }}
          >
            Stop sharing indefinitely
          </button>
        </div>
      )}
      {error && (
        <p style={{ ...typography.caption, color: colors.error, marginTop: spacing.xs, marginBottom: 0 }}>{error}</p>
      )}
    </div>
  )
}

// Per-circle trip-sharing toggle list (proposal 2026-05-10). Default
// OFF everywhere (opt-in) — privacy is the load-bearing constraint
// per the proposal: a user upgrading to this build ships zero trips
// until they explicitly turn sharing on for at least one circle.
// Toggling on is non-destructive (only future trips replicate; past
// trips stay private). Toggling off shows a confirmation surfacing
// the implications.
function TripsSharingSection ({ active = true }) {
  const [list, setList] = useState([])
  const [sharing, setSharing] = useState({})
  const [loading, setLoading] = useState(true)
  const [pendingCircleId, setPendingCircleId] = useState(null)
  const [confirming, setConfirming] = useState(null) // { circleId, name, value }

  const refresh = useCallback(async () => {
    try {
      const [snap, sharingR] = await Promise.all([
        pear.call('circles:getAll'),
        pear.call('trips:sharing:get'),
      ])
      const next = (snap?.circles ?? [])
        .filter((c) => !c.error && !c.circle?.deleted)
        .map((c) => ({ circleId: c.circleId, name: c.circle?.name || CIRCLE_NAME_PENDING }))
      setList(next)
      setSharing(sharingR?.sharing ?? {})
    } catch {
      // Surface nothing here; the Collapsible just stays empty.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (active) refresh() }, [active, refresh])

  const onCommit = async () => {
    if (!confirming) return
    const { circleId, value } = confirming
    setPendingCircleId(circleId)
    try {
      await pear.call('trips:sharing:set', { circleId, enabled: value })
      setSharing((prev) => ({ ...prev, [circleId]: value }))
    } catch {
      // Leave UI in last-known state; user can retry.
    } finally {
      setPendingCircleId(null)
      setConfirming(null)
    }
  }

  if (loading) {
    return <p style={{ ...typography.caption, color: colors.text.muted }}>Loading…</p>
  }
  if (list.length === 0) {
    return (
      <p style={{ ...typography.caption, color: colors.text.muted }}>
        No circles yet. Trip sharing applies once you join or create one.
      </p>
    )
  }

  return (
    <div>
      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.base, fontWeight: 400 }}>
        When on, future trips you take are shared with members of that circle. Past trips remain private until you turn this on. Off any time.
      </p>
      {[...list].sort((a, b) => byName(a.name, b.name)).map((c) => {
        const on = sharing[c.circleId] === true
        const busy = pendingCircleId === c.circleId
        return (
          <div
            key={c.circleId}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}`,
            }}
          >
            <div style={{ ...typography.body, color: colors.text.primary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name}
            </div>
            <button
              onClick={() => setConfirming({ circleId: c.circleId, name: c.name, value: !on })}
              disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: radius.sm,
                background: on ? colors.primary : 'transparent',
                color: on ? colors.text.onPrimary : colors.text.primary,
                border: `1px solid ${on ? colors.primary : colors.border}`,
                cursor: busy ? 'default' : 'pointer',
                fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 13,
                opacity: busy ? 0.5 : 1,
              }}
            >
              {on ? 'Sharing' : 'Off'}
            </button>
          </div>
        )
      })}
      {confirming && (
        <ConfirmSheet
          title={confirming.value
            ? `Share trips with "${confirming.name}"?`
            : `Stop sharing trips with "${confirming.name}"?`}
          message={confirming.value
            ? <>Members of <strong>{confirming.name}</strong> will see trips you take from now on. Past trips stay private. You can turn this off any time.</>
            : <>Future trips won't be shared with <strong>{confirming.name}</strong>. Trips you've already shared remain visible to members until you delete them from the trip detail view.</>}
          confirmLabel={confirming.value ? 'Share' : 'Stop sharing'}
          destructive={!confirming.value}
          busy={pendingCircleId === confirming.circleId}
          onConfirm={onCommit}
          onClose={() => { if (pendingCircleId !== confirming.circleId) setConfirming(null) }}
        />
      )}
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
        background: cur === value ? colors.primary : 'transparent',
        color: cur === value ? colors.text.onPrimary : colors.text.primary,
        border: `1px solid ${cur === value ? colors.primary : colors.border}`,
        cursor: 'pointer',
        fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
      }}
    >
      {label}
    </button>
  )
  return (
    <>
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

// Local mute for the "Jane completed a 12 km trip" OS notifications.
// Worklet is the source of truth (_tripNotificationsEnabled in src/bare.js)
// and it gates the IPC emit before the shell ever hears about a peer trip,
// so flipping this off stops notifications immediately even if the WebView
// stays open. Default on; self-contained state since no other view needs it.
function TripNotificationsSection () {
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    pear.call('tripNotifications:get').then((r) => {
      if (r && typeof r.enabled === 'boolean') setEnabled(r.enabled)
    }).catch(() => {})
    pear.on('tripNotifications:changed', (data) => {
      if (data && typeof data.enabled === 'boolean') setEnabled(data.enabled)
    })
  }, [])
  const toggle = useCallback(async (value) => {
    if (value === enabled) return
    try { await pear.call('tripNotifications:set', { enabled: value }) } catch {}
    setEnabled(value)
  }, [enabled])
  const btn = (label, value) => (
    <button
      onClick={() => toggle(value)}
      style={{
        flex: 1, padding: '10px', borderRadius: radius.sm,
        background: enabled === value ? colors.primary : 'transparent',
        color: enabled === value ? colors.text.onPrimary : colors.text.primary,
        border: `1px solid ${enabled === value ? colors.primary : colors.border}`,
        cursor: 'pointer',
        fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
      }}
    >
      {label}
    </button>
  )
  return (
    <>
      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.sm }}>
        Notify when a circle member finishes a trip. Trips are still recorded either way.
      </p>
      <div style={{ display: 'flex', gap: spacing.sm }}>
        {btn('On', true)}
        {btn('Off', false)}
      </div>
    </>
  )
}

// A daily local reminder to open the app. PearCircle has no servers, so a
// circle's history only catches up while members' apps are open; if nobody
// opens it (and no always-on seeder is enrolled), everyone's view drifts
// stale. The reminder fires every day at the user's chosen time (a repeating
// DAILY trigger in the shell). Reads/writes the shell preference via
// shell:syncReminder:get/set.
function SyncReminderSection () {
  const [enabled, setEnabled] = useState(true)
  const [time, setTime] = useState('08:00')
  useEffect(() => {
    pear.call('shell:syncReminder:get').then((r) => {
      if (r && typeof r.enabled === 'boolean') setEnabled(r.enabled)
      if (r && typeof r.time === 'string') setTime(r.time)
    }).catch(() => {})
  }, [])
  const toggle = useCallback(async (value) => {
    if (value === enabled) return
    setEnabled(value)   // optimistic; revert on failure
    try { await pear.call('shell:syncReminder:set', { enabled: value }) }
    catch { setEnabled(!value) }
  }, [enabled])
  const changeTime = useCallback(async (value) => {
    if (!/^\d{2}:\d{2}$/.test(value)) return
    const prev = time
    setTime(value)
    try { await pear.call('shell:syncReminder:set', { time: value }) }
    catch { setTime(prev) }
  }, [time])
  const btn = (label, value) => (
    <button
      onClick={() => toggle(value)}
      style={{
        flex: 1, padding: '10px', borderRadius: radius.sm,
        background: enabled === value ? colors.primary : 'transparent',
        color: enabled === value ? colors.text.onPrimary : colors.text.primary,
        border: `1px solid ${enabled === value ? colors.primary : colors.border}`,
        cursor: 'pointer',
        fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
      }}
    >
      {label}
    </button>
  )
  return (
    <>
      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.sm }}>
        PearCircle has no servers — your circles sync directly between members' phones, only while the app is running. A daily reminder at the time you pick nudges you to open PearCircle so your latest location goes out and you catch up on everyone else.
      </p>
      <div style={{ display: 'flex', gap: spacing.sm }}>
        {btn('On', true)}
        {btn('Off', false)}
      </div>
      {enabled && (
        <div style={{ marginTop: spacing.lg }}>
          <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.sm, fontWeight: 400 }}>Reminder time</p>
          <div style={{ position: 'relative', width: '100%' }}>
            <input
              type='time'
              value={time}
              onChange={(e) => changeTime(e.currentTarget.value)}
              style={{
                width: '100%', boxSizing: 'border-box', minWidth: 0, margin: 0,
                WebkitAppearance: 'none', appearance: 'none',
                padding: '10px 38px 10px 12px', borderRadius: radius.sm,
                background: colors.surface.input, color: colors.text.primary,
                border: `1px solid ${colors.border}`,
                fontFamily: typography.fontFamily, fontSize: 14,
              }}
            />
            {/* Our own caret: native indicators are hidden (see the time-input
                style block) so spacing is identical on iOS + Android. pointer-
                events:none lets the tap fall through to the input's picker. */}
            <CaretDown
              size={16}
              weight='bold'
              color={colors.text.secondary}
              style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
            />
          </div>
        </div>
      )}
    </>
  )
}

// "Autostart after restart" status (Android only), a sub-block of the
// "Staying in sync" Settings section. PearCircle resumes background sharing
// after a reboot or in-place update via the native BootReceiver, but only when
// the gate is armed (sharing on in some circle) AND a location grant is held --
// and only if the app was opened at least once since the update and never
// force-stopped (an OS "stopped state" rule we can't read from inside the app).
// This surfaces the readable parts so a user or the owner can see why a phone
// isn't auto-resuming without pulling logcat. Battery exemption is shown by the
// sibling block in the same section, so it's intentionally not repeated here
// (and it gates staying-alive, not arming). Returns null on iOS (no boot-resume
// path), hiding the whole sub-block there.
function AutostartStatus () {
  const [status, setStatus] = useState(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    const refresh = () => pear.call('shell:autostart:get')
      .then((r) => { if (mountedRef.current) setStatus(r || { supported: false }) })
      .catch(() => { if (mountedRef.current) setStatus({ supported: false }) })
    refresh()
    // Re-read on foreground so returning from system Settings (permission
    // change) refreshes the readout without a manual action.
    pear.on('app:state', ({ state }) => { if (state === 'active') refresh() })
    return () => { mountedRef.current = false }
  }, [])
  // Stay hidden until we know it's supported: on iOS this resolves to
  // supported:false and the sub-block never appears (no flash).
  if (!status || status.supported === false) return null

  const { gateEnabled, locationGranted, locationStatus } = status
  const armed = gateEnabled && locationGranted
  const headline = armed
    ? 'Armed. PearCircle will reopen itself after a phone restart.'
    : !gateEnabled
        ? 'Not armed yet. Turn on location sharing for at least one circle and it arms automatically.'
        : 'Not armed. Location permission is off.'

  const factorRow = (ok, warn, label, hint) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.sm }}>
      <span style={{ marginTop: 1, flexShrink: 0, color: ok ? colors.success : warn ? colors.warn : colors.error }}>
        {ok ? <CheckCircle size={16} weight='fill' /> : <Warning size={16} weight='fill' />}
      </span>
      <span style={{ ...typography.caption, color: colors.text.secondary, fontWeight: 400 }}>
        <span style={{ color: colors.text.primary }}>{label}</span>{hint ? ` - ${hint}` : ''}
      </span>
    </div>
  )

  return (
    <div style={{ marginTop: spacing.lg }}>
      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.sm, fontWeight: 400, textAlign: 'center' }}>Autostart after restart</p>
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.sm,
        padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.md,
        background: colors.surface.input,
        border: `1px solid ${armed ? colors.success : colors.warn}`,
      }}>
        <span style={{ flexShrink: 0, color: armed ? colors.success : colors.warn }}>
          {armed ? <CheckCircle size={20} weight='fill' /> : <Warning size={20} weight='fill' />}
        </span>
        <span style={{ ...typography.caption, color: colors.text.primary, fontWeight: 400 }}>{headline}</span>
      </div>

      {factorRow(gateEnabled, false, 'Location sharing on', gateEnabled ? null : 'off in every circle')}
      {factorRow(
        locationStatus === 'always',
        locationStatus === 'whenInUse',
        'Location permission',
        locationStatus === 'always'
          ? 'allowed all the time'
          : locationStatus === 'whenInUse'
              ? 'set it to "Allow all the time" for reliable background sharing'
              : 'not granted'
      )}

      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: spacing.lg, marginBottom: 0, fontWeight: 400 }}>
        One thing Android hides from the app: after you update PearCircle you have to open it once, and never "Force stop" it, or the system blocks it from starting on its own until you reopen it.
      </p>
    </div>
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
      <p style={s.muted}>
        The map fetches tile imagery from this MapLibre style URL.
        Default is OpenFreeMap. Change if the default is unavailable
        or you want to point at your own provider.
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

// Offline tile cache stats + admin. Reads from window.__pearTileCache
// (installed in main.jsx at boot). The map fetches every tile through
// the cache, so size grows naturally as the user explores; this UI
// surfaces what's cached, lets them clear LRU entries, and opens the
// region-download manager for explicit offline coverage.
function TileCacheSection () {
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const [regions, setRegions] = useState([])
  const [downloadOpen, setDownloadOpen] = useState(false)

  const refresh = useCallback(async () => {
    const cache = window.__pearTileCache
    if (!cache) return
    try {
      const s = await cache.stats()
      const rs = await cache.listRegions()
      setStats(s)
      setRegions(rs)
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
    // Periodic refresh while the section is mounted so size updates
    // as the user explores the map without leaving Settings open
    // for too long. 5s is plenty -- the user only sees this while
    // the section is expanded.
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const clear = async () => {
    if (busy) return
    setBusy(true)
    try {
      await window.__pearTileCache?.clear()
      await refresh()
    } finally { setBusy(false) }
  }
  const deleteRegion = async (id) => {
    if (busy) return
    setBusy(true)
    try {
      await window.__pearTileCache?.deleteRegion(id)
      await refresh()
    } finally { setBusy(false) }
  }

  return (
    <>
      <p style={{ ...typography.caption, color: colors.text.secondary, marginTop: spacing.lg, marginBottom: spacing.sm, fontWeight: 400 }}>
        Offline tiles
      </p>
      <p style={s.muted}>
        Tiles you've viewed stay cached so the map keeps working without a network connection.
      </p>
      <div style={{
        display: 'flex', gap: spacing.base,
        background: colors.surface.input,
        border: `1px solid ${colors.border}`,
        borderRadius: radius.md,
        padding: `${spacing.sm + 2}px ${spacing.md}px`,
        marginBottom: spacing.sm,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...typography.caption, color: colors.text.muted }}>Cached</div>
          <div style={{ ...typography.body, color: colors.text.primary, fontVariantNumeric: 'tabular-nums' }}>
            {stats ? `${formatBytes(stats.totalBytes)} · ${stats.count.toLocaleString()} tiles` : '...'}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ ...typography.caption, color: colors.text.muted }}>Limit</div>
          <div style={{ ...typography.body, color: colors.text.primary, fontVariantNumeric: 'tabular-nums' }}>
            {stats ? formatBytes(stats.maxBytes) : '...'}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: spacing.sm, marginBottom: regions.length > 0 ? spacing.base : 0 }}>
        <button style={{ ...s.secondaryBtn, marginTop: 0, boxSizing: 'border-box', flex: 1 }} onClick={() => setDownloadOpen(true)}>
          Download tiles
        </button>
        <button style={{ ...s.secondaryBtn, marginTop: 0, boxSizing: 'border-box', flex: 1 }} onClick={clear} disabled={busy}>
          Clear cache
        </button>
      </div>
      {regions.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {regions.map((r) => (
            <li key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: spacing.sm,
              padding: `${spacing.sm}px 0`,
              borderTop: `1px solid ${colors.divider}`,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ ...typography.body, color: colors.text.primary }}>{r.name}</div>
                <div style={{ ...typography.caption, color: colors.text.muted, fontVariantNumeric: 'tabular-nums' }}>
                  {r.status === 'downloading'
                    ? `${formatBytes(r.sizeBytes)} · ${r.downloadedTiles?.toLocaleString() ?? 0} / ${r.totalTiles?.toLocaleString() ?? '?'} tiles · downloading`
                    : r.status === 'failed'
                      ? `${formatBytes(r.sizeBytes)} · ${r.downloadedTiles?.toLocaleString() ?? 0} tiles · failed`
                      : `${formatBytes(r.sizeBytes)} · ${r.downloadedTiles?.toLocaleString() ?? r.totalTiles?.toLocaleString() ?? 0} tiles`}
                </div>
              </div>
              <button
                onClick={() => deleteRegion(r.id)}
                disabled={busy}
                aria-label={'Delete ' + r.name}
                style={{
                  background: 'transparent', border: 'none',
                  color: colors.text.muted, cursor: 'pointer',
                  padding: spacing.sm,
                }}
              >
                <Trash size={18} weight='regular' />
              </button>
            </li>
          ))}
        </ul>
      )}
      {downloadOpen && (
        <RegionDownloadModal
          onClose={() => { setDownloadOpen(false); refresh() }}
        />
      )}
    </>
  )
}

function formatBytes (n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

// Pre-emptive download bottom-sheet. Reads the current map viewport
// from window.__pearMapViewport (published by CircleMap), lets the
// user pick a zoom range, estimates the download, and runs it.
// Progress updates persist into the cache's region record so
// dismissing / reopening Settings while a download is in flight
// still surfaces live progress in the TileCacheSection's regions
// list. Bottom-sheet rather than centered modal because the entry
// button lives at the bottom of the Map tiles section and a centered
// modal lands above the user's scroll position.
function RegionDownloadModal ({ onClose }) {
  const viewport = (typeof window !== 'undefined') ? window.__pearMapViewport : null
  const [name, setName] = useState('')
  const [zMax, setZMax] = useState(13)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const tileStyleUrl = (typeof window !== 'undefined' ? window.__pearTileStyleUrl : null) || DEFAULT_TILE_STYLE_URL
  const zMin = 6  // fixed -- lower than 6 is world-scale and adds negligible bytes

  const tileEstimate = useMemo(() => {
    if (!viewport?.bbox) return 0
    return estimateTilesInBbox(viewport.bbox, zMin, zMax)
  }, [viewport, zMin, zMax])
  const sizeEstimate = tileEstimate * 15 * 1024  // ~15 KB per vector tile

  const start = async () => {
    if (!viewport?.bbox) { setError('Pan the map to the area you want first.'); return }
    let cache = window.__pearTileCache
    if (!cache) {
      // Cache wasn't initialized at boot -- last-ditch open in case
      // main.jsx's init lost a race with the WebView's IDB worker.
      try {
        const mod = await import('./lib/tileCache.js')
        cache = await mod.openTileCache()
        window.__pearTileCache = cache
      } catch (e) {
        setError('Tile cache could not open: ' + (e?.message || e))
        return
      }
    }
    setError(null)
    setRunning(true)
    setProgress(null)
    const controller = new AbortController()
    abortRef.current = controller
    const regionId = 'region-' + Date.now()
    const regionName = name.trim() || ('Offline area · ' + new Date().toLocaleString())
    try {
      await downloadRegion({
        bbox: viewport.bbox,
        zMin, zMax,
        regionId,
        name: regionName,
        tileStyleUrl,
        cache,
        signal: controller.signal,
        onProgress: (r) => setProgress(r),
      })
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }
  const cancel = () => {
    abortRef.current?.abort()
  }

  return (
    <BottomSheet onClose={onClose} zIndex={420}>
      <div style={{ padding: `${spacing.lg}px ${spacing.lg}px ${spacing.base}px` }}>
        <div style={{ ...typography.heading, color: colors.text.primary, marginBottom: spacing.sm }}>
          Download tiles
        </div>
        {!viewport?.bbox ? (
          <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.5 }}>
            Open the map and pan to the area you want to download, then come back here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.base }}>
            <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.5 }}>
              The current map view will be cached down to your chosen zoom level. Higher zoom = more detail and more storage.
            </div>
            <div>
              <div style={{ ...typography.caption, color: colors.text.muted, marginBottom: spacing.xs }}>Name (optional)</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. Denver area'
                disabled={running}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px',
                  background: colors.surface.input,
                  border: `1px solid ${colors.border}`,
                  borderRadius: radius.md,
                  color: colors.text.primary,
                  fontSize: 14, fontFamily: typography.fontFamily,
                }}
              />
            </div>
            <div>
              <div style={{ ...typography.caption, color: colors.text.muted, marginBottom: spacing.xs }}>
                Maximum zoom: {zMax} <span style={{ color: colors.text.muted }}>(11 = neighborhood, 13 = street, 15 = building)</span>
              </div>
              <input
                type='range'
                min={10} max={15}
                value={zMax}
                disabled={running}
                onChange={(e) => setZMax(parseInt(e.target.value, 10))}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{
              background: colors.surface.input,
              border: `1px solid ${colors.border}`,
              borderRadius: radius.md,
              padding: `${spacing.sm}px ${spacing.md}px`,
              ...typography.caption, color: colors.text.secondary,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {progress
                ? `${progress.downloadedTiles.toLocaleString()} / ${progress.totalTiles.toLocaleString()} tiles · ${formatBytes(progress.sizeBytes)}`
                : `~${tileEstimate.toLocaleString()} tiles · ~${formatBytes(sizeEstimate)}`
              }
            </div>
            {error && (
              <div style={{ ...typography.caption, color: colors.error }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: spacing.sm }}>
              {running ? (
                <button
                  onClick={cancel}
                  style={{
                    flex: 1, padding: '13px', borderRadius: radius.md,
                    background: 'transparent', color: colors.text.primary,
                    border: `1px solid ${colors.border}`,
                    cursor: 'pointer',
                    fontFamily: typography.fontFamily, fontSize: 14,
                  }}
                >
                  Cancel
                </button>
              ) : (
                <>
                  <button
                    onClick={onClose}
                    style={{
                      flex: 1, padding: '13px', borderRadius: radius.md,
                      background: 'transparent', color: colors.text.primary,
                      border: `1px solid ${colors.border}`,
                      cursor: 'pointer',
                      fontFamily: typography.fontFamily, fontSize: 14,
                    }}
                  >
                    {progress?.status === 'complete' ? 'Close' : 'Cancel'}
                  </button>
                  {progress?.status !== 'complete' && (
                    <button
                      onClick={start}
                      disabled={tileEstimate === 0}
                      style={{
                        flex: 1, padding: '13px', borderRadius: radius.md,
                        background: colors.primary, color: colors.text.onPrimary,
                        border: 'none', cursor: tileEstimate > 0 ? 'pointer' : 'default',
                        opacity: tileEstimate > 0 ? 1 : 0.5,
                        fontFamily: typography.fontFamily, fontSize: 14,
                      }}
                    >
                      Download
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </BottomSheet>
  )
}

// AboutView mirrors PearGuard's AboutTab pattern: brand header, plain
// prose sections explaining the model, a couple of action buttons. No
// donation flow yet (PearCircle hasn't shipped to stores; can layer in
// later with the same iOS guideline 3.1.1 gating PearGuard uses).
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'

const LIGHTNING_WALLETS = [
  { name: 'Strike',            url: 'https://strike.me',          desc: 'Simple Lightning payments' },
  { name: 'Cash App',          url: 'https://cash.app',           desc: 'Send Bitcoin via Lightning' },
  { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com', desc: 'Beginner-friendly Lightning wallet' },
  { name: 'Phoenix',           url: 'https://phoenix.acinq.co',   desc: 'Self-custodial Lightning wallet' },
]

// Inline collapsible card. Mirrors PearGuard's AboutTab pattern: header
// is a clickable row with a leading icon, title, and a chevron that
// rotates 90deg when open. Body uses a max-height transition so it
// animates instead of snapping.
function Collapsible ({ title, icon: Icon, open, onToggle, maxHeight = '480px', children }) {
  return (
    <div style={{
      background: colors.surface.elevated,
      borderRadius: radius.lg,
      marginBottom: spacing.sm + 2,
      overflow: 'hidden',
    }}>
      {/* <button> rather than <div> so the global capture-phase click
          listener (App.jsx:215) picks it up and fires the light haptic
          for free. Default button chrome is reset back to the parent
          card's surface. */}
      <button
        onClick={onToggle}
        style={{
          width: '100%', textAlign: 'left',
          background: 'transparent', border: 'none',
          color: colors.text.primary, fontFamily: typography.fontFamily,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: `${spacing.md}px ${spacing.base}px`, cursor: 'pointer',
        }}
        aria-expanded={open}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: spacing.sm,
          fontSize: 14, fontWeight: 400, color: colors.text.primary,
          fontFamily: typography.fontFamily,
        }}>
          {Icon ? <Icon size={18} weight='thin' color={colors.text.secondary} /> : null}
          {title}
        </div>
        <span style={{
          fontSize: 16, color: colors.text.muted,
          transition: 'transform 0.3s', display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>&rsaquo;</span>
      </button>
      <div style={{
        maxHeight: open ? maxHeight : '0px',
        overflow: 'hidden',
        transition: 'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{ padding: `0 ${spacing.base}px ${spacing.base}px` }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function AboutView ({ onClose, initialExpand = null, onReplayOnboarding = null }) {
  const [walletModal, setWalletModal] = useState(false)
  // initialExpand opens a single section on navigation (e.g., the
  // donation reminder modal hands us 'support' so the user lands on
  // the Support-development collapsible already open). Per-section
  // state stays user-controlled after that — the user can close it
  // and we don't reopen until the next navigation with expand='support'.
  //
  // Why useEffect rather than useState's lazy initializer: SheetContainer
  // keeps AboutView mounted across navigations (translates off-screen
  // when closed), so the initializer only runs on the very first mount.
  // The effect re-runs whenever the prop changes — i.e., every time
  // setSheet({name:'about', expand:'...'}) lands a new value.
  // Accordion: one section open at a time.
  const [openSection, setOpenSection] = useState(null)
  const toggleSection = (id) => setOpenSection((s) => (s === id ? null : id))
  useEffect(() => {
    if (['support', 'how', 'bitcoin', 'share', 'contact'].includes(initialExpand)) {
      setOpenSection(initialExpand)
    }
  }, [initialExpand])

  const openURL = (url) => { try { pear.call('shell:openUrl', { url }) } catch {} }

  const share = () => {
    try {
      pear.call('shell:share', {
        title: 'PearCircle',
        text: 'Check out PearCircle - a private, peer-to-peer location-sharing app with no servers or accounts.\n\nhttps://peerloomllc.com/pearcircle/',
      })
    } catch {}
  }

  const handleDonateBTC = async () => {
    try {
      const r = await pear.call('shell:canOpenURL', { url: 'lightning:test' })
      if (r?.can) openURL('lightning:' + LIGHTNING_ADDRESS)
      else setWalletModal(true)
    } catch {
      setWalletModal(true)
    }
  }

  const reportIssue = () => openURL('https://github.com/peerloomllc/pearcircle/issues')
  const sendEmail = () => openURL('mailto:peerloomllc@proton.me?subject=%5BPearCircle%5D%20Feedback')

  const body = {
    fontSize: 13, fontWeight: 300,
    color: colors.text.muted, lineHeight: 1.6,
    margin: `0 0 ${spacing.md}px 0`,
    fontFamily: typography.fontFamily,
  }
  // Brand-colored pill for the calls-to-action inside collapsibles.
  // Lime-on-dark contrasts with the elevated card surface and matches
  // s.primaryBtn elsewhere in the app.
  const pillBtn = {
    width: '100%', padding: `${spacing.sm + 2}px`, borderRadius: radius.md,
    border: 'none', background: colors.primary,
    color: colors.text.onPrimary,
    fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={onClose} title='' />

      {/* App-info header */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.lg }}>
        <div style={{ fontSize: 20, fontWeight: 400, color: colors.text.primary, fontFamily: typography.fontFamily }}>PearCircle</div>
        <div style={{ fontSize: 12, fontWeight: 300, color: colors.text.muted, fontFamily: typography.fontFamily }}>
          Private. Peer-to-Peer. No Servers.
        </div>
      </div>

      <Collapsible title='How it works' icon={InfoIcon} open={openSection === 'how'} onToggle={() => toggleSection('how')}>
        <p style={body}>
          PearCircle syncs locations directly between devices using
          peer-to-peer technology powered by Hypercore Protocol. Your
          circle's data never touches a server - it lives only on the
          devices in your circles. No accounts. No subscriptions. No
          data collection.
        </p>
        <button onClick={() => openURL('https://pears.com/')} style={pillBtn}>
          Learn about P2P <ArrowSquareOut size={14} weight='thin' />
        </button>
      </Collapsible>

      {onReplayOnboarding && (
        <Collapsible title='Tutorial' icon={BookOpen} open={openSection === 'tutorial'} onToggle={() => toggleSection('tutorial')}>
          <p style={body}>
            Replay the welcome tour to revisit how the map, circles,
            places, and trips work.
          </p>
          <button onClick={() => { onReplayOnboarding(); onClose() }} style={pillBtn}>
            <BookOpen size={16} weight='thin' /> Replay Tutorial
          </button>
        </Collapsible>
      )}

      <Collapsible title='Support development' icon={Lightning} open={openSection === 'support'} onToggle={() => toggleSection('support')}>
        <p style={body}>
          PearCircle is free and open source. If you receive value from
          it, please consider returning value.
        </p>
        <div style={{ display: 'flex', gap: spacing.sm }}>
          <button onClick={handleDonateBTC} style={{ ...pillBtn, flex: 1 }}>
            <Lightning size={14} weight='thin' /> BTC <Lightning size={14} weight='thin' />
          </button>
          <button onClick={() => openURL('https://buymeacoffee.com/peerloomllc')} style={{ ...pillBtn, flex: 1 }}>
            <CurrencyDollar size={14} weight='thin' /> USD <CurrencyDollar size={14} weight='thin' />
          </button>
        </div>
      </Collapsible>

      <Collapsible title='Learn about Bitcoin' icon={BookOpen} open={openSection === 'bitcoin'} onToggle={() => toggleSection('bitcoin')}>
        <p style={body}>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free,
          concise crash course explaining how Bitcoin works and why it
          matters.
        </p>
        <button onClick={() => openURL('https://nakamotoinstitute.org/crash-course/')} style={pillBtn}>
          <BookOpen size={16} weight='thin' /> Bitcoin Crash Course <ArrowSquareOut size={14} weight='thin' />
        </button>
      </Collapsible>

      <Collapsible title='Share the app' icon={ShareNetwork} open={openSection === 'share'} onToggle={() => toggleSection('share')}>
        <p style={body}>
          Know someone who'd want a private, serverless way to share
          location with friends or family? Share PearCircle with them.
        </p>
        <button onClick={share} style={pillBtn}>
          <ShareNetwork size={16} weight='thin' /> Share PearCircle
        </button>
      </Collapsible>

      <Collapsible title='Contact' icon={EnvelopeSimple} open={openSection === 'contact'} onToggle={() => toggleSection('contact')}>
        <div style={{ display: 'flex', gap: spacing.sm }}>
          <button onClick={sendEmail} style={{ ...pillBtn, flex: 1 }}>
            <EnvelopeSimple size={14} weight='thin' /> Email <ArrowSquareOut size={13} weight='thin' />
          </button>
          <button onClick={reportIssue} style={{ ...pillBtn, flex: 1 }}>
            <Bug size={14} weight='thin' /> Issue <ArrowSquareOut size={13} weight='thin' />
          </button>
        </div>
      </Collapsible>

      <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 300, color: colors.text.muted, paddingTop: spacing.base, paddingBottom: spacing.xs, fontFamily: typography.fontFamily }}>
        v{APP_VERSION}
      </div>

      {walletModal && (
        <LightningWalletModal onClose={() => setWalletModal(false)} />
      )}
    </div>
  )
}

// "No Lightning wallet detected" picker. Shared between the AboutView
// Support-development section and the two-week DonationReminderModal
// so the wallet recommendations stay in one place. Bottom-sheet
// shaped; tapping a wallet opens its install URL and dismisses.
function LightningWalletModal ({ onClose }) {
  const openURL = (url) => { try { pear.call('shell:openUrl', { url }) } catch {} }
  const body = { ...typography.body, color: colors.text.secondary, lineHeight: 1.7 }
  return (
    <BottomSheet onClose={onClose} zIndex={300}>
      <div style={{ padding: `0 ${spacing.lg}px ${spacing.lg}px` }}>
        <div style={{ fontSize: 18, fontWeight: 400, color: colors.text.primary, marginBottom: spacing.xs + 2, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, fontFamily: typography.fontFamily }}>
          <Lightning size={18} weight='thin' /> Bitcoin Lightning <Lightning size={18} weight='thin' />
        </div>
        <p style={{ ...body, marginBottom: spacing.lg, textAlign: 'left' }}>
          No Lightning wallet was detected on your device. Bitcoin
          Lightning is a fast, low-fee payment network built on top of
          Bitcoin. To send a tip, install one of these wallets:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm + 2 }}>
          {LIGHTNING_WALLETS.map((w) => (
            <button
              key={w.name}
              onClick={() => openURL(w.url)}
              style={{
                background: colors.surface.card,
                border: `1px solid ${colors.border}`,
                borderRadius: radius.lg,
                padding: `${spacing.md}px ${spacing.base}px`,
                display: 'flex', alignItems: 'center', gap: spacing.md,
                cursor: 'pointer', width: '100%', textAlign: 'left',
                fontFamily: typography.fontFamily,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 400, color: colors.text.primary }}>{w.name}</div>
                <div style={{ fontSize: 12, fontWeight: 300, color: colors.text.muted }}>{w.desc}</div>
              </div>
              <ArrowSquareOut size={14} weight='thin' color={colors.text.muted} />
            </button>
          ))}
        </div>
        <p style={{ ...body, textAlign: 'center', marginTop: spacing.base, marginBottom: 0 }}>
          After installing, return here and tap BTC again.
        </p>
      </div>
    </BottomSheet>
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
// - Static formats (JPEG/PNG that's not APNG): up to ~150KB after
//   compression to a 256x256 JPEG. Matches PearGuard's static
//   compression (256x256 @ 0.8). The byte cap is a defensive ceiling
//   that's rarely hit at this size/quality; the quality ladder kicks
//   in for unusually high-detail images.
// - Animated formats (GIF, WebP that may be animated): up to ~1MB
//   base64 (~750KB raw) stored raw to preserve animation. Canvas
//   re-encoding would flatten to a single frame, so there's no
//   useful fallback when oversized. Generous so common user-picked
//   GIFs (often 400-700KB raw) make it through without being rejected.
// Bare's cap is the matching 1MB ceiling; the UI enforces the
// per-format budget below.
const AVATAR_STATIC_MAX_B64 = 150_000
const AVATAR_ANIMATED_MAX_B64 = 1_000_000
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

// Center-square-cover crop to 256x256 then JPEG-compress. Reduces quality
// in steps if the encoded result is over the byte budget; gives up at
// quality 0.4 and lets the caller surface a friendly error.
function compressToAvatar (dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const size = 256
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
function MemberDetailSheet ({ member, presence, transitions, placesById, isSelf = false, connected = false, canRemove = false, circleNameForRemoval = 'this circle', needsRepair = false, onRepair, onRemove, onOpenTrips, onClose }) {
  const [repairing, setRepairing] = useState(false)
  const seen = member?.seen
  const isPaused = effectivePresenceMuted(presence)
  // Whether this member has any trips visible to us. Async-probed
  // after mount via trips:listFor; null = still loading, false = no
  // trips (hide the button), number = trip count (show the button).
  // For self the check is essentially "do we have any local trips
  // saved"; for non-self it's "do we have any replicated trips for
  // them in any circle we're in."
  const [tripCount, setTripCount] = useState(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState(null)
  useEffect(() => {
    if (!member?.pubkey) return
    let cancelled = false
    pear.call('trips:listFor', { pubkey: member.pubkey }).then((r) => {
      if (cancelled) return
      const list = Array.isArray(r?.trips) ? r.trips : []
      setTripCount(list.length)
    }).catch(() => {
      if (!cancelled) setTripCount(0)
    })
    return () => { cancelled = true }
  }, [member?.pubkey])
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
    // Universal geo: URI; the shell rewrites it to an Apple Maps
    // universal link on iOS (where geo: has no system handler).
    const url = `geo:${seen.lat},${seen.lon}?q=${seen.lat},${seen.lon}(${label})`
    try { await pear.call('shell:openUrl', { url }) } catch {}
  }

  return (
    <>
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
          {typeof seen.battery === 'number' && <BatteryBadge level={seen.battery} charging={!!seen.isCharging} />}
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
          <div>{formatAbsoluteTime(seen.ts)} · <LiveOrAge ts={seen.ts} stale={seen.stale} /></div>
          {geoLabel && <div style={{ color: colors.text.secondary }}>near {geoLabel}</div>}
          {Number.isFinite(seen.accuracy) && (
            <div style={{ ...typography.caption, color: colors.text.muted }}>±{Math.round(seen.accuracy)} m accuracy</div>
          )}
          {!isSelf && (
            <div style={{ ...typography.caption, color: colors.text.secondary, display: 'flex', alignItems: 'center', gap: 6, marginTop: spacing.xs }}>
              <ConnectionDot connected={connected} />
              {connected ? 'In contact' : 'Not in contact'}
            </div>
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

      {isSelf && needsRepair && onRepair && (
        <div style={{ marginTop: spacing.lg, padding: spacing.base, borderRadius: radius.md, border: `1px solid ${colors.border}` }}>
          <div style={{ ...typography.body, color: colors.text.primary }}>This circle's data is stuck</div>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: spacing.xs, lineHeight: 1.5 }}>
            Your location and trips may have stopped updating. Repairing rebuilds this circle from your peers, so it can take a moment to reconnect before your sharing resumes. Your identity and history are kept.
          </div>
          <button
            disabled={repairing}
            onClick={async () => {
              setRepairing(true)
              try { await onRepair() } finally { setRepairing(false) }
            }}
            style={{
              marginTop: spacing.sm, width: '100%', padding: '12px', borderRadius: radius.md,
              background: colors.primary, color: colors.text.onPrimary,
              border: 'none', cursor: repairing ? 'default' : 'pointer',
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
              opacity: repairing ? 0.6 : 1,
            }}
          >
            {repairing ? 'Repairing…' : 'Repair circle data'}
          </button>
        </div>
      )}

      {isSelf ? (
        <div style={{ marginTop: spacing.lg }}>
          <button
            onClick={onOpenTrips}
            style={{
              width: '100%', padding: '12px', borderRadius: radius.md,
              background: colors.primary, color: colors.text.onPrimary,
              border: 'none', cursor: 'pointer',
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
            }}
          >
            View my trips
          </button>
        </div>
      ) : (
        <div style={{ marginTop: spacing.lg, display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
          <button
            onClick={openDirections}
            disabled={!seen}
            style={{
              width: '100%', padding: '12px', borderRadius: radius.md,
              background: colors.primary, color: colors.text.onPrimary,
              border: 'none', cursor: seen ? 'pointer' : 'default',
              fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
              opacity: seen ? 1 : 0.5,
            }}
          >
            Get directions
          </button>
          {tripCount > 0 && (
            <button
              onClick={onOpenTrips}
              style={{
                width: '100%', padding: '12px', borderRadius: radius.md,
                background: 'transparent', color: colors.text.primary,
                border: `1px solid ${colors.border}`, cursor: 'pointer',
                fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
              }}
            >
              {tripCount === 1 ? 'View 1 trip' : `View ${tripCount} trips`}
            </button>
          )}
          {canRemove && (
            <button
              onClick={() => { setRemoveError(null); setConfirmingRemove(true) }}
              style={{
                width: '100%', padding: '12px', borderRadius: radius.md,
                background: 'transparent', color: colors.error,
                border: `1px solid ${colors.error}`, cursor: 'pointer',
                fontFamily: typography.fontFamily, fontWeight: 400, fontSize: 14,
              }}
            >
              Remove from circle
            </button>
          )}
        </div>
      )}
    </BottomSheet>
    {confirmingRemove && (
      <ConfirmSheet
        title='Remove from circle?'
        message={<>
          Remove <strong>{member.displayName}</strong> from <strong>{circleNameForRemoval}</strong>? They stop appearing on the map for everyone, and their device drops the circle.
          {removeError && <div style={{ color: colors.error, marginTop: spacing.sm }}>{removeError}</div>}
        </>}
        confirmLabel='Remove'
        destructive
        busy={removing}
        onConfirm={async () => {
          setRemoving(true)
          setRemoveError(null)
          try {
            await onRemove?.()
          } catch (e) {
            setRemoveError(e?.message || 'Could not remove member')
            setRemoving(false)
            return
          }
          setRemoving(false)
          setConfirmingRemove(false)
        }}
        onClose={() => { if (!removing) { setConfirmingRemove(false); setRemoveError(null) } }}
      />
    )}
    </>
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
        // colorsRaw, not colors: MapLibre paint props need a literal
        // color string, and the theme-toggle refactor (commit 17aeb64)
        // made colors.accent resolve to 'var(--color-accent)' which
        // MapLibre treats as invalid (renders the layer transparent,
        // which is what makes the polyline disappear from thumbnails).
        paint: { 'line-color': colorsRaw.accent, 'line-width': 3, 'line-opacity': 0.95 },
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
function TripsView ({ active, ownerPubkey, myPubkey, ownerName, distanceUnit, tileStyleUrl, onOpenTrip, onClose }) {
  const [trips, setTrips] = useState(null)
  const [error, setError] = useState(null)
  const thumbs = useTripThumbnails(active && trips ? trips : null, tileStyleUrl)

  // Self when ownerPubkey is null/undefined or matches myPubkey. The
  // self view uses trips:listFor with our pubkey so it shows both
  // local-Hyperbee trips and any replicated ones from circles we've
  // shared into (which dedup via mergeTripStreams in the worklet).
  // Non-self uses the same IPC with the target's pubkey.
  const targetPubkey = ownerPubkey || myPubkey
  const isSelf = !ownerPubkey || ownerPubkey === myPubkey

  const refresh = useCallback(async () => {
    if (!targetPubkey) return
    try {
      const r = await callWithTimeout('trips:listFor', { pubkey: targetPubkey })
      const list = Array.isArray(r?.trips) ? r.trips : []
      list.sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0))
      setTrips(list)
      setError(null)
    } catch (e) {
      setError(e?.code === 'IPC_TIMEOUT' ? 'Loading trips is taking too long. Please try again.' : (e?.message || 'Failed to load trips'))
      setTrips([])
    }
  }, [targetPubkey])

  // Refresh on mount and whenever the sheet is reopened. The
  // `trip:completed` listener registers once at component lifetime;
  // pear.on has no unsubscribe in this codebase, so we gate the
  // refresh on the latest `active` value via a ref so stale-closure
  // refreshes don't fire while the sheet is hidden. Listener only
  // refreshes the self view (a peer's trip completing fires on their
  // device, not ours — replication arrives later via apply, which
  // doesn't emit an event today).
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => {
    pear.on('trip:completed', () => { if (activeRef.current && isSelf) refresh() })
  }, [refresh, isSelf])
  useEffect(() => {
    if (active) refresh()
  }, [active, refresh])

  return (
    <div style={{
      padding: spacing.lg,
      paddingTop: `calc(env(safe-area-inset-top, 24px) + ${spacing.base}px)`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg }}>
        <h1 style={{ ...typography.heading, margin: 0, color: colors.text.primary }}>
          {isSelf ? 'My trips' : (ownerName ? ownerName + "'s trips" : 'Trips')}
        </h1>
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
          {isSelf
            ? 'No trips yet. Drives over 1 minute and 100 m show up here automatically.'
            : "No trips visible. " + (ownerName || 'This member') + " hasn't shared trips with this circle yet."}
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
function TripDetailView ({ startTs, ownerPubkey, myPubkey, ownerName, distanceUnit, tileStyleUrl, onBack }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const [trip, setTrip] = useState(null)
  const [error, setError] = useState(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const targetPubkey = ownerPubkey || myPubkey
  const isSelf = !ownerPubkey || ownerPubkey === myPubkey

  const onDelete = async () => {
    setDeleting(true)
    try {
      // scope: 'all' deletes from local Hyperbee AND writes soft-delete
      // tombstones to every per-circle autobase containing the trip.
      // Most users want "just gone everywhere"; advanced scope chooser
      // (local-only / circle-only) is deferred until a real need emerges.
      await pear.call('trips:delete', { startTs, scope: 'all' })
      setConfirmingDelete(false)
      onBack()
    } catch (e) {
      setError(e?.message || 'Failed to delete trip')
      setDeleting(false)
    }
  }

  useEffect(() => {
    if (!targetPubkey) return
    let cancelled = false
    pear.call('trips:listFor', { pubkey: targetPubkey }).then((r) => {
      if (cancelled) return
      const found = (r?.trips ?? []).find(t => t.startTs === startTs)
      if (!found) setError('Trip not found')
      else setTrip(found)
    }).catch((e) => {
      if (!cancelled) setError(e?.message || 'Failed to load trip')
    })
    return () => { cancelled = true }
  }, [startTs, targetPubkey])

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
        // colorsRaw, not colors: MapLibre paint properties need a
        // literal color string; see useTripThumbnails for the same
        // theme-refactor gotcha.
        paint: {
          'line-color': colorsRaw.accent,
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
        new maplibregl.Marker({ color: colorsRaw.text.muted }).setLngLat(start).addTo(map)
        new maplibregl.Marker({ color: colorsRaw.accent }).setLngLat(end).addTo(map)
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
        {isSelf && trip && (
          <button
            onClick={() => setConfirmingDelete(true)}
            style={{
              background: 'transparent', border: 'none', color: colors.error,
              cursor: 'pointer', padding: '4px 8px',
              display: 'flex', alignItems: 'center',
            }}
            aria-label='Delete trip'
          >
            <Trash size={20} weight='thin' />
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: spacing.lg, ...typography.body, color: colors.error }}>{error}</div>
      )}
      <div ref={containerRef} style={{ flex: 1, minHeight: 320, background: colors.surface.base }} />
      {confirmingDelete && trip && (
        <ConfirmSheet
          title='Delete this trip?'
          message={<>This deletes the trip from this device and from any circles you shared it with. It can't be undone.</>}
          confirmLabel='Delete'
          destructive
          busy={deleting}
          onConfirm={onDelete}
          onClose={() => { if (!deleting) setConfirmingDelete(false) }}
        />
      )}
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

  // Portal to document.body so the position:fixed scrim/sheet escape any
  // transformed ancestor (notably SheetContainer's transform:translateY,
  // which creates a containing block for position:fixed descendants — without
  // this, a ConfirmSheet mounted from inside Settings ends up positioned
  // relative to the SheetContainer rather than the viewport, and the
  // bottom edge can land short of the actual screen bottom).
  // Bottom padding clears the system nav bar / home indicator. Uses
  // max(env(safe-area-inset-bottom), --android-nav-inset): stock Android
  // WebView reports env() as 0 for the nav bar, so the shell injects the
  // real inset as --android-nav-inset and we take whichever is larger.
  return createPortal(
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
          background: colors.surface.card,
          color: colors.text.primary,
          borderRadius: '20px 20px 0 0',
          maxHeight: '85dvh', overflowY: 'auto', overflowX: 'hidden',
          padding: `0 16px calc(max(env(safe-area-inset-bottom, 0px), var(--android-nav-inset, 0px)) + 24px)`,
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
          <div style={{ width: 36, height: 4, borderRadius: 2, background: colors.text.muted }} />
        </div>
        {children}
      </div>
    </div>,
    document.body,
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
  // destructive → red error; non-destructive (affirmative actions like
  // "Share") → brand green to match the rest of the primary CTAs.
  const accentColor = destructive ? colors.error : colors.primary
  return (
    <BottomSheet onClose={onClose} zIndex={250}>
      <h2 style={{
        margin: `${spacing.sm}px 0 ${spacing.xs}px`,
        fontSize: 18, fontWeight: 400, color: colors.text.primary,
        textAlign: 'center',
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
function MemberRow ({ member, seen, isPaused, transition, transitionPlaceName, currentPlaceName, connected, isSelf, onFocus }) {
  const pubkey = member.value?.pubkey ?? ''
  const displayName = member.value?.displayName ?? short(pubkey)
  // Every row opens the member-detail sheet on tap, even one with no
  // shared location (a never-positioned peer, e.g. a failed/abandoned
  // join). The sheet is the only path to "Remove from circle", so
  // gating the tap on a lastSeen position left positionless members
  // unremovable from the UI. focusMember handles a missing position
  // gracefully -- it just skips the map fly-to.
  // Only fetch a "near X" label when there's no recent transition
  // explaining where they are (and they're not paused). Saves
  // requests and keeps the row stable when transitions are fresh.
  // Per-member hysteresis prevents GPS-jitter-driven flicker.
  const geoLabel = useReverseGeocodeForMember(
    pubkey,
    seen?.lat,
    seen?.lon,
    !!seen && !transition && !isPaused && !currentPlaceName,
  )
  return (
    <li
      style={{ ...s.memberItem, cursor: 'pointer' }}
      onClick={() => onFocus(pubkey)}
    >
      <div style={s.memberRow}>
        <Avatar base64={member.value?.avatar} label={displayName} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
              <div style={{ ...s.memberName, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
              {!isSelf && <ConnectionDot connected={connected} />}
              {!isPaused && <MotionGlyph speed={seen?.speed} size={14} />}
            </div>
            {!isPaused && <BatteryBadge level={seen?.battery} charging={!!seen?.isCharging} />}
          </div>
          {isPaused ? (
            <div style={s.lastSeenMuted}>Sharing paused</div>
          ) : transition ? (
            <div style={{ ...s.status, display: 'flex', alignItems: 'center', gap: 4 }}>
              <PlaceIcon name={transitionPlaceName} />
              <span>
                {transition.kind === 'enter' ? 'arrived at ' : 'left '}
                {transitionPlaceName ?? '(unknown place)'}
                {' · '}{ageLabel(transition.ts)}
              </span>
            </div>
          ) : currentPlaceName ? (
            <div style={{ ...s.lastSeen, display: 'flex', alignItems: 'center', gap: 4 }}>
              <PlaceIcon name={currentPlaceName} />
              <span>at {currentPlaceName}</span>
            </div>
          ) : seen ? (
            <div style={s.lastSeen}>
              {geoLabel ? 'near ' + geoLabel : 'no place yet'}
            </div>
          ) : (
            <div style={s.lastSeenMuted}>no location yet</div>
          )}
        </div>
      </div>
    </li>
  )
}

// Tiny inline dot for the Hyperswarm connection state of a non-self
// peer. Green when we're in a live swarm session with this pubkey on
// any circle; muted otherwise. Driven by `peersByCircle` upstream
// (proposal 2026-05-17-swarm-live-signal). Hover/long-press hint via
// the title attribute. Uses colorsRaw because this is a styled inline
// SVG-ish element, not a CSS-var context.
function ConnectionDot ({ connected }) {
  return (
    <span
      title={connected ? 'In contact' : 'Not in contact'}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        background: connected ? colorsRaw.success : colorsRaw.text.muted,
        flexShrink: 0,
      }}
    />
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
function BatteryBadge ({ level, charging = false }) {
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
        {/* Charging bolt: white zigzag inside the battery body, drawn on
            top of the colored fill so it reads at any percentage. */}
        {charging ? (
          <path d="M 9 2 L 6.5 5.4 L 8 5.4 L 7 8 L 9.5 4.6 L 8 4.6 Z" fill="#fff" stroke="#000" strokeWidth="0.3" />
        ) : null}
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
      {title ? <h1 style={{ ...s.h1, textAlign: 'center' }}>{title}</h1> : <span style={{ flex: 1 }} />}
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
  // Clamp: a peer with a fast clock (or a future-stamped ts) would otherwise
  // make Date.now() - ts negative and fall through to nonsense "Xd ago" math
  // (UX audit item g). Treat any future ts as "just now".
  const ms = Math.max(0, Date.now() - ts)
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago'
  return Math.floor(ms / 86_400_000) + 'd ago'
}

// Replaces sub-minute "updated Xs ago" churn with a stable green-dot
// "Live" pill while ts is fresh, then falls back to coarser "Xm ago".
// Used for lastSeen freshness; transitions keep ageLabel since they're
// past events and "Live" wouldn't be the right framing.
function LiveOrAge ({ ts, stale, prefix = 'updated ' }) {
  // Three-way per proposal 2026-05-17. The pure helper handles the
  // classification; this component owns rendering. "Reconnecting"
  // shows when the peer is online (fresh ts via heartbeat) but their
  // position is a cold-boot preload that hasn't been confirmed by a
  // fresh GPS fix yet — so we don't lie by calling them "Live" at a
  // potentially-stale location.
  const status = liveStatus(ts, stale)
  if (status === null) return null
  if (status === 'live') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7ec77a', display: 'inline-block' }} />
        Live
      </span>
    )
  }
  if (status === 'reconnecting') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#e0b76a', display: 'inline-block' }} />
        Reconnecting
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

// Case-insensitive comparator for sorting user-named entities
// (circles, members) alphabetically in the UI. Uses toLowerCase()
// instead of localeCompare's `sensitivity` option because the
// Android System WebView Intl.Collator implementation silently
// ignores the option in some builds, leaving uppercase letters
// sorted before lowercase (Hal, Pixel, iPhone instead of Hal,
// iPhone, Pixel). toLowerCase + plain < / > works everywhere.
// Treats null/undefined as empty string so missing names land at
// the top deterministically rather than throwing.
function byName (a, b) {
  const aL = (a ?? '').toLowerCase()
  const bL = (b ?? '').toLowerCase()
  if (aL < bL) return -1
  if (aL > bL) return 1
  return 0
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
  secondaryBtn: { width: '100%', padding: `${spacing.md + 2}px ${spacing.base}px`, background: colors.surface.input, color: colors.text.primary, border: `1px solid ${colors.text.muted}`, borderRadius: radius.lg, fontSize: typography.subheading.fontSize, fontWeight: 400, cursor: 'pointer', marginTop: spacing.sm },
  dangerBtn: { width: '100%', padding: `${spacing.md + 2}px ${spacing.base}px`, background: 'transparent', color: colors.error, border: `1px solid ${colors.error}`, borderRadius: radius.lg, fontSize: typography.subheading.fontSize, fontWeight: 400, cursor: 'pointer' },
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
  inviteBox: { width: '100%', padding: spacing.md, background: colors.surface.card, color: colors.accent, border: `1px solid ${colors.border}`, borderRadius: radius.md, fontSize: typography.micro.fontSize, fontFamily: typography.monoFamily, resize: 'vertical', marginBottom: spacing.md, minHeight: 80, boxSizing: 'border-box' },
  muted: { color: colors.text.muted, fontSize: typography.body.fontSize },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: typography.body.fontSize },
  section: { background: colors.surface.card, padding: spacing.md, borderRadius: radius.lg, marginBottom: spacing.md },
  row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: typography.body.fontSize },
  memberList: { listStyle: 'none', padding: 0, margin: 0 },
  memberItem: { padding: spacing.md, background: colors.surface.card, borderRadius: radius.lg, marginBottom: spacing.sm },
  memberRow: { display: 'flex', alignItems: 'flex-start', gap: spacing.md },
  memberName: { fontSize: 15, fontWeight: 400 },
  placeRowHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  placeRowActions: { display: 'flex', gap: 6, flexShrink: 0 },
  placeRadiusLine: { fontSize: typography.micro.fontSize, color: colors.text.muted, marginTop: spacing.xs, fontFamily: typography.monoFamily },
  coordsMissing: { fontSize: typography.caption.fontSize, color: colors.warn, padding: `${spacing.sm}px ${spacing.md}px`, background: colors.surface.elevated, border: `1px solid ${colors.warn}`, borderRadius: radius.md, marginBottom: spacing.md, lineHeight: 1.4 },
  avatarRow: { display: 'flex', alignItems: 'center', gap: spacing.base, marginBottom: spacing.base },
  // Avatar placeholder bg + initial color stay literal: this is a stable
  // brand placeholder, not a theme-following surface.
  avatarPreview: { width: 96, height: 96, borderRadius: radius.full, overflow: 'hidden', background: '#2a3a3f', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' },
  avatarFallback: { color: '#cfe', fontSize: 36, fontWeight: 400, fontFamily: typography.fontFamily },
  lastSeen: { fontSize: typography.micro.fontSize, color: colors.accent, marginTop: spacing.xs, fontFamily: typography.monoFamily },
  lastSeenMuted: { fontSize: typography.micro.fontSize, color: colors.text.muted, marginTop: spacing.xs, fontStyle: 'italic' },
  status: { fontSize: typography.caption.fontSize, color: colors.success, marginTop: spacing.xs, fontWeight: 400 },
  mapWrap: { position: 'relative', height: '100%', width: '100%', background: colors.surface.base },
  mapCanvas: { height: '100%', width: '100%' },
  leaderOverlay: { position: 'absolute', top: 0, left: 0, height: '100%', width: '100%', pointerEvents: 'none', zIndex: 1, overflow: 'visible' },
  // Attribution stays white-on-translucent-black: it overlays map tiles
  // (any theme) and the dark scrim makes it readable against any tile.
  mapAttribution: { position: 'absolute', bottom: 4, right: 6, fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: radius.sm, pointerEvents: 'none' },
  mapFirstRoot: { position: 'fixed', inset: 0, color: colors.text.primary, background: colors.surface.base, fontFamily: '-apple-system, system-ui, Roboto, sans-serif', overflow: 'hidden' },
  // zIndex 0 forces a stacking context so MapLibre's per-marker z-index
  // (applyStackMeta sets up to 30 for expanded / 25 for front avatars) stays
  // confined under the floating chrome (pill z20, focus bar z6, gear z5)
  // instead of leaking into the root context and painting over it.
  mapFill: { position: 'absolute', inset: 0, zIndex: 0 },
  // Waiting-for-location scrim: dark overlay + light text so it reads against
  // any tile theme (same rationale as mapAttribution). Above the leader
  // overlay (z1), still inside mapFill so the floating chrome stays on top.
  mapWaiting: { position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' },
  mapWaitingText: { color: '#fff', fontSize: 15, fontWeight: 500, letterSpacing: 0.2, textShadow: '0 1px 2px rgba(0,0,0,0.4)' },
  mapTopBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px',
    paddingTop: 'calc(env(safe-area-inset-top, 24px) + 8px)',
    background: colors.surface.card,
    borderBottom: `1px solid ${colors.border}`,
  },
  mapTitle: { fontSize: 18, margin: 0, flex: 1, fontWeight: 400, color: colors.text.primary },
  peerBadge: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: colors.text.secondary, padding: '4px 8px' },
  peerDot: { width: 8, height: 8, borderRadius: '50%' },
  // Map-overlay pill: theme-stable since it floats over light tiles.
  // Text and border use the raw (dark-mode) values so light-mode UI
  // doesn't render dark text on a dark fab.
  fab: {
    position: 'absolute',
    bottom: 'calc(max(env(safe-area-inset-bottom, 0px), var(--android-nav-inset, 0px)) + 20px)',
    left: '50%', transform: 'translateX(-50%)',
    padding: '10px 18px',
    background: 'rgba(26,26,26,0.92)', color: colorsRaw.text.primary,
    border: `1px solid ${colorsRaw.border}`, borderRadius: 999,
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
    padding: '6px 10px', background: 'transparent', color: colors.text.primary,
    border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 400,
    cursor: 'pointer', textAlign: 'left',
  },
  dropdownLabel: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dropdownChevron: { fontSize: 12, color: colors.text.muted },
  focusTextCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  focusName: { fontSize: 15, fontWeight: 400, color: colors.text.primary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  focusSub: { fontSize: 12, color: colors.accent, fontFamily: 'monospace' },
  avatarBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
  },
  menuScrim: {
    position: 'fixed', inset: 0, zIndex: 9, background: 'transparent',
  },
  menu: {
    position: 'absolute', top: 'calc(env(safe-area-inset-top, 24px) + 56px)', left: 12,
    background: colors.surface.card, border: `1px solid ${colors.border}`, borderRadius: 10,
    padding: 6, minWidth: 220, maxWidth: 'calc(100% - 24px)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 10,
  },
  menuItem: {
    display: 'block', width: '100%', padding: '10px 12px',
    background: 'transparent', color: colors.text.primary, border: 'none', borderRadius: 6,
    fontSize: 14, textAlign: 'left', cursor: 'pointer',
  },
  // Active selection uses primary green for the text on a faint
  // elevated surface; the elevated surface var keeps the contrast
  // right in both themes (slight tint on dark, slight wash on light).
  menuItemActive: { background: colors.surface.elevated, color: colors.primary, fontWeight: 400 },
  menuDivider: { height: 1, background: colors.border, margin: '6px 4px' },
  // QR code background stays white in both themes -- QR scanners require
  // the high-contrast quiet-zone, swapping to dark would break scanning.
  qrWrap: { display: 'flex', justifyContent: 'center', padding: 12, background: '#fff', borderRadius: 12, marginBottom: 12 },
  // Floating empty-hint over the map. rgba uses the dark surface even in
  // light mode because the FAB-pill aesthetic above it is dark; switching
  // both to light surface would lose contrast against the map tiles.
  // Revisit if light-mode legibility audit flags this.
  emptyHint: {
    // Sit above the bottom-corner Settings/About FABs (44px tall + 16px
    // bottom inset). Inset the sides past the FAB columns so they remain
    // tappable even though the hint shares the same z.
    position: 'absolute', left: 72, right: 72,
    bottom: 'calc(max(env(safe-area-inset-bottom, 0px), var(--android-nav-inset, 0px)) + 76px)',
    padding: 14, background: 'rgba(26,26,26,0.92)',
    borderRadius: 10, color: '#ccc', fontSize: 14, lineHeight: 1.4,
    textAlign: 'center',
    zIndex: 5,
  },
}
