const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  NeedsHelperError, VerifyError, UpdateApplier, APPLE_TEAM_ID, parsePkgutilTeam,
  parseSha256Sidecar, sha256File, planApply, downloadAndVerify, applyUpdate,
} = require('../seeder-launcher/host/updateApply')

// Proposal 2026-06-05-seeder-update slice 3a: the verifiable apply core.

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-apply-test-')) }
function sha256 (buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

// A fetch stub that serves bytes for the asset URL and a sidecar for the sha URL.
function stubFetch ({ assetUrl, bytes, shaUrl, shaText, assetStatus = 200, shaStatus = 200 }) {
  return async (url) => {
    if (url === assetUrl) return { ok: assetStatus === 200, status: assetStatus, arrayBuffer: async () => bytes }
    if (url === shaUrl) return { ok: shaStatus === 200, status: shaStatus, text: async () => shaText }
    throw new Error('unexpected url ' + url)
  }
}

describe('parseSha256Sidecar', () => {
  test('parses the standard "<hex>  <file>" shasum line', () => {
    expect(parseSha256Sidecar('54ea7843cbc9296c3fe74828ae32fad9c4e8ae47e869d36ee15b1988059d1d24  X.AppImage'))
      .toBe('54ea7843cbc9296c3fe74828ae32fad9c4e8ae47e869d36ee15b1988059d1d24')
  })
  test('rejects junk', () => {
    expect(parseSha256Sidecar('not a hash')).toBeNull()
    expect(parseSha256Sidecar(null)).toBeNull()
  })
})

test('sha256File matches node crypto', async () => {
  const dir = tmp(); const f = path.join(dir, 'x')
  fs.writeFileSync(f, 'hello seeder')
  expect(await sha256File(f)).toBe(sha256(Buffer.from('hello seeder')))
})

describe('planApply', () => {
  const base = { updateAvailable: true, assetUrl: 'u/a', sha256Url: 'u/a.sha', latestVersion: '1.0.11' }
  test('linux AppImage -> appimage, no helper', () => {
    const p = planApply({ ...base, assetName: 'PearCircleSeeder-x86_64.AppImage' }, 'linux')
    expect(p.applier).toBe('appimage'); expect(p.requiresHelper).toBe(false)
  })
  test('linux .deb -> deb, needs helper', () => {
    const p = planApply({ ...base, assetName: 'pearcircle-seeder_1.0.11_amd64.deb' }, 'linux')
    expect(p.applier).toBe('deb'); expect(p.requiresHelper).toBe(true)
  })
  test('darwin -> macpkg needs helper; win32 -> windows', () => {
    expect(planApply({ ...base, assetName: 'X.pkg' }, 'darwin').requiresHelper).toBe(true)
    expect(planApply({ ...base, assetName: 'X.exe' }, 'win32').applier).toBe('windows')
  })
  test('throws when nothing to apply', () => {
    expect(() => planApply({ updateAvailable: false }, 'linux')).toThrow()
    expect(() => planApply({ updateAvailable: true, assetUrl: 'u' }, 'linux')).toThrow() // no sha
  })
})

describe('downloadAndVerify (the integrity boundary)', () => {
  const bytes = Buffer.from('the new seeder build')
  const good = sha256(bytes)
  const plan = { assetUrl: 'u/asset', sha256Url: 'u/asset.sha', assetName: 'asset.bin' }

  test('passes when the sidecar hash matches', async () => {
    const dir = tmp()
    const r = await downloadAndVerify(plan, {
      workDir: dir,
      fetchImpl: stubFetch({ assetUrl: 'u/asset', bytes, shaUrl: 'u/asset.sha', shaText: `${good}  asset.bin` }),
    })
    expect(r.digest).toBe(good)
    expect(fs.existsSync(r.file)).toBe(true)
  })

  test('REJECTS a tampered asset (hash mismatch) and removes the file', async () => {
    const dir = tmp()
    const wrong = sha256(Buffer.from('a different (malicious) payload'))
    await expect(downloadAndVerify(plan, {
      workDir: dir,
      fetchImpl: stubFetch({ assetUrl: 'u/asset', bytes, shaUrl: 'u/asset.sha', shaText: `${wrong}  asset.bin` }),
    })).rejects.toThrow(VerifyError)
    expect(fs.existsSync(path.join(dir, 'asset.bin'))).toBe(false) // not left on disk
  })

  test('rejects an unparseable sidecar', async () => {
    const dir = tmp()
    await expect(downloadAndVerify(plan, {
      workDir: dir,
      fetchImpl: stubFetch({ assetUrl: 'u/asset', bytes, shaUrl: 'u/asset.sha', shaText: 'garbage' }),
    })).rejects.toThrow(VerifyError)
  })
})

describe('applyUpdate orchestration', () => {
  const bytes = Buffer.from('seeder v1.0.11 appimage')
  const good = sha256(bytes)
  const update = {
    updateAvailable: true, latestVersion: '1.0.11',
    assetUrl: 'u/app', sha256Url: 'u/app.sha', assetName: 'PearCircleSeeder-x86_64.AppImage',
  }
  const fetchImpl = stubFetch({ assetUrl: 'u/app', bytes, shaUrl: 'u/app.sha', shaText: `${good}  PearCircleSeeder-x86_64.AppImage` })

  test('linux AppImage: verifies then runs install + restart', async () => {
    const cmds = []
    const r = await applyUpdate(update, {
      platform: 'linux', target: '/opt/seeder/app.AppImage', workDir: tmp(),
      fetchImpl, exec: async (argv) => { cmds.push(argv) },
    })
    expect(r.applier).toBe('appimage')
    expect(cmds[0][0]).toBe('install')
    expect(cmds[cmds.length - 1]).toEqual(['systemctl', '--user', 'restart', 'pearcircle-seeder'])
  })

  test('a hash mismatch aborts BEFORE any exec (nothing applied)', async () => {
    const cmds = []
    const badFetch = stubFetch({ assetUrl: 'u/app', bytes, shaUrl: 'u/app.sha', shaText: `${sha256(Buffer.from('evil'))}  x` })
    await expect(applyUpdate(update, {
      platform: 'linux', target: '/opt/seeder/app.AppImage', workDir: tmp(),
      fetchImpl: badFetch, exec: async (argv) => { cmds.push(argv) },
    })).rejects.toThrow(VerifyError)
    expect(cmds).toEqual([]) // applier never ran
  })

  test('macOS pkg signals NeedsHelperError (deferred to slice 3b)', async () => {
    await expect(applyUpdate({ ...update, assetName: 'X.pkg' }, {
      platform: 'darwin', workDir: tmp(), fetchImpl: stubFetch({ assetUrl: 'u/app', bytes, shaUrl: 'u/app.sha', shaText: `${good}  X.pkg` }), exec: async () => {},
    })).rejects.toThrow(NeedsHelperError)
  })
})

describe('UpdateApplier state machine', () => {
  const bytes = Buffer.from('seeder v1.0.11 appimage')
  const good = sha256(bytes)
  const update = {
    updateAvailable: true, latestVersion: '1.0.11', releaseUrl: 'rel',
    assetUrl: 'u/app', sha256Url: 'u/app.sha', assetName: 'PearCircleSeeder-x86_64.AppImage',
  }
  const fetchImpl = stubFetch({ assetUrl: 'u/app', bytes, shaUrl: 'u/app.sha', shaText: `${good}  PearCircleSeeder-x86_64.AppImage` })

  test('no update -> no-update', async () => {
    const a = new UpdateApplier({ getUpdate: () => ({ updateAvailable: false }) })
    expect((await a.apply()).status).toBe('no-update')
  })
  test('helper-needed platform -> needs-helper with download', async () => {
    const a = new UpdateApplier({ getUpdate: () => ({ ...update, assetName: 'X.pkg' }), platform: 'darwin', target: null, fetchImpl, exec: async () => {} })
    const s = await a.apply()
    expect(s.status).toBe('needs-helper'); expect(s.assetUrl).toBe('u/app')
  })
  test('no install target -> needs-helper (download fallback)', async () => {
    const a = new UpdateApplier({ getUpdate: () => update, platform: 'linux', target: null, fetchImpl, exec: async () => {} })
    expect((await a.apply()).status).toBe('needs-helper')
  })
  test('AppImage with a target -> restarting after verify+exec', async () => {
    const cmds = []
    const a = new UpdateApplier({ getUpdate: () => update, platform: 'linux', target: '/opt/app.AppImage', workDir: tmp(), fetchImpl, exec: async (c) => cmds.push(c) })
    const s = await a.apply()
    expect(s.status).toBe('restarting')
    expect(cmds.length).toBeGreaterThan(0)
  })
})

describe('macOS privileged-helper handoff (slice 3b)', () => {
  const fs = require('node:fs')
  const bytes = Buffer.from('seeder v1.0.11 pkg')
  const good = sha256(bytes)
  const pkgUpdate = {
    updateAvailable: true, latestVersion: '1.0.11', releaseUrl: 'rel',
    assetUrl: 'u/pkg', sha256Url: 'u/pkg.sha', assetName: 'PearCircleSeeder-1.0.11.pkg',
  }
  const fetchImpl = stubFetch({ assetUrl: 'u/pkg', bytes, shaUrl: 'u/pkg.sha', shaText: `${good}  PearCircleSeeder-1.0.11.pkg` })

  test('drops a verified apply request for the daemon when the request dir exists', async () => {
    const reqDir = tmp()
    const a = new UpdateApplier({ getUpdate: () => pkgUpdate, platform: 'darwin', requestDir: reqDir, fetchImpl, exec: async () => {} })
    const s = await a.apply()
    expect(s.status).toBe('applying-via-helper')
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, 'apply.json'), 'utf8'))
    expect(req.sha256).toBe(good)
    expect(req.version).toBe('1.0.11')
    expect(req.teamId).toBe(APPLE_TEAM_ID)
    expect(fs.existsSync(req.pkgPath)).toBe(true)
  })

  test('falls back to needs-helper when the daemon dir is absent (helper not installed)', async () => {
    const a = new UpdateApplier({ getUpdate: () => pkgUpdate, platform: 'darwin', requestDir: '/no/such/dir', fetchImpl, exec: async () => {} })
    const s = await a.apply()
    expect(s.status).toBe('needs-helper')
    expect(s.reason).toBe('privileged-installer')
  })
})

describe('parsePkgutilTeam', () => {
  test('extracts the team id from both pkgutil output shapes', () => {
    expect(parsePkgutilTeam('   1. Developer ID Installer: PeerLoom LLC (G79ALD29NA)\n')).toBe('G79ALD29NA')
    expect(parsePkgutilTeam('Status: signed\n   Team identifier: G79ALD29NA\n')).toBe('G79ALD29NA')
  })
  test('returns null when no team id present', () => {
    expect(parsePkgutilTeam('Status: no signature')).toBeNull()
    expect(parsePkgutilTeam(null)).toBeNull()
  })
})
