# Stale-connection shedding — drop dead swarm sockets fast so replication recovers

**Status**: Draft 2026-06-01. On-device validated 2026-05-31 (see Verify). Awaiting approval.

**Goal**: Cut the location-replication lag a moving device sees after a network change, by detecting and dropping a dead Hyperswarm connection at the secret-stream layer (a short timeout refreshed by the existing 5s keepalives) instead of waiting on UDX's slow internal timeout, plus an on-demand keepalive nudge on foreground and movement.

**Tier**: T1. No wire-format, Hyperbee-key, IPC-shape, or persisted-field change. It only changes local Hyperswarm connection lifecycle (how fast this device sheds a dead socket so it can redial). An old-code peer and a new-code peer still talk identically; the secret-stream `timeout` and `keepAlive` primitives are already supported on both ends regardless of this code. Documented as a proposal anyway because it tunes the swarm/replication core and resolves part of a recorded `TODO.md` limitation.

## Background

`TODO.md` records the limitation: "geofence/location notifications lag ~30s cross-device while the crossing device is moving." Root cause, confirmed 2026-05-22 and again in the 2026-05-30 lag investigation: when a device moves, a cell-tower handoff or wifi roam kills its Hyperswarm socket without firing `network:changed`. The dead socket then lingers in the swarm's connection set until UDX's internal timeout expires, and a fresh connection cannot form while the dead one occupies the set, so the fresh position cannot replicate. An earlier fix attempt (retain discovery handles, call `discovery.refresh()` on append) did not help, because re-announcing cannot beat the dead socket still sitting in the set.

Two facts make a cleaner fix possible (verified in `node_modules` 2026-05-30):
- HyperDHT sets `connectionKeepAlive: 5000` on every connection, so both ends send an empty keepalive every 5s.
- `@hyperswarm/secret-stream` supports `setTimeout(ms)` (destroys the stream if no inbound data arrives within `ms`, refreshed by `_onrawdata` on every inbound frame) and a one-shot `sendKeepAlive()`. PearCircle sets neither today, so dead-detection falls through to UDX.

## Scope

In scope:

- **Arm a secret-stream timeout on every member connection.** `conn.setTimeout(STALE_CONN_TIMEOUT_MS)` (15000ms) in `onSwarmConnection`. A live link's 5s keepalives keep refreshing it so it never trips; a dead link trips after ~15s and the socket is destroyed, letting Hyperswarm redial. This is the primary lever.
- **On-demand keepalive nudge.** `probeConnections()` writes a one-shot `sendKeepAlive()` on every active connection, called on app foreground and on each `location:update` (debounced `CONN_PROBE_DEBOUNCE_MS` = 3000ms). Secondary lever: it solicits traffic so a live peer converges promptly and a moving device pokes its links each fix.
- **Kill-switch + tunables.** `STALE_CONN_PROBE_ENABLED` (default true) disables both levers in one flip. `STALE_CONN_TIMEOUT_MS` and `CONN_PROBE_DEBOUNCE_MS` are the tuning knobs.
- **Observability.** `conn:stale-dropped` and `conn:probe` marks in the cold-start trace / logcat for confirming behavior on-device.

Out of scope:

- **The seeder connection path.** Only member connections (`onSwarmConnection`) arm the timeout; the seeder is not part of the moving-device case.
- **The cold-boot first-write lag** (`base.append` gating on `findingPeers`, ~66s). Separate `TODO.md` bug, different fix, untouched here.
- **Cellular-handoff detection** to proactively fire `network:changed`. A possible complementary follow-up; this proposal makes the dead socket self-heal instead.
- **A persistent runtime event log.** Attempted 2026-05-31 and reverted: shipping an IPC per `mark()` flooded the worklet IPC during the post-init replication burst and aborted the bare runtime (native `SIGABRT`). If revisited it must batch lines and flush on a timer, never one send per mark.

## Compat

Fully local and additive. No old/new peer interaction changes: `setTimeout` and `keepAlive` are standard secret-stream features both ends already run, and dropping a dead socket faster is behavior the swarm already expects (connections drop and redial normally). An old-code peer simply keeps relying on the slower UDX timeout for its own drops; a new-code peer sheds its dead sockets sooner. Disabling `STALE_CONN_PROBE_ENABLED` reverts to stock behavior with no migration.

Risk to live connections: arming a 15s timeout could in principle drop a healthy-but-silent link. It does not, because HyperDHT's 5s keepalive guarantees inbound traffic every 5s on a live link (3 keepalives per timeout window, tolerant of 2 losses). The 15s value is `> 2x` the keepalive specifically for this margin.

## Verify

`npm run verify` (jest + bundle builds) green. The behavior is connection-lifecycle I/O, not a pure unit, so coverage is on-device.

On-device (2026-05-31, D1 Pixel debug + iPhone Release, same circle):
- A moving/foreground test showed no perceptible lag in the iPhone's dot tracking on the viewer.
- Live logcat confirmed the mechanism: `conn:stale-dropped {"timeoutMs":15000}` fired when a socket went silent, and `peer:reconnected` landed within seconds once the peer was reachable again, with `conn:probe reason:location` firing each fix while moving.

Honest gap: a controlled A/B (flag on vs off over the identical drive) was **not** completed; adoption rests on the positive signals above and no observed regression, not a measured delta. Re-validate with the flag-off comparison if a regression is suspected.

## Rollback

Flip `STALE_CONN_PROBE_ENABLED` to false (no arm, no probe; connections fall back to stock UDX-timeout dead-detection). Or revert the change entirely: it is self-contained in `onSwarmConnection`, the `app:state` handler, and the `location:update` handler, with no persisted or wire footprint.

## Open questions

- **Q1: Keep the secondary `sendKeepAlive` probe, or ship only the timeout?** The timeout is the load-bearing lever; the probe's benefit to our own drop is marginal (our drop is driven by inbound silence, not our outbound frame). Kept for now because it was part of the validated configuration and is low-cost. Could be dropped in a follow-up if it proves to add nothing.
- **Q2: Tune `STALE_CONN_TIMEOUT_MS` (15s).** Lower detects faster but narrows the keepalive safety margin. 15s is conservative; a moving-test sweep could justify 10-12s.
- **Q3: `CONN_PROBE_DEBOUNCE_MS` (3s).** Fine at the current ~10s fix cadence; revisit if fix cadence changes.
- **Q4: Cellular-handoff `network:changed`** as a complement, so the swarm re-announces immediately rather than only self-healing via the timeout. Follow-up.
