# Seeder revocation signal

## Goal

Give a revoked blind seeder an explicit, content-blind signal so its launcher dashboard stops presenting circles it can no longer seed.

## Tier

T2. Additive: a new message type on the existing seeder-admission Protomux channel, plus a new row family in the seeder's local Hyperbee. Old and new peers still interoperate (see Compat). Amends the T3 blind-seeder protocol (proposal `2026-05-19-blind-seeder-peers.md`); a reviewer may reclassify it T3 given it touches the seeder protocol.

## Background

A member can revoke a seeder. Revocation writes a `seeder:{pubkey}` row with `revoked: true` into the circle's autobase, and the member-side peer-filter (`classifySeederConnection`, `src/lib/seederPeerFilter.js`) stops replicating circle blocks to that seeder. The connection is deliberately left open so re-admission stays possible.

The seeder never learns it was revoked:

- It is blind. It does not open the circle's autobase, so it cannot read the `revoked` flag.
- The seeder-admission channel is one-way (seeder announces, member listens). There is no member-to-seeder path.
- The connection stays open, so the seeder cannot even infer revocation from a disconnect. "Revoked" and "members are simply offline" look identical to it.

Result: the seeder-launcher dashboard keeps listing a revoked circle as actively seeded, because `seeder:enrolled:list` reads the seeder's own local enrollment rows, which revocation never touches.

## Scope

### Changes

1. **Member-to-seeder notice.** When a member is connected to a seeder and finds, in a circle they share, a `seeder:{seederPubkey}` row with `revoked: true`, the member sends the seeder a revocation notice over the seeder-admission Protomux channel: a new message `{ type: 'revoked', circleId, revokedAt }`. The per-connection classification this needs (`classifySeederConnection`) already runs on every seeder connection.

2. **Seeder records it.** On receiving a revocation notice, the seeder writes `seeder:revoked:{circleId}` to its local Hyperbee: `{ circleId, revokedAt, noticedAt }`.

3. **UI surfaces it.** `seeder:enrolled:list` joins enrolled rows with `seeder:revoked:*` rows and returns a `revoked` flag (and `revokedAt`) per circle. The seeder-launcher dashboard renders a revoked circle distinctly (a "revoked" badge), with the existing Leave action to clear it.

### Out of scope / unchanged

- Revocation enforcement is unchanged. The member-side peer-filter remains the mechanism that actually stops a revoked seeder from replicating. This proposal only makes the seeder's UI honest.
- The blind-seeder property holds: the notice carries only a circle id and a timestamp, never circle content.
- The seed-invite format and the admission (announce) flow are unchanged.

## Compat

The notice is a new, additive Protomux message; peers that do not understand it ignore it.

- Old seeder, new member: the member sends the notice; the old seeder ignores the unknown message. Its UI stays stale (status quo). No break.
- New seeder, old member: the old member never sends a notice. The new seeder's UI stays stale for circles whose members have not upgraded (status quo). No break.
- Both upgraded: the notice flows and the dashboard updates.

No migration. The new `seeder:revoked:{circleId}` rows are absent by default, which reads as "not revoked."

## Verify

- Unit: member-side "on a revoked-everywhere circle, emit a revocation notice"; seeder-side "on notice, write `seeder:revoked` row"; `seeder:enrolled:list` returns the `revoked` flag.
- Integration smoke: enroll a seeder in a circle from two member devices, revoke it on one member, confirm the seeder receives the notice and the dashboard flags the circle as revoked within one connection cycle.
- `npm run verify` green.

## Rollback

The change is purely additive (one new message type, one new local row family). To back out, revert the code: peers stop sending and handling the notice, and any `seeder:revoked` rows already written become inert (the UI no longer reads them). No persistent or cross-peer damage.

## Open questions

1. **Authentication.** The seeder is blind and has no circle member list, so it cannot fully verify that a revocation notice came from a real member rather than a malicious peer on the circle topic. Recommended resolution: treat the notice as advisory and UI-only. The actual enforcement stays member-side, so a spoofed notice at worst shows a wrong "revoked" badge that the user can dismiss. Confirm this is acceptable, or design a verifiable notice (for example, forward the signed revocation row).
2. **Topic behavior.** Should a seeder that has been told it is revoked stop announcing and joining that circle's swarm topic, or keep trying in case of re-admission? Stopping saves resources; staying keeps re-admission instant.
3. **Enrollment lifecycle.** Keep a revoked circle in the enrolled list with a "revoked" badge until the user clicks Leave (recommended, for transparency), or auto-remove it.
4. **Re-admission.** If a revoked seeder is later re-admitted, how is the `seeder:revoked:{circleId}` row cleared? Options: the member sends an "admitted" notice that clears it, or the seeder clears it on the next successful block replication for that circle.
