#!/usr/bin/env node
// Pair-flow smoke for slices 6D + 6E.
// Spins two corestores in tmp dirs, mounts a per-circle Autobase on each
// (owner = founding writer, joiner = reader), pipes corestore replication
// AND the pearcircle/pair/1 protomux channel through hyperswarm connections.
// Verifies:
//   1. Replication: joiner reads owner's circle + member-owner rows (6D)
//   2. addWriter:   joiner sends writerHello, owner appends addWriter,
//                   joiner becomes base.writable (6E)
//   3. Member claim: joiner appends member:{joinerKey}, owner reads it (6E)
//
// Run: node scripts/pair-smoke.js
// Exits 0 on PASS, 1 on FAIL or 30s timeout per phase.
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
const { setupPairChannel } = require('../src/pair')

const PHASE_TIMEOUT_MS = 90000

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

async function waitFor (label, predicate) {
  const start = Date.now()
  while (Date.now() - start < PHASE_TIMEOUT_MS) {
    if (await predicate()) return true
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('timeout waiting for: ' + label)
}

async function main () {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcircle-pair-'))
  const ownerDir = path.join(tmpRoot, 'owner')
  const joinerDir = path.join(tmpRoot, 'joiner')
  console.log('owner store: ', ownerDir)
  console.log('joiner store:', joinerDir)

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

  const joinerStore = new Corestore(joinerDir)
  await joinerStore.ready()
  const joinerIdentity = generateKeypair()
  const joinerPublicKey = b4a.toString(joinerIdentity.publicKey, 'hex')

  const joinerNs = joinerStore.namespace(circleId)
  const joinerBase = new Autobase(joinerNs, b4a.from(bootstrap, 'hex'), {
    open: openCircleView,
    apply: applyCircleNodes,
    valueEncoding: 'json',
  })
  await joinerBase.ready()

  const ownerSwarm = new Hyperswarm({ keyPair: ownerIdentity })
  const joinerSwarm = new Hyperswarm({ keyPair: joinerIdentity })

  ownerSwarm.on('connection', (conn) => {
    ownerStore.replicate(conn)
    setupPairChannel({
      conn, circleId, base: ownerBase,
      onWriterAdded: (k) => console.log('owner: addWriter appended for', k.slice(0, 16) + '…'),
    })
    conn.on('error', () => {})
  })
  joinerSwarm.on('connection', (conn) => {
    joinerStore.replicate(conn)
    setupPairChannel({ conn, circleId, base: joinerBase })
    conn.on('error', () => {})
  })

  const topic = topicForCircleKey(circleKey)
  ownerSwarm.join(topic, { server: true, client: true })
  joinerSwarm.join(topic, { server: true, client: true })
  console.log('joining swarm topic and flushing…')
  await Promise.all([ownerSwarm.flush(), joinerSwarm.flush()])

  // Phase 1: replication of circle + member-owner
  await waitFor('joiner reads circle + member-owner', async () => {
    await joinerBase.update()
    const c = await joinerBase.view.get('circle')
    const m = await joinerBase.view.get('member:' + ownerPublicKey)
    return Boolean(c?.value && m?.value)
  })
  console.log('PHASE 1 OK: joiner replicated circle + member-owner rows')

  // Phase 2: joiner becomes a writer
  await waitFor('joiner.base.writable', async () => {
    await joinerBase.update()
    return joinerBase.writable === true
  })
  console.log('PHASE 2 OK: joiner is now a writer (writable=true)')

  // Phase 3: joiner appends own member row, owner reads it
  await joinerBase.append({
    type: 'put', key: 'member:' + joinerPublicKey,
    value: { pubkey: joinerPublicKey, displayName: 'Joiner', joinedAt: Date.now(), v: 1 },
  })

  await waitFor('owner reads joiner member row', async () => {
    await ownerBase.update()
    const m = await ownerBase.view.get('member:' + joinerPublicKey)
    return Boolean(m?.value && m.value.pubkey === joinerPublicKey)
  })
  console.log('PHASE 3 OK: owner replicated joiner member row')

  await Promise.all([ownerSwarm.destroy(), joinerSwarm.destroy()])
  await ownerBase.close()
  await joinerBase.close()
  await ownerStore.close()
  await joinerStore.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })

  console.log('PASS: full bidirectional pair flow (replication + addWriter + member claim)')
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e?.message ?? e); process.exit(1) })
