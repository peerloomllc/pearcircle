// Browser-side API client. The token rides in the URL as ?t=<hex>; we
// stash it in sessionStorage on first load so refreshes still work, and
// attach it as a Bearer header to every API call + WS upgrade.

function readToken () {
  const u = new URL(window.location.href)
  const fromUrl = u.searchParams.get('t')
  if (fromUrl) {
    sessionStorage.setItem('pcs:token', fromUrl)
    return fromUrl
  }
  return sessionStorage.getItem('pcs:token') || ''
}

const TOKEN = readToken()

async function jsonFetch (url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'authorization': `Bearer ${TOKEN}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) {
    let detail = res.statusText
    try { const j = await res.json(); detail = j.error || detail } catch {}
    throw new Error(`${res.status}: ${detail}`)
  }
  return res.json()
}

export const api = {
  status: () => jsonFetch('/api/status'),
  circles: () => jsonFetch('/api/circles'),
  enroll: (invite) => jsonFetch('/api/enroll', { method: 'POST', body: JSON.stringify({ invite }) }),
  leave: (circleId) => jsonFetch('/api/leave', { method: 'POST', body: JSON.stringify({ circleId }) }),
  retentionGet: (circleId) => jsonFetch(`/api/retention/${encodeURIComponent(circleId)}`),
  retentionSet: (circleId, pruneOlderThan) => jsonFetch(`/api/retention/${encodeURIComponent(circleId)}`, {
    method: 'PUT', body: JSON.stringify({ pruneOlderThan }),
  }),
}

export function openWs ({ onMessage, onClose }) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${scheme}://${location.host}/ws?t=${TOKEN}`)
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data)) } catch {}
  }
  if (onClose) ws.onclose = onClose
  return ws
}

export function formatBytes (n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 ? 2 : 0)} ${units[i]}`
}

export function formatUptime (ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}
