// Account backup UI (proposal 2026-10-06-owner-continuity, part 3): back up
// now, automatic backup (Android), restore on a fresh install, and the
// reminder when the last backup is old.
import { useCallback, useEffect, useState } from 'react'
import { colors, typography, spacing, radius } from '../theme.js'

// main.jsx assigns window.pear after this module is imported, so resolve
// through window at call time. Mirrors App.jsx's proxy.
const pear = {
  call: (...args) => window.pear.call(...args),
}

export const BACKUP_REMINDER_MS = 14 * 24 * 60 * 60 * 1000
const MIN_PASSWORD = 8

// IPC results carry worklet errors as { ok: false, error }; turn that into a
// throw so callers have one error path.
async function call (method, args) {
  const r = await pear.call(method, args)
  if (r && r.ok === false && r.error) throw new Error(r.error)
  return r
}

function formatWhen (ts) {
  if (!ts) return 'never'
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Newest backup of either kind, for the reminder.
export function lastBackupAt (status) {
  return Math.max(status?.lastAt || 0, status?.manualAt || 0) || null
}

// Backup status from the shell plus how many circles this install has
// (the reminder only matters with circles; restore only works with none).
export function useBackupStatus (active = true) {
  const [status, setStatus] = useState(null)
  const refresh = useCallback(async () => {
    try {
      const [st, list] = await Promise.all([pear.call('shell:backup:status'), pear.call('circles:list')])
      setStatus({ ...st, circleCount: Array.isArray(list?.circles) ? list.circles.length : 0 })
    } catch {}
  }, [])
  useEffect(() => { if (active) refresh() }, [active, refresh])
  return [status, refresh]
}

// Password + confirm. Calls onSubmit(password) once both match.
function PasswordForm ({ intro, submitLabel, busy, error, onSubmit, onCancel }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [localError, setLocalError] = useState(null)
  const submit = () => {
    if (pw.length < MIN_PASSWORD) { setLocalError('Use at least ' + MIN_PASSWORD + ' characters.'); return }
    if (pw !== pw2) { setLocalError('The passwords do not match.'); return }
    setLocalError(null)
    onSubmit(pw)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm, marginTop: spacing.sm }}>
      <p style={muted}>{intro}</p>
      <input style={input} type='password' autoComplete='new-password' placeholder='Backup password' value={pw} onChange={(e) => setPw(e.target.value)} />
      <input style={input} type='password' autoComplete='new-password' placeholder='Type it again' value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {(localError || error) && <p style={errorText}>{localError || error}</p>}
      <div style={{ display: 'flex', gap: spacing.sm }}>
        <button style={secondaryBtn} disabled={busy} onClick={onCancel}>Cancel</button>
        <button style={primaryBtn} disabled={busy} onClick={submit}>{busy ? 'Working...' : submitLabel}</button>
      </div>
    </div>
  )
}

// Pick a backup file, enter its password, restore, restart. Used in Settings
// and on the welcome screen.
export function RestoreBackupFlow ({ onCancel }) {
  const [contents, setContents] = useState(null)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const pick = async () => {
    setError(null)
    try {
      const r = await call('shell:importFile')
      if (r?.canceled) return
      if (typeof r?.contents !== 'string') throw new Error('could not read the file')
      setContents(r.contents)
    } catch (e) { setError(e.message) }
  }

  const restore = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('account:restore', { contents, password: pw })
      // The restored account already has a name, so skip onboarding after
      // the reload.
      await pear.call('shell:onboarding:set', { complete: true, tourPending: false }).catch(() => {})
      // The worklet closed its store; the shell restarts it as the restored
      // account and reloads this page.
      await pear.call('shell:worklet:restart')
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <p style={muted}>
        Restore brings back your name, your account and all your circles from a PearCircle backup file.
        Use a backup on one phone at a time: two phones using the same backup would keep swapping your location on the map.
      </p>
      {!contents
        ? <button style={primaryBtn} onClick={pick}>Choose backup file</button>
        : (
          <>
            <input style={input} type='password' autoComplete='current-password' placeholder='Backup password' value={pw} onChange={(e) => setPw(e.target.value)} />
            <button style={primaryBtn} disabled={busy || !pw} onClick={restore}>{busy ? 'Restoring...' : 'Restore'}</button>
          </>
          )}
      {error && <p style={errorText}>{error}</p>}
      {onCancel && <button style={textBtn} disabled={busy} onClick={onCancel}>Cancel</button>}
    </div>
  )
}

