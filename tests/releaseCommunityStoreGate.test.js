const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The PeerLoom community store served 1.0.19 for seven releases because
// release.sh bumped its manifests and then printed "commit + push that repo to
// publish" - a line that scrolls past in a long release log. These cases pin
// the gate that turns that miss into a failed release.
//
// Two traps are covered because both actually happened: bumps left uncommitted,
// and a clone sitting on a feature branch so committing in place would still
// not publish.

// Mirrors the block at the end of release.sh.
const GATE = `
if [ -n "\${UMBREL_STORE_DIR:-}" ] && [ -d "\${UMBREL_STORE_DIR}/.git" ]; then
  _store_dirty=$(git -C "$UMBREL_STORE_DIR" status --porcelain -- '*pearcircle-seeder*' 2>/dev/null)
  _store_branch=$(git -C "$UMBREL_STORE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
  _store_default=$(git -C "$UMBREL_STORE_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  _store_default="\${_store_default:-master}"
  if [ -n "$_store_dirty" ]; then
    echo "RELEASE INCOMPLETE"
    if [ "$_store_branch" != "$_store_default" ]; then echo "WRONG BRANCH TOO"; fi
    exit 1
  fi
  if [ "$_store_branch" != "$_store_default" ]; then echo "BRANCH NOTE"; fi
fi
echo "GATE PASSED"
`

let tmp

function sh (cmd, cwd) {
  return execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

// A throwaway repo shaped like the store: a default branch recorded on a
// remote, so the gate resolves it the way it does against a real clone.
function makeStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'))
  const origin = path.join(dir, 'origin.git')
  const work = path.join(dir, 'work')
  sh(`git init -q --bare -b master "${origin}"`)
  sh(`git clone -q "${origin}" "${work}"`)
  sh('git config user.email t@t && git config user.name t', work)
  fs.mkdirSync(path.join(work, 'peerloom-pearcircle-seeder'))
  fs.writeFileSync(path.join(work, 'peerloom-pearcircle-seeder/umbrel-app.yml'), 'version: "1.0.19"\n')
  sh('git add -A && git commit -q -m init && git push -q origin master', work)
  sh('git remote set-head origin master', work)
  return work
}

function runGate (storeDir) {
  try {
    const out = execFileSync('bash', ['-c', `UMBREL_STORE_DIR="${storeDir}"\n${GATE}`], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '' }
  }
}

beforeEach(() => { tmp = makeStore() })
afterEach(() => { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }) })

describe('release.sh community store gate', () => {
  test('clean clone on the default branch passes', () => {
    const r = runGate(tmp)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/GATE PASSED/)
  })

  test('THE BUG: an uncommitted version bump fails the release', () => {
    fs.writeFileSync(path.join(tmp, 'peerloom-pearcircle-seeder/umbrel-app.yml'), 'version: "1.1.0"\n')
    const r = runGate(tmp)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/RELEASE INCOMPLETE/)
  })

  test('a bump on a non-default branch reports BOTH problems', () => {
    // The real shape: the clone was on `add-peartune`, so committing in place
    // would not have published either.
    sh('git checkout -q -b add-peartune', tmp)
    fs.writeFileSync(path.join(tmp, 'peerloom-pearcircle-seeder/umbrel-app.yml'), 'version: "1.1.0"\n')
    const r = runGate(tmp)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/RELEASE INCOMPLETE/)
    expect(r.out).toMatch(/WRONG BRANCH TOO/)
  })

  test('a clean clone parked on a feature branch warns but does not fail', () => {
    sh('git checkout -q -b add-peartune', tmp)
    const r = runGate(tmp)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/BRANCH NOTE/)
  })

  test('changes to OTHER apps do not fail the release', () => {
    // Unrelated work in the same store must not block a PearCircle release.
    fs.mkdirSync(path.join(tmp, 'peerloom-peartune'))
    fs.writeFileSync(path.join(tmp, 'peerloom-peartune/umbrel-app.yml'), 'version: "0.1.0"\n')
    const r = runGate(tmp)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/GATE PASSED/)
  })

  test('no store configured is a clean no-op', () => {
    const r = runGate('')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/GATE PASSED/)
  })
})
