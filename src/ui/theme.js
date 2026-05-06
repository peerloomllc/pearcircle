// Visual tokens for PearCircle. Structure mirrors PearGuard's theme so
// the family looks coherent across PeerLoom apps. PearCircle is dark-
// only for now; light-mode follow-up if/when needed.
//
// Colors lean green-forward to match the app icon (the lime pear on a
// dark forest-green background). Teal accent is kept separately for
// member-pin selection rings since it pops better against the green
// avatar bubbles.

export const colors = {
  primary: '#9FE15A',          // brand lime (matches the pear)
  primaryDark: '#5BAF3A',
  accent: '#7ec4cf',           // teal for selection rings, "Live" pill kept green
  error: '#ef5350',
  warn: '#ffb74d',
  success: '#7ec77a',
  surface: {
    base: '#0d0d0d',           // app background
    card: '#1a1a1a',           // cards, list items, inputs
    elevated: '#252525',       // headers, sheets above cards
    input: '#1c1c1c',
  },
  text: {
    primary: '#f0f0f0',
    secondary: '#a0a0a0',
    muted: '#666666',
    onPrimary: '#0a1f23',      // text on primary-color buttons
  },
  border: '#2a2a2a',
  divider: '#222222',
}

// Manrope-300 (Light) is the only weight we ship via fonts.js, matching
// PearCal's typography. Headings use 400 which falls back to the system
// regular weight; the visual hierarchy holds and the bundle stays small.
export const typography = {
  display:    { fontSize: 24, fontWeight: 400 },
  heading:    { fontSize: 20, fontWeight: 400 },
  subheading: { fontSize: 16, fontWeight: 400 },
  body:       { fontSize: 14, fontWeight: 300 },
  caption:    { fontSize: 13, fontWeight: 300 },
  micro:      { fontSize: 12, fontWeight: 300 },
  fontFamily: `'Manrope', -apple-system, BlinkMacSystemFont, sans-serif`,
  monoFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

export const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32, xxxl: 48 }

export const radius = { sm: 4, md: 8, lg: 10, xl: 14, full: 9999 }

export const shadow = '0 2px 8px rgba(0,0,0,0.4)'
