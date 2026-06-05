const {
  parseVersion, compareVersions, isNewer, selectAsset, selectSha256For, evaluateRelease,
} = require('../src/lib/seederUpdateCheck')

// Proposal 2026-06-05-seeder-update slice 2: version compare + asset selection.

describe('parseVersion / compareVersions', () => {
  test('parses v-prefixed, plain, and partial versions', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.2')).toEqual([1, 2, 0])
    expect(parseVersion('0.0.0-dev')).toEqual([0, 0, 0])
    expect(parseVersion('1.0.4-rc1')).toEqual([1, 0, 4])
    expect(parseVersion('nope')).toBeNull()
    expect(parseVersion(null)).toBeNull()
  })

  test('orders numerically, not lexically', () => {
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1) // 9 < 10
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0)
  })
})

describe('isNewer (errs toward false)', () => {
  test('strictly newer only', () => {
    expect(isNewer('1.0.11', '1.0.10')).toBe(true)
    expect(isNewer('1.0.10', '1.0.10')).toBe(false)
    expect(isNewer('1.0.9', '1.0.10')).toBe(false)
  })
  test('unparseable either side -> false (no false positives)', () => {
    expect(isNewer('garbage', '1.0.0')).toBe(false)
    expect(isNewer('1.0.1', undefined)).toBe(false)
    expect(isNewer('1.0.1', '0.0.0-dev')).toBe(true) // dev parses to 0.0.0
  })
})

describe('selectAsset (real release asset naming)', () => {
  // Mirrors the actual GitHub release asset names (arch-specific on Linux).
  const assets = [
    { name: 'pearcircle-seeder_1.0.10_amd64.deb', browser_download_url: 'u/deb-amd64' },
    { name: 'pearcircle-seeder_1.0.10_amd64.deb.sha256', browser_download_url: 'u/deb-amd64.sha' },
    { name: 'pearcircle-seeder_1.0.10_arm64.deb', browser_download_url: 'u/deb-arm64' },
    { name: 'PearCircleSeeder-1.0.10.pkg', browser_download_url: 'u/pkg' },
    { name: 'PearCircleSeeder-1.0.10.pkg.sha256', browser_download_url: 'u/pkg.sha' },
    { name: 'PearCircleSeeder-aarch64.AppImage', browser_download_url: 'u/app-arm64' },
    { name: 'PearCircleSeeder-x86_64.AppImage', browser_download_url: 'u/app-x64' },
    { name: 'PearCircleSeeder-Setup-1.0.10.exe', browser_download_url: 'u/exe' },
    { name: 'pearcircle-v1.0.10.apk', browser_download_url: 'u/apk' }, // mobile, never picked
  ]
  test('macOS pkg + Windows exe are arch-universal', () => {
    expect(selectAsset(assets, 'darwin', 'x64').browser_download_url).toBe('u/pkg')
    expect(selectAsset(assets, 'darwin', 'arm64').browser_download_url).toBe('u/pkg')
    expect(selectAsset(assets, 'win32', 'x64').browser_download_url).toBe('u/exe')
  })
  test('linux defaults to the ARCH-matching AppImage (prefer) then deb', () => {
    expect(selectAsset(assets, 'linux', 'x64').browser_download_url).toBe('u/app-x64')
    expect(selectAsset(assets, 'linux', 'arm64').browser_download_url).toBe('u/app-arm64')
    const noApp = assets.filter((a) => !a.name.endsWith('.AppImage'))
    expect(selectAsset(noApp, 'linux', 'x64').browser_download_url).toBe('u/deb-amd64')
    expect(selectAsset(noApp, 'linux', 'arm64').browser_download_url).toBe('u/deb-arm64')
  })
  test('installKind=deb prefers the ARCH-matching .deb so the pkexec helper applies it', () => {
    // A .deb-installed seeder must be offered the .deb even though an AppImage
    // exists in the same release (proposal slice 3c).
    expect(selectAsset(assets, 'linux', 'x64', 'deb').browser_download_url).toBe('u/deb-amd64')
    expect(selectAsset(assets, 'linux', 'arm64', 'deb').browser_download_url).toBe('u/deb-arm64')
    // installKind=appimage keeps the AppImage self-apply.
    expect(selectAsset(assets, 'linux', 'x64', 'appimage').browser_download_url).toBe('u/app-x64')
    // A deb install with only an AppImage published still gets the AppImage.
    const noDeb = assets.filter((a) => !a.name.endsWith('.deb'))
    expect(selectAsset(noDeb, 'linux', 'x64', 'deb').browser_download_url).toBe('u/app-x64')
  })
  test('never hands a wrong-arch binary: null when no arch match', () => {
    const onlyArm = assets.filter((a) => /aarch64|arm64/.test(a.name))
    expect(selectAsset(onlyArm, 'linux', 'x64')).toBeNull()
  })
  test('returns null for an unknown platform or empty assets', () => {
    expect(selectAsset(assets, 'sunos', 'x64')).toBeNull()
    expect(selectAsset([], 'darwin', 'x64')).toBeNull()
    expect(selectAsset(null, 'darwin', 'x64')).toBeNull()
  })
  test('finds the matching .sha256 sidecar', () => {
    expect(selectSha256For(assets, 'PearCircleSeeder-1.0.10.pkg').browser_download_url).toBe('u/pkg.sha')
    expect(selectSha256For(assets, 'no-such')).toBeNull()
  })
})

describe('evaluateRelease', () => {
  const release = {
    tag_name: 'v1.0.11',
    html_url: 'https://github.com/peerloomllc/pearcircle/releases/tag/v1.0.11',
    assets: [
      { name: 'pearcircle-seeder-v1.0.11.pkg', browser_download_url: 'u/pkg' },
      { name: 'pearcircle-seeder-v1.0.11.pkg.sha256', browser_download_url: 'u/pkg.sha' },
    ],
  }
  test('update available with asset + sha256 + release url', () => {
    const r = evaluateRelease(release, { currentVersion: '1.0.10', platform: 'darwin' })
    expect(r.updateAvailable).toBe(true)
    expect(r.latestVersion).toBe('1.0.11')
    expect(r.assetUrl).toBe('u/pkg')
    expect(r.sha256Url).toBe('u/pkg.sha')
    expect(r.releaseUrl).toContain('v1.0.11')
  })
  test('up to date -> no update', () => {
    expect(evaluateRelease(release, { currentVersion: '1.0.11', platform: 'darwin' }).updateAvailable).toBe(false)
  })
  test('malformed release -> safe, no update', () => {
    const r = evaluateRelease({}, { currentVersion: '1.0.10', platform: 'darwin' })
    expect(r.updateAvailable).toBe(false)
    expect(r.latestVersion).toBeNull()
    expect(r.assetUrl).toBeNull()
  })
})
