#!/usr/bin/env node
// Manual smoke for swarm topic connectivity (slice 6C).
// Spins two Hyperswarms with distinct device keypairs, both join the same
// circle topic, and reports whether they discover each other via the public
// Holepunch DHT.
//
// Run: node scripts/two-swarm-smoke.js
// Exits 0 on bidirectional discovery, 1 on failure or timeout.
// Requires network access to the Holepunch bootstrap nodes.

const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const { topicForCircleKey } = require('../src/swarm')
const { generateKeypair } = require('../src/identity')
const { generateCircleKey } = require('../src/circle')

const TIMEOUT_MS = 30000

async function main () {
  const circleKey = generateCircleKey()
  const topic = topicForCircleKey(circleKey)
  console.log('circleKey:', circleKey.slice(0, 16) + '…')
  console.log('topic:    ', b4a.toString(topic, 'hex').slice(0, 16) + '…')

  const a = new Hyperswarm({ keyPair: generateKeypair() })
  const b = new Hyperswarm({ keyPair: generateKeypair() })

  const aPub = b4a.toString(a.keyPair.publicKey, 'hex').slice(0, 16)
  const bPub = b4a.toString(b.keyPair.publicKey, 'hex').slice(0, 16)
  console.log('A pubkey: ', aPub + '…')
  console.log('B pubkey: ', bPub + '…')

  let aSawB = false
  let bSawA = false

  a.on('connection', (conn, info) => {
    aSawB = true
    console.log('A → connection from', b4a.toString(info.publicKey, 'hex').slice(0, 16) + '…')
    conn.on('error', () => {})
  })
  b.on('connection', (conn, info) => {
    bSawA = true
    console.log('B → connection from', b4a.toString(info.publicKey, 'hex').slice(0, 16) + '…')
    conn.on('error', () => {})
  })

  a.join(topic, { server: true, client: true })
  b.join(topic, { server: true, client: true })

  console.log('Joining and flushing…')
  await Promise.all([a.flush(), b.flush()])

  const start = Date.now()
  while (Date.now() - start < TIMEOUT_MS) {
    if (aSawB && bSawA) break
    await new Promise(r => setTimeout(r, 250))
  }

  await Promise.all([a.destroy(), b.destroy()])

  if (aSawB && bSawA) {
    console.log('PASS: bidirectional connectivity confirmed')
    process.exit(0)
  } else {
    console.error('FAIL: aSawB=' + aSawB + ' bSawA=' + bSawA)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
