const { UpdateChecker } = require('../seeder-launcher/host/updateCheck')

// Proposal 2026-06-05-seeder-update slice 2: the host's GitHub-Releases checker.
// Exercises the fetch -> evaluate -> cache flow and the fail-open behaviour with
// an injected fetch stub (no network).

function okFetch (json) {
  return async () => ({ ok: true, json: async () => json })
}

const RELEASE = {
  tag_name: 'v1.0.11',
  html_url: 'https://github.com/peerloomllc/pearcircle/releases/tag/v1.0.11',
  assets: [
    { name: 'pearcircle-seeder-v1.0.11.pkg', browser_download_url: 'u/pkg' },
    { name: 'pearcircle-seeder-v1.0.11.pkg.sha256', browser_download_url: 'u/pkg.sha' },
  ],
}

test('detects an available update and caches the evaluated result', async () => {
  const checker = new UpdateChecker({ currentVersion: '1.0.10', platform: 'darwin', fetchImpl: okFetch(RELEASE) })
  const r = await checker.checkNow()
  expect(r.updateAvailable).toBe(true)
  expect(r.latestVersion).toBe('1.0.11')
  expect(r.assetUrl).toBe('u/pkg')
  expect(r.sha256Url).toBe('u/pkg.sha')
  expect(r.error).toBeNull()
  expect(typeof r.checkedAt).toBe('number')
  expect(checker.get()).toEqual(r) // cached
})

test('no update when already current', async () => {
  const checker = new UpdateChecker({ currentVersion: '1.0.11', platform: 'darwin', fetchImpl: okFetch(RELEASE) })
  expect((await checker.checkNow()).updateAvailable).toBe(false)
})

test('fail-open on HTTP error: records error, never throws', async () => {
  const checker = new UpdateChecker({
    currentVersion: '1.0.10', platform: 'darwin',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  })
  const r = await checker.checkNow()
  expect(r.error).toMatch(/403/)
  expect(r.updateAvailable).toBe(false)
})

test('fail-open on network throw', async () => {
  const checker = new UpdateChecker({
    currentVersion: '1.0.10', platform: 'darwin',
    fetchImpl: async () => { throw new Error('ENOTFOUND') },
  })
  const r = await checker.checkNow()
  expect(r.error).toMatch(/ENOTFOUND/)
  expect(r.updateAvailable).toBe(false)
})

test('no fetch available -> graceful error', async () => {
  const checker = new UpdateChecker({ currentVersion: '1.0.10', platform: 'darwin', fetchImpl: null })
  // force the "no fetch" branch by nulling the resolved impl
  checker._fetch = null
  const r = await checker.checkNow()
  expect(r.error).toBe('no fetch available')
})
