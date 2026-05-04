// PearCircle — WebView UI bootstrap.
//
// This file is bundled by `npm run build:ui` into `assets/app-ui.bundle`,
// which the RN shell loads into a WebView. The UI talks to the RN shell
// (which talks to the bare worklet) via window.ReactNativeWebView.postMessage.

import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'

let _nextId = 1
const _pending = new Map()
const _eventHandlers = new Map()

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
}

window.__pearResponse = (id, result) => {
  const fn = _pending.get(id)
  if (fn) { _pending.delete(id); fn(result) }
}

window.__pearEvent = (event, data) => {
  for (const fn of _eventHandlers.get(event) ?? []) fn(data)
}

window.pear = { call, on }

const root = createRoot(document.getElementById('root'))
root.render(<App />)
