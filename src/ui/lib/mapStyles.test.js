import {
  STREET_STYLE_URL,
  satelliteStyleUrl,
  isSatelliteStyle,
  keyFromSatelliteStyle,
  styleMode,
  validateMaptilerKey,
  loadSavedKey,
  saveKey,
  checkSatelliteKey,
} from './mapStyles.js'

describe('mapStyles', () => {
  test('satellite URL round-trips the key', () => {
    const url = satelliteStyleUrl('  abcDEF123456  ')
    expect(url).toBe('https://api.maptiler.com/maps/hybrid/style.json?key=abcDEF123456')
    expect(isSatelliteStyle(url)).toBe(true)
    expect(keyFromSatelliteStyle(url)).toBe('abcDEF123456')
  })

  test('styleMode', () => {
    expect(styleMode(null)).toBe('street')
    expect(styleMode('')).toBe('street')
    expect(styleMode(STREET_STYLE_URL)).toBe('street')
    expect(styleMode(satelliteStyleUrl('abcdefgh'))).toBe('satellite')
    expect(styleMode('https://example.com/style.json')).toBe('custom')
    expect(keyFromSatelliteStyle('https://example.com/style.json')).toBe(null)
  })

  test('validateMaptilerKey', () => {
    expect(validateMaptilerKey('')).toMatch(/Paste/)
    expect(validateMaptilerKey('https://api.maptiler.com/x?key=1')).toMatch(/does not look/)
    expect(validateMaptilerKey('has space in it')).toMatch(/does not look/)
    expect(validateMaptilerKey('AbCdEf1234567890')).toBe(null)
  })

  test('saved key survives in localStorage', () => {
    localStorage.clear()
    expect(loadSavedKey()).toBe(null)
    saveKey(' key12345 ')
    expect(loadSavedKey()).toBe('key12345')
  })

  test('checkSatelliteKey maps responses to messages', async () => {
    const ok = jest.fn(async () => ({ ok: true, status: 200 }))
    expect(await checkSatelliteKey('abcdefgh', ok)).toBe(null)
    expect(ok).toHaveBeenCalledWith(satelliteStyleUrl('abcdefgh'))
    expect(await checkSatelliteKey('abcdefgh', async () => ({ ok: false, status: 403 }))).toMatch(/did not accept/)
    expect(await checkSatelliteKey('abcdefgh', async () => ({ ok: false, status: 500 }))).toMatch(/500/)
    expect(await checkSatelliteKey('abcdefgh', async () => { throw new Error('offline') })).toMatch(/connection/)
  })
})
