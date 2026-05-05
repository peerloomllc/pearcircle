import { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, NativeModules, NativeEventEmitter, Platform, AppState, Share, Modal, TouchableOpacity } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import * as Linking from 'expo-linking'
import { CameraView, useCameraPermissions } from 'expo-camera'

const { PearCircleLocation } = NativeModules

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

  const asset = Asset.fromModule(require('../assets/bare-universal.bundle'))
  await asset.downloadAsync()
  const bundle = await FileSystem.readAsStringAsync(asset.localUri!, {
    encoding: FileSystem.EncodingType.Base64
  })

  _worklet = new Worklet()
  await _worklet.start('/app.bundle', b4a.from(bundle, 'base64'))

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
  // QR scanner is a JS-driven modal that resolves a pending shell:scanQr
  // IPC call when the camera reads a code (or the user cancels).
  const [scannerVisible, setScannerVisible] = useState(false)
  const scanResolveRef = useRef<((value: string | null) => void) | null>(null)

  useEffect(() => {
    startWorklet().catch((e) => console.warn('worklet start failed', e))
    loadUiHtml().then(setHtml).catch((e) => console.warn('UI bundle load failed', e))

    const sub = AppState.addEventListener('change', (s) => {
      sendToWorklet({ method: 'app:state', args: { state: s } })
    })

    // Forward worklet events to the WebView so the UI can react.
    onEvent('ready', (data) => emitEvent('ready', data))
    onEvent('peer:connected', (data) => emitEvent('peer:connected', data))
    onEvent('peer:disconnected', (data) => emitEvent('peer:disconnected', data))
    onEvent('circle:writer:added', (data) => emitEvent('circle:writer:added', data))

    // Deep links: pear://pearcircle/join?... and https equivalent.
    Linking.getInitialURL().then((url) => {
      if (url && isInviteUrl(url)) deliverDeeplink(url)
    })
    const linkSub = Linking.addEventListener('url', ({ url }) => {
      if (isInviteUrl(url)) deliverDeeplink(url)
    })

    return () => { sub.remove(); linkSub.remove() }
  }, [])

  const deliverDeeplink = (url: string) => {
    if (webViewLoaded.current) {
      emitEvent('deeplink:invite', { url })
    } else {
      pendingDeeplink.current = url
    }
  }

  const onLoad = () => {
    webViewLoaded.current = true
    if (pendingDeeplink.current) {
      emitEvent('deeplink:invite', { url: pendingDeeplink.current })
      pendingDeeplink.current = null
    }
  }

  useEffect(() => {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return
    if (!PearCircleLocation) return

    ensureLocationListener()
    PearCircleLocation.startUpdates?.().catch?.((e: any) =>
      console.warn('startUpdates failed', e),
    )

    // Deliberately no cleanup: the location listener survives activity
    // destruction (set up at module scope), and the foreground service
    // is meant to keep running too. Stopping is an explicit user action
    // (future "Stop sharing" toggle slice).
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
