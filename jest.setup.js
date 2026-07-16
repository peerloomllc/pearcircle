global.window = global.window || {}
window.ReactNativeWebView = { postMessage: jest.fn() }

// React 19 gates act() on this flag; without it every render logs a warning.
global.IS_REACT_ACT_ENVIRONMENT = true

if (!document.getElementById('root')) {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
}
