import { h } from 'preact'
import { useEffect, useState, useCallback, useRef } from 'preact/hooks'
import QRCode from 'qrcode'
import { api, openWs, formatBytes, formatUptime } from './api.js'

const RETENTION_OPTIONS = [
  { label: 'Keep forever', value: null },
  { label: 'Keep 30 days', value: 30 * 86400_000 },
  { label: 'Keep 7 days', value: 7 * 86400_000 },
  { label: 'Keep 24 hours', value: 86400_000 },
]

const DONATE = {
  lnAddress: 'peerloomllc@strike.me',
  bmcUrl: 'https://buymeacoffee.com/peerloomllc?new=1',
}

// Brand mark = the real app icon, reused from the favicon already inlined in
// index.html (no duplicated data URI, no external asset).
const BRAND_ICON = typeof document !== 'undefined' ? (document.querySelector('link[rel="icon"]')?.href || '') : ''

/* ---- inline icons (no icon font / external asset) ------------------------- */
const Icon = ({ d, ...p }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" {...p}><path d={d} /></svg>
)
const Sun = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
const Moon = () => <Icon d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
const Gear = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.3a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.3 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 2.7h.1A1.7 1.7 0 0 0 8.3 1V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 2.3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
const Close = () => <Icon d="M18 6 6 18M6 6l12 12" />
const Copy = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
const Plus = () => <Icon d="M12 5v14M5 12h14" />
const Wrench = () => <Icon d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.8 2.8-2.1-.7-.7-2.1z" />
const Heart = () => <Icon d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z" />

/* ---- clipboard (works on the seeder's plain-http origin) ------------------ */
async function copyText (text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select()
    const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok
  } catch { return false }
}

/* ---- themed confirm dialog (replaces window.confirm) ---------------------- */
let _pushConfirm = null
function askConfirm (opts) {
  return new Promise((resolve) => {
    if (!_pushConfirm) { resolve(window.confirm(opts.message || opts.title)); return }
    _pushConfirm({ ...opts, resolve })
  })
}
function ConfirmHost () {
  const [c, setC] = useState(null)
  useEffect(() => { _pushConfirm = setC; return () => { _pushConfirm = null } }, [])
  useEffect(() => {
    if (!c) return
    const h = (e) => { if (e.key === 'Escape') { c.resolve(false); setC(null) } }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [c])
  if (!c) return null
  const close = (v) => { c.resolve(v); setC(null) }
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false) }}>
      <div class="modal confirm" role="alertdialog" aria-modal="true" aria-label={c.title}>
        <h3>{c.title}</h3>
        {c.message && <p class="hint">{c.message}</p>}
        <div class="confirm-actions">
          <button class="ghost" onClick={() => close(false)}>{c.cancelLabel || 'Cancel'}</button>
          <button class={c.danger ? 'destructive' : ''} onClick={() => close(true)} autofocus>{c.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  )
}

/* ---- theme (system default, manual override persisted) -------------------- */
function useTheme () {
  const initial = () => {
    const saved = localStorage.getItem('seeder-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  const [theme, setTheme] = useState(initial)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const toggle = () => setTheme((t) => {
    const next = t === 'dark' ? 'light' : 'dark'
    localStorage.setItem('seeder-theme', next); return next
  })
  return [theme, toggle]
}

