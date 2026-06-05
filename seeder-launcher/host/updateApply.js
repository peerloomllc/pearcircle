// Seeder-launcher one-click update apply (proposal 2026-06-05-seeder-update
// slice 3a: the verifiable core). Downloads the platform asset chosen by the
// update check, verifies it against the release's .sha256 sidecar (the
// integrity boundary — a tampered or wrong asset is rejected and nothing is
// installed), then dispatches to a per-platform applier.
//
// Self-apply paths that need no extra privilege (Linux AppImage; Windows via the
// LocalSystem service) are handled here. The macOS .pkg / Linux .deb paths need
// root and go through an install-once privileged helper (slice 3b) — their
// appliers throw `NeedsHelperError` until 3b lands, so the route can fall back to
// "download + open" rather than silently doing nothing.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

class NeedsHelperError extends Error {
  constructor (platform) { super(`apply on ${platform} needs the privileged helper (slice 3b)`); this.code = 'NEEDS_HELPER' }
}
class VerifyError extends Error {
  constructor (msg) { super(msg); this.code = 'VERIFY_FAILED' }
}

// Pull the 64-hex digest out of a `<hex>  <filename>` shasum sidecar.
function parseSha256Sidecar (text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/\b([0-9a-f]{64})\b/i)
  return m ? m[1].toLowerCase() : null
}

// SHA-256 of a file on disk, lowercase hex.
function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const s = fs.createReadStream(filePath)
    s.on('error', reject)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve(hash.digest('hex')))
  })
}

// Decide what to do for a platform from an evaluated update (see
// seederUpdateCheck.evaluateRelease). Pure. Throws when there's nothing to apply.
function planApply (update, platform) {
  if (!update || !update.updateAvailable) throw new Error('no update available to apply')
  if (!update.assetUrl || !update.sha256Url) throw new Error('release has no verifiable asset for this platform')
  const applier = platform === 'darwin' ? 'macpkg'
    : platform === 'win32' ? 'windows'
      : platform === 'linux' ? (update.assetName && /\.appimage$/i.test(update.assetName) ? 'appimage' : 'deb')
        : null
  if (!applier) throw new Error('unsupported platform: ' + platform)
  const requiresHelper = applier === 'macpkg' || applier === 'deb'
  return { applier, requiresHelper, assetUrl: update.assetUrl, sha256Url: update.sha256Url, assetName: update.assetName }
}

