import { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, NativeModules, NativeEventEmitter, Platform, AppState, Share, Modal, TouchableOpacity, BackHandler, StatusBar } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import * as DocumentPicker from 'expo-document-picker'
import * as Linking from 'expo-linking'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Notifications from 'expo-notifications'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { makeStartLock, autostartGateValue } from '@/src/lib/backendBootstrap'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

const { PearCircleLocation } = NativeModules

// Foreground-display behavior for geofence notifications. Default
// expo-notifications suppresses alerts when the app is foregrounded;
// transitions are timely so we override.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

// Per-device mute state for place transitions. Loaded once from AsyncStorage
// at startup; written through on every change so reloads see latest. The
// WebView is the editor; RN holds the source of truth for fast lookup when
// transition:applied events arrive.
const MUTES_KEY = 'pc:notif:mutes'
// Persisted MapLibre style URL. Default lives in src/ui/App.jsx so the
// WebView can fall back when AsyncStorage has nothing yet. Keeping the
// string here too avoids a chicken-and-egg dance on first launch (we'd
// have to round-trip to the WebView before showing the map).
const TILE_STYLE_KEY = 'pc:tile:styleUrl'
// Display preference: 'km' (default) or 'miles'. Persisted via the
// shell:distanceUnit IPC so the WebView can hydrate it on boot.
const DISTANCE_UNIT_KEY = 'pc:distanceUnit'
// Theme preference: 'dark' (default) or 'light'. CSS variables in the
// WebView swap palettes via document.documentElement.dataset.theme; this
// just persists the user's choice across launches.
const THEME_KEY = 'pc:theme'
// First-run onboarding gates. Both default to a fresh-launch state
// (onboarding pending, tour pending). The UI flips them via
// shell:onboarding:set; a Settings "Reset onboarding" entry can flip
// them back. Local to the install — uninstall wipes them along with
// the rest of AsyncStorage.
const ONBOARDING_COMPLETE_KEY = 'pc:onboardingComplete'
const TOUR_PENDING_KEY = 'pc:tourPending'
// Two-week donation-reminder modal (mirrors PearCal/PearGuard). The
// firstLaunch key is auto-seeded with Date.now() on the very first
// shell:donateReminder:get call so we have a reference point for the
// 14-day window. The shown key flips to true after the user picks
// Donate / Maybe later / Already donated. Both keys are local to the
// shell; the WebView reads them via shell:donateReminder:get and writes
// the shown flag via shell:donateReminder:setShown. Skipped on iOS at
// the WebView layer per App Store guideline 3.1.1 (same gating as the
// About page's donate section).
const DONATE_FIRST_LAUNCH_KEY = 'pc:donateReminder:firstLaunch'
const DONATE_SHOWN_KEY = 'pc:donateReminder:shown'
// Daily "open the app to sync" reminder. PearCircle has no servers: a circle's
// history only converges while members' apps run the worklet (Activity-bound;
// no reliable background autostart), so a circle with no always-on seeder goes
// stale when everyone backgrounds/kills the app. A local notification nudges the
// user to reopen. It's a fixed daily ping: a repeating DAILY trigger fires every
// day at the user's chosen time (see refreshSyncReminder). Default ON; the
// WebView toggles it via shell:syncReminder:get/set. Stored as the string
// 'false' when disabled; absent/anything else = enabled (default-on).
const SYNC_REMINDER_KEY = 'pc:syncReminder:enabled'
const SYNC_REMINDER_TIME_KEY = 'pc:syncReminder:time'  // 'HH:MM' local; user-set, default 08:00
const SYNC_REMINDER_DEFAULT_TIME = '08:00'             // 8am: a morning nudge before the day gets going
const SYNC_REMINDER_ID = 'sync-reminder'               // stable id so a settings change is cancel+reschedule
// Shared copy for both the scheduled reminder and the test fire. Time-neutral
// since the user picks the time.
const SYNC_REMINDER_CONTENT = {
  title: 'Open PearCircle to sync',
  body: "Your circles sync peer-to-peer while the app is open. Open PearCircle a moment to share a fresh location and catch up on everyone.",
}
// Android SAF directory the user picked for circle-config exports (e.g.
// Downloads). Persisted so exports after the first grant need no prompt.
const EXPORT_DIR_KEY = 'pc:export:dirUri'
const _mutes = new Set<string>()
let _ourPubkey: string | null = null
// Cached locally so the peerTrip:completed hot path doesn't round-trip
// to AsyncStorage / the worklet. Seeded on boot from the same sources
// the WebView reads (shell:distanceUnit AsyncStorage + worklet
// tripNotifications:get), refreshed via the IPC set handlers / event.
let _distanceUnitPref: 'km' | 'miles' = 'km'
let _tripNotificationsEnabled = true

