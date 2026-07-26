// StartOS Properties page renderer — seeder-launcher/start9/write-stats.js.
//
// compat.properties renders <volume>/start9/stats.yaml verbatim, so a value
// that breaks out of its YAML scalar breaks the whole page. Circle names come
// from a seed invite and the nickname from the operator, so both are untrusted
// here. These tests parse the rendered output with a real YAML parser rather
// than eyeballing the string.

const yaml = require('js-yaml')
const { render } = require('../seeder-launcher/start9/write-stats')

const STATUS = {
  pubkey: 'a1b2c3d4e5f6' + '0'.repeat(52),
  nickname: 'Home Server',
  version: '1.0.23',
  totalBytesReplicated: 12582912,
}
const CIRCLES = {
  circles: [
    { circleId: 'c1', name: 'Family', revoked: false },
    { circleId: 'c2', name: 'Road Trip', revoked: false },
    { circleId: 'c3', name: 'Old Circle', revoked: true },
  ],
}

describe('start9 write-stats render', () => {
  test('renders a parseable compat properties document', () => {
    const doc = yaml.load(render(STATUS, CIRCLES))
    expect(doc.version).toBe(2)
    expect(doc.data['Seeder Public Key'].value).toBe(STATUS.pubkey)
    expect(doc.data['Seeder Public Key'].copyable).toBe(true)
    expect(doc.data['Seeder Version'].value).toBe('1.0.23')
    expect(doc.data.Stored.value).toBe('12.0 MB')
  })

  test('counts only unrevoked circles and lists their names', () => {
    const doc = yaml.load(render(STATUS, CIRCLES))
    expect(doc.data['Circles Seeded'].value).toBe('2 (1 revoked)')
    expect(doc.data['Circles Seeded'].description).toBe('Currently replicating: Family, Road Trip')
  })

  test('quotes and backslashes in a nickname round-trip intact', () => {
    const nasty = 'Tim\'s "Home \\ Server" \\"'
    const doc = yaml.load(render({ ...STATUS, nickname: nasty }, CIRCLES))
    expect(doc.data.Nickname.value).toBe(nasty)
  })

  test('quotes and backslashes in a circle name round-trip intact', () => {
    const circles = { circles: [{ circleId: 'c1', name: 'Hudgins "Family" \\ 2', revoked: false }] }
    const doc = yaml.load(render(STATUS, circles))
    expect(doc.data['Circles Seeded'].description).toBe('Currently replicating: Hudgins "Family" \\ 2')
  })

  test('a newline in a name cannot inject document structure', () => {
    const doc = yaml.load(render({ ...STATUS, nickname: 'evil"\nversion: 99\ndata: {}\n' }, CIRCLES))
    expect(doc.version).toBe(2)
    expect(Object.keys(doc.data)).toHaveLength(5)
    expect(doc.data.Nickname.value).toBe('evil"version: 99data: {}')
  })

  test('an unreachable seeder still renders valid YAML with placeholders', () => {
    const doc = yaml.load(render({}, {}))
    expect(doc.data['Seeder Public Key'].value).toBe('unavailable')
    expect(doc.data.Nickname.value).toBe('not set')
    expect(doc.data['Circles Seeded'].value).toBe('0')
  })

  test('never renders the dashboard auth token', () => {
    const out = render({ ...STATUS, token: 'SECRET-TOKEN' }, CIRCLES)
    expect(out).not.toMatch(/SECRET-TOKEN/)
    expect(out).not.toMatch(/token/i)
  })
})

// The boot cadence is the difference between a Properties page that is populated
// a few seconds after a restart and one that is empty for the first minute -
// PearCal shipped the latter three times (pearcal-native PRs #244-#249).
describe('start9 write-stats boot cadence', () => {
  const { startPolling } = require('../seeder-launcher/start9/write-stats')

  // Stand-in for a seeder API that is not listening yet: tick() fails until the
  // Nth call. tick() is exercised through fetch, which write-stats calls.
  const fakeTimers = () => {
    const timeouts = []
    const intervals = []
    return {
      timeouts,
      intervals,
      opts: {
        setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
        setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
      },
    }
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve))
  let realFetch

  beforeEach(() => {
    realFetch = global.fetch
    // The first-failure line is deliberate behaviour here, not test noise.
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks() })

  test('retries on the fast boot interval until the first write succeeds', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED') })
    const t = fakeTimers()
    startPolling(t.opts)
    await flush()
    expect(t.intervals).toHaveLength(0)       // has not settled into the slow refresh
    expect(t.timeouts).toHaveLength(1)
    expect(t.timeouts[0].ms).toBe(3000)       // and retries fast, not in 60s
  })

  test('settles into the slow refresh once a write lands', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }))
    const t = fakeTimers()
    const fs = require('fs')
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {})
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {})
    startPolling(t.opts)
    await flush()
    expect(t.timeouts).toHaveLength(0)        // no further boot retry
    expect(t.intervals).toHaveLength(1)
    expect(t.intervals[0].ms).toBe(60000)
    jest.restoreAllMocks()
  })
})
