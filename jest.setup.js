global.window = global.window || {}
window.ReactNativeWebView = { postMessage: jest.fn() }

if (!document.getElementById('root')) {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
}