export function BackupSection ({ active }) {
  const [status, refresh] = useBackupStatus(active)
  const hasCircles = (status?.circleCount ?? 0) > 0
  const [mode, setMode] = useState(null) // 'manual' | 'auto' | 'restore'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const backUpNow = async (password) => {
    setBusy(true)
    setError(null)
    try {
      const keyed = await call('account:backup:key', { password })
      const built = await call('account:backup:build', keyed)
      const date = new Date().toISOString().slice(0, 10)
      const r = await call('shell:exportFile', { filename: 'pearcircle-backup-' + date + '.json', contents: built.contents, title: 'Save PearCircle backup' })
      if (r?.canceled) { setBusy(false); return }
      await pear.call('shell:backup:manual-done')
      setNotice('Backup saved. Keep the file and your password somewhere safe.')
      setMode(null)
      refresh()
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  const enableAuto = async (password) => {
    setBusy(true)
    setError(null)
    try {
      const keyed = await call('account:backup:key', { password })
      const r = await call('shell:backup:auto:enable', keyed)
      if (r?.canceled) { setBusy(false); return }
      setNotice('Automatic backup is on.')
      setMode(null)
      refresh()
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  const disableAuto = async () => {
    await pear.call('shell:backup:auto:disable')
    setNotice(null)
    refresh()
  }

  const last = lastBackupAt(status)
  const overdue = hasCircles && (!last || Date.now() - last > BACKUP_REMINDER_MS)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <p style={muted}>
        A backup saves your account, name and circles in one password-protected file. If you lose your phone or reinstall the app, restoring it brings everything back, including owner controls.
      </p>
      <p style={{ ...muted, color: overdue ? colors.error : colors.text.secondary }}>
        Last backup: {formatWhen(last)}{overdue ? (last ? ' - more than 14 days ago' : '') : ''}
      </p>

      {mode === 'manual' && (
        <PasswordForm
          intro='Choose a password for this backup. You need it to restore, and it cannot be recovered if you forget it.'
          submitLabel='Save backup'
          busy={busy}
          error={error}
          onSubmit={backUpNow}
          onCancel={() => { setMode(null); setError(null) }}
        />
      )}
      {mode === 'auto' && (
        <PasswordForm
          intro='Choose a password, then pick a folder. PearCircle keeps pearcircle-backup.json there up to date. A folder that syncs off this phone (Nextcloud, Syncthing, a cloud drive) also protects you if the phone is lost.'
          submitLabel='Choose folder'
          busy={busy}
          error={error}
          onSubmit={enableAuto}
          onCancel={() => { setMode(null); setError(null) }}
        />
      )}
      {mode === 'restore' && <RestoreBackupFlow onCancel={() => setMode(null)} />}

      {!mode && (
        <>
          <button style={primaryBtn} onClick={() => { setNotice(null); setMode('manual') }}>Back up now</button>
          {status?.autoSupported && (
            status.enabled
              ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
                  <p style={muted}>Automatic backup is on. It updates when your circles or profile change, and at least daily while the app runs.</p>
                  {status.lastError && <p style={errorText}>Last automatic backup failed: {status.lastError}</p>}
                  <button style={secondaryBtn} onClick={disableAuto}>Turn off automatic backup</button>
                </div>
                )
              : <button style={secondaryBtn} onClick={() => { setNotice(null); setMode('auto') }}>Back up automatically</button>
          )}
          {status && !hasCircles && <button style={secondaryBtn} onClick={() => setMode('restore')}>Restore from backup</button>}
        </>
      )}
      {notice && <p style={{ ...muted, color: colors.success }}>{notice}</p>}
    </div>
  )
}

const muted = { ...typography.caption, color: colors.text.secondary, margin: 0, lineHeight: 1.5 }

const primaryBtn = {
  width: '100%', padding: '12px',
  background: colors.primary, color: colors.text.onPrimary,
  border: 'none', borderRadius: radius.md,
  fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 400,
  cursor: 'pointer',
}

const secondaryBtn = {
  width: '100%', padding: '12px',
  background: 'transparent', color: colors.text.primary,
  border: `1px solid ${colors.border}`, borderRadius: radius.md,
  fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 400,
  cursor: 'pointer',
}

const textBtn = {
  width: '100%', padding: '8px',
  background: 'none', border: 'none', color: colors.text.muted,
  fontSize: 13, fontWeight: 400, cursor: 'pointer',
  fontFamily: typography.fontFamily,
}

const input = {
  width: '100%',
  padding: '12px 14px',
  background: colors.surface.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.md,
  color: colors.text.primary,
  fontSize: 15, fontFamily: typography.fontFamily,
  boxSizing: 'border-box',
}

const errorText = { ...typography.caption, color: colors.error, margin: 0 }
