// Seeder-launcher update checker (proposal 2026-06-05-seeder-update slice 2).
// Polls the GitHub Releases API for the repo's latest release, compares its tag
// to the running build version, and caches the result for the /api/update route
// + the WS snapshot. Fail-open: a GitHub outage records an `error` and never
// blocks the seeder. Notify-only at this slice; the one-click apply (slice 3)
// will consume the same assetUrl/sha256Url.

const { evaluateRelease } = require('../../src/lib/seederUpdateCheck')

const REPO = process.env.PEARCIRCLE_UPDATE_REPO || 'peerloomllc/pearcircle'
// PEARCIRCLE_UPDATE_LATEST_URL overrides the release-check endpoint. Its primary
// use is on-device update validation: point a seeder at a local "fake release"
// server (scripts/serve-local-release.js) serving GitHub-shaped JSON for a
// locally-built installer, so the full check -> download -> verify -> apply path
// runs without publishing a real release. It also allows a self-hosted release
// mirror (consistent with the no-central-infra principle). Unset = real GitHub.
const LATEST_URL = process.env.PEARCIRCLE_UPDATE_LATEST_URL || `https://api.github.com/repos/${REPO}/releases/latest`
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // hourly; GitHub's unauthenticated limit is 60/h

// How this seeder was installed, which decides the Linux artifact it is offered
// (the .deb pkexec-helper path vs the AppImage self-apply). The AppImage runtime
// exports APPIMAGE (the running image's path); its absence on Linux means a .deb
// /opt install. Other platforms have a single artifact, so the hint is unused.
function defaultInstallKind (platform) {
  if (platform !== 'linux') return undefined
  return process.env.APPIMAGE ? 'appimage' : 'deb'
}

class UpdateChecker {
  constructor ({ currentVersion, platform = process.platform, arch = process.arch, installKind = defaultInstallKind(platform), intervalMs = DEFAULT_INTERVAL_MS, log = () => {}, fetchImpl } = {}) {
    this._currentVersion = currentVersion
    this._platform = platform
    this._arch = arch
    this._installKind = installKind
    this._intervalMs = intervalMs
    this._log = log
    this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
    this._timer = null
    this._last = {
      currentVersion: currentVersion ?? null,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      assetName: null,
      assetUrl: null,
      sha256Url: null,
      checkedAt: null,
      error: null,
    }
  }

  get () { return this._last }

  async checkNow () {
    if (!this._fetch) {
      this._last = { ...this._last, checkedAt: Date.now(), error: 'no fetch available' }
      return this._last
    }
    try {
      const res = await this._fetch(LATEST_URL, {
        headers: { 'user-agent': 'pearcircle-seeder', accept: 'application/vnd.github+json' },
      })
      if (!res.ok) throw new Error('github http ' + res.status)
      const release = await res.json()
      const evald = evaluateRelease(release, { currentVersion: this._currentVersion, platform: this._platform, arch: this._arch, installKind: this._installKind })
      this._last = { ...evald, checkedAt: Date.now(), error: null }
      if (evald.updateAvailable) {
        this._log('update', `update available: v${evald.latestVersion} (running v${this._currentVersion})`)
      }
    } catch (e) {
      this._last = { ...this._last, checkedAt: Date.now(), error: e.message }
      this._log('update', `check failed: ${e.message}`)
    }
    return this._last
  }

  start () {
    this.checkNow().catch(() => {})
    this._timer = setInterval(() => this.checkNow().catch(() => {}), this._intervalMs)
    if (this._timer.unref) this._timer.unref()
    return this
  }

  stop () { if (this._timer) clearInterval(this._timer) }
}

module.exports = { UpdateChecker, REPO, LATEST_URL }
