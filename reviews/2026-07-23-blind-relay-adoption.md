# Blind relay adoption review

**Status: implemented, verify green, on-device smoke-tested on D2. Awaiting sign-off before merge.** Proposal `proposals/2026-07-23-blind-relay-adoption.md`, branch `feature/blind-relay`, PR #170. T3 because it points PearCircle at PeerLoom-operated infrastructure that carries user traffic, not because anything on the wire changed.

## What shipped

PearCircle's one member-mode Hyperswarm now passes `relayThrough` as a function (`src/lib/relay.js`), so a connection that cannot hole-punch escalates through the shared PeerLoom blind relay PearTune deployed and hardware-verified on 2026-07-23. Direct-first is structural, not a policy we enforce: Hyperswarm only sets `force=true` after this peer's own punch aborted. A Settings toggle (Staying in sync, "Connection helper", default ON) persists to the local Hyperbee under `relay` and is loaded before the swarm is built, so an opted-out user never relays even on the first connect. The seeder swarm is deliberately untouched, per the PearTune phase-1 finding that only the dialing side needs to request the relay.

## Validated

- `npm run verify` green: 753 tests (7 new in `tests/relay.test.js` pinning every branch of the policy plus the shared key), all three bundles build.
- The deployed relay answers on the baked key from this network (raw `dht.connect` smoke).
- Debug APK installed on D1 + D2. On D2: `init:swarm-created {"relay":true}`, `init:done`, peers still connect directly in ~3.6s so the relay correctly stays out on a punchable network, the toggle flips (`relay:toggled {"useRelay":false}`) and survives a force-stop relaunch (`init:swarm-created {"relay":false}`), and flipping it back on restores the default.

## Validation gap

No PearCircle connection has yet been observed actually going *through* the relay - every test-network path punches fine, which is exactly why the relay stays out. Proving the relayed path for PearCircle specifically needs a 0%-punch network and, per PearTune's phase 3, must be read from the relay node's own stats (`journalctl -u peartune-relay` on the droplet: `pairings.active` / `streams.active`), because the phone-side `dht.stats.relaying` counter reads 0 even while relaying. The mechanism itself is already hardware-proven end to end by PearTune on the same relay and the same hyperswarm/hyperdht versions, so this gap is about PearCircle's specific wiring, which the direct-first smoke above exercises everywhere except the escalation branch.

## Sign-off checklist

- [ ] T3 tier and the "PeerLoom now runs infrastructure PearCircle touches" consequence acknowledged.
- [ ] Default-ON toggle accepted (opt-out, not opt-in).
- [ ] Settings copy accepted as an honest disclosure: blind and stateless, but not zero-knowledge (the relay sees which two keys talk and how many bytes).
- [ ] Validation gap accepted, with the relay-node-stats check deferred to a real 0%-punch network.
- [ ] Seeder-side escalation correctly deferred rather than dropped.
