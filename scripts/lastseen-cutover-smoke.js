#!/usr/bin/env node
// End-to-end smoke for proposal 2026-06-04-lastseen-ephemeral slice 3
// (phase-2 cutover): a writer stops appending lastSeen to the Autobase once
// every member of a circle has announced a last-known core (growth-stop),
// self-driving and per-circle, with a keep-writing kill-switch for safety.
//
// Drives ONE real src/bare.js member worklet (a solo circle is the minimal
// converged state — the only member, us, has announced its core, so the gate
// engages). This deterministically exercises the full cutover machinery against
// the real worklet: the view-streamed gate computation, the cutover mark, and
// the kill-switch IPC + persistence + revert/re-engage. The MULTI-member
// decision rule (an unsupported peer keeps the write on) is covered by the unit
// test tests/lastSeenCutover.test.js; two-peer pairing is covered by
// scripts/pair-smoke.js. Steps:
//   1. create a circle + take a fix -> cutover engages (we are the sole member).
//   2. flip the keep-writing kill-switch on  -> cutover reverts.
//   3. flip it off                            -> cutover re-engages.
//
// Run: node scripts/lastseen-cutover-smoke.js
// Exits 0 on PASS, 1 on FAIL / timeout. Needs Holepunch bootstrap access (the
// worklet creates a swarm on boot), but no second peer.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.join(__dirname, '..')
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const BARE = process.env.BARE_BIN ||
  path.join(REPO, 'node_modules', `bare-runtime-${process.platform}-${ARCH}`, 'bin', 'bare')
const BUNDLE = path.join(REPO, 'src', 'bare.js')

class Worklet {
  constructor (tag, extraArgs = []) {
    this.tag = tag; this.marks = []; this._buf = ''; this._pending = new Map(); this._id = 0
    this.proc = spawn(BARE, [BUNDLE, ...extraArgs], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (d) => this._onStdout(d))
    this.proc.stderr.on('data', (d) => { this.marks.push(d.toString()); if (process.env.VERBOSE) process.stderr.write('[' + tag + '] ' + d) })
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-'))
  const w = new Worklet('solo')
  const cleanup = () => { w.kill(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

  const inCutover = async (circleId) => {
    const r = await w.call('lastSeen:cutover:get').catch(() => null)
    return !!r?.cutoverCircles?.includes(circleId)
  }
  const waitFor = async (fn, label, tries, gapMs) => {
    for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(gapMs) }
    throw new Error('timeout waiting for ' + label)
  }

  try {
    await w.call('init', { dataDir: dir })
    const created = await w.call('circle:create', { name: 'cutover-solo' })
    const circleId = created.circleId
    if (!circleId) throw new Error('circle:create returned no circleId')
    console.log('created circle', circleId.slice(0, 8))
    await w.call('location:update', { lat: 37.7749, lon: -122.4194, ts: Date.now() })

    // 1. Converge: sole member, own core announced -> cutover engages (5s sweep).
    await waitFor(() => inCutover(circleId), 'cutover to engage', 12, 2500)
    console.log('PASS step 1: Autobase lastSeen write stopped (cutover engaged)')

    // 2. Keep-writing kill-switch on -> cutover reverts.
    const set1 = await w.call('lastSeen:cutover:setForceWrite', { enabled: true })
    if (set1.forceAutobaseLastSeen !== true) throw new Error('setForceWrite(true) did not stick')
    await waitFor(async () => !(await inCutover(circleId)), 'cutover to revert', 8, 1500)
    console.log('PASS step 2: keep-writing kill-switch reverted the cutover')

    // 3. Kill-switch off -> cutover re-engages on the next sweep.
    await w.call('lastSeen:cutover:setForceWrite', { enabled: false })
    await waitFor(() => inCutover(circleId), 'cutover to re-engage', 12, 2500)
    console.log('PASS step 3: cutover re-engaged after clearing the kill-switch')

    console.log('\nPASS: phase-2 cutover engages on convergence; kill-switch toggles it')
    cleanup(); process.exit(0)
  } catch (e) {
    console.error('\nFAIL:', e.message)
    const ls = w.marks.join('').split('\n').filter((m) => /lastseen:cutover|lastseen:force|lastknown:announced/.test(m))
    console.error('--- cutover marks ---\n' + ls.slice(-10).join('\n'))
    cleanup(); process.exit(1)
  }
}

main()
