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

4. **Re-admission clears it.** The seeder's existing per-block `download` hook clears `seeder:revoked:{circleId}` the first time real blocks replicate for that circle again (question 4). Block replication cannot be spoofed, so it is evidence-based re-admission; no new message type is needed.

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

- Unit: member-side "on a revoked seeder row, build a revocation notice"; seeder-side "on notice, write `seeder:revoked` row"; "clear `seeder:revoked` on re-admission"; `seeder:enrolled:list` returns the `revoked` flag.
- Integration smoke: enroll a seeder in a circle from two member devices, revoke it on one member, confirm the seeder receives the notice and the dashboard flags the circle as revoked promptly (see Amendment: pushed immediately over a live connection).
- `npm run verify` green.

## Rollback

The change is purely additive (one new message type, one new local row family). To back out, revert the code: peers stop sending and handling the notice, and any `seeder:revoked` rows already written become inert (the UI no longer reads them). No persistent or cross-peer damage.

## Open questions (resolved 2026-05-21)

Resolved in conversation before implementation; each resolution is baked into the Scope above and recorded in `DECISIONS.md`.

1. **Authentication.** The seeder is blind and has no circle member list, so it cannot verify a revocation notice came from a real member rather than a malicious peer on the circle topic.
   **Resolved: advisory, UI-only.** The notice updates dashboard state and nothing else; it never drives automatic or network behavior. A spoofed notice at worst shows a wrong "revoked" badge the user dismisses with the existing Leave action, and real enforcement stays member-side (`classifySeederConnection`), untouched by a fake notice. A verifiable notice (forwarding the signed revocation row) was rejected: with no member list a valid signature only proves "someone signed this", not "an authorized member signed this", so full verification is not achievable here. The advisory model also keeps the change additive and T2.
2. **Topic behavior.** Should a revoked seeder stop announcing and joining that circle's swarm topic?
   **Resolved: keep joining and announcing.** The notice changes UI only. Acting on an unauthenticated notice by leaving the topic would let a spoofed notice deny a still-legitimate seeder, and it contradicts the existing peer-filter, which deliberately keeps the connection open for instant re-admission. One topic's cost is negligible.
3. **Enrollment lifecycle.** Keep a revoked circle in the enrolled list with a badge, or auto-remove it?
   **Resolved: keep it, with a badge, until the user clicks Leave.** Auto-removal would hide why a circle vanished and would let a spoofed notice silently evict circles. The existing Leave action clears it.
4. **Re-admission.** How is `seeder:revoked:{circleId}` cleared when a revoked seeder is re-admitted?
   **Resolved: clear it on the next successful block replication for that circle.** Real block replication cannot be spoofed, so it is evidence-based re-admission, unlike an "admitted" notice which would carry the exact spoofability of question 1. It needs no new message type. Trade-off: a re-admitted but idle circle keeps the badge until traffic resumes, which is acceptable since no replication means the seeder is not effectively seeding it yet.

## Amendment - 2026-05-21: instant propagation + durable revocation

Implementation surfaced two gaps; both fixed on the same branch before merge. Tier unchanged (T2): no new wire shape, key, or topic - a new send-trigger, an in-memory registry, and a behavior change on the admission apply path.

1. **Instant propagation.** The base design sent the revoke notice only when a member-role admission channel opens (a fresh connection), so a revoke made while already connected to the seeder did not reach it until the connection cycled. `circle:seeder:revoke` now also pushes the notice over any live connection to that seeder immediately, via an in-memory registry of member-role admission channels keyed by connection and circleId. The `revoked` message itself is unchanged.

2. **Durable revocation.** `handleSeederAnnounce` previously auto-re-admitted any announcing seeder, including revoked ones (this revises the 2026-05-20 follow-on "re-announce is a re-admission request"). Because a seeder announces on every connection, that silently undid every revocation on the seeder's next reconnect. Revised: an announce from an already-revoked seeder no longer auto-re-admits - the revocation stays in force and the member re-sends the revoke notice, which also closes the race where the seeder mounts the circle after the member connected and so missed the connect-time notice. First-time admission (no `seeder:{pubkey}` row yet) is still a frictionless auto-admit; re-admitting a revoked seeder is now an explicit action. Removing auto-re-admit broke the member UI's only re-admit path (the old flow was "set the seeder up again" so it re-announces and gets auto-re-admitted), so Settings to Seeders gained a "Re-admit" control - it calls the existing `circle:seeder:approve` IPC, which was already built for this but unwired - and the seeders list now keeps revoked seeders visible instead of dropping fully-revoked devices.

Mixed-fleet caveat: an old-code member still auto-re-admits a revoked seeder, so durable revocation holds only once a circle's members are all on new code. Acceptable at the v1 floor (test devices only, all reinstallable).