export function App () {
  const [status, setStatus] = useState(null)
  const [circles, setCircles] = useState([])
  const [error, setError] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [version, setVersion] = useState(null)
  const [update, setUpdate] = useState(null)
  const [applyState, setApplyState] = useState(null)
  const [pairResult, setPairResult] = useState(null)
  const [modal, setModal] = useState(null) // 'add' | 'maintenance' | 'support' | null
  const [theme, toggleTheme] = useTheme()

  useEffect(() => {
    const ws = openWs({
      onMessage: (msg) => {
        setWsConnected(true)
        if (msg.type === 'event' && msg.name === 'seeder:pair:result') {
          setPairResult(msg.data || { enrolled: 0, names: [] }); return
        }
        if (msg.type === 'snapshot') {
          if (msg.status && !msg.status.error) { setStatus(msg.status); setError(null) }
          if (msg.circles && !msg.circles.error) setCircles(msg.circles.circles ?? [])
          if (msg.launcherVersion) setVersion(msg.launcherVersion)
          if (msg.update) setUpdate(msg.update)
          if (msg.applyState) setApplyState(msg.applyState)
        } else if (msg.type === 'snapshot:error' || msg.type === 'exit') {
          setError(msg.error || `worklet exited (code=${msg.code})`)
        }
      },
      onClose: () => setWsConnected(false),
    })
    return () => ws.close()
  }, [])

  const refresh = () => api.circles().then((c) => setCircles(c.circles ?? [])).catch(() => {})
  const liveCount = circles.filter((c) => !c.revoked).length

  return (
    <div class="app">
      <TopBar
        status={status} wsConnected={wsConnected} version={version} theme={theme}
        onToggleTheme={toggleTheme} onOpen={setModal} setError={setError}
      />

      {update && update.updateAvailable && (
        <UpdateBar update={update} applyState={applyState} setApplyState={setApplyState} />
      )}
      {error && <div class="toast error" style={{ flex: '0 0 auto' }}>{error}</div>}

      <div class="main">
        <div class="stats">
          <div class="stat hero">
            <div class="num">{status ? liveCount : '—'}</div>
            <div class="lbl">{liveCount === 1 ? 'circle kept alive' : 'circles kept alive'}</div>
          </div>
          <div class="stat">
            <div class="num small">{status ? formatUptime(status.uptime) : '—'}</div>
            <div class="lbl">uptime</div>
          </div>
          <div class="stat">
            <div class="num small">{status ? formatBytes(status.totalBytesReplicated || 0) : '—'}</div>
            <div class="lbl">replicated</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2>Circles</h2>
            <span class="count">{circles.length ? `· ${circles.length}` : ''}</span>
          </div>
          <div class="list">
            {!status && <div class="empty">Connecting to the seeder…</div>}
            {status && circles.length === 0 && (
              <div class="empty">
                <strong>No circles yet.</strong><br />
                Add one below — pair a phone or paste a seed invite from a member's Settings → Seeders.
              </div>
            )}
            {circles.map((c) => (
              <CircleRow key={c.circleId} circle={c} wsConnected={wsConnected} onChanged={refresh} setError={setError} />
            ))}
          </div>
        </div>
      </div>

      <div class="actionbar">
        <Identity status={status} />
        <div class="spacer" />
        <button onClick={() => setModal('add')}><Plus />Add circles</button>
      </div>

      {modal === 'add' && (
        <Modal title="Add circles" onClose={() => setModal(null)}>
          <AddCircles pairResult={pairResult} clearPairResult={() => setPairResult(null)} onAdded={refresh} setError={setError} />
        </Modal>
      )}
      {modal === 'maintenance' && (
        <Modal title="Maintenance" onClose={() => setModal(null)}>
          <Maintenance setError={setError} />
        </Modal>
      )}
      {modal === 'support' && (
        <Modal title="Support Development" onClose={() => setModal(null)}>
          <Support />
        </Modal>
      )}
      <ConfirmHost />
    </div>
  )
}

