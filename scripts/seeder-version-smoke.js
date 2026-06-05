#!/usr/bin/env node
// End-to-end smoke for proposal 2026-06-05-seeder-update slice 1 (version
// visibility): a seeder reports its build version, and a circle member learns
// it over the seeder-admission announce and surfaces it via seeders:listAll.
//
// Drives two real src/bare.js worklets over real Hyperswarm:
//   member : init -> circle:create -> location:update -> circle:invite:seed
//   seeder : init{mode:seed, version:'9.9.9'} -> seeder:enroll{invite}
// The seeder announces (carrying its version); the member auto-admits and
// records it. PASS when the member's seeders:listAll shows version '9.9.9'.
//
// Run: node scripts/seeder-version-smoke.js  (needs Holepunch bootstrap access)

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.join(__dirname, '..')
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const BARE = process.env.BARE_BIN ||
  path.join(REPO, 'node_modules', `bare-runtime-${process.platform}-${ARCH}`, 'bin', 'bare')
const BUNDLE = path.join(REPO, 'src', 'bare.js')
const SEEDER_VERSION = '9.9.9'
const TIMEOUT_MS = 120000

class Worklet {
  constructor (tag, extraArgs = []) {
    this.tag = tag; this._buf = ''; this._pending = new Map(); this._id = 0
    this.proc = spawn(BARE, [BUNDLE, ...extraArgs], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (d) => this._onStdout(d))
    if (process.env.VERBOSE) this.proc.stderr.on('data', (d) => process.stderr.write('[' + tag + '] ' + d))
  }
  _onStdout (d) {
    this._buf += d.toString(); let nl
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim(); this._buf = this._buf.slice(nl + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg && msg.id != null && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id); this._pending.delete(msg.id)
        if (msg.error) reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
  }
  call (method, args = {}) {
    const id = ++this._id
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ id, method, args }) + '\n')
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(method + ' IPC timeout')) } }, 60000)
    })
  }
  kill () { try { this.proc.kill('SIGKILL') } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main () {
  if (!fs.existsSync(BARE)) { console.error('FAIL: bare runtime not found at ' + BARE); process.exit(1) }
  const dirM = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-m-'))
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-s-'))
  const member = new Worklet('member')
  const seeder = new Worklet('seeder', ['--seed'])
  const cleanup = () => {
    member.kill(); seeder.kill()
    try { fs.rmSync(dirM, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(dirS, { recursive: true, force: true }) } catch {}
  }

  try {
    await member.call('init', { dataDir: dirM })
    await seeder.call('init', { mode: 'seed', dataDir: dirS, version: SEEDER_VERSION })

    // Sanity: the seeder echoes its version locally.
    const st = await seeder.call('seeder:status')
    if (st.version !== SEEDER_VERSION) throw new Error('seeder:status version = ' + st.version)
    console.log('seeder reports version', st.version)

    const created = await member.call('circle:create', { name: 'sv-smoke' })
    await member.call('location:update', { lat: 1, lon: 2, ts: Date.now() })
    const seed = await member.call('circle:invite:seed', { circleId: created.circleId })
    await seeder.call('seeder:enroll', { invite: seed.invite })

    // Wait for the member to admit the seeder and record its announced version.
    const start = Date.now()
    let seen = null
    while (Date.now() - start < TIMEOUT_MS) {
      const r = await member.call('seeders:listAll').catch(() => null)
      const entry = r?.seeders?.find((s) => s.version === SEEDER_VERSION)
      if (entry) { seen = entry; break }
      await sleep(3000)
    }
    if (!seen) throw new Error('member never surfaced the seeder version via seeders:listAll')
    console.log('PASS: member surfaced seeder version', seen.version, 'for', seen.pubkey.slice(0, 8))

    console.log('\nPASS: seeder build version travels over the admission announce to the member')
    cleanup(); process.exit(0)
  } catch (e) {
    console.error('\nFAIL:', e.message)
    cleanup(); process.exit(1)
  }
}
main()
