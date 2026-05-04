import { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, NativeModules, Platform, AppState } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'

const { PearCircleLocation } = NativeModules

let _worklet: any = null
let _workletStarted = false
let _nextId = 1
const _pending = new Map<number, (msg: any) => void>()
const _eventHandlers = new Map<string, ((data: any) => void)[]>()

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

export default function Index() {
  const webViewRef = useRef<WebView>(null)
  const [uiReady, setUiReady] = useState(false)

  useEffect(() => {
    startWorklet().catch((e) => console.warn('worklet start failed', e))

    const sub = AppState.addEventListener('change', (s) => {
      sendToWorklet({ method: 'app:state', args: { state: s } })
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      PearCircleLocation?.startUpdates?.()
    }
  }, [])

  // Bridge WebView → worklet for most methods, with a few RN-side intercepts.
  const onMessage = async (e: any) => {
    let msg: any
    try { msg = JSON.parse(e.nativeEvent.data) } catch { return }
    if (!msg?.method) return

    // RN-side intercepts go here (camera, QR, deep links, geofence registration).
    if (msg.method === 'geofence:register') {
      const result = await PearCircleLocation?.registerGeofence?.(msg.args)
      respond(msg.id, result)
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

  if (!uiReady) {
    // UI bundle loader will go here. For now, render a placeholder.
    return (
      <View style={styles.splash}>
        <Text style={styles.splashText}>PearCircle</Text>
      </View>
    )
  }

  return (
    <WebView
      ref={webViewRef}
      source={{ html: '<html><body style="background:#111;color:#eee;font:16px sans-serif;padding:24px">UI bundle not yet built. Run <code>npm run build:ui</code>.</body></html>' }}
      onMessage={onMessage}
      style={{ flex: 1, backgroundColor: '#111' }}
    />
  )
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  splashText: { color: '#eee', fontSize: 28, fontWeight: '600' }
})
