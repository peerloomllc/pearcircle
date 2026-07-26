// Seed-side pairing progress hook (issue #179). The dashboard needs to know a
// phone is on the wire before enrollment finishes, otherwise a working handshake
// looks dead behind a static QR. Protomux is faked here so the channel's onopen
// can be fired without a live connection.

const channels = []

jest.mock('protomux', () => ({
  from: () => ({
    createChannel: (opts) => {
      const ch = { ...opts, messages: [], addMessage: (m) => { ch.messages.push(m); return m }, open: () => {} }
      channels.push(ch)
      return ch
    },
  }),
}))

const { setupSeederPairChannel } = require('../src/seederPair')

const RV = 'A'.repeat(43)

describe('setupSeederPairChannel onPeer', () => {
  beforeEach(() => { channels.length = 0 })

  test('fires once for the seed side when the channel opens', () => {
    let peers = 0
    setupSeederPairChannel({ conn: {}, role: 'seed', rv: RV, onPeer: () => { peers++ } })
    expect(channels).toHaveLength(1)
    expect(peers).toBe(0) // not until the remote actually opens the channel
    channels[0].onopen()
    expect(peers).toBe(1)
  })

  test('does not fire for the member side', () => {
    let peers = 0
    setupSeederPairChannel({ conn: {}, role: 'member', rv: RV, onPeer: () => { peers++ }, getBundle: () => [] })
    channels[0].onopen()
    expect(peers).toBe(0)
  })

  test('a throwing onPeer does not break the channel open', () => {
    const marks = []
    setupSeederPairChannel({
      conn: {},
      role: 'seed',
      rv: RV,
      onPeer: () => { throw new Error('boom') },
      mark: (name) => marks.push(name),
    })
    expect(() => channels[0].onopen()).not.toThrow()
    expect(marks).toContain('seederpair:onpeer-failed')
  })

  test('is optional', () => {
    setupSeederPairChannel({ conn: {}, role: 'seed', rv: RV })
    expect(() => channels[0].onopen()).not.toThrow()
  })
})
