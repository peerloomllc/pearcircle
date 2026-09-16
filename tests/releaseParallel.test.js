// release.sh runs the seeder builds as background jobs and uploads the GitHub
// release assets several at a time. These cases run the real blocks from the
// script against stub build scripts and a fake curl, so they check ordering,
// exit statuses and cleanup without building or uploading anything.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')

function between (start, end) {
  const a = SCRIPT.indexOf(start)
  const b = SCRIPT.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`block not found: ${start}`)
  return SCRIPT.slice(a, b)
}

const HELPERS = between('_BG_DIR=$(mktemp -d)', '# ---------------------------------------------------------------------------\n# Helper:')

function run (body, env = {}) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${HELPERS}\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000
  })
  return r
}

function tmp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-par-'))
}

test('_bg_follow shows the job\'s matching log lines and returns its exit status', () => {
  const dir = tmp()
  const log = path.join(dir, 'job.log')
  const r = run(`
job() { echo "==> step one" > "${log}"; echo "noise" >> "${log}"; sleep 1; echo "==> step two" >> "${log}"; return 3; }
_bg_start job job
if _bg_follow job "${log}" '^==>'; then echo "rc=0"; else echo "rc=$?"; fi
`)
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('      ==> step one')
  expect(r.stdout).toContain('      ==> step two')
  expect(r.stdout).not.toContain('noise')
  expect(r.stdout).toContain('rc=3')
})

test('exiting the script kills background jobs and their children', () => {
  const dir = tmp()
  const pidFile = path.join(dir, 'child.pid')
  const r = run(`
job() { sleep 60 & echo $! > "${pidFile}"; wait; }
_bg_start job job
while [ ! -s "${pidFile}" ]; do sleep 0.1; done
exit 0
`)
  expect(r.status).toBe(0)
  const child = Number(fs.readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(child, 0) } catch { alive = false }
  expect(alive).toBe(false)
})

test('desktop builds: Linux and macOS start at once, Windows waits for Linux and the Android build', () => {
  const dir = tmp()
  const sl = path.join(dir, 'seeder-launcher')
  const bin = path.join(dir, 'bin')
  const trace = path.join(dir, 'trace')
  fs.mkdirSync(path.join(sl, 'scripts'), { recursive: true })
  fs.mkdirSync(bin)
  const stub = (name, secs) => fs.writeFileSync(path.join(sl, 'scripts', name),
    `echo "start ${name} $(date +%s.%N)" >> "${trace}"; sleep ${secs}; echo "end ${name} $(date +%s.%N)" >> "${trace}"\n`)
  stub('build-linux.sh', 1)
  stub('build-windows-local.sh', 0)
  stub('build-macos-remote.sh', 0)
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const launch = between('_SLV="${RELEASE_TAG#v}"', '# ---------------------------------------------------------------------------\n# 3. Build signed release APK')
    .replace('_SL="$REPO_ROOT/seeder-launcher"', `_SL="${sl}"`)
    .replaceAll('/tmp/pearcircle-build-', `${dir}/build-`)

  const r = run(`
RELEASE_TAG=v9.9.9; REPO_ROOT="${dir}"
SKIP_DESKTOP=false; SKIP_LINUX=false; SKIP_WINDOWS=false; SKIP_MACOS=false
${launch}
sleep 2.5
echo "android-done $(date +%s.%N)" >> "${trace}"
touch "$_BG_DIR/android.done"
for j in linux windows macos; do if _bg_wait $j; then echo "$j ok"; else echo "$j failed"; fi; done
`, { PATH: `${bin}:${process.env.PATH}` })
  expect(r.stderr).toBe('')
  expect(r.stdout).toMatch(/linux ok\nwindows ok\nmacos ok/)

  const t = {}
  for (const line of fs.readFileSync(trace, 'utf8').trim().split('\n')) {
    const parts = line.split(' ')
    t[parts.slice(0, -1).join(' ')] = Number(parts.at(-1))
  }
  const androidDone = t['android-done']
  expect(t['start build-linux.sh']).toBeLessThan(androidDone)
  expect(t['start build-macos-remote.sh']).toBeLessThan(androidDone)
  expect(t['start build-windows-local.sh']).toBeGreaterThanOrEqual(t['end build-linux.sh'])
  expect(t['start build-windows-local.sh']).toBeGreaterThanOrEqual(androidDone)
})

const UPLOAD = between('  # --- Upload the assets, UPLOAD_JOBS', '\nelse\n  # Fallback: gh CLI')

function uploadRun (names, jobs) {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  const trace = path.join(dir, 'trace')
  fs.mkdirSync(bin)
  // Fake curl: logs start/end per upload, sleeps, and answers with an API error
  // for any asset whose name contains "bad".
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac
  shift
done
name="\${url##*name=}"
echo "start $name $(date +%s.%N)" >> "${trace}"
sleep 1
echo "end $name $(date +%s.%N)" >> "${trace}"
case "$name" in *bad*) echo '{"message":"Validation Failed"}' > "$out" ;; *) echo '{"id":1}' > "$out" ;; esac
`, { mode: 0o755 })
  const assets = names.map(n => { const p = path.join(dir, n); fs.writeFileSync(p, 'x'); return `"${p}"` })
  const r = run(`
_asset_content_type() { echo application/octet-stream; }
GH_TOKEN=t; REPO_SLUG=o/r; RELEASE_TAG=v9.9.9; UPLOAD_URL=https://uploads.example/assets
EXISTING_ASSETS_JSON='{}'; UPLOAD_JOBS=${jobs}
RELEASE_ASSETS=(${assets.join(' ')})
${UPLOAD}
`, { PATH: `${bin}:${process.env.PATH}` })
  const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => l.split(' '))
  let running = 0; let peak = 0
  for (const [kind] of events.sort((x, y) => Number(x[2]) - Number(y[2]))) {
    running += kind === 'start' ? 1 : -1
    peak = Math.max(peak, running)
  }
  return { r, peak }
}

test('assets upload several at a time, never more than UPLOAD_JOBS', () => {
  const { r, peak } = uploadRun(['a.apk', 'a.apk.sha256', 'b.s9pk', 'b.s9pk.sha256', 'c.pkg', 'c.pkg.sha256'], 4)
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('All 6 assets uploaded.')
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(4)
  expect(uploadRun(['a', 'b', 'c', 'd'], 2).peak).toBe(2)
})

test('a failed upload still lets the others finish, then fails the run naming it', () => {
  const { r } = uploadRun(['good.apk', 'bad.s9pk', 'good.pkg'], 4)
  expect(r.status).toBe(1)
  expect(r.stdout).toContain('Uploaded good.apk.')
  expect(r.stdout).toContain('Uploaded good.pkg.')
  expect(r.stdout).toContain('ERROR: Upload of bad.s9pk failed:')
  expect(r.stdout).toContain('1 asset(s) were not attached')
})
