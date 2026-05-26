// PearCircle — WebView UI bootstrap.
//
// This file is bundled by `npm run build:ui` into `assets/app-ui.bundle`,
// which the RN shell loads into a WebView. The UI talks to the RN shell
// (which talks to the bare worklet) via window.ReactNativeWebView.postMessage.

import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import { openTileCache } from './lib/tileCache.js'
import { installTileFetchInterceptor } from './lib/tileFetch.js'

// Tile cache must be installed before MapLibre initializes (App.jsx
// imports maplibre-gl-js, which registers no fetches yet but will fire
// them on first map mount). We open the cache, install the fetch
// interceptor, and expose the handle on window so Settings can read
// stats and run admin ops (clear, region delete) without re-opening
// the IDB connection. App render is deferred until this resolves so
// MapLibre's first request is guaranteed to go through the cache.
async function initTileCache () {
  try {
    const cache = await openTileCache()
    installTileFetchInterceptor({ cache })
    window.__pearTileCache = cache
  } catch (e) {
    console.warn('tile cache init failed:', e?.message || e)
  }
}

let _nextId = 1
const _pending = new Map()
const _eventHandlers = new Map()
// Events that arrive before any handler is registered get buffered here
// and delivered when the first handler subscribes. Needed because the
// shell can inject an event (e.g. deeplink:invite at webview:loaded)
// before initTileCache() resolves and App.jsx mounts its pear.on
// listeners. Without this buffer the event is silently dropped.
const _bufferedEvents = new Map()

function call(method, args = {}) {
  return new Promise((resolve) => {
    const id = _nextId++
    _pending.set(id, resolve)
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))
  })
}

function on(event, fn) {
  const handlers = _eventHandlers.get(event) ?? []
  handlers.push(fn)
  _eventHandlers.set(event, handlers)
  const buffered = _bufferedEvents.get(event)
  if (buffered) {
    _bufferedEvents.delete(event)
    for (const data of buffered) fn(data)
  }
}

window.__pearResponse = (id, result) => {
  const fn = _pending.get(id)
  if (fn) { _pending.delete(id); fn(result) }
}

window.__pearEvent = (event, data) => {
  const handlers = _eventHandlers.get(event)
  if (!handlers || handlers.length === 0) {
    const buf = _bufferedEvents.get(event) ?? []
    buf.push(data)
    _bufferedEvents.set(event, buf)
    return
  }
  for (const fn of handlers) fn(data)
}

window.pear = { call, on }

initTileCache().then(() => {
  const root = createRoot(document.getElementById('root'))
  root.render(<App />)
})
