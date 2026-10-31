// release.sh runs background jobs, and the shared release library
// (../peerloom-release/release-lib.sh, release_upload_assets) uploads the GitHub
// release assets several at a time. These cases run the real code against a fake
// curl, so they check concurrency, exit statuses and cleanup without uploading
// anything.

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

test('exiting the script kills background jobs and their children', () => {
  const dir = tmp()
  const pidFile = path.join(dir, 'child.pid')
  const r = run(`
job() { sleep 60 & echo $! > "${pidFile}"; wait; }
job < /dev/null &
_BG_PIDS+=("$!")
while [ ! -s "${pidFile}" ]; do sleep 0.1; done
exit 0
`)
  expect(r.status).toBe(0)
  const child = Number(fs.readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(child, 0) } catch { alive = false }
  expect(alive).toBe(false)
})

// The upload moved from release.sh to the shared library on 2026-10-27.
const RELEASE_LIB = path.join(__dirname, '..', '..', 'peerloom-release', 'release-lib.sh')

function uploadRun (names, jobs) {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  const trace = path.join(dir, 'trace')
  fs.mkdirSync(bin)
  // Fake curl: lists no existing assets, and for each POST logs start/end, sleeps,
  // and answers HTTP 422 for any asset whose name contains "bad", 201 otherwise.
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
out=""; url=""; method=GET
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; -X) method="$2"; shift ;; http*) url="$1" ;; esac
  shift
done
if [ "$method" != POST ]; then echo '[]'; exit 0; fi
name="\${url##*name=}"
echo "start $name $(date +%s.%N)" >> "${trace}"
sleep 1
echo "end $name $(date +%s.%N)" >> "${trace}"
case "$name" in
  *bad*) echo '{"message":"Validation Failed"}' > "$out"; printf 422 ;;
  *) echo '{"id":1}' > "$out"; printf 201 ;;
esac
`, { mode: 0o755 })
  const assets = names.map(n => { const p = path.join(dir, n); fs.writeFileSync(p, 'x'); return `"${p}"` })
  const r = spawnSync('bash', ['-c', `set -euo pipefail
source "${RELEASE_LIB}"
GH_TOKEN=t RELEASE_UPLOAD_JOBS=${jobs}
release_upload_assets https://uploads.github.com/repos/o/r/releases/1/assets ${assets.join(' ')}
`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60000 })
  // Only the first, concurrent round counts towards the peak; a failed file's
  // retry runs on its own afterwards.
  const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(l => l.split(' '))
  let running = 0; let peak = 0
  for (const [kind] of events.sort((x, y) => Number(x[2]) - Number(y[2]))) {
    running += kind === 'start' ? 1 : -1
    peak = Math.max(peak, running)
  }
  return { r, peak }
}

test('assets upload several at a time, never more than RELEASE_UPLOAD_JOBS', () => {
  const { r, peak } = uploadRun(['a.apk', 'a.apk.sha256', 'b.s9pk', 'b.s9pk.sha256', 'c.pkg', 'c.pkg.sha256'], 4)
  expect(r.status).toBe(0)
  for (const n of ['a.apk', 'b.s9pk', 'c.pkg.sha256']) expect(r.stdout).toContain(`✓ ${n}`)
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(4)
  expect(uploadRun(['a', 'b', 'c', 'd'], 2).peak).toBe(2)
})

test('a failed upload still lets the others finish, is retried once, then fails the run', () => {
  const { r } = uploadRun(['good.apk', 'bad.s9pk', 'good.pkg'], 4)
  expect(r.status).toBe(1)
  expect(r.stdout).toContain('✓ good.apk')
  expect(r.stdout).toContain('✓ good.pkg')
  expect(r.stdout).toContain('✗ bad.s9pk failed (HTTP 422), trying again on its own')
  expect(r.stdout).toContain('✗ bad.s9pk failed again (HTTP 422)')
})
