import { h } from 'preact'
import { useEffect, useState, useCallback } from 'preact/hooks'
import QRCode from 'qrcode'
import { api, openWs, formatBytes, formatUptime } from './api.js'

const RETENTION_OPTIONS = [
  { label: 'Forever', value: null },
  { label: '30 days', value: 30 * 86400_000 },
  { label: '7 days', value: 7 * 86400_000 },
  { label: '24 hours', value: 86400_000 },
]

export function App () {
  const [status, setStatus] = useState(null)
  const [circles, setCircles] = useState([])
  const [error, setError] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [version, setVersion] = useState(null)
  const [update, setUpdate] = useState(null)
  const [applyState, setApplyState] = useState(null)
  const [pairResult, setPairResult] = useState(null)

  useEffect(() => {
    const ws = openWs({
      onMessage: (msg) => {
        setWsConnected(true)
        if (msg.type === 'event' && msg.name === 'seeder:pair:result') {
          setPairResult(msg.data || { enrolled: 0, names: [] })
          return
        }
        if (msg.type === 'snapshot') {
          // A healthy snapshot means the worklet is up — clear any stale
          // error (e.g. the transient "worklet exited" from a Restart, which
          // would otherwise linger after it comes back).
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

  return (
    <div>
      <h1>PearCircle Seeder</h1>
      <div class="sub">
        <span class={'dot ' + (wsConnected ? 'good' : 'bad')} />
        {wsConnected ? 'connected to worklet' : 'connecting…'}
        {version && <span class="version"> · v{version}</span>}
      </div>

      {error && <div class="toast error">{error}</div>}

      {update && update.updateAvailable && (
        <UpdateBanner update={update} applyState={applyState} setApplyState={setApplyState} />
      )}

      <Status status={status} circles={circles} onChanged={() => api.circles().then((c) => setCircles(c.circles ?? []))} setError={setError} />
      <AddCircles pairResult={pairResult} clearPairResult={() => setPairResult(null)} onAdded={() => api.circles().then((c) => setCircles(c.circles ?? []))} setError={setError} />
      <Maintenance setError={setError} />
      <Support />
    </div>
  )
}

// Donation / support. Two no-account rails the dashboard renders entirely
// client-side (no tracking, no phone-home, no host network call): a Lightning
// address for sats and Buy Me a Coffee for USD/card. The QR is built from the
// constants below, so blanking either string drops that rail. The dashboard is
// often viewed on a laptop while paying from a phone, hence a QR for both.
const DONATE = {
  lnAddress: 'peerloomllc@strike.me',
  bmcUrl: 'https://buymeacoffee.com/peerloomllc?new=1',
}

// Copy that also works on the seeder's plain-http origin (Umbrel proxy): the
// async Clipboard API needs a secure context, so fall back to execCommand.
async function copyText (text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

function Support () {
  const [tab, setTab] = useState('ln') // 'ln' | 'bmc'
  const [qr, setQr] = useState(null)
  const [copied, setCopied] = useState(false)

  // Lightning Address QR = the bare address (what wallet scanners expect);
  // Buy Me a Coffee QR = the page URL.
  const qrPayload = tab === 'ln' ? DONATE.lnAddress : DONATE.bmcUrl
  const copyValue = tab === 'ln' ? DONATE.lnAddress : DONATE.bmcUrl

  useEffect(() => {
    let cancelled = false
    setQr(null)
    QRCode.toDataURL(qrPayload, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQr(url) })
      .catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [qrPayload])

  const onCopy = async () => {
    if (await copyText(copyValue)) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }

  return (
    <div class="panel">
      <h2>Support PearCircle</h2>
      <div class="empty" style={{ marginBottom: 14 }}>
        No accounts, no servers, no subscriptions. If running this seeder is useful, a tip helps keep PearCircle free — entirely optional.
      </div>
      <div class="row" style={{ gap: 10, justifyContent: 'center', marginBottom: 14 }}>
        <button class={tab === 'ln' ? '' : 'ghost'} style={{ flex: 1, maxWidth: 180 }} onClick={() => setTab('ln')}>⚡ BTC ⚡</button>
        <button class={tab === 'bmc' ? '' : 'ghost'} style={{ flex: 1, maxWidth: 180 }} onClick={() => setTab('bmc')}>💲 USD 💲</button>
      </div>
      <div style={{ textAlign: 'center' }}>
        {qr
          ? <img src={qr} alt={tab === 'ln' ? 'Lightning donation QR code' : 'Buy Me a Coffee QR code'}
                 style={{ width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 8 }} />
          : <div class="empty">generating…</div>}
        <div class="empty" style={{ marginTop: 10 }}>
          {tab === 'ln'
            ? 'Scan with any bitcoin lightning wallet to donate sats (pick your own amount), or copy the address.'
            : 'Scan to open Buy Me a Coffee on your phone, or open it here to donate by card.'}
        </div>
        <div style={{ marginTop: 12 }}>
          <div class="mono" style={{ color: 'var(--muted)', wordBreak: 'break-all' }}>{copyValue}</div>
          <div class="row" style={{ gap: 10, justifyContent: 'center', marginTop: 10 }}>
            <button class="ghost" onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
            {tab === 'bmc' && (
              <button onClick={() => window.open(DONATE.bmcUrl, '_blank', 'noopener,noreferrer')}>Open</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// QR pairing: show a QR a phone scans to push its circles to this seeder, no
// copy-paste (proposal 2026-06-22). The phone-side push + enroll completes over
// P2P; the worklet emits seeder:pair:result, which arrives as pairResult.
function PairPhone ({ pairResult, clearPairResult, onPaired, setError }) {
  const [link, setLink] = useState(null)
  const [qr, setQr] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const [busy, setBusy] = useState(false)

  const close = async () => {
    setLink(null); setQr(null); setRemaining(0)
    try { await api.pairClose() } catch {}
  }

  const open = async () => {
    setBusy(true); setError(null); clearPairResult()
    try {
      const r = await api.pairOpen()
      if (r?.error) { setError(r.error); return }
      setLink(r.link)
      setRemaining(Math.round((r.ttlMs || 300000) / 1000))
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  // Render the link as a QR data URL whenever it changes.
  useEffect(() => {
    if (!link) { setQr(null); return }
    let cancelled = false
    QRCode.toDataURL(link, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setQr(url) })
      .catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [link])

  // Countdown; auto-close when the TTL runs out (the worklet enforces the real one).
  useEffect(() => {
    if (!link) return
    if (remaining <= 0) { close(); return }
    const t = setTimeout(() => setRemaining(remaining - 1), 1000)
    return () => clearTimeout(t)
  }, [link, remaining])

  // A successful pairing arrived: stop showing the QR and refresh the circle list.
  useEffect(() => {
    if (!pairResult) return
    setLink(null); setQr(null); setRemaining(0)
    api.pairClose().catch(() => {})
    if (typeof onPaired === 'function') onPaired()
  }, [pairResult])

  return (
    <div>
      {pairResult ? (
        <div style={{ textAlign: 'center', color: 'var(--good)', padding: '8px 0' }}>
          Paired — now seeding {pairResult.enrolled} circle{pairResult.enrolled === 1 ? '' : 's'}
          {Array.isArray(pairResult.names) && pairResult.names.length > 0 ? ` (${pairResult.names.join(', ')})` : ''}.
          <div class="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button class="ghost" onClick={clearPairResult}>Done</button>
          </div>
        </div>
      ) : !link ? (
        <div>
          <div class="empty" style={{ textAlign: 'center', marginBottom: 12 }}>
            Link this seeder to a phone's circles by QR — no copy-paste. Tap below, then in the PearCircle app open Seeders → Scan seeder QR.
          </div>
          <div class="row" style={{ justifyContent: 'center' }}>
            <button onClick={open} disabled={busy}>{busy ? 'Starting…' : 'Pair a phone'}</button>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          {qr
            ? <img src={qr} alt="pairing QR code" style={{ width: 240, height: 240, background: '#fff', borderRadius: 8, padding: 8 }} />
            : <div class="empty">generating…</div>}
          <div class="empty" style={{ marginTop: 10 }}>Scan with the PearCircle app. Expires in {remaining}s.</div>
          <div class="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button class="ghost" onClick={close}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// On-demand maintenance controls. Retention sweeps already run at startup and
// every 24h; these apply a just-changed retention policy immediately (or claw
// back disk now) without waiting or restarting from a shell.
function Maintenance ({ setError }) {
  const [sweeping, setSweeping] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [msg, setMsg] = useState(null)

  const sweep = async () => {
    setMsg(null); setError(null); setSweeping(true)
    try {
      const r = await api.sweepNow()
      const w = r?.writer?.cleared ?? 0
      const b = r?.bootstrap?.cleared ?? 0
      const total = w + b
      const bytes = (r?.writer?.clearedBytes ?? 0) + (r?.bootstrap?.clearedBytes ?? 0)
      setMsg(total === 0
        ? 'Swept — nothing past the retention window to reclaim.'
        : `Swept — cleared ${total} block${total === 1 ? '' : 's'} (${w} writer-core, ${b} bootstrap), ~${formatBytes(bytes)} freed. Disk space is reclaimed on the next compaction.`)
    } catch (e) { setError(e.message) }
    finally { setSweeping(false) }
  }

  const restart = async () => {
    if (!confirm('Restart the seeder? It will briefly disconnect, re-sync, and run a retention sweep on boot.')) return
    setMsg(null); setError(null); setRestarting(true)
    try {
      await api.restart()
      setMsg('Seeder restarted.')
    } catch (e) { setError(e.message) }
    finally { setRestarting(false) }
  }

  return (
    <div class="panel">
      <h2>Maintenance</h2>
      <div class="empty" style={{ marginBottom: 12, textAlign: 'center' }}>
        Retention sweeps run automatically at startup and every 24h. Use these to apply a changed retention policy right away.
      </div>
      <div class="row" style={{ gap: 10, justifyContent: 'center' }}>
        <button onClick={sweep} disabled={sweeping || restarting}>{sweeping ? 'Sweeping…' : 'Run sweep now'}</button>
        <button class="ghost" onClick={restart} disabled={sweeping || restarting}>{restarting ? 'Restarting…' : 'Restart seeder'}</button>
      </div>
      {msg && <div style={{ marginTop: 10, color: 'var(--good)', fontSize: 13, textAlign: 'center' }}>{msg}</div>}
    </div>
  )
}

// Update-available banner with the one-click "Update now" action (proposal
// 2026-06-05-seeder-update slices 2+3a). Self-apply platforms restart the
// service; platforms that need the privileged helper (macOS .pkg / Linux .deb,
// slice 3b) or that can't self-apply fall back to a verified download link.
function UpdateBanner ({ update, applyState, setApplyState }) {
  const [busy, setBusy] = useState(false)
  const onUpdate = async () => {
    setBusy(true)
    try { setApplyState(await api.applyUpdate()) }
    catch (e) { setApplyState({ status: 'error', error: String(e?.message ?? e) }) }
    finally { setBusy(false) }
  }
  const st = applyState?.status
  const downloadHref = update.assetUrl || update.releaseUrl
  return (
    <div class="toast update" style={{ textAlign: 'center' }}>
      <div>Update available: v{update.latestVersion}</div>
      {st === 'restarting' && <div>Updating — the seeder will restart on v{update.latestVersion}.</div>}
      {st === 'applying-via-helper' && <div>Installing v{update.latestVersion} — the seeder will restart shortly.</div>}
      {(st === 'needs-helper') && (
        <div>This build installs with a system installer.{' '}
          <a href={downloadHref} target="_blank" rel="noreferrer">Download v{update.latestVersion}</a></div>
      )}
      {st === 'error' && (
        <div>Update failed ({applyState.error}).{' '}
          <a href={downloadHref} target="_blank" rel="noreferrer">Download instead</a></div>
      )}
      {(st !== 'restarting' && st !== 'applying-via-helper') && (
        <div style={{ marginTop: 8 }}>
          <button onClick={onUpdate} disabled={busy || st === 'running'}>
            {busy || st === 'running' ? 'Updating…' : 'Update now'}
          </button>
        </div>
      )}
    </div>
  )
}

// Status + the enrolled-circles list folded into one Overview panel: the
// seeder's identity/uptime/bytes and what it's actually seeding belong
// together. Per-circle retention/leave controls live on each Circle row.
function Status ({ status, circles, onChanged, setError }) {
  return (
    <div class="panel">
      <h2>Status</h2>
      {!status && <div class="empty">awaiting first snapshot…</div>}
      {status && (
        <div>
          <div class="row"><div class="label">Pubkey</div><div class="mono pubkey">{status.pubkey}</div></div>
          <div class="row"><div class="label">Uptime</div><div>{formatUptime(status.uptime)}</div></div>
          <div class="row"><div class="label">Replicated</div><div>{formatBytes(status.totalBytesReplicated || 0)}</div></div>
        </div>
      )}
      <div class="section-head">Seeding {circles.length} circle{circles.length === 1 ? '' : 's'}</div>
      {circles.length === 0 && <div class="empty">no circles yet — paste a seed invite below to start</div>}
      {circles.map((c) => (
        <Circle key={c.circleId} circle={c} onChanged={onChanged} setError={setError} />
      ))}
    </div>
  )
}

function Enroll ({ onEnrolled, setError }) {
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const submit = useCallback(async (e) => {
    e.preventDefault()
    setMsg(null); setError(null); setBusy(true)
    try {
      // The paste may be a bundle (one /circle/seed URL per line, minted
      // by the mobile "Set up a seeder device" action) or a single
      // invite. The host splits + enrolls each, returning per-circle
      // results.
      const res = await api.enroll(invite.trim())
      const enrolled = res.enrolled ?? 0
      const failed = res.failed ?? 0
      const already = (res.results ?? []).filter((r) => r.ok && r.alreadyEnrolled).length
      const parts = [`enrolled in ${enrolled} circle${enrolled === 1 ? '' : 's'}`]
      if (already > 0) parts.push(`${already} already enrolled`)
      if (failed > 0) parts.push(`${failed} failed`)
      setMsg(parts.join(', '))
      setInvite('')
      onEnrolled()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [invite])

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <textarea
        placeholder="Paste a seed invite, or a bundle (one per line) from a PearCircle member's Settings → Seeders"
        value={invite}
        onInput={(e) => setInvite(e.currentTarget.value)}
      />
      <div class="row" style={{ marginTop: 12, justifyContent: 'center' }}>
        <button type="submit" disabled={busy || !invite.trim()}>{busy ? 'enrolling…' : 'Enroll'}</button>
      </div>
      {msg && (
        <div style={{ marginTop: 10, textAlign: 'center', color: 'var(--good)', fontSize: 13 }}>
          {msg}
        </div>
      )}
    </form>
  )
}

// "Add circles" combines the two ways to link circles to this seeder: QR
// pairing (primary) and pasting an invite (tucked behind an expander). Both are
// the same function - adding circles - so they live in one section.
function AddCircles ({ pairResult, clearPairResult, onAdded, setError }) {
  const [pasteOpen, setPasteOpen] = useState(false)
  return (
    <div class="panel">
      <h2>Add circles</h2>
      <PairPhone pairResult={pairResult} clearPairResult={clearPairResult} onPaired={onAdded} setError={setError} />
      <button
        onClick={() => setPasteOpen((v) => !v)}
        style={{
          width: '100%', marginTop: 14, padding: '4px 0', background: 'transparent',
          border: 0, color: 'var(--muted)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
        }}>
        {pasteOpen ? '▾ Or paste an invite instead' : '▸ Or paste an invite instead'}
      </button>
      {pasteOpen && <Enroll onEnrolled={onAdded} setError={setError} />}
    </div>
  )
}

function Circle ({ circle, onChanged, setError }) {
  const [retention, setRetention] = useState(undefined)

  useEffect(() => {
    api.retentionGet(circle.circleId)
      .then((r) => setRetention(r.pruneOlderThan ?? null))
      .catch((e) => setError(e.message))
  }, [circle.circleId])

  const setRet = async (value) => {
    setError(null)
    try {
      await api.retentionSet(circle.circleId, value)
      setRetention(value)
    } catch (e) { setError(e.message) }
  }

  const leave = async () => {
    if (!confirm(`Leave circle ${circle.name || circle.circleId.slice(0, 8)}? The seeder will stop replicating its blocks.`)) return
    setError(null)
    try {
      await api.leave(circle.circleId)
      onChanged()
    } catch (e) { setError(e.message) }
  }

  return (
    <div class={'circle' + (circle.revoked ? ' revoked' : '')}>
      <div class="circle-name">
        {circle.name || '(unnamed)'}
        {circle.revoked && <span class="badge revoked">revoked</span>}
      </div>
      <div class="circle-meta mono">{circle.circleId}</div>
      {circle.revoked && (
        <div class="circle-note">
          A member of this circle revoked this seeder; it can no longer sync the circle. Use Leave to remove it.
        </div>
      )}
      <div class="circle-controls">
        <label class="label" style={{ minWidth: 0 }}>retain</label>
        <select
          value={retention === undefined ? '' : (retention === null ? 'null' : String(retention))}
          onChange={(e) => {
            const v = e.currentTarget.value
            setRet(v === 'null' ? null : Number(v))
          }}
          disabled={retention === undefined}
        >
          {RETENTION_OPTIONS.map((o) => (
            <option key={String(o.value)} value={o.value === null ? 'null' : String(o.value)}>{o.label}</option>
          ))}
        </select>
        <button class="ghost danger" onClick={leave}>Leave</button>
      </div>
    </div>
  )
}
