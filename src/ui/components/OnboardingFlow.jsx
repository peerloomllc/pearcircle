// First-run onboarding modal. Walks the user through:
//   0. Welcome -- what PearCircle is.
//   1. Your name -- required, calls profile:set so any member rows
//      created in this session land with the right displayName.
//   2. Battery (Android only, conditional) -- nudge to disable Doze
//      battery optimization for PearCircle. Skipped on iOS, on
//      pre-Doze Android, and when the exemption is already granted.
//      Banner on the home view picks up the same case if the user
//      defers here.
//   3. Get started -- Create or Join. Tapping either routes into the
//      existing CreateView/JoinView sheets and closes the modal.
//
// Persistence is handled by the parent via onComplete; this component is
// stateless across launches and just renders a 4-step wizard.

import { useEffect, useState } from 'react'
import { colors, typography, spacing, radius } from '../theme.js'

// main.jsx assigns window.pear after this module is imported, so we
// must resolve through window at call time. Mirrors App.jsx's proxy.
const pear = {
  call: (...args) => window.pear.call(...args),
}

export function OnboardingFlow ({ profile, battery = { supported: null, exempt: false }, onCreate, onJoin, onComplete, onSkip }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(profile?.displayName ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Hydrate name when profile loads (profile prop may arrive after mount).
  useEffect(() => {
    if (profile?.displayName && !name) setName(profile.displayName)
  }, [profile?.displayName])

  // Whether the battery step is reachable. Android-only feature; the
  // shell reports supported=true once the platform check + Doze
  // availability resolve. Skip the step if the exemption is already
  // granted -- no point asking the user to fix what isn't broken.
  const isAndroid = typeof window !== 'undefined' && window.__pearPlatform === 'android'
  const showBatteryStep = isAndroid && battery.supported === true && !battery.exempt

  const saveName = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('Please enter a name'); return }
    setSaving(true)
    setError(null)
    try {
      const r = await pear.call('profile:set', { displayName: trimmed })
      setSaving(false)
      if (r?.ok) setStep(showBatteryStep ? 2 : 3)
      else setError('Could not save name')
    } catch (e) {
      setSaving(false)
      setError(String(e?.message ?? e))
    }
  }

  // Fire the system battery-opt dialog and advance. We don't await the
  // user's decision -- the dialog is a separate OS surface and the
  // OnboardingFlow stays mounted underneath. App-level state re-probes
  // on app:state=active when they return, so the banner / settings row
  // pick up the new exempt status whichever way they chose.
  const requestBatteryExempt = async () => {
    try { await pear.call('shell:battery:requestExempt') } catch {}
    setStep(3)
  }

  const handleCreate = () => { onCreate(); onComplete() }
  const handleJoin   = () => { onJoin();   onComplete() }
  const handleSkip   = () => { onSkip() }

  return (
    <div style={scrim}>
      <div style={card}>
        {step === 0 && (
          <>
            <div style={{ fontSize: 56, lineHeight: 1, marginTop: spacing.sm }}>📍</div>
            <div style={{ ...typography.heading, color: colors.text.primary, textAlign: 'center' }}>
              Welcome to PearCircle
            </div>
            <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.6, textAlign: 'center' }}>
              Private location sharing with the people you trust. No accounts, no tracking, no subscriptions - your location lives only on the devices in your circles.
            </div>
            <button style={primaryBtn} onClick={() => setStep(1)}>Get started</button>
            <button style={textBtn} onClick={handleSkip}>Skip setup</button>
          </>
        )}

        {step === 1 && (
          <>
            <div style={{ ...typography.heading, color: colors.text.primary, textAlign: 'center' }}>
              What should we call you?
            </div>
            <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.6, textAlign: 'center' }}>
              This is how your name shows up to people in your circles.
            </div>
            <input
              style={input}
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null) }}
              placeholder='Your name'
              maxLength={64}
            />
            {error && <div style={errorText}>{error}</div>}
            <button style={primaryBtn} disabled={!name.trim() || saving} onClick={saveName}>
              {saving ? 'Saving...' : 'Continue'}
            </button>
            <button style={textBtn} onClick={() => setStep(0)}>Back</button>
          </>
        )}

        {step === 2 && (
          <>
            <div style={{ fontSize: 56, lineHeight: 1, marginTop: spacing.sm }}>🔋</div>
            <div style={{ ...typography.heading, color: colors.text.primary, textAlign: 'center' }}>
              Keep sharing alive
            </div>
            <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.6, textAlign: 'center' }}>
              Android pauses background apps to save battery. PearCircle needs an exemption to keep your circle in sync while your phone is idle.
            </div>
            <button style={primaryBtn} onClick={requestBatteryExempt}>Disable battery optimization</button>
            <button style={textBtn} onClick={() => setStep(3)}>Skip for now</button>
          </>
        )}

        {step === 3 && (
          <>
            <div style={{ ...typography.heading, color: colors.text.primary, textAlign: 'center' }}>
              Start sharing
            </div>
            <div style={{ ...typography.body, color: colors.text.secondary, lineHeight: 1.6, textAlign: 'center' }}>
              Create a new circle to invite people, or join one with an invite link or QR code.
            </div>
            <button style={primaryBtn} onClick={handleCreate}>Start a new circle</button>
            <button style={secondaryBtn} onClick={handleJoin}>I have an invite</button>
            <button style={textBtn} onClick={handleSkip}>Skip for now</button>
          </>
        )}
      </div>
    </div>
  )
}

const scrim = {
  position: 'fixed', inset: 0, zIndex: 400,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.75)',
  padding: spacing.lg,
}

const card = {
  width: '100%', maxWidth: 380,
  background: colors.surface.card,
  borderRadius: radius.lg,
  padding: `${spacing.lg + 8}px ${spacing.lg}px`,
  display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: spacing.base,
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  fontFamily: typography.fontFamily,
}

const primaryBtn = {
  width: '100%', padding: '13px',
  background: colors.primary, color: colors.text.onPrimary,
  border: 'none', borderRadius: radius.md,
  fontFamily: typography.fontFamily, fontSize: 15, fontWeight: 400,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const secondaryBtn = {
  width: '100%', padding: '13px',
  background: 'transparent', color: colors.text.primary,
  border: `1px solid ${colors.border}`, borderRadius: radius.md,
  fontFamily: typography.fontFamily, fontSize: 15, fontWeight: 400,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
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

const errorText = {
  ...typography.caption,
  color: colors.error,
  margin: 0,
  textAlign: 'center',
}
