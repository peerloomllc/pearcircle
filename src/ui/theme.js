// Visual tokens for PearCircle. Structure mirrors PearGuard's theme so
// the family looks coherent across PeerLoom apps.
//
// Theming uses CSS variables defined in App.jsx's pearcircle-theme-vars
// <style> block. There are two palettes -- dark (default) and light --
// and the two resolve through the same var(--color-*) names. The values
// exported here are the var() strings themselves, so any inline style
// referencing colors.x picks up the current theme automatically without
// a re-render.
//
// For non-CSS contexts that need a literal hex (MapLibre paint props,
// some marker rendering paths), import colorsRaw -- it holds the dark
// palette and is theme-stable. App.jsx's themeColor() helper can also
// read the live computed value off documentElement when needed.

export const colors = {
  primary:     'var(--color-primary)',
  primaryDark: 'var(--color-primary-dark)',
  accent:      'var(--color-accent)',
  error:       'var(--color-error)',
  warn:        'var(--color-warn)',
  success:     'var(--color-success)',
  surface: {
    base:     'var(--color-surface-base)',
    card:     'var(--color-surface-card)',
    elevated: 'var(--color-surface-elevated)',
    input:    'var(--color-surface-input)',
  },
  text: {
    primary:    'var(--color-text-primary)',
    secondary:  'var(--color-text-secondary)',
    muted:      'var(--color-text-muted)',
    onPrimary:  'var(--color-text-on-primary)',
  },
  border: 'var(--color-border)',
  divider: 'var(--color-divider)',
}

// Raw palette. Dark values; what colors.* used to resolve to before the
// CSS-variable refactor. Use only when var() can't (MapLibre paint props,
// canvas, anything that needs a static literal). Tests also import this
// for pure-Node assertions.
export const colorsRaw = {
  primary:     '#9FE15A',
  primaryDark: '#5BAF3A',
  accent:      '#7ec4cf',
  error:       '#ef5350',
  warn:        '#ffb74d',
  success:     '#7ec77a',
  surface: {
    base:     '#0d0d0d',
    card:     '#1a1a1a',
    elevated: '#252525',
    input:    '#1c1c1c',
  },
  text: {
    primary:   '#f0f0f0',
    secondary: '#a0a0a0',
    muted:     '#666666',
    onPrimary: '#0a1f23',
  },
  border: '#4d4d4d',
  divider: '#2e2e2e',
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
