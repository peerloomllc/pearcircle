import { h } from 'preact'
import { useEffect, useState, useCallback } from 'preact/hooks'
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

  useEffect(() => {
    const ws = openWs({
      onMessage: (msg) => {
        setWsConnected(true)
        if (msg.type === 'snapshot') {
          if (msg.status && !msg.status.error) setStatus(msg.status)
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
        <UpdateBanner update={update} version={version} applyState={applyState} setApplyState={setApplyState} />
      )}

      <Status status={status} />
      <Enroll onEnrolled={() => api.circles().then((c) => setCircles(c.circles ?? []))} setError={setError} />
      <Circles circles={circles} onChanged={() => api.circles().then((c) => setCircles(c.circles ?? []))} setError={setError} />
    </div>
  )
}

// Update-available banner with the one-click "Update now" action (proposal
// 2026-06-05-seeder-update slices 2+3a). Self-apply platforms restart the
// service; platforms that need the privileged helper (macOS .pkg / Linux .deb,
// slice 3b) or that can't self-apply fall back to a verified download link.
function UpdateBanner ({ update, version, applyState, setApplyState }) {
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
    <div class="toast update">
      Update available: v{update.latestVersion} (you have v{version || update.currentVersion}).{' '}
      {st === 'restarting' && <span>Updating — the seeder will restart on v{update.latestVersion}.</span>}
      {(st === 'needs-helper') && (
        <span>This build installs with a system installer.{' '}
          <a href={downloadHref} target="_blank" rel="noreferrer">Download v{update.latestVersion}</a></span>
      )}
      {st === 'error' && (
        <span>Update failed ({applyState.error}).{' '}
          <a href={downloadHref} target="_blank" rel="noreferrer">Download instead</a></span>
      )}
      {(st !== 'restarting') && (
        <button onClick={onUpdate} disabled={busy || st === 'running'} style={{ marginLeft: 8 }}>
          {busy || st === 'running' ? 'Updating…' : 'Update now'}
        </button>
      )}
    </div>
  )
}

function Status ({ status }) {
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
    <div class="panel">
      <h2>Enroll circles</h2>
      <form onSubmit={submit}>
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
    </div>
  )
}

function Circles ({ circles, onChanged, setError }) {
  return (
    <div class="panel">
      <h2>Enrolled circles ({circles.length})</h2>
      {circles.length === 0 && <div class="empty">no circles yet — paste a seed invite above to start</div>}
      {circles.map((c) => (
        <Circle key={c.circleId} circle={c} onChanged={onChanged} setError={setError} />
      ))}
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
