import { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, NativeModules, NativeEventEmitter, Platform, AppState, Share, Modal, TouchableOpacity } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import * as Linking from 'expo-linking'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Notifications from 'expo-notifications'
import * as Haptics from 'expo-haptics'
import AsyncStorage from '@react-native-async-storage/async-storage'

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
const _mutes = new Set<string>()
let _ourPubkey: string | null = null

const muteKey = (circleId: string, placeId: string) => circleId + ':' + placeId

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
    await Notifications.setNotificationChannelAsync('geofence', {
      name: 'Place transitions',
      importance: Notifications.AndroidImportance.HIGH,
      description: 'Notifications when circle members arrive at or leave Places',
      lightColor: '#0E413A',
    })
  }
  const settings = await Notifications.getPermissionsAsync()
  if (settings.status !== 'granted') {
    await Notifications.requestPermissionsAsync()
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
  const verb = transition.kind === 'enter' ? 'arrived at' : 'left'
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'PearCircle',
        body: `${displayName} ${verb} ${placeName}`,
        // Stashed for tap-routing: the response listener pulls these
        // fields and delivers a notification:focus event to the WebView,
        // which sets the circle filter + focuses the member.
        data: { kind: 'transition', circleId, pubkey: transition.pubkey },
        ...(Platform.OS === 'android' ? { channelId: 'geofence' } : {}),
      },
      trigger: null,
    })
  } catch (e: any) {
    console.warn('fire transition notification failed: ' + e?.message)
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
    _pending.set(id, (msg) => resolve(msg.result))
    sendToWorklet({ id, method, args })
  })
}

async function startWorklet() {
  if (_workletStarted) return
  _workletStarted = true

  shellMark('worklet:bundle-load:start')
  const asset = Asset.fromModule(require('../assets/bare-universal.bundle'))
  await asset.downloadAsync()
  const bundle = await FileSystem.readAsStringAsync(asset.localUri!, {
    encoding: FileSystem.EncodingType.Base64
  })
  shellMark('worklet:bundle-load:done', { bytes: bundle.length })

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
}

function buildHtml(jsBundle: string) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
    <style>
      html, body, #root { height: 100%; margin: 0; padding: 0; background: #111; }
      body { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
    </style>
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
  return url.startsWith('pear://pearcircle/join?') ||
         url.startsWith('https://peerloomllc.com/circle/join?')
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

  useEffect(() => {
    shellMark('shell:mount')
    startWorklet().catch((e) => console.warn('worklet start failed', e))
    loadUiHtml().then((h) => { shellMark('ui:html-ready'); setHtml(h) }).catch((e) => console.warn('UI bundle load failed', e))

    const sub = AppState.addEventListener('change', (s) => {
      sendToWorklet({ method: 'app:state', args: { state: s } })
      // Also forward to the WebView so the UI can refresh things
      // that change outside the app (e.g. the battery-optimization
      // toggle reflects after the user dismisses the system dialog).
      emitEvent('app:state', { state: s })
    })

    // Forward worklet events to the WebView so the UI can react.
    onEvent('ready', (data) => {
      shellMark('worklet:ready-received')
      // Capture our pubkey so transition:applied can suppress self-notifications.
      if (data?.publicKey && typeof data.publicKey === 'string') _ourPubkey = data.publicKey
      emitEvent('ready', data)
    })
    onEvent('peer:connected', (data) => emitEvent('peer:connected', data))
    onEvent('peer:disconnected', (data) => emitEvent('peer:disconnected', data))
    onEvent('circle:writer:added', (data) => emitEvent('circle:writer:added', data))
    onEvent('sharing:changed', (data) => emitEvent('sharing:changed', data))
    // Owner tear-down notice (proposal amendment 2026-05-07). The worklet
    // suppresses this on the owner's own device, so we only see it when
    // a peer's circle has been deleted by its owner. UI surfaces a
    // one-time toast and then runs circle:cleanup-deleted.
    onEvent('circle:deleted', (data) => emitEvent('circle:deleted', data))
    // Geofence transitions land here; fire OS notification if it's a peer
    // (not us) and the place isn't muted on this device.
    onEvent('transition:applied', (data) => { fireTransitionNotification(data) })

    // Notification setup runs in parallel with worklet startup; it's
    // independent and either order is fine.
    loadMutes().catch(() => {})
    ensureNotifications().catch((e) => console.warn('notif setup failed', e))

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
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      const data = resp?.notification?.request?.content?.data as any
      if (data?.kind === 'transition' && typeof data.circleId === 'string' && typeof data.pubkey === 'string') {
        deliverNotificationFocus({ circleId: data.circleId, pubkey: data.pubkey })
      }
    }).catch(() => {})
    const notifSub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp?.notification?.request?.content?.data as any
      if (data?.kind === 'transition' && typeof data.circleId === 'string' && typeof data.pubkey === 'string') {
        deliverNotificationFocus({ circleId: data.circleId, pubkey: data.pubkey })
      }
    })

    return () => { sub.remove(); linkSub.remove(); notifSub.remove() }
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
    if (pendingDeeplink.current) {
      emitEvent('deeplink:invite', { url: pendingDeeplink.current })
      pendingDeeplink.current = null
    }
    if (pendingNotificationFocus.current) {
      emitEvent('notification:focus', pendingNotificationFocus.current)
      pendingNotificationFocus.current = null
    }
  }

  useEffect(() => {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return
    if (!PearCircleLocation) return

    ensureLocationListener()

    // Auto-start the foreground service unless the worklet's persisted
    // sharing toggle says otherwise. The worklet emits its current
    // `sharingEnabled` on the `ready` event, before any user
    // interaction. We listen once and start (or skip) accordingly.
    const onReadyOnce = (data: any) => {
      if (data?.sharingEnabled === false) return
      PearCircleLocation.startUpdates?.().catch?.((e: any) =>
        console.warn('startUpdates failed', e),
      )
    }
    onEvent('ready', onReadyOnce)

    // Deliberately no cleanup: the location listener survives activity
    // destruction (set up at module scope), and the foreground service
    // is meant to keep running too. Stopping is an explicit user
    // action (the sharing toggle).
  }, [])

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
      // reach the worklet. Worklet-side `_sharingEnabled` is the
      // belt-and-suspenders gate for any in-flight events.
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
      try {
        await Linking.openURL(url)
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

  const emitEvent = (event: string, data: any) => {
    webViewRef.current?.injectJavaScript(
      `window.__pearEvent(${JSON.stringify(event)}, ${JSON.stringify(data ?? null)}); true;`
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
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: 'about:blank' }}
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
