#!/usr/bin/env node
// Pair-flow smoke for slice 6D (publish/read).
// Spins two corestores in tmp dirs, mounts a per-circle Autobase on each
// (owner = writer, joiner = reader), pipes corestore replication through
// hyperswarm connections, and verifies the joiner reads owner's circle and
// member rows from the replicated view.
//
// Run: node scripts/pair-smoke.js
// Exits 0 on PASS, 1 on FAIL or 30s timeout.
// Requires network access to the Holepunch bootstrap nodes.

const path = require('path')
const fs = require('fs')
const os = require('os')
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const { generateKeypair } = require('../src/identity')
const { generateCircleId, generateCircleKey } = require('../src/circle')
const { topicForCircleKey } = require('../src/swarm')

const TIMEOUT_MS = 30000

function openCircleView (store) {
  return new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  })
}

async function applyCircleNodes (nodes, view, base) {
  const bootstrapHex = b4a.toString(base.key, 'hex')
  for (const node of nodes) {
    const op = node.value
    if (!op || typeof op.type !== 'string') continue
    if (op.type === 'addWriter' && typeof op.pubkey === 'string') {
      await base.addWriter(b4a.from(op.pubkey, 'hex'))
      continue
    }
    if (op.type === 'put' && typeof op.key === 'string') {
      if (op.key === 'circle') {
        const fromHex = b4a.toString(node.from.key, 'hex')
        if (fromHex !== bootstrapHex) continue
        await view.put('circle', op.value)
        continue
      }
      if (op.key.startsWith('member:')) {
        await view.put(op.key, op.value)
      }
    }
  }
}

async function main () {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcircle-pair-'))
  const ownerDir = path.join(tmpRoot, 'owner')
  const joinerDir = path.join(tmpRoot, 'joiner')
  console.log('owner store: ', ownerDir)
  console.log('joiner store:', joinerDir)

  // Owner setup
  const ownerStore = new Corestore(ownerDir)
  await ownerStore.ready()
  const ownerIdentity = generateKeypair()
  const ownerPublicKey = b4a.toString(ownerIdentity.publicKey, 'hex')
  const circleId = generateCircleId()
  const circleKey = generateCircleKey()
  const circleName = 'Smith Family'

  const ownerNs = ownerStore.namespace(circleId)
  const ownerBase = new Autobase(ownerNs, null, {
    open: openCircleView,
    apply: applyCircleNodes,
    valueEncoding: 'json',
  })
  await ownerBase.ready()
  const bootstrap = b4a.toString(ownerBase.local.key, 'hex')
  console.log('bootstrap:   ', bootstrap.slice(0, 16) + '…')

  await ownerBase.append({
    type: 'put', key: 'circle',
    value: { id: circleId, name: circleName, ownerKey: ownerPublicKey, createdAt: Date.now(), v: 1 },
  })
  await ownerBase.append({
    type: 'put', key: 'member:' + ownerPublicKey,
    value: { pubkey: ownerPublicKey, displayName: 'Owner', joinedAt: Date.now(), v: 1 },
  })

  // Joiner setup
  const joinerStore = new Corestore(joinerDir)
  await joinerStore.ready()
  const joinerIdentity = generateKeypair()

  const joinerNs = joinerStore.namespace(circleId)
  const joinerBase = new Autobase(joinerNs, b4a.from(bootstrap, 'hex'), {
    open: openCircleView,
    apply: applyCircleNodes,
    valueEncoding: 'json',
  })
  await joinerBase.ready()

  // Swarms
  const ownerSwarm = new Hyperswarm({ keyPair: ownerIdentity })
  const joinerSwarm = new Hyperswarm({ keyPair: joinerIdentity })

  ownerSwarm.on('connection', (conn) => {
    ownerStore.replicate(conn)
    conn.on('error', () => {})
  })
  joinerSwarm.on('connection', (conn) => {
    joinerStore.replicate(conn)
    conn.on('error', () => {})
  })

  const topic = topicForCircleKey(circleKey)
  ownerSwarm.join(topic, { server: true, client: true })
  joinerSwarm.join(topic, { server: true, client: true })

  console.log('joining swarm topic and flushing…')
  await Promise.all([ownerSwarm.flush(), joinerSwarm.flush()])

  // Wait for replication to populate joiner's view
  const start = Date.now()
  let circleRow = null
  let memberRow = null
  while (Date.now() - start < TIMEOUT_MS) {
    await joinerBase.update()
    const got = await joinerBase.view.get('circle')
    if (got && got.value) {
      circleRow = got.value
      const m = await joinerBase.view.get('member:' + ownerPublicKey)
      if (m && m.value) {
        memberRow = m.value
        break
      }
    }
    await new Promise(r => setTimeout(r, 250))
  }

  await Promise.all([ownerSwarm.destroy(), joinerSwarm.destroy()])
  await ownerBase.close()
  await joinerBase.close()
  await ownerStore.close()
  await joinerStore.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })

  if (circleRow && circleRow.id === circleId && circleRow.name === circleName && memberRow && memberRow.pubkey === ownerPublicKey) {
    console.log('PASS: joiner replicated circle + owner-member rows')
    console.log('  circle:', JSON.stringify(circleRow))
    console.log('  member:', JSON.stringify(memberRow))
    process.exit(0)
  }
  console.error('FAIL: replication incomplete after', TIMEOUT_MS, 'ms')
  console.error('  circleRow:', circleRow)
  console.error('  memberRow:', memberRow)
  process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
