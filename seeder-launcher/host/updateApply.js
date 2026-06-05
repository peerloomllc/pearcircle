// Seeder-launcher one-click update apply (proposal 2026-06-05-seeder-update
// slice 3a: the verifiable core). Downloads the platform asset chosen by the
// update check, verifies it against the release's .sha256 sidecar (the
// integrity boundary — a tampered or wrong asset is rejected and nothing is
// installed), then dispatches to a per-platform applier.
//
// Self-apply paths that need no extra privilege are handled inline: the Linux
// AppImage (swap the image, restart the user service) and Windows (the NSIS
// installer, driven by the already-privileged LocalSystem service). The macOS
// .pkg and Linux .deb need root and go through an install-once privileged
// helper installed at first install (slice 3b/3c): macOS drops a request for a
// root LaunchDaemon; Linux runs a root updater via a passwordless polkit/pkexec
// rule. When that helper isn't present (an old build) the applier throws
// `NeedsHelperError` so the route falls back to a verified download rather than
// silently doing nothing.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

// The Apple Developer Team that signs + notarizes PearCircle (reused from
// PearCal/PearGuard). The privileged macOS updater LaunchDaemon (slice 3b) only
// installs a .pkg signed by this team and notarized — the trust anchor that
// makes the host->helper drop-folder handoff safe even on a multi-user box.
const APPLE_TEAM_ID = 'G79ALD29NA'

// Pull the signing Team Identifier out of `pkgutil --check-signature <pkg>`
// output. macOS prints a line like `   1. Developer ID Installer: Name (TEAMID)`
// or an explicit `Team identifier: TEAMID`. Returns the id or null. Pure.
function parsePkgutilTeam (output) {
  if (typeof output !== 'string') return null
  const explicit = output.match(/Team identifier:\s*([A-Z0-9]{10})/i)
  if (explicit) return explicit[1].toUpperCase()
  const paren = output.match(/Developer ID Installer:[^\n(]*\(([A-Z0-9]{10})\)/i)
  return paren ? paren[1].toUpperCase() : null
}

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
  // requiresHelper: needs an install-once privileged helper (macOS daemon /
  // Linux pkexec). requiresTarget: a self-apply that swaps a known payload path
  // up front (the AppImage) — the Windows installer self-applies with no target.
  const requiresHelper = applier === 'macpkg' || applier === 'deb'
  const requiresTarget = applier === 'appimage'
  return { applier, requiresHelper, requiresTarget, assetUrl: update.assetUrl, sha256Url: update.sha256Url, assetName: update.assetName }
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
    // `--no-block`: enqueue the restart and return immediately. A plain restart
    // tears down this service's cgroup, killing the `systemctl` child (and us)
    // before it exits 0 — which surfaced as a bogus `error` state on a
    // successful self-update. With --no-block systemctl returns 0, we report
    // `restarting`, then systemd brings us back on the new image.
    await exec(['systemctl', '--user', 'restart', '--no-block', 'pearcircle-seeder'])
    return { restarted: true }
  },
  // Windows: run the verified NSIS installer silently. The installer's upgrade
  // path stops the service -> overwrites the payload -> re-registers -> starts
  // it, which releases the running node.exe lock that a plain file copy can't.
  // The NSSM service runs as LocalSystem, so the installer inherits elevation
  // (no UAC) and `/S` suppresses every UI page (no browser/finish-page popup on
  // an unattended update). We must NOT spawn the installer as a child of the
  // service: NSSM reaps the service's process tree on stop, and the installer
  // *itself* stops the service — a child would be killed mid-swap. So launch it
  // detached via WMI (Win32_Process.Create re-parents it under WmiPrvSE), then
  // return; the host process is replaced when the installer restarts the service.
  windows: async ({ file, exec }) => {
    const cmdLine = `\"${file}\" /S`
    const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdLine}'} | Out-Null`
    await exec(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps])
    return { restarted: true }
  },
  // macOS: hand the verified .pkg to the privileged updater LaunchDaemon by
  // dropping a request into its watched directory (slice 3b). The host is
  // unprivileged, so it cannot run `installer -pkg` itself; the root daemon
  // re-verifies (sha256 + Developer-ID/notarization) and installs. If the
  // daemon dir is absent (helper not installed — old build), fall back to the
  // download path. The .pkg's own postinstall restarts the LaunchAgent.
  macpkg: async ({ file, digest, version, platform, requestDir, fsImpl }) => {
    const f = fsImpl || fs
    if (!requestDir || !f.existsSync(requestDir)) throw new NeedsHelperError(platform || 'darwin')
    const req = { pkgPath: file, sha256: digest, version: version || null, teamId: APPLE_TEAM_ID, ts: Date.now() }
    // Write to a temp name then rename, so the daemon's WatchPaths never sees a
    // half-written request.
    const tmp = path.join(requestDir, '.apply.json.tmp')
    const dst = path.join(requestDir, 'apply.json')
    f.writeFileSync(tmp, JSON.stringify(req))
    f.renameSync(tmp, dst)
    return { handedToHelper: true }
  },
  // Linux .deb: the systemd *user* service is unprivileged and `dpkg -i` needs
  // root. The .deb's postinst installs a root-owned updater script plus a polkit
  // rule that lets this seeder's user run it via pkexec with no password
  // (proposal slice 3c). The helper re-verifies the sha256 (trust anchor =
  // HTTPS + the release .sha256; debs are unsigned), runs `dpkg -i`, then
  // restarts the user service — restart LAST, so the cgroup teardown can't
  // interrupt an in-flight dpkg. If the helper script is absent (an old build)
  // fall back to a verified download. `user` is the seeder's username, handed to
  // the helper so it restarts the right --user unit.
  deb: async ({ file, digest, version, platform, helperPath, user, exec, fsImpl }) => {
    const f = fsImpl || fs
    if (!helperPath || !f.existsSync(helperPath)) throw new NeedsHelperError(platform || 'linux')
    await exec(['pkexec', helperPath, file, digest, user || '', version || ''])
    return { restarted: true }
  },
}

