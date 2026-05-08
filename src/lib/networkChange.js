// Network-change response. Called from the worklet's `network:changed`
// IPC handler when the native module reports the device's default
// network has changed (wifi <-> cell, vpn on/off, etc). Forces
// Hyperswarm to re-announce on the current network so peers can find
// us again without waiting on Hyperswarm's internal periodic re-announce.
// See proposal 2026-05-07-network-change-handler.md.
async function handleNetworkChange (swarm) {
  if (!swarm) return { ok: false, reason: 'no_swarm' }
  try {
    await swarm.flush()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

module.exports = { handleNetworkChange }
