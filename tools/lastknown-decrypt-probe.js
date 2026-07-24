// Which key were the last-known tips actually encrypted with?
// (investigation 2026-07-24, Hudgins circle V7yrQFkw)
//
// Symptom: three of five members' `lastknownCore` tips download and store fine
// on a real device, then decrypt to binary noise - "Unexpected token '+',
// \"+s...HT_C\"... is not valid JSON" - while another member's decrypts
// perfectly. Since a stream cipher never fails on a wrong key, that is a key
// mismatch, not a corrupt block.
//
// The block key derives from exactly three inputs (hypercore's
// DefaultEncryption.deriveKeys): the circle encryption key, the core's public
// key, and a `compat` flag that selects between two different hash
// constructions. The first two are provably identical on both sides - same key
// from the invite, same core opened by its own public key - so `compat` is the
// only free variable left.
//
// This settles it without a device: replicate the circle, pull each member's
// tip block RAW (open the core with no encryptionKey, so hypercore hands back
// exactly what is stored), then decrypt a copy under every candidate derivation
// and report which one yields JSON.
//
// Read-only: never appends, never writes to the live circle.
//
// Usage: node tools/lastknown-decrypt-probe.js "<invite-url>"
//   env: SYNC_MS (default 45000) replication wait before probing

const os = require('os')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const Autobase = require('autobase')
const Hypercore = require('hypercore')
const { parseInvite } = require('../src/invite')
const { topicForCircleKey } = require('../src/swarm')

const DefaultEncryption = Hypercore.DefaultEncryption
const SYNC_MS = Number(process.env.SYNC_MS || 45000)
const TIP_TIMEOUT_MS = 20000

// Every way the block key could have been derived, so the answer is a name
// rather than a guess.
const CANDIDATES = [
  { name: 'modern (compat:false)', opts: { block: false, compat: false } },
  { name: 'compat (compat:true)', opts: { block: false, compat: true } },
  { name: 'block-key (raw enc key)', opts: { block: true, compat: false } },
]

function tryDecrypt (rawBlock, index, blockKey) {
  // decrypt() mutates in place and treats the first 8 bytes as the blinded
  // fork padding, so hand it a copy and read the plaintext after the padding.
  const copy = b4a.from(rawBlock)
  try {
    DefaultEncryption.decrypt(index, copy, blockKey)
  } catch (e) {
    return { ok: false, why: 'decrypt threw: ' + e.message }
  }
  const body = copy.subarray(DefaultEncryption.PADDING)
  try {
    const parsed = JSON.parse(b4a.toString(body))
    return { ok: true, parsed }
  } catch (e) {
    return { ok: false, why: 'not JSON', preview: b4a.toString(body.subarray(0, 16)) }
  }
}

async function main () {
  const inviteArg = process.argv[2] || process.env.INVITE
  if (!inviteArg) { console.error('usage: node tools/lastknown-decrypt-probe.js "<invite-url>"'); process.exit(1) }
  const parsed = parseInvite(inviteArg)
  if (!parsed.ok) { console.error('bad invite:', parsed.error); process.exit(1) }
  const { circleId, name, circleKey, bootstrap, encryptionKey } = parsed
  if (!encryptionKey) { console.error('invite carries no encryption key; nothing to probe'); process.exit(1) }
  const encKeyBuf = b4a.from(encryptionKey, 'hex')
  console.log('circle:', name, circleId.slice(0, 8))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcprobe-'))
  const store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))
  swarm.join(topicForCircleKey(circleKey), { server: false, client: true })
  await swarm.flush()

  const ns = store.namespace(circleId)
  const base = new Autobase(ns, b4a.from(bootstrap, 'hex'), {
    valueEncoding: 'json',
    encryptionKey: encKeyBuf,
    open: (viewStore) => new Hyperbee(viewStore.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
    apply: async (nodes, view) => {
      for (const n of nodes) {
        const op = n.value
        if (op && op.type === 'put' && typeof op.key === 'string') await view.put(op.key, op.value)
      }
    },
  })
  await base.ready()
  console.log(`replicating for ${SYNC_MS}ms…`)
  await new Promise((r) => setTimeout(r, SYNC_MS))
  try { await base.update() } catch (e) { console.log('base.update failed:', e.message) }

  // Each member announces their last-known core key in the (encrypted) view,
  // which we can read because we hold the circle key.
  const announced = []
  for await (const { key, value } of base.view.createReadStream({ gt: 'lastknownCore:', lt: 'lastknownCore:~' })) {
    const pubkey = key.slice('lastknownCore:'.length)
    if (value && typeof value.coreKey === 'string') announced.push({ pubkey, coreKey: value.coreKey })
  }
  console.log(`\n${announced.length} members announce a last-known core\n`)

  for (const { pubkey, coreKey } of announced) {
    // NO encryptionKey: we want the bytes exactly as stored, to decrypt by hand.
    const core = store.get({ key: b4a.from(coreKey, 'hex') })
    await core.ready()
    try { await core.update({ wait: true }) } catch {}
    const label = `member ${pubkey.slice(0, 8)} core ${coreKey.slice(0, 8)}`
    if (core.length === 0) { console.log(`${label}: core empty / never synced`); continue }
    let raw
    try {
      raw = await core.get(core.length - 1, { wait: true, timeout: TIP_TIMEOUT_MS })
    } catch (e) {
      console.log(`${label}: tip fetch failed (${e.message})`)
      continue
    }
    if (!raw) { console.log(`${label}: tip unavailable`); continue }

    console.log(`${label}  len=${core.length} compat=${core.core ? core.core.compat : '?'} tipBytes=${raw.length}`)
    let solved = false
    // Was it ever encrypted at all? A writer whose local record carried no
    // encryption key writes plaintext, and a reader that holds one still strips
    // 8 bytes and XORs the rest - producing noise indistinguishable from a key
    // mismatch. So try the stored bytes verbatim before blaming a key.
    try {
      const asIs = JSON.parse(b4a.toString(raw))
      solved = true
      const ts = asIs?.ts ? new Date(asIs.ts).toISOString() : '(no ts)'
      console.log(`   NOT ENCRYPTED (raw bytes are JSON)  ts=${ts}`)
    } catch {
      console.log('   raw bytes: not JSON (so it is encrypted with something)')
    }
    for (const cand of CANDIDATES) {
      const keys = DefaultEncryption.deriveKeys(encKeyBuf, core.key, cand.opts)
      const r = tryDecrypt(raw, core.length - 1, keys.block)
      if (r.ok) {
        solved = true
        const ts = r.parsed?.ts ? new Date(r.parsed.ts).toISOString() : '(no ts)'
        console.log(`   ${cand.name}: JSON OK  ts=${ts}`)
      } else {
        console.log(`   ${cand.name}: ${r.why}${r.preview ? ' ' + JSON.stringify(r.preview) : ''}`)
      }
    }
    if (!solved) console.log('   >>> NO candidate derivation produced JSON')
    console.log('')
  }

  await swarm.destroy()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('done; throwaway store removed')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
