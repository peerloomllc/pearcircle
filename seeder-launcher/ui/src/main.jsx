import { h, render } from 'preact'
import { App } from './App.jsx'
import { FONT_CSS } from './fonts.js'

// Inject Manrope @font-face once. Matches src/ui/App.jsx's font-load
// pattern so the launcher UI shares the same typography as the mobile UI.
const fontStyle = document.createElement('style')
fontStyle.textContent = FONT_CSS
document.head.appendChild(fontStyle)

render(h(App, null), document.getElementById('root'))
