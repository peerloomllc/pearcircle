// The legacy StartOS 0.3.5 .s9pk is ~3x the size of the 0.4 one and being phased
// out, so publishing it is opt-in. It is still built, because the 0.4 package is
// converted from it. These cases run the real pre-flight prompt and the real
// registry publisher.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8')
const PUBLISH = path.join(ROOT, 'seeder-launcher', 'scripts', 'publish-start9-registry.sh')

const prompt = SCRIPT.match(/^ {2}# Legacy StartOS 0\.3\.5 \.s9pk\.[\s\S]*?^ {2}fi$/m)[0]

function preflight ({ answer = '', skipStart9 = false, flag = false } = {}) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail
SKIP_START9=${skipStart9}; SKIP_START9_LEGACY=true; _START9_LEGACY_FLAG=${flag}
${prompt}
echo "RESULT=$SKIP_START9_LEGACY"`], { input: answer + '\n', encoding: 'utf8' })
  expect(r.status).toBe(0)
  return r.stdout.match(/RESULT=(\w+)/)[1]
}

test('pressing Enter skips the legacy package', () => {
  expect(preflight()).toBe('true')
})

test('answering y publishes it', () => {
  expect(preflight({ answer: 'y' })).toBe('false')
})

test('--skip-start9-legacy and --skip-start9 skip it without asking', () => {
  expect(preflight({ answer: 'y', flag: true })).toBe('true')
  expect(preflight({ answer: 'y', skipStart9: true })).toBe('true')
})

test('step 7 uploads the legacy s9pk only when opted in', () => {
  expect(SCRIPT).toMatch(/if ! \$SKIP_START9_LEGACY; then\n\s+RELEASE_ASSETS\+=\("\$START9_S9PK"\)/)
  expect(SCRIPT).toMatch(/SKIP_LEGACY="\$SKIP_START9_LEGACY"/)
})

test('the registry publisher leaves the 0.3.5 tree and its redirects alone when skipping legacy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start9-legacy-'))
  const site = path.join(dir, 'site')
  fs.mkdirSync(site)
  const redirects = '/package/v0/pearcircle-seeder.s9pk  https://github.com/peerloomllc/pearcircle/releases/download/v1.1.2/pearcircle-seeder.s9pk  302\n'
  fs.writeFileSync(path.join(site, '_redirects'), redirects)
  const git = (...a) => execFileSync('git', ['-C', site, ...a], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const s9pk = path.join(dir, 'pearcircle-seeder.s9pk')
  fs.writeFileSync(s9pk, 'not a real s9pk')

  // No start-cli on PATH, so the 0.4 half skips too and nothing else touches the clone.
  const r = spawnSync('bash', [PUBLISH, '1.1.3'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: dir,
      WEBSITE_DIR: site,
      S9PK: s9pk,
      S9PK_V2: path.join(dir, 'missing-v2.s9pk'),
      SKIP_LEGACY: 'true'
    }
  })
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/skipping the 0\.3\.5 \/package\/v0 registry/)
  expect(r.stdout).not.toMatch(/upserting pearcircle-seeder \/package\/v0/)
  expect(fs.readFileSync(path.join(site, '_redirects'), 'utf8')).toBe(redirects)
  expect(fs.existsSync(path.join(site, 'package'))).toBe(false)
})
