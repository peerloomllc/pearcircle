const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadHostSettings, resolveBind } = require('../seeder-launcher/host/settings')

// The Mac and Windows installers rebuild the service definition on every update,
// so a bind address edited into it is lost. <dataDir>/settings.json survives.

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-settings-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const write = (body) => fs.writeFileSync(path.join(dir, 'settings.json'), body)

describe('loadHostSettings', () => {
  test('a missing file is normal and yields nothing', () => {
    expect(loadHostSettings(dir)).toMatchObject({ settings: {}, errors: [] })
  })

  test('reads host and port', () => {
    write('{ "host": "0.0.0.0", "port": 9000 }')
    expect(loadHostSettings(dir)).toMatchObject({ settings: { host: '0.0.0.0', port: 9000 }, errors: [] })
  })

  test('trims the host', () => {
    write('{ "host": " 192.168.1.50 " }')
    expect(loadHostSettings(dir).settings.host).toBe('192.168.1.50')
  })

  test('a UTF-8 byte-order mark (Windows Notepad) is tolerated', () => {
    write('\uFEFF{ "host": "0.0.0.0" }')
    expect(loadHostSettings(dir)).toMatchObject({ settings: { host: '0.0.0.0' }, errors: [] })
  })

  test('invalid JSON is reported and ignored', () => {
    write('{ host: 0.0.0.0 }')
    const r = loadHostSettings(dir)
    expect(r.settings).toEqual({})
    expect(r.errors[0]).toMatch(/not valid JSON/)
  })

  test('a non-object is reported and ignored', () => {
    write('["0.0.0.0"]')
    expect(loadHostSettings(dir).errors[0]).toMatch(/JSON object/)
  })

  test('bad values are dropped one by one, good ones kept', () => {
    write('{ "host": "0.0.0.0", "port": "8730" }')
    const r = loadHostSettings(dir)
    expect(r.settings).toEqual({ host: '0.0.0.0' })
    expect(r.errors).toHaveLength(1)
    write('{ "host": "", "port": 70000 }')
    expect(loadHostSettings(dir)).toMatchObject({ settings: {} })
    expect(loadHostSettings(dir).errors).toHaveLength(2)
  })
})

describe('resolveBind', () => {
  test('defaults to loopback on 8730', () => {
    expect(resolveBind({ host: null, port: null }, {})).toEqual({
      host: '127.0.0.1', port: 8730, hostSource: 'default', portSource: 'default',
    })
  })

  test('settings.json overrides the default', () => {
    expect(resolveBind({ host: null, port: null }, { host: '0.0.0.0' })).toMatchObject({
      host: '0.0.0.0', hostSource: 'settings.json', port: 8730,
    })
  })

  test('a flag or env var beats settings.json (Umbrel sets SEEDER_HOST)', () => {
    expect(resolveBind({ host: '127.0.0.1', port: 8731 }, { host: '0.0.0.0', port: 9000 })).toMatchObject({
      host: '127.0.0.1', port: 8731, hostSource: 'flag or environment', portSource: 'flag or environment',
    })
  })
})
