// Device-level seeder auto-follow channel. Proposal amendment 2026-05-20
// (blind-seeder auto-follow).
//
// Once a member marks a seeder device as "followed", the member pushes
// its full seed-invite bundle to that seeder over the Hyperswarm
// connection they already share for some other circle. The seeder
// auto-enrolls any circle it isn't already in, so circles created or
// joined after setup get seeded with no manual re-paste.
//
// Wire: protocol 'pearcircle/seeder-sync/1', a single channel per
// connection (fixed id — not per-circle, unlike the admission channel).
//
// Roles:
//   'member' — opened by a member-mode worklet on a connection whose
//              remote is one of its followed seeders. Sends one
//              { invites: string[] } message on channel open; resend()
//              re-pushes after a circle:create / circle:join.
//   'seed'   — opened by a seed-mode worklet. Receives the bundle and
//              hands it to onBundle for the trust check + enroll.

const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const SEEDER_SYNC_PROTOCOL = 'pearcircle/seeder-sync/1'
const SYNC_CHANNEL_ID = b4a.from('seeder-sync')

function setupSeederSyncChannel ({ conn, role, getBundle, onBundle, mark }) {
  if (role !== 'member' && role !== 'seed') {
    throw new Error('role must be "member" or "seed"')
  }
  const mux = Protomux.from(conn)
  const trace = (name, extra) => {
    if (typeof mark === 'function') {
      try { mark(name, { role, ...(extra || {}) }) } catch {}
    }
  }

  let bundleMessage = null

  async function sendBundle () {
    if (role !== 'member' || !bundleMessage) return
    let invites = []
    try {
      invites = (await (typeof getBundle === 'function' ? getBundle() : [])) || []
    } catch (e) {
      trace('seedersync:getbundle-failed', { err: e?.message ?? String(e) })
      return
    }
    if (!Array.isArray(invites) || invites.length === 0) return
    try {
      bundleMessage.send({ invites })
      trace('seedersync:bundle-sent', { count: invites.length })
    } catch (e) {
      trace('seedersync:bundle-send-failed', { err: e?.message ?? String(e) })
    }
  }

  const channel = mux.createChannel({
    protocol: SEEDER_SYNC_PROTOCOL,
    id: SYNC_CHANNEL_ID,
    onopen () {
      trace('seedersync:onopen')
      if (role === 'member') sendBundle()
    },
    onclose () { trace('seedersync:onclose') },
  })
  if (!channel) {
    trace('seedersync:create-failed')
    return null
  }

  bundleMessage = channel.addMessage({
    encoding: c.json,
    onmessage: async (msg) => {
      if (role !== 'seed') return
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.invites)) {
        trace('seedersync:bundle-rejected', { reason: 'shape' })
        return
      }
      const invites = msg.invites.filter((x) => typeof x === 'string' && x.length > 0)
      trace('seedersync:bundle-received', { count: invites.length })
      try {
        if (typeof onBundle === 'function') await onBundle({ invites })
      } catch (e) {
        trace('seedersync:onbundle-failed', { err: e?.message ?? String(e) })
      }
    },
  })

  channel.open()
  trace('seedersync:channel-opened')
  // resend() lets circle:create / circle:join re-push the bundle over an
  // already-open channel so a new circle seeds without a reconnect.
  return { channel, resend: sendBundle }
}

module.exports = { SEEDER_SYNC_PROTOCOL, setupSeederSyncChannel }