const METERS_PER_MILE = 1609.344
function formatTripDistance(meters: number, unit: 'km' | 'miles'): string {
  if (!Number.isFinite(meters) || meters < 0) return ''
  if (unit === 'miles') {
    const miles = meters / METERS_PER_MILE
    if (miles < 0.1) return `${(miles * 5280).toFixed(0)} ft`
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${miles.toFixed(0)} mi`
  }
  const km = meters / 1000
  if (km < 0.1) return `${meters.toFixed(0)} m`
  return km < 10 ? `${km.toFixed(1)} km` : `${km.toFixed(0)} km`
}

const muteKey = (circleId: string, placeId: string) => circleId + ':' + placeId

// Strip anything that isn't safe in a filename (path separators, control
// chars) so a circle name can't escape the cache dir or break the share.
// Used by shell:exportFile. Falls back to '' so the caller can default.
function sanitizeFilename(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80)
}

async function loadMutes() {
  try {
    const raw = await AsyncStorage.getItem(MUTES_KEY)
    if (!raw) return
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) for (const k of arr) if (typeof k === 'string') _mutes.add(k)
  } catch {}
}

async function persistMutes() {
  try { await AsyncStorage.setItem(MUTES_KEY, JSON.stringify([..._mutes])) } catch {}
}

async function setMute(circleId: string, placeId: string, muted: boolean) {
  if (typeof circleId !== 'string' || typeof placeId !== 'string') return
  const k = muteKey(circleId, placeId)
  if (muted) _mutes.add(k)
  else _mutes.delete(k)
  await persistMutes()
}

async function ensureNotifications() {
  if (Platform.OS === 'android') {
    // Custom transition sounds (ElevenLabs-generated chimes; arrive
    // ascends, leave descends). Android binds a sound to the channel
    // at creation time and ignores subsequent changes, so each
    // direction needs its own channel. The `sound` value is the
    // resource name without extension, resolved against res/raw/.
    await Notifications.setNotificationChannelAsync('geofence_arrive', {
      name: 'Place arrivals',
      importance: Notifications.AndroidImportance.HIGH,
      description: 'Notifications when circle members arrive at a Place',
      lightColor: '#0E413A',
      sound: 'arrive',
    })
    await Notifications.setNotificationChannelAsync('geofence_leave', {
      name: 'Place departures',
      importance: Notifications.AndroidImportance.HIGH,
      description: 'Notifications when circle members leave a Place',
      lightColor: '#0E413A',
      sound: 'leave',
    })
    // Remove the legacy single-channel id from pre-sounds installs so
    // the OS app-info page stops showing a leftover row. Safe no-op
    // when the channel was never created on this device.
    try { await Notifications.deleteNotificationChannelAsync('geofence') } catch {}
    // Separate channel so users (and the OS) can mute trip notifications
    // independently of geofence ones from the system notification settings.
    await Notifications.setNotificationChannelAsync('trip', {
      name: 'Trip completions',
      importance: Notifications.AndroidImportance.DEFAULT,
      description: 'Notifications when circle members finish a trip',
      lightColor: '#0E413A',
    })
    // Membership changes (someone joined / left a circle). Informational,
    // so DEFAULT importance and no custom sound -- and its own channel so
    // users can mute it from system settings independently of the others.
    await Notifications.setNotificationChannelAsync('membership', {
      name: 'Circle membership',
      importance: Notifications.AndroidImportance.DEFAULT,
      description: 'Notifications when members join or leave a circle',
      lightColor: '#0E413A',
    })
    // The daily "open to sync" reminder. Its own channel so users can mute it
    // from system settings independently of the geofence/trip/membership ones.
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Sync reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
      description: 'A daily nudge to open PearCircle so your circles stay in sync',
      lightColor: '#0E413A',
    })
  }
  const settings = await Notifications.getPermissionsAsync()
  if (settings.status !== 'granted') {
    await Notifications.requestPermissionsAsync()
  }
}

// Default-on: only an explicit 'false' disables it (absent key = enabled).
async function isSyncReminderEnabled(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(SYNC_REMINDER_KEY)) !== 'false' }
  catch { return true }
}

// Parse a stored/incoming 'HH:MM' (24h). Returns null on anything malformed so
// callers can fall back to the default rather than schedule at a bogus time.
function parseHHMM(s: unknown): { hour: number, minute: number } | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

async function getSyncReminderTime(): Promise<{ hour: number, minute: number }> {
  try {
    return parseHHMM(await AsyncStorage.getItem(SYNC_REMINDER_TIME_KEY))
      ?? parseHHMM(SYNC_REMINDER_DEFAULT_TIME)!
  } catch { return { hour: 8, minute: 0 } }
}

// Cancel any pending reminder and, if enabled, schedule a single repeating
// DAILY trigger that fires every day at the user's chosen time. Idempotent
// (cancel + reschedule on the stable id), so it's safe to call on boot and
// whenever the user changes the time/toggle. The OS keeps firing it daily on
// its own -- no per-foreground re-arm. Best-effort: notification permission may
// be denied (no-op then).
async function refreshSyncReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(SYNC_REMINDER_ID)
  } catch {}
  if (!(await isSyncReminderEnabled())) return
  const { hour, minute } = await getSyncReminderTime()
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: SYNC_REMINDER_ID,
      content: SYNC_REMINDER_CONTENT,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
        channelId: 'reminders',
      },
    })
  } catch (e: any) {
    console.warn('sync reminder schedule failed', e?.message ?? String(e))
  }
}

// Multi-circle dedup: when a Place exists in two circles a member is
// in (e.g., "Home" in both a family and friends circle), each circle's
// apply emits its own transition:applied event. The transition records
// stay distinct per circle (correct, replication semantics demand it),
// but firing the OS notification once per circle is just noise. Dedup
// on pubkey + kind + placeName within a short TTL collapses the burst.
const NOTIF_DEDUP_TTL_MS = 10_000
const _recentNotifications = new Map<string, number>()

async function firePeerTripNotification(payload: any) {
  if (!payload) return
  if (!_tripNotificationsEnabled) return
  const { authorPubkey, displayName, distanceMeters } = payload
  if (typeof authorPubkey !== 'string') return
  // Defense in depth: worklet already filters self, but if our pubkey
  // arrives here (e.g. an old worklet build) drop instead of bugging
  // the user about their own trip.
  if (_ourPubkey && authorPubkey === _ourPubkey) return
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) return
  const distanceStr = formatTripDistance(distanceMeters, _distanceUnitPref)
  if (!distanceStr) return
  const name = (typeof displayName === 'string' && displayName.length > 0)
    ? displayName
    : authorPubkey.slice(0, 8)
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'PearCircle',
        body: `${name} completed a ${distanceStr} trip`,
        data: { kind: 'peerTrip', authorPubkey, circleId: payload.circleId ?? null },
      },
      trigger: Platform.OS === 'android' ? { channelId: 'trip' } : null,
    })
  } catch (e: any) {
    console.warn('fire peer trip notification failed: ' + e?.message)
  }
}

async function fireTransitionNotification(payload: any) {
  if (!payload || !payload.transition) return
  const { circleId, transition, displayName, placeName } = payload
  if (typeof transition.pubkey !== 'string') return
  // Self-transitions: peers get notified about you, you don't need to be
  // told you arrived where you went.
  if (_ourPubkey && transition.pubkey === _ourPubkey) return
  if (_mutes.has(muteKey(circleId, transition.placeId))) return
  const dedupKey = transition.pubkey + ':' + transition.kind + ':' + placeName
  const lastTs = _recentNotifications.get(dedupKey)
  const now = Date.now()
  if (lastTs != null && now - lastTs < NOTIF_DEDUP_TTL_MS) return
  _recentNotifications.set(dedupKey, now)
  // Opportunistic cleanup so the Map is bounded across long sessions.
  // Cheap; only runs when we're already on the firing path.
  const cutoff = now - NOTIF_DEDUP_TTL_MS
  for (const [k, ts] of _recentNotifications) {
    if (ts < cutoff) _recentNotifications.delete(k)
  }
  const isArrival = transition.kind === 'enter'
  const verb = isArrival ? 'arrived at' : 'left'
  // Direction-specific sound (Android: per-channel binding;
  // iOS: per-notification content.sound). Filenames are the exact
  // resources bundled into ios/PearCircle/ and android/.../res/raw/.
  const channelId = isArrival ? 'geofence_arrive' : 'geofence_leave'
  const soundFile = isArrival ? 'arrive.wav' : 'leave.wav'
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'PearCircle',
        body: `${displayName} ${verb} ${placeName}`,
        // Stashed for tap-routing: the response listener pulls these
        // fields and delivers a notification:focus event to the WebView,
        // which sets the circle filter + focuses the member.
        data: { kind: 'transition', circleId, pubkey: transition.pubkey },
        // iOS reads the sound off the content; Android ignores this
        // and uses the channel-bound sound, which is why we have two
        // channels above.
        sound: Platform.OS === 'ios' ? soundFile : undefined,
      },
      // expo-notifications 0.32 ignores content.channelId on Android when
      // trigger is null (see build/scheduleNotificationAsync.js:109-119 -
      // the channel-trigger fallback only reads channelId off the trigger
      // object), so the OS routes to its fallback channel. Putting the
      // channelId on the trigger fires immediately on the named channel.
      trigger: Platform.OS === 'android' ? { channelId } : null,
    })
  } catch (e: any) {
    console.warn('fire transition notification failed: ' + e?.message)
  }
}

// Member joined / left a circle. The worklet already gates freshness,
// dedup, self-suppression, and the post-dates-our-join anchor; the shell
// just formats the body and posts it on the membership channel. The
// short-TTL dedup mirrors fireTransitionNotification -- belt-and-braces
// against a double emit from autobase re-applies racing the worklet set.
async function fireMembershipNotification(payload: any, kind: 'memberJoined' | 'memberLeft') {
  if (!payload) return
  const { circleId, pubkey, displayName, circleName } = payload
  if (typeof pubkey !== 'string') return
  // Defense in depth: worklet already drops self, but never bug the user
  // about their own join/leave if an old worklet build lets it through.
  if (_ourPubkey && pubkey === _ourPubkey) return
  const name = (typeof displayName === 'string' && displayName.length > 0) ? displayName : pubkey.slice(0, 8)
  const circle = (typeof circleName === 'string' && circleName.length > 0) ? circleName : 'a circle'
  const verb = kind === 'memberJoined' ? 'joined' : 'left'
  const dedupKey = kind + ':' + pubkey + ':' + (circleId ?? '')
  const lastTs = _recentNotifications.get(dedupKey)
  const now = Date.now()
  if (lastTs != null && now - lastTs < NOTIF_DEDUP_TTL_MS) return
  _recentNotifications.set(dedupKey, now)
  const cutoff = now - NOTIF_DEDUP_TTL_MS
  for (const [k, ts] of _recentNotifications) {
    if (ts < cutoff) _recentNotifications.delete(k)
  }
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'PearCircle',
        body: `${name} ${verb} ${circle}`,
        data: { kind, circleId: circleId ?? null, pubkey },
      },
      trigger: Platform.OS === 'android' ? { channelId: 'membership' } : null,
    })
  } catch (e: any) {
    console.warn('fire membership notification failed: ' + e?.message)
  }
}

// Cold-start instrumentation. _shellT0 anchors shell-side timing relative
// to JS bundle load; the worklet has its own _bootTs (see src/bare.js).
// Grep `adb logcat` for `coldstart` to see the interleaved timeline. The
// `shell:worklet-started` mark records the offset between the two clocks.
const _shellT0 = Date.now()
function shellMark(name: string, extra?: any) {
  const dt = Date.now() - _shellT0
  if (extra !== undefined) console.warn('[coldstart shell+' + dt + 'ms] ' + name + ' ' + JSON.stringify(extra))
  else console.warn('[coldstart shell+' + dt + 'ms] ' + name)
}

let _worklet: any = null
let _workletStarted = false
let _nextId = 1
const _pending = new Map<number, (msg: any) => void>()
const _eventHandlers = new Map<string, ((data: any) => void)[]>()
let _locationListenerSet = false
// Region events that fired before the worklet finished booting. iOS can
// revive the app from a force-quit on a region crossing, and the native
// PearCircleLocationModule emits the event as soon as the
// NativeEventEmitter listener attaches -- which the shell wires up in
// ensureLocationListener, well before _worklet exists. We buffer the
// IPC messages here and flush them once startWorklet completes so the
// cold-start transition isn't lost. Plain location:update events are
// not buffered: they keep arriving and one near-immediate update is
// enough; the region event is the one-shot signal that matters.
let _pendingRegionEvents: object[] = []

// WebView ref holder. emitEvent forwards worklet events to the UI, but the
// backend now also runs without an Activity (the headless boot/update task,
// proposal 2026-06-09) where there is no WebView at all. Module-scoping the
// ref lets the native-action event handlers live at module scope and call
// emitEvent unconditionally: it no-ops when no WebView is attached (headless)
// and forwards when the Index component has mounted one. The Index component
// points this at its ref on mount and clears it on unmount.
let _webViewRef: { current: WebView | null } | null = null

// Notification setup (channels + permission). Hoisted to module scope so the
// headless path can kick it off and the `ready` FGS-start flow can await it
// before startUpdates, exactly as the Activity path did via a component ref.
let _notifSetupReady: Promise<void> = Promise.resolve()

// iOS first-run location priming gate (Activity path only; iOS never runs
// headless). Module-scoped because the `ready` native handler sets it and the
// WebView's shell:permission:proceed clears it -- both now outside the Index
// component's closure.
let _pendingLocationStart = false

function emitEvent(event: string, data: any) {
  // Optional-chains through a possibly-null ref/current so a headless backend
  // (no WebView) is a safe no-op rather than a crash.
  _webViewRef?.current?.injectJavaScript(
    `window.__pearEvent(${JSON.stringify(event)}, ${JSON.stringify(data ?? null)}); true;`
  )
}

function ensureLocationListener() {
  if (_locationListenerSet) return
  if (!PearCircleLocation) return
  const emitter = new NativeEventEmitter(PearCircleLocation)
  // No corresponding remove(): the listener intentionally survives
  // activity destruction so the foreground service's location callbacks
  // continue to reach the worklet while the app is in the background or
  // its task has been swiped from recents.
  emitter.addListener('PearCircleLocation:update', (data: any) => {
    sendToWorklet({ method: 'location:update', args: data })
  })
  // Default-network change (wifi <-> cell, vpn on/off, etc). Native
  // module debounces the burst Android emits during a transition and
  // delivers one event per real change. Worklet responds by forcing
  // Hyperswarm to re-announce on the new network.
  emitter.addListener('PearCircleLocation:network:changed', (data: any) => {
    sendToWorklet({ method: 'network:changed', args: data })
  })
  // CLCircularRegion enter/exit events from the iOS native side. These
  // fire while the app is alive AND on cold-start when iOS revives the
  // process for a boundary cross after a force-quit. If the worklet
  // hasn't started yet (cold-start case), buffer for replay once
  // startWorklet finishes so the first crossing isn't lost.
  emitter.addListener('PearCircleLocation:region:enter', (data: any) => {
    const msg = { method: 'region:enter', args: data }
    if (_worklet) sendToWorklet(msg)
    else _pendingRegionEvents.push(msg)
  })
  emitter.addListener('PearCircleLocation:region:exit', (data: any) => {
    const msg = { method: 'region:exit', args: data }
    if (_worklet) sendToWorklet(msg)
    else _pendingRegionEvents.push(msg)
  })
  // CoreMotion activity transitions from the iOS native side (proposal
  // 2026-05-21). A stationary -> moving change escalates the worklet's
  // adaptive location mode out of SLC-only "idle" without waiting on
  // the trip detector, closing the idle-trap. Android emits no
  // equivalent, so the listener simply never fires there.
  emitter.addListener('PearCircleLocation:motion:changed', (data: any) => {
    sendToWorklet({ method: 'motion:changed', args: data })
  })
  _locationListenerSet = true
}

function onEvent(event: string, fn: (data: any) => void) {
  const handlers = _eventHandlers.get(event) ?? []
  handlers.push(fn)
  _eventHandlers.set(event, handlers)
}

function sendToWorklet(msg: object) {
  _worklet?.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}

function call(method: string, args: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = _nextId++
    // Carry a thrown worklet error through as { error } instead of dropping it,
    // so the WebView can show the real reason (e.g. an invite/circle mismatch)
    // rather than a generic message. Proposal 2026-06-11 follow-up.
    _pending.set(id, (msg) => resolve(msg.error != null ? { ok: false, error: msg.error } : msg.result))
    sendToWorklet({ id, method, args })
  })
}

async function startWorklet() {
  if (_workletStarted) return
  _workletStarted = true

  shellMark('worklet:bundle-load:start')
  // Bare bundles bake the linked native-addon resolver per host. Android
  // uses the `--linked` universal bundle (host comes from the gradle
  // build's NDK ABI). iOS needs the `--preset ios` fat bundle which
  // includes ios-arm64 (device), ios-arm64-simulator (Apple Silicon),
  // and ios-x64-simulator (Intel/Rosetta) addon variants.
  const asset = Asset.fromModule(
    Platform.OS === 'ios'
      ? require('../assets/bare-ios.bundle')
      : require('../assets/bare-universal.bundle')
  )
  await asset.downloadAsync()
  const bundle = await FileSystem.readAsStringAsync(asset.localUri!, {
    encoding: FileSystem.EncodingType.Base64
  })
  shellMark('worklet:bundle-load:done', { bytes: bundle.length, platform: Platform.OS })

  _worklet = new Worklet()
  await _worklet.start('/app.bundle', b4a.from(bundle, 'base64'))
  shellMark('worklet:started')

  let buffer = ''
  _worklet.IPC.on('data', (chunk: any) => {
    buffer += b4a.toString(chunk)
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        const msg = JSON.parse(line)
        if (msg.id && _pending.has(msg.id)) {
          _pending.get(msg.id)!(msg)
          _pending.delete(msg.id)
        } else if (msg.event) {
          for (const fn of _eventHandlers.get(msg.event) ?? []) fn(msg.data)
        }
      } catch (e) {
        console.warn('worklet IPC parse error', e)
      }
    }
  })

  // Bare runs a Corestore at <dataDir>/pearcircle/store. Strip the file://
  // prefix so the path is a plain POSIX path Bare can open directly.
  const docDir = FileSystem.documentDirectory!
  const dataDir = docDir.replace(/^file:\/\//, '').replace(/\/$/, '')
  await call('init', { dataDir })
  // Drain region events that fired before the worklet existed (cold-
  // start from a force-quit + boundary cross). Replay in FIFO order
  // after init so the worklet's handler sees a fully initialized
  // state. Plain field assignment + length=0 in case the listener
  // appended during the await above.
  if (_pendingRegionEvents.length > 0) {
    const drain = _pendingRegionEvents
    _pendingRegionEvents = []
    for (const msg of drain) sendToWorklet(msg)
  }
}

// The one-time FGS / location-permission bring-up, fired off the worklet's
// `ready` event. Factored to module scope (was the Index component's
// onReadyOnce) so the headless boot/update path runs it too. iOS keeps the
// first-run priming-modal gate; Android awaits notification setup first so
// the POST_NOTIFICATIONS and FINE_LOCATION dialogs don't race a shared
// PermissionListener. On Android it also mirrors sharing state into the
// native autostart gate so a subsequent reboot can resume without the JS
// context (proposal 2026-06-09).
async function onBackendReady(data: any) {
  if (Platform.OS === 'android') {
    const gate = autostartGateValue(data, 'sharingAnyEnabled')
    if (gate.write) PearCircleLocation?.setAutostartEnabled?.(gate.value).catch(() => {})
  }
  if (data?.sharingAnyEnabled === false) return
  if (Platform.OS === 'ios') {
    try {
      const status: string = await PearCircleLocation.getAuthorizationStatus?.()
      if (status === 'notDetermined') {
        // Stash the resolver; WebView's Continue button triggers the actual start.
        _pendingLocationStart = true
        emitEvent('permission:prime', { reason: 'first-time' })
        return  // wait for shell:permission:proceed
      }
      // Already determined (any state): start updates, then publish status.
      await PearCircleLocation.startUpdates?.()
      const post: string = await PearCircleLocation.getAuthorizationStatus?.()
      emitEvent('permission:status', { status: post })
    } catch (e: any) {
      console.warn('startUpdates failed', e?.message)
    }
    return
  }
  // Android: existing flow. Emit permission:status after the request
  // resolves so the home banner can nudge "Allow only while using the app"
  // users toward Settings -> "Allow all the time". We await notif setup
  // first so the POST_NOTIFICATIONS dialog resolves before FINE_LOCATION --
  // otherwise the two share a PermissionListener and the wrong grant result
  // can start the FGS without location permission, crashing on Android 14+.
  try {
    await _notifSetupReady
    await PearCircleLocation.startUpdates?.()
    const post: string = await PearCircleLocation.getAuthorizationStatus?.()
    if (typeof post === 'string') emitEvent('permission:status', { status: post })
  } catch (e: any) {
    console.warn('startUpdates failed', e?.message)
  }
}

// Native-action worklet handlers: the side of the IPC that touches OS
// surfaces (foreground service, notifications, CLLocationManager) and the
// local caches the notification formatters read. Registered once, by the
// shared bootstrap, so they run in BOTH the Activity path and the headless
// boot/update path. The WebView/UI-forwarding handlers (emitEvent-only) are
// attached separately by the Index component and only exist when it mounts.
function registerNativeActionHandlers() {
  // ready: capture our pubkey for self-notification suppression and seed the
  // worklet's adaptive-location app-foreground state (AppState only fires on
  // change, so without this push the worklet wouldn't know the foreground
  // state until the first background/foreground cycle).
  onEvent('ready', (data) => {
    if (data?.publicKey && typeof data.publicKey === 'string') _ourPubkey = data.publicKey
    sendToWorklet({ method: 'app:state', args: { state: AppState.currentState } })
  })
  onEvent('ready', onBackendReady)

  // FGS lifecycle + autostart gate. When every circle is muted, stop the
  // native foreground location service so the persistent notification
  // disappears and the OS can reclaim wake-locks; resume when any circle
  // flips back on. The worklet computes anyEnabled (including the
  // zero-circles-default-on case). The UI-side emitEvent('sharing:changed')
  // is a separate handler in Index.
  onEvent('sharing:changed', async (data) => {
    if (Platform.OS === 'android') {
      const gate = autostartGateValue(data, 'anyEnabled')
      if (gate.write) PearCircleLocation?.setAutostartEnabled?.(gate.value).catch(() => {})
    }
    if (typeof data?.anyEnabled !== 'boolean') return
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return
    try {
      if (data.anyEnabled) await PearCircleLocation?.startUpdates?.()
      else await PearCircleLocation?.stopUpdates?.()
    } catch (e: any) {
      console.warn('FGS toggle on sharing:changed failed', e?.message ?? String(e))
    }
  })

  // Geofence transitions: fire the OS notification for a peer (not us) on an
  // unmuted place. Trip-completion and membership join/leave notifications
  // likewise; the worklet owns the freshness / dedup / self / anchor gates,
  // the shell just formats and posts.
  onEvent('transition:applied', (data) => { fireTransitionNotification(data) })
  onEvent('peerTrip:completed', (data) => { firePeerTripNotification(data) })
  onEvent('member:joined', (data) => { fireMembershipNotification(data, 'memberJoined') })
  onEvent('member:left', (data) => { fireMembershipNotification(data, 'memberLeft') })
  // Keep the local trip-notification-enabled cache fresh so headless trip
  // notifications respect the toggle. The UI forwarding is separate in Index.
  onEvent('tripNotifications:changed', (data) => {
    if (data && typeof data.enabled === 'boolean') _tripNotificationsEnabled = data.enabled
  })

  // Worklet asks the shell to reconcile the iOS CLCircularRegion set with its
  // current places (iOS-only; Android no-ops here). Capped to <=20 by the
  // worklet (Apple's limit). Non-fatal: the JS classifier still covers the
  // foreground / backgrounded case via location:update.
  onEvent('regions:set', async (data) => {
    if (Platform.OS !== 'ios' || !PearCircleLocation?.setMonitoredRegions) return
    const regions = Array.isArray(data?.regions) ? data.regions : []
    try { await PearCircleLocation.setMonitoredRegions(regions) }
    catch (e: any) { console.warn('setMonitoredRegions failed', e?.message ?? String(e)) }
  })
  // Adaptive location mode (proposal 2026-05-16): worklet flips the native
  // CLLocationManager between SLC-only ("idle") and SLC+continuous
  // ("tracking"). iOS only; Android has its own knobs.
  onEvent('location:mode:set', async (data) => {
    if (Platform.OS !== 'ios' || !PearCircleLocation?.setMode) return
    const mode = data?.mode
    if (mode !== 'idle' && mode !== 'tracking') return
    try { await PearCircleLocation.setMode(mode) }
    catch (e: any) { console.warn('setMode failed', e?.message ?? String(e)) }
  })
}

// Idempotent, serialized backend bring-up shared by the Activity mount and
// the headless boot/update task (proposal 2026-06-09). makeStartLock is the
// process-level start lock on top of the worklet's _workletStarted singleton:
// a near-simultaneous Activity-mount and headless-task cannot both pass the
// guard and open the Autobase writer core twice (the single-writer hazard).
// Registers only the native-action handlers; the WebView/UI-forwarding
// handlers are attached by Index when it mounts. Also brings up the location
// IPC listener and the notification channels + local caches the notification
// formatters read, so a boot-resumed backend can still fire notifications.
export const ensureBackendStarted = makeStartLock(async () => {
  ensureLocationListener()
  registerNativeActionHandlers()
  // Notification channels + permission. Stash the promise so onBackendReady
  // can await it before Android startUpdates. Non-fatal.
  _notifSetupReady = ensureNotifications()
    // Arm the daily sync reminder once channels + permission exist. The
    // AppState 'active' handler re-arms it on every foreground thereafter.
    .then(() => { refreshSyncReminder().catch(() => {}) })
    .catch((e) => {
      console.warn('notif setup failed', e?.message ?? String(e))
    })
  // Local caches read by the notification formatters: muted places and the
  // distance-unit preference. Safe before the worklet is ready.
  loadMutes().catch(() => {})
  AsyncStorage.getItem(DISTANCE_UNIT_KEY).then((raw) => {
    _distanceUnitPref = raw === 'miles' ? 'miles' : 'km'
  }).catch(() => {})
  await startWorklet()
})

function buildHtml(jsBundle: string) {
  // Platform identifier injected before the JS bundle runs so the WebView
  // can branch on it (e.g. About page hides Support development on iOS
  // until App Store approval per guideline 3.1.1).
  const platform = JSON.stringify(Platform.OS)
  // __DEV__ is true only in debug Metro bundles, false in release. Exposed so
  // dev-only UI (e.g. the trip-inject probe) renders on debug builds but not in
  // the release app that ships to users.
  const debug = JSON.stringify(__DEV__)
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
    <style>
      html, body, #root { height: 100%; margin: 0; padding: 0; background: #111; }
      body { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
    </style>
    <script>window.__pearPlatform = ${platform}; window.__pearDebug = ${debug};</script>
  </head>
  <body>
    <div id="root"></div>
    <script>${jsBundle}</script>
  </body>
</html>`
}

async function loadUiHtml(): Promise<string> {
  const asset = Asset.fromModule(require('../assets/app-ui.bundle'))
  await asset.downloadAsync()
  const js = await FileSystem.readAsStringAsync(asset.localUri!, {
    encoding: FileSystem.EncodingType.UTF8,
  })
  return buildHtml(js)
}

function isInviteUrl(url: string) {
  // Tolerate an optional trailing slash before the query - app share links emit
  // ".../circle/join/?circle=...". Without this, a tapped real invite link is
  // silently dropped (no deeplink:invite event, no Join sheet) and the user just
  // lands on the map. Mirrors parseInvite's stripPathTrailingSlash. The worklet
  // re-normalizes on parse, so the slashed URL flows through fine.
  return /^(pear:\/\/pearcircle\/join|https:\/\/peerloomllc\.com\/circle\/join)\/?\?/.test(url)
}

export default function Index() {
  const webViewRef = useRef<WebView>(null)
  const [html, setHtml] = useState<string | null>(null)
  const webViewLoaded = useRef(false)
  const pendingDeeplink = useRef<string | null>(null)
  const pendingNotificationFocus = useRef<{ circleId: string; pubkey: string } | null>(null)
  // QR scanner is a JS-driven modal that resolves a pending shell:scanQr
  // IPC call when the camera reads a code (or the user cancels).
  const [scannerVisible, setScannerVisible] = useState(false)
  const scanResolveRef = useRef<((value: string | null) => void) | null>(null)
  // Status bar icon tint. 'light-content' (white icons) is the default
  // because most of the app is dark-themed. The home view with the
  // light map tiles flips it to 'dark-content' via shell:statusBar:set
  // so the icons remain readable. WebView is the source of truth since
  // it knows whether the map is visible (vs a sheet covering it).
  const [statusBarStyle, setStatusBarStyle] = useState<'dark-content' | 'light-content'>('light-content')

  // Android stock WebView reports env(safe-area-inset-bottom) as 0 for the
  // navigation bar -- only the top (status bar) inset is propagated -- so the
  // UI's bottom-anchored controls render behind the 3-button nav bar. We read
  // the real bottom inset natively and inject it into the WebView as the
  // --android-nav-inset CSS var; the UI takes max(env(), that var). iOS
  // WKWebView reports env() correctly, so we leave the var unset there.
  const insets = useSafeAreaInsets()
  const injectNavInset = (bottom: number) => {
    if (Platform.OS !== 'android') return
    webViewRef.current?.injectJavaScript(
      `document.documentElement.style.setProperty('--android-nav-inset', '${Math.round(bottom)}px'); true;`
    )
  }

  // Re-inject when the inset changes after first paint (e.g. nav-mode or
  // orientation change). The onLoad handler covers the initial injection.
  useEffect(() => {
    if (webViewLoaded.current) injectNavInset(insets.bottom)
  }, [insets.bottom])

  useEffect(() => {
    shellMark('shell:mount')
    // Point the module-level emitEvent at this WebView so the native-action
    // handlers (registered by ensureBackendStarted, possibly already running
    // from a headless start) can forward to the UI once it mounts.
    _webViewRef = webViewRef
    // Shared, idempotent backend bring-up. Registers the native-action
    // worklet handlers and starts the worklet; safe if the headless boot
    // task already started it (the start lock returns the same promise).
    ensureBackendStarted().catch((e: any) => console.warn('backend start failed', e))
    loadUiHtml().then((h) => { shellMark('ui:html-ready'); setHtml(h) }).catch((e) => console.warn('UI bundle load failed', e))

    const sub = AppState.addEventListener('change', (s) => {
      sendToWorklet({ method: 'app:state', args: { state: s } })
      // Also forward to the WebView so the UI can refresh things
      // that change outside the app (e.g. the battery-optimization
      // toggle reflects after the user dismisses the system dialog).
      emitEvent('app:state', { state: s })
      // iOS: re-query authorization status whenever we come back to
      // foreground. The user may have gone to Settings via the home
      // banner, flipped the toggle, and bounced back -- in which case
      // the banner needs to auto-dismiss / change copy without
      // requiring a relaunch. Cheap (single native call), idempotent.
      if (s === 'active' && PearCircleLocation?.getAuthorizationStatus) {
        PearCircleLocation.getAuthorizationStatus().then((status: string) => {
          emitEvent('permission:status', { status })
        }).catch(() => {})
      }
      // Android-only: re-check whether the OS network-location provider is on
      // (GrapheneOS ships it off, freezing a stationary phone's position).
      // Refreshing on foreground means the banner auto-dismisses after the
      // user flips it in Settings and returns. iOS lacks this method, so the
      // event never fires there and the banner stays Android-only.
      if (s === 'active' && PearCircleLocation?.isNetworkLocationEnabled) {
        PearCircleLocation.isNetworkLocationEnabled().then((enabled: boolean) => {
          emitEvent('networkLocation:status', { enabled: !!enabled })
        }).catch(() => {})
      }
      // Force one fresh location fix on every foreground
      // (foreground-refresh, 2026-05-29). On iOS the adaptive pipeline
      // only writes lastSeen on movement past distanceFilter / a ~500m
      // SLC, so a stationary phone that just reopened the app keeps
      // showing a stale "last seen" timestamp; on Android it delivers an
      // instant fix instead of waiting up to the ~10s service interval
      // (and covers the window before the foreground service is running).
      // requestSingleFix actively obtains a current fix and pushes it
      // through the normal location:update path. Delayed a beat so the
      // app:state we just forwarded has time to re-establish iOS
      // "tracking" mode first -- otherwise a coincident idle->tracking
      // startUpdatingLocation would cancel the pending one-shot (harmless
      // on Android). No-op natively when unauthorized.
      if (s === 'active' && PearCircleLocation?.requestSingleFix) {
        setTimeout(() => {
          PearCircleLocation.requestSingleFix?.().catch(() => {})
        }, 1500)
      }
    })

    // WebView/UI-forwarding handlers ONLY. The native-action side of these
    // events (FGS toggle, OS notifications, region/mode native calls, the
    // ready app:state seed + pubkey capture) is registered by
    // ensureBackendStarted's registerNativeActionHandlers so it runs in the
    // headless boot/update path too. Multiple handlers per event are
    // supported (onEvent appends), so these coexist with the native ones.
    onEvent('ready', (data) => {
      shellMark('worklet:ready-received')
      emitEvent('ready', data)
    })
    // Phase-4 device verification side-channel: write the worklet's
    // buffered cold-start trace to FileSystem.documentDirectory/coldstart.log
    // so it can be pulled off the iPhone with `xcrun devicectl device copy from`.
    // os_log streaming on a real device requires root or interactive Console.app;
    // the file path works headless. Shell-side logs are also concatenated so a
    // single file gives the full picture.
    onEvent('coldstart:trace', async (data) => {
      try {
        const lines = Array.isArray(data?.lines) ? data.lines : []
        const shellLine = '[coldstart shell+' + (Date.now() - _shellT0) + 'ms] coldstart:trace-received'
        const body = lines.join('\n') + '\n' + shellLine + '\n'
        const path = FileSystem.documentDirectory + 'coldstart.log'
        await FileSystem.writeAsStringAsync(path, body)
      } catch (e: any) {
        console.warn('coldstart trace write failed', e?.message)
      }
    })
    onEvent('peer:connected', (data) => emitEvent('peer:connected', data))
    onEvent('peer:disconnected', (data) => emitEvent('peer:disconnected', data))
    onEvent('circle:writer:added', (data) => emitEvent('circle:writer:added', data))
    // Circle-repair lifecycle, so the UI's repair / Repairing… banners flip
    // promptly instead of waiting on the next circles:getAll poll.
    onEvent('circle:degraded', (data) => emitEvent('circle:degraded', data))
    onEvent('circle:repairing', (data) => emitEvent('circle:repairing', data))
    onEvent('circle:repaired', (data) => emitEvent('circle:repaired', data))
    // Blind-seeder admission events. The approval prompt was dropped
    // (proposal amendment 2026-05-20) — seeders auto-admit, so there is
    // no seeder:announced. seeder:admitted / seeder:revoked are still
    // forwarded for any UI that wants an optimistic refresh.
    onEvent('seeder:admitted', (data) => emitEvent('seeder:admitted', data))
    onEvent('seeder:revoked', (data) => emitEvent('seeder:revoked', data))
    onEvent('sharing:changed', (data) => emitEvent('sharing:changed', data))
    // Owner tear-down notice (proposal amendment 2026-05-07). The worklet
    // suppresses this on the owner's own device, so we only see it when
    // a peer's circle has been deleted by its owner. UI surfaces a
    // one-time toast and then runs circle:cleanup-deleted.
    onEvent('circle:deleted', (data) => emitEvent('circle:deleted', data))
    // Owner removed this member from a circle (proposal 2026-05-03 §3).
    // Same UI path as circle:deleted -- one-time notice, then cleanup.
    onEvent('circle:removed-self', (data) => emitEvent('circle:removed-self', data))
    onEvent('tripNotifications:changed', (data) => emitEvent('tripNotifications:changed', data))

    // Deep links: pear://pearcircle/join?... and https equivalent.
    Linking.getInitialURL().then((url) => {
      if (url && isInviteUrl(url)) deliverDeeplink(url)
    })
    const linkSub = Linking.addEventListener('url', ({ url }) => {
      if (isInviteUrl(url)) deliverDeeplink(url)
    })

    // Notification taps: route to focus-member in the WebView. Cold-start
    // taps come through getLastNotificationResponseAsync; live taps come
    // through addNotificationResponseReceivedListener. Both deliver via
    // deliverNotificationFocus, which mirrors the deeplink pending-flush
    // pattern so a tap that lands before the WebView is ready isn't lost.
    // These notification kinds carry focus-routing payloads:
    //   - transition:  { kind: 'transition', circleId, pubkey } from geofence enter/exit
    //   - peerTrip:     { kind: 'peerTrip', circleId, authorPubkey } from trip-completion
    //   - memberJoined: { kind: 'memberJoined', circleId, pubkey } from a circle join
    //   - memberLeft:   { kind: 'memberLeft', circleId, pubkey } from a circle leave/remove
    // All resolve to the same WebView event so the UI can switch circle
    // filter and focus the member uniformly.
    const routeNotificationData = (data: any) => {
      if (!data) return
      if (data.kind === 'transition' && typeof data.circleId === 'string' && typeof data.pubkey === 'string') {
        deliverNotificationFocus({ circleId: data.circleId, pubkey: data.pubkey })
      } else if (data.kind === 'peerTrip' && typeof data.circleId === 'string' && typeof data.authorPubkey === 'string') {
        deliverNotificationFocus({ circleId: data.circleId, pubkey: data.authorPubkey })
      } else if ((data.kind === 'memberJoined' || data.kind === 'memberLeft') &&
                 typeof data.circleId === 'string' && typeof data.pubkey === 'string') {
        deliverNotificationFocus({ circleId: data.circleId, pubkey: data.pubkey })
      }
    }
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      routeNotificationData(resp?.notification?.request?.content?.data as any)
    }).catch(() => {})
    const notifSub = Notifications.addNotificationResponseReceivedListener((resp) => {
      routeNotificationData(resp?.notification?.request?.content?.data as any)
    })

    // Hardware-back / back-gesture handling. We always consume the event
    // here (return true) and let the WebView decide what to do via the
    // back:pressed event: if it has anything to dismiss (open sheet,
    // active focus, etc.) it consumes; otherwise it calls shell:exitApp
    // and we exit. The handler returns true unconditionally because
    // BackHandler is synchronous and we can't wait for the WebView's
    // async response -- exitApp is the WebView's explicit signal that
    // the back was effectively unhandled.
    const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
      emitEvent('back:pressed', null)
      return true
    })

    return () => {
      // Detach the UI from the module-level emitEvent so a torn-down WebView
      // isn't written to. The backend (worklet + native handlers) keeps
      // running -- the FGS, not the Activity, is its lifecycle anchor.
      _webViewRef = null
      sub.remove(); linkSub.remove(); notifSub.remove(); backSub.remove()
    }
  }, [])

  const deliverDeeplink = (url: string) => {
    if (webViewLoaded.current) {
      emitEvent('deeplink:invite', { url })
    } else {
      pendingDeeplink.current = url
    }
  }

  const deliverNotificationFocus = (payload: { circleId: string; pubkey: string }) => {
    if (webViewLoaded.current) {
      emitEvent('notification:focus', payload)
    } else {
      pendingNotificationFocus.current = payload
    }
  }

  const onLoad = () => {
    shellMark('webview:loaded')
    webViewLoaded.current = true
    injectNavInset(insets.bottom)
    if (pendingDeeplink.current) {
      emitEvent('deeplink:invite', { url: pendingDeeplink.current })
      pendingDeeplink.current = null
    }
    if (pendingNotificationFocus.current) {
      emitEvent('notification:focus', pendingNotificationFocus.current)
      pendingNotificationFocus.current = null
    }
  }

  const onMessage = async (e: any) => {
    let msg: any
    try { msg = JSON.parse(e.nativeEvent.data) } catch { return }
    if (!msg?.method) return
    if (msg.method === 'shell:scanQr') {
      // Open the native CameraView modal and resolve when a QR is read
      // (or when the user cancels).
      const text = await new Promise<string | null>((resolve) => {
        scanResolveRef.current = resolve
        setScannerVisible(true)
      })
      respond(msg.id, text)
      return
    }
    if (msg.method === 'shell:share') {
      // Native share sheet via React Native's Share API. The Web Share
      // API in the WebView is unreliable with the about:blank base URL
      // (not always considered a secure context), so we route through
      // the shell instead.
      try {
        const result = await Share.share({
          message: msg.args?.text ?? '',
          title: msg.args?.title ?? '',
        })
        respond(msg.id, { ok: result.action !== Share.dismissedAction })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:exportFile') {
      // Save the circle-config JSON to a real, user-visible file. Proposal
      // 2026-06-17 slice 4.
      //   Android: write straight into a folder the user picked once (e.g.
      //   Downloads) via the Storage Access Framework. The granted folder URI
      //   is persisted, so after the first grant every export lands there with
      //   no further prompt. Scoped-storage compliant — apps can't blind-write
      //   to Downloads without this one-time grant.
      //   iOS: there is no Downloads folder; route through the share sheet so
      //   the user can "Save to Files".
      try {
        const filename = sanitizeFilename(msg.args?.filename) || 'pearcircle-export.json'
        const baseName = filename.replace(/\.json$/i, '')
        const contents = typeof msg.args?.contents === 'string' ? msg.args.contents : ''
        if (Platform.OS === 'android') {
          const SAF = (FileSystem as any).StorageAccessFramework
          const writeInto = async (dirUri: string) => {
            const fileUri = await SAF.createFileAsync(dirUri, baseName, 'application/json')
            await FileSystem.writeAsStringAsync(fileUri, contents, { encoding: FileSystem.EncodingType.UTF8 })
          }
          let dirUri = await AsyncStorage.getItem(EXPORT_DIR_KEY)
          if (dirUri) {
            // Reuse the saved grant. If it's stale (folder removed / access
            // revoked) the write throws; fall through to a fresh prompt.
            try { await writeInto(dirUri); respond(msg.id, { ok: true, savedToFolder: true }); return }
            catch { dirUri = null; await AsyncStorage.removeItem(EXPORT_DIR_KEY) }
          }
          const perm = await SAF.requestDirectoryPermissionsAsync()
          if (!perm.granted) { respond(msg.id, { ok: false, canceled: true }); return }
          await AsyncStorage.setItem(EXPORT_DIR_KEY, perm.directoryUri)
          await writeInto(perm.directoryUri)
          respond(msg.id, { ok: true, savedToFolder: true })
          return
        }
        const uri = (FileSystem.cacheDirectory ?? FileSystem.documentDirectory!) + filename
        await FileSystem.writeAsStringAsync(uri, contents, { encoding: FileSystem.EncodingType.UTF8 })
        if (!(await Sharing.isAvailableAsync())) {
          respond(msg.id, { ok: false, error: 'sharing not available' })
          return
        }
        await Sharing.shareAsync(uri, {
          mimeType: 'application/json',
          dialogTitle: msg.args?.title ?? 'Export circle',
          UTI: 'public.json',
        })
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:importFile') {
      // Open the OS document picker, read the chosen JSON file, and hand its
      // text back to the WebView, which validates + imports it. Proposal
      // 2026-06-17 slice 4.
      try {
        const res = await DocumentPicker.getDocumentAsync({
          type: ['application/json', 'text/plain', '*/*'],
          copyToCacheDirectory: true,
          multiple: false,
        })
        if (res.canceled || !res.assets?.[0]?.uri) {
          respond(msg.id, { ok: false, canceled: true })
          return
        }
        const contents = await FileSystem.readAsStringAsync(res.assets[0].uri, {
          encoding: FileSystem.EncodingType.UTF8,
        })
        respond(msg.id, { ok: true, contents })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:location:start') {
      // Start the native foreground location service. Used by the
      // sharing toggle to resume location updates after a stop.
      try {
        await PearCircleLocation?.startUpdates?.()
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:location:stop') {
      // Stop the native foreground location service. The service's
      // persistent notification disappears and no further callbacks
      // reach the worklet. Worklet-side per-circle gates are the
      // belt-and-suspenders for any in-flight events.
      try {
        await PearCircleLocation?.stopUpdates?.()
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:battery:isExempt') {
      // Doze / OEM battery optimizations gate the foreground service
      // after extended idle. The UI uses this to decide whether to
      // show the "Disable battery optimization" onboarding card in
      // ProfileView. iOS / pre-Doze Android resolve as supported=false.
      if (Platform.OS !== 'android' || !PearCircleLocation?.isIgnoringBatteryOptimizations) {
        respond(msg.id, { supported: false, exempt: false })
        return
      }
      try {
        const exempt = await PearCircleLocation.isIgnoringBatteryOptimizations()
        respond(msg.id, { supported: true, exempt: !!exempt })
      } catch (err: any) {
        respond(msg.id, { supported: true, exempt: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:autostart:get') {
      // Settings "Autostart after restart" diagnostic. Reads the native gate
      // BootReceiver checks (autostart_enabled + location grant) plus the
      // location granularity and battery exemption, so the UI can show armed /
      // why-not. iOS has no boot-resume path -> supported:false (section hidden).
      if (Platform.OS !== 'android' || !PearCircleLocation?.getAutostartStatus) {
        respond(msg.id, { supported: false })
        return
      }
      try {
        const s = await PearCircleLocation.getAutostartStatus()
        respond(msg.id, {
          supported: true,
          gateEnabled: !!s?.gateEnabled,
          locationGranted: !!s?.locationGranted,
          locationStatus: s?.locationStatus ?? 'denied',
          batteryExempt: !!s?.batteryExempt,
        })
      } catch (err: any) {
        respond(msg.id, { supported: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:notif:mute:list') {
      // Return the current mute set as an array of '{circleId}:{placeId}'
      // keys. Cheap; called once on UI init and after sets to refresh state.
      respond(msg.id, { mutes: [..._mutes] })
      return
    }
    if (msg.method === 'shell:notif:mute:set') {
      const { circleId, placeId, muted } = msg.args ?? {}
      await setMute(circleId, placeId, !!muted)
      respond(msg.id, { ok: true })
      return
    }
    if (msg.method === 'shell:tileStyle:get') {
      // MapLibre style URL override. null means "use default" (the WebView
      // has the default constant). Tile-provider independence per TODO.md.
      try {
        const raw = await AsyncStorage.getItem(TILE_STYLE_KEY)
        respond(msg.id, { url: typeof raw === 'string' && raw.length > 0 ? raw : null })
      } catch (err: any) {
        respond(msg.id, { url: null, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:exitApp') {
      // Last-resort exit. The WebView's back:pressed handler walks its
      // own dismissal stack first; only when nothing is left to close
      // does it call this. BackHandler.exitApp() bypasses the OS's
      // recents-suspend route and actually finishes the activity --
      // the foreground location service still keeps the worklet alive
      // (per network-change-handler design), so location sharing
      // continues in the background.
      try { BackHandler.exitApp() } catch {}
      respond(msg.id, { ok: true })
      return
    }
    if (msg.method === 'shell:distanceUnit:get') {
      try {
        const raw = await AsyncStorage.getItem(DISTANCE_UNIT_KEY)
        respond(msg.id, { unit: raw === 'miles' ? 'miles' : 'km' })
      } catch (err: any) {
        respond(msg.id, { unit: 'km', error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:theme:get') {
      try {
        const raw = await AsyncStorage.getItem(THEME_KEY)
        respond(msg.id, { theme: raw === 'light' ? 'light' : 'dark' })
      } catch (err: any) {
        respond(msg.id, { theme: 'dark', error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:theme:set') {
      const theme = msg.args?.theme
      if (theme !== 'dark' && theme !== 'light') {
        respond(msg.id, { ok: false, error: "theme must be 'dark' or 'light'" })
        return
      }
      try {
        await AsyncStorage.setItem(THEME_KEY, theme)
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:syncReminder:get') {
      const { hour, minute } = await getSyncReminderTime()
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      respond(msg.id, { enabled: await isSyncReminderEnabled(), time })
      return
    }
    if (msg.method === 'shell:syncReminder:set') {
      // Both fields optional; set whichever the UI sends (toggle vs time picker).
      const { enabled, time } = msg.args ?? {}
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        respond(msg.id, { ok: false, error: 'enabled must be a boolean' })
        return
      }
      if (time !== undefined && !parseHHMM(time)) {
        respond(msg.id, { ok: false, error: "time must be 'HH:MM' (24h)" })
        return
      }
      try {
        if (typeof enabled === 'boolean') {
          await AsyncStorage.setItem(SYNC_REMINDER_KEY, enabled ? 'true' : 'false')
        }
        if (parseHHMM(time)) await AsyncStorage.setItem(SYNC_REMINDER_TIME_KEY, time)
        // Apply immediately: enabling/time-change re-arms, disabling cancels.
        await refreshSyncReminder()
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:distanceUnit:set') {
      const unit = msg.args?.unit
      if (unit !== 'km' && unit !== 'miles') {
        respond(msg.id, { ok: false, error: "unit must be 'km' or 'miles'" })
        return
      }
      try {
        await AsyncStorage.setItem(DISTANCE_UNIT_KEY, unit)
        _distanceUnitPref = unit
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:onboarding:get') {
      try {
        const [complete, tourPending] = await Promise.all([
          AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY),
          AsyncStorage.getItem(TOUR_PENDING_KEY),
        ])
        respond(msg.id, {
          complete: complete === 'true',
          tourPending: tourPending === 'true',
        })
      } catch (err: any) {
        respond(msg.id, { complete: false, tourPending: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:statusBar:set') {
      // 'dark' = dark icons (for light backgrounds, e.g. map tiles)
      // 'light' = light icons (for dark backgrounds, e.g. sheets)
      const style = msg.args?.style
      if (style === 'dark') setStatusBarStyle('dark-content')
      else if (style === 'light') setStatusBarStyle('light-content')
      respond(msg.id, { ok: true })
      return
    }
    if (msg.method === 'shell:onboarding:set') {
      const { complete, tourPending } = msg.args ?? {}
      try {
        if (typeof complete === 'boolean') {
          await AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, complete ? 'true' : 'false')
        }
        if (typeof tourPending === 'boolean') {
          await AsyncStorage.setItem(TOUR_PENDING_KEY, tourPending ? 'true' : 'false')
        }
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:tileStyle:set') {
      // url === null clears the override and falls back to the WebView's
      // default. Truthy strings are stored verbatim; the WebView is
      // responsible for validating before calling.
      const url = msg.args?.url
      try {
        if (url == null) await AsyncStorage.removeItem(TILE_STYLE_KEY)
        else if (typeof url === 'string' && url.length > 0) await AsyncStorage.setItem(TILE_STYLE_KEY, url)
        else { respond(msg.id, { ok: false, error: 'url must be a non-empty string or null' }); return }
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:permission:proceed') {
      // WebView's "Continue" tap on the priming modal. iOS: now fire
      // the system dialog. Whatever the user picks (Always, WhenInUse,
      // Don't Allow, Allow Once), we then publish the post-decision
      // status so the home banner can react.
      if (Platform.OS !== 'ios') { respond(msg.id, { ok: false, reason: 'not_ios' }); return }
      if (!_pendingLocationStart) { respond(msg.id, { ok: false, reason: 'not_pending' }); return }
      _pendingLocationStart = false
      try {
        await PearCircleLocation?.startUpdates?.()
        const post: string = await PearCircleLocation?.getAuthorizationStatus?.()
        emitEvent('permission:status', { status: post })
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:permission:status') {
      // On-demand status query from the WebView (e.g., the home banner
      // refreshes after the user returns from Settings). Both iOS and
      // Android implement getAuthorizationStatus with the same string
      // vocabulary (proposal-aligned UI handles both).
      try {
        const status = await PearCircleLocation?.getAuthorizationStatus?.()
        respond(msg.id, { status: typeof status === 'string' ? status : 'unknown' })
      } catch (err: any) {
        respond(msg.id, { status: 'unknown', error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:location:networkEnabled') {
      // On-demand network-location-provider query for the cold-boot pull:
      // the shell emits networkLocation:status on app:state, but on a cold
      // launch that fires before the WebView attaches and the injected event
      // is dropped, so the banner would only appear after a background ->
      // foreground cycle. iOS has no such provider; resolve enabled=true so
      // the banner never shows there.
      try {
        if (!PearCircleLocation?.isNetworkLocationEnabled) {
          respond(msg.id, { enabled: true })
          return
        }
        const enabled = await PearCircleLocation.isNetworkLocationEnabled()
        respond(msg.id, { enabled: !!enabled })
      } catch (err: any) {
        respond(msg.id, { enabled: true, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:openSettings') {
      // Deep-link the user to "where they can fix the location
      // permission." Each OS exposes a different best path:
      //   iOS:     UIApplication.openSettingsURLString — app's Settings
      //            entry. Apple doesn't expose a deeper deep-link.
      //   Android: if FINE is already granted (whenInUse status), call
      //            requestBackgroundLocation which the OS routes to the
      //            location-permission detail page directly (Android
      //            11+) or shows the upgrade dialog (Android 10). If
      //            FINE is not granted, fall back to Linking.openSettings
      //            (general app-info page) since the request flow needs
      //            FINE first.
      try {
        if (Platform.OS === 'ios') {
          await PearCircleLocation?.openSettings?.()
        } else if (Platform.OS === 'android') {
          let landed = false
          try {
            const status = await PearCircleLocation?.getAuthorizationStatus?.()
            if (status === 'whenInUse' && PearCircleLocation?.requestBackgroundLocation) {
              await PearCircleLocation.requestBackgroundLocation()
              landed = true
            }
          } catch {}
          if (!landed) await Linking.openSettings()
        }
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:location:openSettings') {
      // Android-only: open the OS Location settings page (where network
      // location is toggled) for the network-location banner's action.
      try {
        await PearCircleLocation?.openLocationSettings?.()
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:donateReminder:get') {
      // Returns { firstLaunch, shown, elapsedMs }. firstLaunch is auto-
      // seeded with Date.now() on the very first call so the WebView
      // doesn't need a separate "init" step. Storage failures fall
      // back to "shown=true" so a broken AsyncStorage doesn't pin the
      // modal open forever.
      try {
        let firstLaunchStr = await AsyncStorage.getItem(DONATE_FIRST_LAUNCH_KEY)
        if (!firstLaunchStr) {
          const now = String(Date.now())
          await AsyncStorage.setItem(DONATE_FIRST_LAUNCH_KEY, now)
          firstLaunchStr = now
        }
        const shownStr = await AsyncStorage.getItem(DONATE_SHOWN_KEY)
        const firstLaunch = Number(firstLaunchStr)
        respond(msg.id, {
          firstLaunch,
          shown: shownStr === '1',
          elapsedMs: Date.now() - firstLaunch,
        })
      } catch (err: any) {
        respond(msg.id, { firstLaunch: Date.now(), shown: true, elapsedMs: 0, error: err?.message })
      }
      return
    }
    if (msg.method === 'shell:donateReminder:setShown') {
      try {
        await AsyncStorage.setItem(DONATE_SHOWN_KEY, '1')
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:openUrl') {
      // Hand a URL off to the OS for resolution. Used by the member
      // detail sheet's "Get directions" action with a geo: URI; could
      // host any external link in the future. The shell does the work
      // because the WebView's about:blank base URL prevents reliable
      // window.open / location.href navigation.
      const url = msg.args?.url
      if (typeof url !== 'string' || url.length === 0) {
        respond(msg.id, { ok: false, error: 'url must be a non-empty string' })
        return
      }
      let target = url
      // iOS doesn't register Apple Maps for the geo: scheme — geo: is
      // a Google convention. Handing geo: to Linking.openURL on iOS
      // either fails outright (no registered handler) or gets hijacked
      // by whatever app claims it, most commonly Google Earth. Rewrite
      // to an Apple Maps universal link so directions land in Apple
      // Maps deterministically; no LSApplicationQueriesSchemes entry
      // needed because https://maps.apple.com resolves to the system
      // app natively. Android keeps the geo: URI so it goes through
      // the user's default maps app picker.
      if (Platform.OS === 'ios' && url.startsWith('geo:')) {
        const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:\?(.*))?$/.exec(url)
        if (m) {
          const lat = Number(m[1])
          const lon = Number(m[2])
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const params = new URLSearchParams()
            params.set('daddr', `${lat},${lon}`)
            params.set('dirflg', 'd')
            const labelMatch = m[3] ? /q=[^()&]+\(([^)]+)\)/.exec(m[3]) : null
            if (labelMatch) {
              try { params.set('q', decodeURIComponent(labelMatch[1])) }
              catch { params.set('q', labelMatch[1]) }
            }
            target = `https://maps.apple.com/?${params.toString()}`
          }
        }
      }
      try {
        await Linking.openURL(target)
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:canOpenURL') {
      // Probe whether the OS has a registered handler for a given URL
      // scheme. Used by the About page to detect a Lightning wallet
      // (`lightning:`) before showing a wallet-list modal -- if a wallet
      // is installed we hand the lightning: URI off to it directly via
      // shell:openUrl; if none is installed, we surface the modal of
      // wallet recommendations instead.
      const url = msg.args?.url
      if (typeof url !== 'string' || url.length === 0) {
        respond(msg.id, { ok: false, error: 'url must be a non-empty string' })
        return
      }
      try {
        const can = await Linking.canOpenURL(url)
        respond(msg.id, { ok: true, can: !!can })
      } catch (err: any) {
        respond(msg.id, { ok: false, can: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:clipboard') {
      // Copy text to the OS clipboard. Used by the donation sheet's copy
      // buttons (Lightning address, on-chain BTC address). Routes through
      // the shell because navigator.clipboard is unreliable in the WebView
      // -- its about:blank base URL isn't treated as a secure context.
      const text = msg.args?.text
      if (typeof text !== 'string' || text.length === 0) {
        respond(msg.id, { ok: false, error: 'text must be a non-empty string' })
        return
      }
      try {
        await Clipboard.setStringAsync(text)
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    if (msg.method === 'shell:haptic') {
      // Tactile feedback for high-touch interactions in the WebView.
      // Routes through the shell because expo-haptics is a native
      // module not directly accessible from the WebView. Failures are
      // silently swallowed -- a missing haptic is never a reason to
      // block the user-visible action that triggered it.
      const kind = msg.args?.kind
      try {
        if (kind === 'light') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        else if (kind === 'medium') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
        else if (kind === 'heavy') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
        else if (kind === 'warn') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
        else if (kind === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      } catch {}
      respond(msg.id, { ok: true })
      return
    }
    if (msg.method === 'shell:battery:requestExempt') {
      // Opens the system "Allow PearCircle to ignore battery
      // optimizations?" dialog. The user has to tap Allow themselves
      // — there's no programmatic bypass. After the dialog closes,
      // the activity resumes and the WebView's app:state=active
      // listener triggers a re-check.
      if (Platform.OS !== 'android' || !PearCircleLocation?.requestIgnoreBatteryOptimizations) {
        respond(msg.id, { ok: false, supported: false })
        return
      }
      try {
        await PearCircleLocation.requestIgnoreBatteryOptimizations()
        respond(msg.id, { ok: true })
      } catch (err: any) {
        respond(msg.id, { ok: false, error: err?.message ?? String(err) })
      }
      return
    }
    const result = await call(msg.method, msg.args)
    respond(msg.id, result)
  }

  const respond = (id: number, result: any) => {
    webViewRef.current?.injectJavaScript(
      `window.__pearResponse(${id}, ${JSON.stringify(result ?? null)}); true;`
    )
  }

  if (!html) {
    return (
      <View style={styles.splash}>
        <Text style={styles.splashText}>PearCircle</Text>
      </View>
    )
  }

  const onScannerResult = (text: string | null) => {
    setScannerVisible(false)
    const fn = scanResolveRef.current
    scanResolveRef.current = null
    if (fn) fn(text)
  }

  return (
    <>
      <StatusBar barStyle={statusBarStyle} translucent backgroundColor='transparent' />
      <WebView
        ref={webViewRef}
        // baseUrl https://localhost/ rather than about:blank: the
        // WebView treats about:blank as a non-secure null-origin
        // context and denies IndexedDB (SecurityError on IDBFactory.open).
        // localhost is a recognized "secure context" on both Chromium
        // and WKWebView, so IDB-backed tile caching works. OpenFreeMap
        // and Protomaps ship permissive CORS headers, so cross-origin
        // tile fetches still succeed from this origin.
        source={{ html, baseUrl: 'https://localhost/' }}
        onMessage={onMessage}
        onLoad={onLoad}
        style={{ flex: 1, backgroundColor: '#111' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
      />
      <QrScannerModal
        visible={scannerVisible}
        onScanned={(t) => onScannerResult(t)}
        onCancel={() => onScannerResult(null)}
      />
    </>
  )
}

function QrScannerModal({
  visible,
  onScanned,
  onCancel,
}: {
  visible: boolean
  onScanned: (text: string) => void
  onCancel: () => void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const scanned = useRef(false)

  useEffect(() => {
    if (!visible) { scanned.current = false; return }
    if (!permission?.granted) {
      requestPermission().then((res) => {
        if (!res.granted) onCancel()
      })
    }
  }, [visible, permission, requestPermission, onCancel])

  const handleBarcode = (result: any) => {
    if (scanned.current) return
    scanned.current = true
    onScanned(result.data)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {permission?.granted ? (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            onBarcodeScanned={handleBarcode}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          />
          <View style={styles.scannerOverlay} pointerEvents="box-none">
            <View style={styles.scannerHint}>
              <Text style={styles.scannerHintText}>Point at the invite QR</Text>
            </View>
            <TouchableOpacity style={styles.scannerCancel} onPress={onCancel}>
              <Text style={styles.scannerCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.scannerWaiting}>
          <Text style={{ color: '#fff' }}>Requesting camera permission…</Text>
        </View>
      )}
    </Modal>
  )
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  splashText: { color: '#eee', fontSize: 28, fontWeight: '600' },
  scannerOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', padding: 32 },
  scannerHint: { alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 12, borderRadius: 8, marginTop: 60 },
  scannerHintText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  scannerCancel: { backgroundColor: 'rgba(0,0,0,0.7)', padding: 16, borderRadius: 8, alignItems: 'center' },
  scannerCancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  scannerWaiting: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
})
