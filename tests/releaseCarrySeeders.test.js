// A release that skips seeder builds carries the newest earlier seeder files
// forward (release.sh _carry_forward_seeders), so releases/latest always has
// every seeder download. Run for real against a fake GitHub of file:// URLs.

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')
const helper = SCRIPT.match(/^_carry_forward_seeders\(\) \{[\s\S]*?^\}$/m)[0]

// releases: [{ tag, files: [name], badSum: [name] }], newest first like the API.
function fakeGithub (releases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-seeders-'))
  const files = path.join(dir, 'files')
  fs.mkdirSync(files)
  const list = releases.map(({ tag, files: names = [], badSum = [] }) => {
    const assets = []
    for (const name of names) {
      const sub = path.join(files, tag)
      fs.mkdirSync(sub, { recursive: true })
      const body = Buffer.from(`${tag} ${name}`)
      fs.writeFileSync(path.join(sub, name), body)
      const hash = badSum.includes(name) ? '0'.repeat(64) : crypto.createHash('sha256').update(body).digest('hex')
      fs.writeFileSync(path.join(sub, name + '.sha256'), `${hash}  ${name}\n`)
      assets.push({ name, browser_download_url: `file://${sub}/${name}` })
      assets.push({ name: name + '.sha256', browser_download_url: `file://${sub}/${name}.sha256` })
    }
    return { tag_name: tag, draft: false, assets }
  })
  const api = path.join(dir, 'api', 'repos', 'o', 'r')
  fs.mkdirSync(api, { recursive: true })
  fs.writeFileSync(path.join(api, 'releases'), JSON.stringify(list))
  return dir
}

function carry (dir, thisTag, have = []) {
  const dest = path.join(dir, 'dest')
  const args = have.map((h) => `"${h}"`).join(' ')
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helper}\n_carry_forward_seeders "" o/r "${dest}" "${thisTag}" ${args}`], {
    env: { ...process.env, GITHUB_API: `file://${dir}/api` },
  })
  assert.equal(r.status, 0, String(r.stderr))
  return String(r.stdout).split('\n').filter(Boolean).map((p) => path.basename(p)).filter((n) => !n.endsWith('.sha256'))
}

const HISTORY = [
  { tag: 'v1.1.5', files: [] },
  { tag: 'v1.1.4', files: ['pearcircle-seeder-v2.s9pk'] },
  { tag: 'v1.1.2', files: ['pearcircle-seeder-v2.s9pk', 'pearcircle-seeder.s9pk', 'PearCircleSeeder-1.1.2.pkg'] },
  { tag: 'v1.1.1', files: ['PearCircleSeeder-1.1.1.pkg', 'PearCircleSeeder-Setup-1.1.1.exe'] },
  { tag: 'v1.1.0', files: ['pearcircle-seeder_1.1.0_amd64.deb', 'pearcircle-seeder_1.1.0_arm64.deb', 'PearCircleSeeder-x86_64.AppImage', 'PearCircleSeeder-aarch64.AppImage', 'PearCircleSeeder-1.1.0.pkg'] },
]

test('each seeder file comes from the newest release that has it', () => {
  const got = carry(fakeGithub(HISTORY), 'v1.1.5')
  assert.deepEqual(got.sort(), [
    'PearCircleSeeder-1.1.2.pkg',
    'PearCircleSeeder-Setup-1.1.1.exe',
    'PearCircleSeeder-aarch64.AppImage',
    'PearCircleSeeder-x86_64.AppImage',
    'pearcircle-seeder-v2.s9pk',
    'pearcircle-seeder.s9pk',
    'pearcircle-seeder_1.1.0_amd64.deb',
    'pearcircle-seeder_1.1.0_arm64.deb',
  ].sort())
})

test('the v2 s9pk comes from v1.1.4, not v1.1.2', () => {
  const dir = fakeGithub(HISTORY)
  carry(dir, 'v1.1.5')
  assert.equal(fs.readFileSync(path.join(dir, 'dest', 'pearcircle-seeder-v2.s9pk'), 'utf8'), 'v1.1.4 pearcircle-seeder-v2.s9pk')
})

test('files this release built are not carried', () => {
  const got = carry(fakeGithub(HISTORY), 'v1.1.5', ['PearCircleSeeder-1.1.5.pkg', 'PearCircleSeeder-1.1.5-x86_64.AppImage', 'pearcircle-seeder_1.1.5_amd64.deb'])
  assert.ok(!got.some((n) => n.endsWith('.pkg')))
  assert.ok(!got.includes('PearCircleSeeder-x86_64.AppImage'))
  assert.ok(!got.includes('pearcircle-seeder_1.1.0_amd64.deb'))
  assert.ok(got.includes('PearCircleSeeder-aarch64.AppImage'))
})

test('a file whose checksum does not match is skipped', () => {
  const hist = HISTORY.map((r) => r.tag === 'v1.1.1' ? { ...r, badSum: ['PearCircleSeeder-Setup-1.1.1.exe'] } : r)
  assert.ok(!carry(fakeGithub(hist), 'v1.1.5').some((n) => n.endsWith('.exe')))
})