// Download `url` to `destPath` (streamed via fetch). Returns destPath.
async function downloadTo (url, destPath, { fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) throw new Error('no fetch available')
  const res = await doFetch(url, { redirect: 'follow', headers: { 'user-agent': 'pearcircle-seeder' } })
  if (!res.ok) throw new Error('download http ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.promises.writeFile(destPath, buf)
  return destPath
}

// Download the asset + its sidecar, verify the hash. Throws VerifyError on
// mismatch (the asset file is removed). Returns the verified file path + digest.
async function downloadAndVerify (plan, { workDir, fetchImpl } = {}) {
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-update-'))
  const file = path.join(dir, plan.assetName || 'asset.download')
  await downloadTo(plan.assetUrl, file, { fetchImpl })
  const doFetch = fetchImpl || fetch
  const shaRes = await doFetch(plan.sha256Url, { redirect: 'follow', headers: { 'user-agent': 'pearcircle-seeder' } })
  if (!shaRes.ok) throw new VerifyError('sha256 sidecar http ' + shaRes.status)
  const expected = parseSha256Sidecar(await shaRes.text())
  if (!expected) throw new VerifyError('unparseable sha256 sidecar')
  const actual = await sha256File(file)
  if (actual !== expected) {
    try { await fs.promises.unlink(file) } catch {}
    throw new VerifyError(`sha256 mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
  }
  return { file, digest: actual, dir }
}

// Per-platform apply command plans. exec(argv) runs one command (injectable for
// tests). target/installRoot come from the host. AppImage + Windows self-apply;
// macpkg/deb require the helper (3b) and throw until then.
const APPLIERS = {
  // Replace the installed AppImage payload, then restart the user service.
  appimage: async ({ file, target, exec }) => {
    if (!target) throw new Error('appimage applier needs a target path')
    await exec(['install', '-m', '0755', file, target])
    await exec(['systemctl', '--user', 'restart', 'pearcircle-seeder'])
    return { restarted: true }
  },
  // The Windows NSSM service runs as LocalSystem and can swap+restart itself.
  // Command construction lives here; on-device validation is slice 3b/Windows.
  windows: async ({ file, exec }) => {
    await exec(['nssm', 'stop', 'PearCircleSeeder'])
    await exec(['__swap_payload__', file]) // host helper expands this to the file moves
    await exec(['nssm', 'start', 'PearCircleSeeder'])
    return { restarted: true }
  },
  macpkg: async ({ platform }) => { throw new NeedsHelperError(platform || 'darwin') },
  deb: async ({ platform }) => { throw new NeedsHelperError(platform || 'linux') },
}

// Full orchestration: plan -> download+verify -> apply. `exec` and `fetchImpl`
// are injectable. Aborts (and applies nothing) if verification fails.
async function applyUpdate (update, { platform = process.platform, target, workDir, fetchImpl, exec, log = () => {} } = {}) {
  const plan = planApply(update, platform)
  log('update', `applying v${update.latestVersion} via ${plan.applier}`)
  const { file, digest } = await downloadAndVerify(plan, { workDir, fetchImpl })
  log('update', `verified ${plan.assetName} (${digest.slice(0, 12)}…)`)
  const applier = APPLIERS[plan.applier]
  if (!applier) throw new Error('no applier for ' + plan.applier)
  const result = await applier({ file, target, platform, exec })
  return { ...result, applier: plan.applier, version: update.latestVersion, file, digest }
}

// Stateful one-click apply driver for the host (proposal slice 3a). Tracks a
// single in-flight apply and exposes its state for /api/update/apply + the WS
// snapshot. `getUpdate` returns the checker's latest result; `target` is the
// install path to swap (e.g. process.env.APPIMAGE); both `exec`/`fetchImpl` are
// injectable for tests. Self-apply platforms run to a `restarting` state (the
// service manager brings us back on the new version); helper/no-target/unknown
// platforms land on `needs-helper` so the UI offers a verified download instead.
class UpdateApplier {
  constructor ({ getUpdate, platform = process.platform, target = null, exec, fetchImpl, log = () => {} } = {}) {
    this._getUpdate = getUpdate
    this._platform = platform
    this._target = target
    this._exec = exec
    this._fetchImpl = fetchImpl
    this._log = log
    this._state = { status: 'idle' }
  }

  getState () { return this._state }

  async apply () {
    const update = typeof this._getUpdate === 'function' ? this._getUpdate() : null
    if (!update || !update.updateAvailable) { this._state = { status: 'no-update' }; return this._state }
    if (this._state.status === 'running') return this._state
    this._state = { status: 'running', version: update.latestVersion }
    const downloadFallback = { status: 'needs-helper', version: update.latestVersion, assetUrl: update.assetUrl, releaseUrl: update.releaseUrl }
    try {
      const plan = planApply(update, this._platform)
      if (plan.requiresHelper) { this._state = { ...downloadFallback, reason: 'privileged-installer' }; return this._state }
      if (!this._target) { this._state = { ...downloadFallback, reason: 'no-install-target' }; return this._state }
      await applyUpdate(update, { platform: this._platform, target: this._target, exec: this._exec, fetchImpl: this._fetchImpl, log: this._log })
      this._state = { status: 'restarting', version: update.latestVersion }
    } catch (e) {
      this._state = e.code === 'NEEDS_HELPER'
        ? { ...downloadFallback, reason: 'privileged-installer' }
        : { status: 'error', version: update.latestVersion, error: e.message }
      this._log('update', `apply failed: ${e.message}`)
    }
    return this._state
  }
}

module.exports = {
  NeedsHelperError, VerifyError, UpdateApplier,
  parseSha256Sidecar, sha256File, planApply, downloadTo, downloadAndVerify, applyUpdate, APPLIERS,
}
