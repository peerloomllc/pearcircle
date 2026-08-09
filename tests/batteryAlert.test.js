const {
  batteryAlertDecision,
  isValidBatteryThreshold,
  BATTERY_ALERT_MIN_THRESHOLD,
  BATTERY_ALERT_MAX_THRESHOLD,
  BATTERY_ALERT_THRESHOLD_STEP,
  BATTERY_ALERT_DEFAULT_THRESHOLD,
  BATTERY_ALERT_REARM_MARGIN,
  BATTERY_ALERT_FRESHNESS_MS,
} = require('../src/lib/batteryAlert')

const NOW = 1_770_000_000_000
const PEER = 'aa'.repeat(32)
const US = 'bb'.repeat(32)

// A fresh, discharging reading from a peer, low enough to fire at the default
// threshold. Tests override one field at a time from here.
const reading = (over = {}) => ({
  pubkey: PEER, battery: 10, isCharging: false, ts: NOW, ...over,
})

const decide = (value, opts = {}) =>
  batteryAlertDecision(value, { ourPubkey: US, now: NOW, ...opts })

describe('batteryAlertDecision', () => {
  test('a fresh low discharging peer reading fires', () => {
    expect(decide(reading())).toBe('fire')
  })

  test('exactly at the threshold fires (below means at-or-below)', () => {
    expect(decide(reading({ battery: BATTERY_ALERT_DEFAULT_THRESHOLD }))).toBe('fire')
  })

  test('one point above the threshold does not fire', () => {
    expect(decide(reading({ battery: BATTERY_ALERT_DEFAULT_THRESHOLD + 1 }))).toBe('ignore')
  })

  test('our own reading never fires', () => {
    expect(decide(reading({ pubkey: US }))).toBe('ignore')
  })

  test('the toggle being off suppresses the alert', () => {
    expect(decide(reading(), { enabled: false })).toBe('ignore')
  })

  test('a charging phone is recovering, not dying', () => {
    expect(decide(reading({ isCharging: true }))).toBe('ignore')
  })

  test('a stale reading does not fire', () => {
    expect(decide(reading({ ts: NOW - BATTERY_ALERT_FRESHNESS_MS - 1 }))).toBe('ignore')
  })

  test('a reading right at the freshness edge still fires', () => {
    expect(decide(reading({ ts: NOW - BATTERY_ALERT_FRESHNESS_MS }))).toBe('fire')
  })

  test('a missing or malformed timestamp does not fire', () => {
    expect(decide(reading({ ts: undefined }))).toBe('ignore')
    expect(decide(reading({ ts: 'soon' }))).toBe('ignore')
  })

  test('a missing or out-of-range battery level is ignored', () => {
    for (const battery of [undefined, null, NaN, -1, 101, '10']) {
      expect(decide(reading({ battery }))).toBe('ignore')
    }
  })

  test('a malformed value is ignored rather than thrown on', () => {
    expect(decide(null)).toBe('ignore')
    expect(decide({})).toBe('ignore')
    expect(decide({ battery: 5 })).toBe('ignore')   // no pubkey
  })

  test('a custom threshold is honoured in both directions', () => {
    expect(decide(reading({ battery: 30 }), { threshold: 50 })).toBe('fire')
    expect(decide(reading({ battery: 30 }), { threshold: 25 })).toBe('ignore')
  })

  describe('isValidBatteryThreshold', () => {
    test('accepts every stop the slider can land on', () => {
      for (let t = BATTERY_ALERT_MIN_THRESHOLD; t <= BATTERY_ALERT_MAX_THRESHOLD; t += BATTERY_ALERT_THRESHOLD_STEP) {
        expect(isValidBatteryThreshold(t)).toBe(true)
      }
    })

    test('the default is a valid stop', () => {
      expect(isValidBatteryThreshold(BATTERY_ALERT_DEFAULT_THRESHOLD)).toBe(true)
    })

    test('rejects values outside the range', () => {
      expect(isValidBatteryThreshold(BATTERY_ALERT_MIN_THRESHOLD - BATTERY_ALERT_THRESHOLD_STEP)).toBe(false)
      expect(isValidBatteryThreshold(BATTERY_ALERT_MAX_THRESHOLD + BATTERY_ALERT_THRESHOLD_STEP)).toBe(false)
      expect(isValidBatteryThreshold(0)).toBe(false)
      expect(isValidBatteryThreshold(100)).toBe(false)
    })

    test('rejects values off the step grid', () => {
      expect(isValidBatteryThreshold(17)).toBe(false)
      expect(isValidBatteryThreshold(12.5)).toBe(false)
    })

    test('rejects non-numbers', () => {
      for (const t of [undefined, null, NaN, '15', {}, Infinity]) {
        expect(isValidBatteryThreshold(t)).toBe(false)
      }
    })
  })

  describe('once per discharge cycle', () => {
    const fired = new Set([PEER])

    test('a second low reading does not fire again', () => {
      expect(decide(reading({ battery: 8 }), { fired })).toBe('ignore')
    })

    test('a small recovery inside the re-arm margin does not re-arm', () => {
      const level = BATTERY_ALERT_DEFAULT_THRESHOLD + BATTERY_ALERT_REARM_MARGIN
      expect(decide(reading({ battery: level }), { fired })).toBe('ignore')
    })

    test('recovering past the margin re-arms', () => {
      const level = BATTERY_ALERT_DEFAULT_THRESHOLD + BATTERY_ALERT_REARM_MARGIN + 1
      expect(decide(reading({ battery: level }), { fired })).toBe('rearm')
    })

    test('plugging in re-arms immediately, at any level', () => {
      expect(decide(reading({ battery: 3, isCharging: true }), { fired })).toBe('rearm')
    })

    test('a stale recovery reading still re-arms', () => {
      // Deliberate: the freshness gate guards against alerting on old news,
      // not against believing an old "they charged up" observation.
      expect(decide(
        reading({ battery: 90, ts: NOW - BATTERY_ALERT_FRESHNESS_MS * 10 }),
        { fired },
      )).toBe('rearm')
    })

    test('re-arming works even while the toggle is off', () => {
      // Otherwise toggling alerts off over a charge cycle and back on would
      // leave the member permanently marked as already-alerted.
      expect(decide(reading({ battery: 90 }), { fired, enabled: false })).toBe('rearm')
    })

    test('a different member is unaffected by our mark', () => {
      const other = 'cc'.repeat(32)
      expect(decide(reading({ pubkey: other }), { fired })).toBe('fire')
    })

    test('the decision never mutates the caller\'s set', () => {
      const set = new Set([PEER])
      decide(reading({ battery: 90 }), { fired: set })
      expect(set.has(PEER)).toBe(true)
    })
  })
})
