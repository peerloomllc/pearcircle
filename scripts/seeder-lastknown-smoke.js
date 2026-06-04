#!/usr/bin/env node
// End-to-end smoke for proposal 2026-06-04-lastseen-ephemeral slice 2b:
// a blind seeder receives a member's last-known core key over the
// seeder-admission channel, opens the core blind, and replicates its
// (encrypted) tip so it can serve offline last-known.
//
// Drives the REAL src/bare.js worklet via the bare-runtime CLI (the same
// JSON-newline stdin/stdout IPC the RN shell + seeder-launcher use):
//   member : bare src/bare.js            (member mode)
//            init -> circle:create -> location:update -> circle:invite:seed
//   seeder : bare src/bare.js --seed     (blind seed mode)
//            init{mode:seed} -> seeder:enroll{invite}
// The two find each other over Hyperswarm; the member auto-admits the seeder
// and pushes its last-known core keys; the seeder opens + downloads the tip.
//
// PASS when the seeder emits `seeder:lastknown-opened` AND `seeder:lastknown-tip`
// (mark() lines on stderr). Run: node scripts/seeder-lastknown-smoke.js
// Exits 0 on PASS, 1 on FAIL / 120s timeout. Needs Holepunch bootstrap access.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.join(__dirname, '..')
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const PLATFORM = process.platform // linux | darwin
const BARE = process.env.BARE_BIN ||
  path.join(REPO, 'node_modules', `bare-runtime-${PLATFORM}-${ARCH}`, 'bin', 'bare')
const BUNDLE = path.join(REPO, 'src', 'bare.js')
const TIMEOUT_MS = 120000

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk2b-' + tag + '-'))
}

// One worklet subprocess with promise-based JSON IPC + a stderr mark log.
class Worklet {
  constructor (tag, extraArgs = []) {
    this.tag = tag
    this.marks = []
    this._buf = ''
    this._pending = new Map()
    this._id = 0
    this.proc = spawn(BARE, [BUNDLE, ...extraArgs], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (d) => this._onStdout(d))
    this.proc.stderr.on('data', (d) => {
      const s = d.toString()
      this.marks.push(s)
      if (process.env.VERBOSE) process.stderr.write('[' + tag + '] ' + s)
    })
  }

  _onStdout (d) {
    this._buf += d.toString()
    let nl
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim()
      this._buf = this._buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg && msg.id != null && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id)
        this._pending.delete(msg.id)
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
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(method + ' IPC timeout')) }
      }, 60000)
    })
  }

  sawMark (name) { return this.marks.some((m) => m.includes(name)) }
  kill () { try { this.proc.kill('SIGKILL') } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor (fn, label, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await sleep(500)
  }
  throw new Error('timeout waiting for ' + label)
}

async function main () {
  if (!fs.existsSync(BARE)) {
    console.error('FAIL: bare runtime not found at ' + BARE)
    process.exit(1)
  }
  const memberDir = tmpDir('member')
  const seederDir = tmpDir('seed')
  const member = new Worklet('member')
  const seeder = new Worklet('seeder', ['--seed'])
  const cleanup = () => {
    member.kill(); seeder.kill()
    try { fs.rmSync(memberDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(seederDir, { recursive: true, force: true }) } catch {}
  }

  try {
    await member.call('init', { dataDir: memberDir })
    await seeder.call('init', { mode: 'seed', dataDir: seederDir })

    const created = await member.call('circle:create', { name: 'lk2b-smoke' })
    if (!created?.circleId) throw new Error('circle:create returned no circleId')
    console.log('member created circle', created.circleId.slice(0, 8))

    // Give the member a position so its self last-known core has a tip + announce.
    await member.call('location:update', { lat: 37.7749, lon: -122.4194, ts: Date.now() })

    const seed = await member.call('circle:invite:seed', { circleId: created.circleId })
    if (!seed?.invite) throw new Error('circle:invite:seed returned no invite')

    const enrolled = await seeder.call('seeder:enroll', { invite: seed.invite })
    console.log('seeder enrolled', JSON.stringify(enrolled))

    // Keep the member emitting fixes so the seeder follows fresh tips.
    const ticker = setInterval(() => {
      member.call('location:update', { lat: 37.7749 + Math.random() * 0.001, lon: -122.4194, ts: Date.now() })
        .catch(() => {})
    }, 4000)

    try {
      await waitFor(() => seeder.sawMark('seeder:lastknown-opened'), 'seeder:lastknown-opened', TIMEOUT_MS)
      console.log('PASS step 1: seeder opened the member last-known core')
      await waitFor(() => seeder.sawMark('seeder:lastknown-tip'), 'seeder:lastknown-tip', 30000)
      console.log('PASS step 2: seeder replicated the (encrypted) tip')
    } finally {
      clearInterval(ticker)
    }

    console.log('\nPASS: blind seeder received + replicated the last-known core tip')
    cleanup()
    process.exit(0)
  } catch (e) {
    console.error('\nFAIL:', e.message)
    console.error('--- seeder marks (lastknown/admission) ---')
    for (const m of seeder.marks.join('').split('\n')) {
      if (/lastknown|admission|seeder:mounted|seeder:announce/.test(m)) console.error(m)
    }
    console.error('--- member marks (admission/lastknown) ---')
    for (const m of member.marks.join('').split('\n')) {
      if (/lastknown|admission/.test(m)) console.error(m)
    }
    cleanup()
    process.exit(1)
  }
}

main()
