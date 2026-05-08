const { handleNetworkChange } = require('../src/lib/networkChange')

describe('handleNetworkChange', () => {
  test('null swarm short-circuits with reason', async () => {
    expect(await handleNetworkChange(null)).toEqual({ ok: false, reason: 'no_swarm' })
  })

  test('undefined swarm short-circuits with reason', async () => {
    expect(await handleNetworkChange(undefined)).toEqual({ ok: false, reason: 'no_swarm' })
  })

  test('calls swarm.flush and returns ok on success', async () => {
    const flush = jest.fn(() => Promise.resolve())
    expect(await handleNetworkChange({ flush })).toEqual({ ok: true })
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('returns error string when flush rejects with Error', async () => {
    const flush = jest.fn(() => Promise.reject(new Error('boom')))
    expect(await handleNetworkChange({ flush })).toEqual({ ok: false, error: 'boom' })
  })

  test('returns String(err) when flush rejects with non-Error', async () => {
    const flush = jest.fn(() => Promise.reject('plain'))
    expect(await handleNetworkChange({ flush })).toEqual({ ok: false, error: 'plain' })
  })
})
