// Repair surfaces: the needs-repair nudge, the in-progress indicator, and the
// confirm-with-explainer. Lifted out of App.jsx unchanged (proposal
// 2026-07-16) so they can be rendered in jsdom without dragging maplibre in.
import React from 'react'
import { colors, typography, spacing, radius } from '../theme.js'

// Top-of-map nudge when one or more circles are wedged (needsRepair) and not
// already repairing. Primary, discoverable surface for the rebuild -- the
// per-avatar member-sheet button is too hidden for most users to find. The
// action opens a confirm-with-explainer first (repair pauses sharing and
// rebuilds from peers), it isn't a one-tap toggle. Dismissible per session;
// the persisted degraded flag re-surfaces it next launch.
export function RepairBanner ({ count, circleName, onRepair, onDismiss }) {
  const headline = count > 1 ? `${count} circles need repair` : `${circleName || 'A circle'} needs repair`
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
      padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
      background: 'rgba(26,26,26,0.92)',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <button
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          position: 'absolute',
          top: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px)`,
          right: spacing.sm,
          background: 'transparent', border: 'none', color: colors.text.secondary,
          fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
        }}
      >×</button>
      <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
        <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>{headline}</div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
          {count > 1 ? 'Their data is stuck' : "This circle's data is stuck"}, so members' locations may be out of sync. Repairing rebuilds {count > 1 ? 'them' : 'it'} from your peers.
        </div>
        <button
          onClick={onRepair}
          style={{
            display: 'inline-block', marginTop: spacing.sm, padding: '6px 14px',
            background: colors.primary, color: colors.text.onPrimary,
            border: 'none', borderRadius: radius.sm,
            fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400, cursor: 'pointer',
          }}
        >
          Repair
        </button>
      </div>
    </div>
  )
}

// How long an in-process repair may run before we stop promising it will
// finish and escalate to "leave and rejoin". A healthy re-sync converges well
// under this; the wedges that never converge (oplog bloat, forked view) would
// otherwise spin "Repairing…" forever. Backstop for the non-staged path only:
// a staged rebuild escalates on the worklet's attempt count instead (proposal
// 2026-07-16 Part C), which is a fact rather than a timer's guess.
export const REPAIR_ESCALATE_MS = 75_000

// Indeterminate "Repairing…" indicator. circle:repair returns in seconds but
// the actual re-sync from the seeder + writer re-admission run async and can
// take a long time, so this persists (via the worklet's `repairing` flag)
// until the rebuilt base is functional again. While it's progressing there's
// no action; once escalated we tell the user some wedges can't be repaired and
// point them at leave + rejoin.
export function RepairingBanner ({ count, circleName, needsRestart = false, escalated = false, onResolve }) {
  const target = count > 1 ? `${count} circles` : (circleName || 'circle')
  const bannerStyle = {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
    padding: `calc(env(safe-area-inset-top, 24px) + ${spacing.sm}px) ${spacing.base}px ${spacing.sm}px`,
    background: 'rgba(26,26,26,0.92)',
    borderBottom: `1px solid ${colors.border}`,
  }
  // Escalated: the re-sync isn't converging. Some wedges (stuck/bloated or
  // forked data) can't be rebuilt from peers; the reliable fix is to leave the
  // circle and rejoin from a fresh invite. Shown for the restart-staged case
  // too (proposal 2026-07-16): "reopen the app" is only a real path while the
  // retry might still land, and once the worklet has given up it is a dead end
  // — which is what stranded a user behind an undismissable banner.
  if (escalated) {
    return (
      <div style={bannerStyle}>
        <div style={{ textAlign: 'center', padding: `0 ${spacing.lg}px` }}>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>
            Repair is taking longer than usual
          </div>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
            Some stuck data can't be rebuilt this way. If {count > 1 ? 'a circle' : (circleName || 'the circle')} still looks out of sync, leave it and rejoin from a fresh invite (ask the circle's owner to send a new one).
          </div>
          {onResolve && (
            <button
              onClick={onResolve}
              style={{
                display: 'inline-block', marginTop: spacing.sm, padding: '6px 14px',
                background: colors.primary, color: colors.text.onPrimary,
                border: 'none', borderRadius: radius.sm,
                fontFamily: typography.fontFamily, fontSize: 13, fontWeight: 400, cursor: 'pointer',
              }}
            >
              Open circle settings
            </button>
          )}
        </div>
      </div>
    )
  }
  const label = needsRestart
    ? `Finishing repair of ${target}`
    : (count > 1 ? `Repairing ${count} circles…` : `Repairing ${circleName || 'circle'}…`)
  const sub = needsRestart
    ? 'Reopen the app to finish repairing.'
    : 'This can take a while. Your circle will catch up in the background.'
  return (
    <div style={bannerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: `0 ${spacing.lg}px` }}>
        {/* Spinner runs in the staged case too: the rebuild retries on every
            foreground now, so it's genuinely still in progress rather than
            parked waiting for a restart that never came. */}
        <span
          data-testid='repair-spinner'
          style={{
            width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${colors.border}`, borderTopColor: colors.primary,
            animation: 'pearcircle-focus-spin 0.8s linear infinite', display: 'inline-block',
          }}
        />
        <div style={{ textAlign: 'left' }}>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: 400 }}>{label}</div>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: 2, lineHeight: 1.4 }}>
            {sub}
          </div>
        </div>
      </div>
    </div>
  )
}

// Confirm-with-explainer before a rebuild, since it pauses sharing and runs a
// long re-sync. Repairs every wedged circle on confirm.
export function RepairConfirmModal ({ circles, onConfirm, onCancel }) {
  const single = circles.length === 1
  const name = single ? (circles[0]?.circle?.name || 'this circle') : `${circles.length} circles`
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 360,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.7)', padding: spacing.lg,
    }}>
      <div style={{
        width: '100%', maxWidth: 360,
        background: colors.surface.card, borderRadius: radius.lg,
        padding: spacing.lg, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ ...typography.heading, margin: `0 0 ${spacing.base}px`, color: colors.text.primary }}>
          Repair {name}?
        </h2>
        <p style={{ ...typography.body, color: colors.text.secondary, marginTop: 0, marginBottom: spacing.base, lineHeight: 1.5 }}>
          This rebuilds {single ? 'the circle' : 'these circles'} from your peers to fix the stuck data. Your sharing pauses briefly and it can take a while to catch up. Your identity and history are kept.
        </p>
        <div style={{ display: 'flex', gap: spacing.sm, marginTop: spacing.base }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: '12px', background: 'transparent',
              color: colors.text.secondary, border: `1px solid ${colors.border}`,
              borderRadius: radius.md, fontFamily: typography.fontFamily, fontSize: 14, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: '12px', background: colors.primary, color: colors.text.onPrimary,
              border: 'none', borderRadius: radius.md, fontFamily: typography.fontFamily, fontSize: 14, fontWeight: 400, cursor: 'pointer',
            }}
          >
            Repair
          </button>
        </div>
      </div>
    </div>
  )
}
