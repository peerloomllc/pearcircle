// Decision rules for low-battery alerts about circle MEMBERS
// ("Jane's phone is at 12%").
//
// A member's battery level already rides on every position they share, so this
// reads data we hold rather than putting anything new on the wire. Scoped to
// peers only: the OS already warns you about your own phone.
//
// The contract is one alert per member per discharge cycle. `fired` is the
// caller's set of members already alerted about; this module decides whether a
// given reading should fire, re-arm, or be ignored, and the caller does the
// set mutation and the IPC emit. Kept pure and separate from src/bare.js so the
// gate ordering is testable without a worklet, an Autobase or a swarm.

// The Settings slider's range. Stepped in 5s: a 1% slider implies a precision
// the readings don't have (both platforms report whole percents that jump
// several points at a time) and makes the control fiddly on a phone.
// Floor at 5 because below that a phone is minutes from dead, ceiling at 50
// because alerting on a half-full battery is noise.
const BATTERY_ALERT_MIN_THRESHOLD = 5
const BATTERY_ALERT_MAX_THRESHOLD = 50
const BATTERY_ALERT_THRESHOLD_STEP = 5
const BATTERY_ALERT_DEFAULT_THRESHOLD = 15

// True for a value the slider could actually have produced. The worklet
// validates with this rather than trusting the UI, so a stale bundle or a
// hand-made IPC call can't persist a threshold the slider can never show back.
function isValidBatteryThreshold (t) {
  return typeof t === 'number' && Number.isInteger(t) &&
    t >= BATTERY_ALERT_MIN_THRESHOLD && t <= BATTERY_ALERT_MAX_THRESHOLD &&
    t % BATTERY_ALERT_THRESHOLD_STEP === 0
}

// How far a phone must recover ABOVE the threshold before it re-arms. Without
// the margin, a phone hovering at exactly the threshold would re-fire on every
// one-point blip up and down.
const BATTERY_ALERT_REARM_MARGIN = 5

// A reading older than this can't justify waking someone. Cold boot replays
// cached last-known tips and durable lastSeen rows that may be hours stale, and
// "Jane was at 9% this morning" is noise, not a warning.
const BATTERY_ALERT_FRESHNESS_MS = 30 * 60 * 1000

// Decide what a peer battery reading means. Returns one of:
//   'fire'   - alert now, and mark this member as alerted
//   'rearm'  - their phone recovered; clear the mark so the next drop alerts
//   'ignore' - nothing to do
//
// `value` is the signed position payload ({ pubkey, battery, isCharging, ts }).
// `opts.ourPubkey` is dropped so we never alert about ourselves; `opts.fired`
// is the already-alerted set (anything with .has); `opts.now` is injectable for
// tests.
function batteryAlertDecision (value, opts = {}) {
  const {
    enabled = true,
    threshold = BATTERY_ALERT_DEFAULT_THRESHOLD,
    ourPubkey = null,
    fired = null,
    now = Date.now(),
    freshnessMs = BATTERY_ALERT_FRESHNESS_MS,
    rearmMargin = BATTERY_ALERT_REARM_MARGIN,
  } = opts

  if (!value || typeof value.pubkey !== 'string') return 'ignore'
  if (ourPubkey && value.pubkey === ourPubkey) return 'ignore'
  const level = value.battery
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 100) return 'ignore'
  const charging = value.isCharging === true
  const alreadyFired = !!(fired && fired.has(value.pubkey))

  // Re-arming is deliberately NOT gated on `enabled` or on freshness. A user
  // who toggles alerts off and back on, or whose phone was asleep through the
  // recovery, should still see the next real drop -- and a stale reading that
  // says "back at 80%" is perfectly good evidence the phone was charged.
  if (alreadyFired) {
    return (charging || level > threshold + rearmMargin) ? 'rearm' : 'ignore'
  }

  if (!enabled) return 'ignore'
  if (charging) return 'ignore'
  if (level > threshold) return 'ignore'
  if (typeof value.ts !== 'number' || now - value.ts > freshnessMs) return 'ignore'
  return 'fire'
}

module.exports = {
  batteryAlertDecision,
  isValidBatteryThreshold,
  BATTERY_ALERT_MIN_THRESHOLD,
  BATTERY_ALERT_MAX_THRESHOLD,
  BATTERY_ALERT_THRESHOLD_STEP,
  BATTERY_ALERT_DEFAULT_THRESHOLD,
  BATTERY_ALERT_REARM_MARGIN,
  BATTERY_ALERT_FRESHNESS_MS,
}