/* ---- top bar -------------------------------------------------------------- */
function TopBar ({ status, wsConnected, version, theme, onToggleTheme, onOpen, setError }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return
    const h = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menuOpen])

  return (
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src={BRAND_ICON} alt="" aria-hidden="true" />
        <div>
          <div class="brand-name">PearCircle Seeder</div>
          <div class="brand-sub">keeping your circles alive</div>
        </div>
      </div>

      <Nickname status={status} setError={setError} />

      <div class="topbar-right">
        <span class="pill" title={wsConnected ? 'Connected to the worklet' : 'Reconnecting'}>
          <span class={'dot ' + (wsConnected ? 'good' : 'bad')} />
          {wsConnected ? 'live' : 'offline'}
          {version && <span class="v">· v{version}</span>}
        </span>
        <button class="iconbtn" onClick={onToggleTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
        <div class="menuwrap" ref={menuRef}>
          <button class="iconbtn" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu" aria-expanded={menuOpen}><Gear /></button>
          {menuOpen && (
            <div class="menu" role="menu">
              <button onClick={() => { setMenuOpen(false); onOpen('maintenance') }}><Wrench /> Maintenance</button>
              <button onClick={() => { setMenuOpen(false); onOpen('support') }}><Heart /> Support Development</button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

// Operator nickname (proposal 2026-07-15-seeder-nickname), inline in the bar.
function Nickname ({ status, setError }) {
  const current = status?.nickname ?? ''
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (!touched) setValue(current) }, [current, touched])
  const dirty = value.trim() !== current
  const save = async () => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await api.nicknameSet(value.trim())
      setTouched(false); setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  return (
    <div class={'nick' + (dirty ? ' dirty' : '')}>
      <input
        value={value} maxLength={48}
        placeholder="Name this seeder…"
        title="Shown in members' apps instead of the hex key"
        onInput={(e) => { setTouched(true); setValue(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && dirty) save() }}
      />
      <button class={'save small' + (saved ? ' show' : '')} onClick={save} disabled={saving || (!dirty && !saved)}>
        {saving ? '…' : (saved ? 'Saved' : 'Save')}
      </button>
    </div>
  )
}

/* ---- identity (action bar left) ------------------------------------------- */
function Identity ({ status }) {
  const [copied, setCopied] = useState(false)
  if (!status?.pubkey) return <div class="identity" />
  const pk = status.pubkey
  const short = pk.slice(0, 8) + '…' + pk.slice(-6)
  const copy = async () => { if (await copyText(pk)) { setCopied(true); setTimeout(() => setCopied(false), 1200) } }
  return (
    <div class="identity" title={pk}>
      <span class="mono">{short}</span>
      <button class="iconbtn" style={{ width: 28, height: 28 }} onClick={copy} aria-label="Copy seeder key">
        {copied ? <span style={{ color: 'var(--good)', fontSize: 12 }}>✓</span> : <Copy />}
      </button>
    </div>
  )
}

/* ---- circle row ----------------------------------------------------------- */
function CircleRow ({ circle, wsConnected, onChanged, setError }) {
  const [retention, setRetention] = useState(undefined)
  useEffect(() => {
    api.retentionGet(circle.circleId)
      .then((r) => setRetention(r.pruneOlderThan ?? null))
      .catch((e) => setError(e.message))
  }, [circle.circleId])
  const setRet = async (value) => {
    setError(null)
    try { await api.retentionSet(circle.circleId, value); setRetention(value) }
    catch (e) { setError(e.message) }
  }
  const leave = async () => {
    const ok = await askConfirm({
      title: `Leave ${circle.name || circle.circleId.slice(0, 8)}?`,
      message: 'This seeder stops replicating the circle’s blocks. Members re-admit it if you add it again.',
      confirmLabel: 'Leave', danger: true,
    })
    if (!ok) return
    setError(null)
    try { await api.leave(circle.circleId); onChanged() } catch (e) { setError(e.message) }
  }
  const revoked = circle.revoked
  return (
    <div class="circle">
      <span class={'live' + (revoked ? ' warn' : (wsConnected ? '' : ' off'))} aria-hidden="true" />
      <div class="circle-main">
        <div class="circle-name">
          {circle.name || '(unnamed circle)'}
          <span class="id">{circle.circleId.slice(0, 10)}…</span>
          {revoked && <span class="badge revoked">revoked</span>}
        </div>
        <div class={'circle-state' + (revoked ? ' rev' : '')}>
          {revoked ? 'A member removed this seeder — leave to clear it' : (wsConnected ? 'Seeding' : 'Waiting for connection')}
        </div>
      </div>
      <div class="circle-controls">
        {!revoked && (
          <select
            value={retention === undefined ? '' : (retention === null ? 'null' : String(retention))}
            onChange={(e) => { const v = e.currentTarget.value; setRet(v === 'null' ? null : Number(v)) }}
            disabled={retention === undefined}
            title="How long this seeder keeps the circle's blocks"
          >
            {RETENTION_OPTIONS.map((o) => (
              <option key={String(o.value)} value={o.value === null ? 'null' : String(o.value)}>{o.label}</option>
            ))}
          </select>
        )}
        <button class="ghost small danger" onClick={leave}>Leave</button>
      </div>
    </div>
  )
}

/* ---- modal wrapper -------------------------------------------------------- */
function Modal ({ title, onClose, children }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head">
          <h3>{title}</h3>
          <button class="iconbtn" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ---- add circles (pair / paste) ------------------------------------------- */
function AddCircles ({ pairResult, clearPairResult, onAdded, setError }) {
  const [tab, setTab] = useState('pair')
  return (
    <div>
      <div class="tabs">
        <button class={tab === 'pair' ? '' : 'ghost'} onClick={() => setTab('pair')}>Pair a phone</button>
        <button class={tab === 'paste' ? '' : 'ghost'} onClick={() => setTab('paste')}>Paste invite</button>
      </div>
      {tab === 'pair'
        ? <PairPhone pairResult={pairResult} clearPairResult={clearPairResult} onPaired={onAdded} setError={setError} />
        : <Enroll onEnrolled={onAdded} setError={setError} />}
    </div>
  )
}

function PairPhone ({ pairResult, clearPairResult, onPaired, setError }) {
  const [link, setLink] = useState(null)
  const [qr, setQr] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const [busy, setBusy] = useState(false)

  const close = async () => { setLink(null); setQr(null); setRemaining(0); try { await api.pairClose() } catch {} }
  const open = async () => {
    setBusy(true); setError(null); clearPairResult()
    try {
      const r = await api.pairOpen()
      if (r?.error) { setError(r.error); return }
      setLink(r.link); setRemaining(Math.round((r.ttlMs || 300000) / 1000))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!link) { setQr(null); return }
    let cancelled = false
    QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQr(url) }).catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [link])
  useEffect(() => {
    if (!link) return
    if (remaining <= 0) { close(); return }
    const t = setTimeout(() => setRemaining(remaining - 1), 1000)
    return () => clearTimeout(t)
  }, [link, remaining])
  useEffect(() => {
    if (!pairResult) return
    setLink(null); setQr(null); setRemaining(0)
    api.pairClose().catch(() => {})
    if (typeof onPaired === 'function') onPaired()
  }, [pairResult])

  if (pairResult) {
    return (
      <div class="stack center">
        <div class="msg-good center">
          Paired — now seeding {pairResult.enrolled} circle{pairResult.enrolled === 1 ? '' : 's'}
          {Array.isArray(pairResult.names) && pairResult.names.length ? ` (${pairResult.names.join(', ')})` : ''}.
        </div>
        <button class="ghost" onClick={clearPairResult}>Done</button>
      </div>
    )
  }
  if (!link) {
    return (
      <div class="stack center">
        <p class="hint center">Show a QR to link this seeder to a phone's circles — no copy-paste. In the PearCircle app: <strong>Seeders → Scan seeder QR</strong>.</p>
        <button onClick={open} disabled={busy}>{busy ? 'Starting…' : 'Show pairing QR'}</button>
      </div>
    )
  }
  return (
    <div class="stack center">
      {qr ? <img class="qr" src={qr} alt="pairing QR code" /> : <div class="empty">generating…</div>}
      <div class="hint center">Scan with the PearCircle app. Expires in {remaining}s.</div>
      <div class="hint center" style={{ opacity: 0.85 }}>Won't connect? Turn off the phone's WiFi so it pairs over cellular — a seeder on a home server often can't be found over the same WiFi.</div>
      <button class="ghost" onClick={close}>Cancel</button>
    </div>
  )
}

function Enroll ({ onEnrolled, setError }) {
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const submit = useCallback(async (e) => {
    e.preventDefault(); setMsg(null); setError(null); setBusy(true)
    try {
      const res = await api.enroll(invite.trim())
      const enrolled = res.enrolled ?? 0
      const failed = res.failed ?? 0
      const already = (res.results ?? []).filter((r) => r.ok && r.alreadyEnrolled).length
      const parts = [`enrolled in ${enrolled} circle${enrolled === 1 ? '' : 's'}`]
      if (already > 0) parts.push(`${already} already enrolled`)
      if (failed > 0) parts.push(`${failed} failed`)
      setMsg(parts.join(', ')); setInvite(''); onEnrolled()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }, [invite])
  return (
    <form onSubmit={submit} class="stack">
      <p class="hint">Paste a seed invite, or a bundle (one per line) from a member's <strong>Settings → Seeders</strong>.</p>
      <textarea placeholder="pear://pearcircle/circle/seed?…" value={invite} onInput={(e) => setInvite(e.currentTarget.value)} />
      <button type="submit" class="block" disabled={busy || !invite.trim()}>{busy ? 'Enrolling…' : 'Enroll'}</button>
      {msg && <div class="msg-good center">{msg}</div>}
    </form>
  )
}

/* ---- maintenance ---------------------------------------------------------- */
function Maintenance ({ setError }) {
  const [sweeping, setSweeping] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [msg, setMsg] = useState(null)
  const sweep = async () => {
    setMsg(null); setError(null); setSweeping(true)
    try {
      const r = await api.sweepNow()
      const w = r?.writer?.cleared ?? 0, b = r?.bootstrap?.cleared ?? 0, total = w + b
      const bytes = (r?.writer?.clearedBytes ?? 0) + (r?.bootstrap?.clearedBytes ?? 0)
      setMsg(total === 0
        ? 'Swept — nothing past the retention window to reclaim.'
        : `Swept — cleared ${total} block${total === 1 ? '' : 's'}, ~${formatBytes(bytes)} freed. Disk is reclaimed on the next compaction.`)
    } catch (e) { setError(e.message) } finally { setSweeping(false) }
  }
  const restart = async () => {
    const ok = await askConfirm({
      title: 'Restart the seeder?',
      message: 'It briefly disconnects, re-syncs, and runs a retention sweep on boot.',
      confirmLabel: 'Restart',
    })
    if (!ok) return
    setMsg(null); setError(null); setRestarting(true)
    try { await api.restart(); setMsg('Seeder restarted.') } catch (e) { setError(e.message) } finally { setRestarting(false) }
  }
  return (
    <div class="stack">
      <p class="hint">Retention sweeps run automatically at startup and every 24h. Use these to apply a just-changed retention policy right away, or reclaim disk now.</p>
      <button class="block" onClick={sweep} disabled={sweeping || restarting}>{sweeping ? 'Sweeping…' : 'Run sweep now'}</button>
      <button class="ghost block" onClick={restart} disabled={sweeping || restarting}>{restarting ? 'Restarting…' : 'Restart seeder'}</button>
      {msg && <div class="msg-good center">{msg}</div>}
    </div>
  )
}

/* ---- support -------------------------------------------------------------- */
function Support () {
  const [tab, setTab] = useState('ln')
  const [qr, setQr] = useState(null)
  const [copied, setCopied] = useState(false)
  const value = tab === 'ln' ? DONATE.lnAddress : DONATE.bmcUrl
  useEffect(() => {
    let cancelled = false; setQr(null)
    QRCode.toDataURL(value, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQr(url) }).catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [value])
  const onCopy = async () => { if (await copyText(value)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }
  return (
    <div class="stack center">
      <p class="hint center">No accounts, no servers, no subscriptions. If running this seeder is useful, a tip helps keep PearCircle free — entirely optional.</p>
      <div class="tabs" style={{ width: '100%' }}>
        <button class={tab === 'ln' ? '' : 'ghost'} onClick={() => setTab('ln')}>⚡ Bitcoin</button>
        <button class={tab === 'bmc' ? '' : 'ghost'} onClick={() => setTab('bmc')}>💲 Card / USD</button>
      </div>
      {qr ? <img class="qr" src={qr} alt="donation QR code" /> : <div class="empty">generating…</div>}
      <div class="hint center">
        {tab === 'ln' ? 'Scan with any Lightning wallet (pick your own amount), or copy the address.' : 'Scan to open Buy Me a Coffee, or open it here to pay by card.'}
      </div>
      <div class="mono center" style={{ color: 'var(--muted)', fontSize: 12, wordBreak: 'break-all' }}>{value}</div>
      <div class="row" style={{ display: 'flex', gap: 10 }}>
        <button class="ghost" onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
        {tab === 'bmc' && <button onClick={() => window.open(DONATE.bmcUrl, '_blank', 'noopener,noreferrer')}>Open</button>}
      </div>
    </div>
  )
}

/* ---- update bar ----------------------------------------------------------- */
function UpdateBar ({ update, applyState, setApplyState }) {
  const [busy, setBusy] = useState(false)
  const onUpdate = async () => {
    setBusy(true)
    try { setApplyState(await api.applyUpdate()) }
    catch (e) { setApplyState({ status: 'error', error: String(e?.message ?? e) }) }
    finally { setBusy(false) }
  }
  const st = applyState?.status
  const href = update.assetUrl || update.releaseUrl
  return (
    <div class="updatebar">
      <div class="grow">
        <strong>Update available: v{update.latestVersion}</strong>
        {st === 'restarting' && <span> — restarting on v{update.latestVersion}.</span>}
        {st === 'applying-via-helper' && <span> — installing, will restart shortly.</span>}
        {st === 'needs-helper' && <span> — installs with a system installer. <a href={href} target="_blank" rel="noreferrer">Download</a></span>}
        {st === 'error' && <span> — update failed. <a href={href} target="_blank" rel="noreferrer">Download instead</a></span>}
      </div>
      {(st !== 'restarting' && st !== 'applying-via-helper') && (
        <button class="small" onClick={onUpdate} disabled={busy || st === 'running'}>{busy || st === 'running' ? 'Updating…' : 'Update now'}</button>
      )}
    </div>
  )
}
