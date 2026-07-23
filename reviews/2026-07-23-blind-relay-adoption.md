# Blind relay adoption review

**Status: implemented, verify green, on-device verified on D2 in BOTH directions (relayed path proven against the relay node's own stats, direct-first proven to keep the relay out). Awaiting sign-off before merge.** Proposal `proposals/2026-07-23-blind-relay-adoption.md`, branch `feature/blind-relay`, PR #170. T3 because it points PearCircle at PeerLoom-operated infrastructure that carries user traffic, not because anything on the wire changed.

## What shipped

PearCircle's one member-mode Hyperswarm now passes `relayThrough` as a function (`src/lib/relay.js`), so a connection that cannot hole-punch escalates through the shared PeerLoom blind relay PearTune deployed and hardware-verified on 2026-07-23. Direct-first is structural, not a policy we enforce: Hyperswarm only sets `force=true` after this peer's own punch aborted. A Settings toggle (Staying in sync, "Connection helper", default ON) persists to the local Hyperbee under `relay` and is loaded before the swarm is built, so an opted-out user never relays even on the first connect. The seeder swarm is deliberately untouched, per the PearTune phase-1 finding that only the dialing side needs to request the relay.

## Validated

- `npm run verify` green: 753 tests (7 new in `tests/relay.test.js` pinning every branch of the policy plus the shared key), all three bundles build.
- The deployed relay answers on the baked key from this network (raw `dht.connect` smoke).
- Debug APK installed on D1 + D2. On D2: `init:swarm-created {"relay":true}`, `init:done`, peers still connect directly in ~3.6s so the relay correctly stays out on a punchable network, the toggle flips (`relay:toggled {"useRelay":false}`) and survives a force-stop relaunch (`init:swarm-created {"relay":false}`), and flipping it back on restores the default.

## The relayed path, proven (gap closed 2026-07-23)

Waiting for a genuinely-0%-punch network was unnecessary: a **throwaway force-relay build** (the policy fn returns the key unconditionally, reverted immediately after and never committed) proves the wiring against the relay node's own stats, which is the ground truth per PearTune. Clean A/B on D2, relay stats read over ssh from the droplet:

| | `sessions.active` | `pairings.active` | `pairings.matched` | `streams.active` |
|---|---|---|---|---|
| Baseline (PearTune traffic only) | 2 | 1 | 14 | 2 |
| Force-relay PearCircle build launched | **3** | **2** | **20** | **3** |
| Honest direct-first build relaunched | 2 | 1 | 20 (frozen) | 2 |

So PearCircle's connections really do pair and carry bytes through the relay when escalation fires, and the moment the honest build is back the relay drops to baseline and stays there while the phone connects **directly** in 2.9s. Both halves of the requirement are covered: the relayed path works, and the relay stays out of a punchable network.

Residual: this exercised the escalation *branch*, not the *trigger*. The `force=true` handoff after a real `HOLEPUNCH_ABORTED` is Hyperswarm's own code, unmodified and already hardware-proven by PearTune on a real cellular 0%-punch case, so what remains untested here is nothing PearCircle owns.

## Sign-off checklist

- [ ] T3 tier and the "PeerLoom now runs infrastructure PearCircle touches" consequence acknowledged.
- [ ] Default-ON toggle accepted (opt-out, not opt-in).
- [ ] Settings copy accepted as an honest disclosure: blind and stateless, but not zero-knowledge (the relay sees which two keys talk and how many bytes).
- [ ] The force-relay A/B accepted as sufficient proof of the relayed path (vs holding out for a real 0%-punch network).
- [ ] Seeder-side escalation correctly deferred rather than dropped.