// Full orchestration: plan -> download+verify -> apply. `exec`/`fetchImpl`/
// `fsImpl` are injectable. Aborts (and applies nothing) if verification fails.
async function applyUpdate (update, { platform = process.platform, target, requestDir, helperPath, user, workDir, fetchImpl, exec, fsImpl, log = () => {} } = {}) {
  const plan = planApply(update, platform)
  log('update', `applying v${update.latestVersion} via ${plan.applier}`)
  const { file, digest } = await downloadAndVerify(plan, { workDir, fetchImpl })
  log('update', `verified ${plan.assetName} (${digest.slice(0, 12)}…)`)
  const applier = APPLIERS[plan.applier]
  if (!applier) throw new Error('no applier for ' + plan.applier)
  const result = await applier({ file, digest, version: update.latestVersion, target, platform, requestDir, helperPath, user, exec, fsImpl })
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
  constructor ({ getUpdate, platform = process.platform, target = null, requestDir = null, helperPath = null, user = null, exec, fetchImpl, log = () => {} } = {}) {
    this._getUpdate = getUpdate
    this._platform = platform
    this._target = target        // self-apply payload path (Linux AppImage)
    this._requestDir = requestDir // macOS privileged-helper drop dir (slice 3b)
    this._helperPath = helperPath // Linux .deb root updater run via pkexec (slice 3c)
    this._user = user            // seeder username (Linux: restart the --user unit)
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
      // Target-based self-apply (the AppImage) needs a payload path up front;
      // without one we can't swap, so offer the verified download instead. The
      // Windows installer self-applies with no target, so it is exempt.
      if (plan.requiresTarget && !this._target) {
        this._state = { ...downloadFallback, reason: 'no-install-target' }; return this._state
      }
      const result = await applyUpdate(update, {
        platform: this._platform, target: this._target, requestDir: this._requestDir,
        helperPath: this._helperPath, user: this._user,
        exec: this._exec, fetchImpl: this._fetchImpl, log: this._log,
      })
      // macOS hands off to the privileged daemon (installs + restarts the agent
      // asynchronously); self-apply platforms restart the service directly.
      this._state = result.handedToHelper
        ? { status: 'applying-via-helper', version: update.latestVersion }
        : { status: 'restarting', version: update.latestVersion }
    } catch (e) {
      // NeedsHelperError = the privileged helper isn't installed (old build) or
      // the platform isn't wired yet -> fall back to a verified download.
      this._state = e.code === 'NEEDS_HELPER'
        ? { ...downloadFallback, reason: 'privileged-installer' }
        : { status: 'error', version: update.latestVersion, error: e.message }
      this._log('update', `apply failed: ${e.message}`)
    }
    return this._state
  }
}

module.exports = {
  NeedsHelperError, VerifyError, UpdateApplier, APPLE_TEAM_ID, parsePkgutilTeam,
  parseSha256Sidecar, sha256File, planApply, downloadTo, downloadAndVerify, applyUpdate, APPLIERS,
}
