# Adopt the shared PeerLoom blind relay as PearCircle's off-LAN backstop

## Goal

Let two PearCircle members connect when the hole-punch never lands, by pointing PearCircle's one
member-mode Hyperswarm at the already-deployed, already-proven PeerLoom blind relay.

## Tier

**T3.** Not because the wire protocol changes (it does not), but because it introduces a
PeerLoom-operated piece of infrastructure that carries user traffic, which is the exact thing the
no-servers principle governs. Proposal + rollback + RCA readiness required.

This is an **adoption**, not a new design. The design, the load-bearing source reading, the relay
node and the hardware verification all live in `../peartune/proposals/2026-07-23-blind-relay.md` and
peartune `DECISIONS.md` 2026-07-23. Read that first; this file only records what is different here.

## What the relay is

A `hyperdht` node on a public VPS running a `blind-relay.Server`. When two peers cannot punch, both
dial the relay and it pairs their two half-connections by token and forwards bytes. It never holds a
key to the Noise session, so it sees ciphertext plus metadata (which two keys are talking, and how
many bytes). It stores nothing. It is transient encrypted transit, never a copy of anyone's data.

Already deployed (DigitalOcean droplet, `peartune-relay` systemd service, 2026-07-23). Public key
`qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy`. **App-agnostic by construction** - a blind
byte-forwarder does not know or care which app's bytes it carries - so PearCircle adopting it is a
config change on our side and no change at all on the relay.

## Scope

**Changes:**

- `src/lib/relay.js` (new). The baked relay public key plus `relayThroughFor`, the pure direct-first
  policy function. Mirrors `peartune/protocol/relay.js` deliberately, so the two apps cannot drift.
- `src/bare.js`, member-mode `new Hyperswarm(...)`: gains `relayThrough`, passed as a **function**
  (Hyperswarm accepts a key or a `(force, swarm) => key|null`) so the toggle is read live per connect
  and no reconnect is needed to apply a change.
- A privacy toggle persisted in the local Hyperbee (`relay` key) with `relay:get` / `relay:set` IPC
  and a Settings switch, default **on**.
- `tests/relay.test.js` pinning every branch of the policy.

**Does not change:**

- The wire protocol, Hyperbee keys, IPC message shapes and Autobase. Only socket acquisition changes,
  and only on the fail path.
- **The seeder.** Seed-mode's own Hyperswarm is left alone on purpose. Per the phase-1 finding in the
  PearTune proposal, only the *dialing* side needs to request the relay: hyperdht's server honors
  `remotePayload.relayThrough` and dials the relay itself on the peer's token, so a phone escalating
  to the relay reaches a NAT'd home seeder with no seeder change. Setting `relayThrough` on the
  seeder as well would make it relay *every* connection it dials, burning relay bandwidth even where
  the direct punch works. A seeder-initiated escalation is a possible later iteration, not this one.
- The blind seeder's role. The relay moves bytes between two live peers; the seeder holds data for
  peers that are never awake at the same time. They solve different problems and both stay.

**Explicitly out of scope, so it is not conflated:** this does **not** address the iOS
background-suspension wall. A relay cannot wake a suspended app. The iOS trip-capture item and the
push-wake gap are untouched by this.

## Why PearCircle wants it

Phone-to-phone is the hardest punch case there is: both ends are typically on carrier CGNAT, and
neither is a stable public host. The transition-lag investigation kept landing on the same lever -
the original 6-minute geofence notification was a moving iPhone with **no live peer for minutes**,
not slow replication over a live link. A relay does not make replication faster; it makes a
connection *exist* in the window where a punch would have failed. That is the lever.

## Compat

No wire change, so old and new peers interoperate. A new-code peer that escalates to the relay
connects to an old-code peer without the old peer knowing or caring, because the responder side is
handled by hyperdht (6.31.0 here, which supports the relay handshake on both roles). A build with the
toggle off, or an older build with no relay support, behaves exactly as today.

## Verify

- `npm run verify` green.
- `tests/relay.test.js`: direct-first (no relay on the first attempt), escalate-on-force, toggle-off
  wins, no-key-is-inert, key decodes to 32 bytes.
- On-device: two phones on cellular. Success = they connect and sync. Then the harder gate, matching
  PearTune phase 3: the relay node's own stats (`journalctl -u peartune-relay` on the droplet,
  `pairings.active` / `streams.active`) are the ground truth for whether a connection actually went
  through the relay - the phone-side `dht.stats.relaying` counter reads 0 even while relaying, since
  it tracks a different relay role. Confirm the relay stays OUT when a direct punch works.

## Rollback

Flip the toggle off, or delete the `relayThrough` option. Both degrade exactly to today's behavior.
If the relay node is down, nothing routes through it and peers that could not punch stay unreachable,
which is the status quo. No wire or storage change to unwind.

## RCA readiness / risks

- **Single point, open forwarder.** Same posture PearTune accepted: it forwards ciphertext for anyone
  presenting a token. Down = 0%-punch users lose the backstop, everyone else is unaffected.
- **Metadata disclosure.** The relay sees key-pair-to-key-pair and byte volume. State this honestly in
  the toggle copy. Do not call it zero-knowledge.
- **The no-servers claim.** PeerLoom now runs a piece of infrastructure. The honest framing is that it
  is optional (toggle off = pure peer-to-peer), blind (it cannot read anything) and stateless (it
  stores nothing). The user-facing disclaimer work is tracked separately and applies suite-wide.

## Open questions

- Should the seeder escalate on its own dials too? Deferred, see Scope.
- Should the app surface relay usage anywhere in the UI? Deferred until the phone-side counter is
  known to be meaningful (it was not for PearTune).
