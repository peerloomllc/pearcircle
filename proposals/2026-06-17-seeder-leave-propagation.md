# Seeder-initiated leave propagation + member-side removal

## Goal
When a seeder operator presses **LEAVE** for a circle on the seeder side (dashboard / launcher), that seeder should disappear from the circle members' Seeders list entirely. Today it lingers forever — either as a live entry or, once revoked, as a "re-admit" entry — because nothing makes a seeder go away from the member view.

## Tier
T2. Additive: one new optional `left` state on the existing replicated `seeder:{pubkey}` row, one new additive message ([5] `left`, seed→member) on the existing `pearcircle/seeder-admission/2` channel, and one new member IPC (`circle:seeder:remove`). No crypto, invite, or topic change; old builds ignore the unknown message index and the unknown row field.

## Background
The blind seeder (proposal 2026-05-19) has **no Autobase write access** — it only replicates encrypted blocks and exchanges content-blind notices over the admission channel. The member-written `seeder:{pubkey}` row is the source of truth for "is this circle seeded, by whom". A member can mark it `revoked` (`circle:seeder:revoke`), and durable revocation (2026-05-21) deliberately keeps revoked rows in the list so they can be re-admitted (2026-06-11-seeder-readmit).

`seeder:leave` (seeder side) tears down the seeder's swarm + cores for the circle and deletes its own local enrollment rows — but it cannot touch the member-side `seeder:{pubkey}` row. So a member who admitted a seeder sees it forever. Reported 2026-06-17: "if I LEAVE on the seeder side, the entry lingers in the mobile app with a re-admit button; it should be removed entirely."

## Scope

### New row state: `left`
A third terminal state for a `seeder:{pubkey}` row, distinct from `revoked`:
- `left: true`, `leftAt: number`, `leftBy: hex64` (the member who wrote it), alongside the usual `pubkey/writer/addedBy/addedAt/updatedAt/v/sig`.
- A `left` row is **filtered out of the member-facing lists entirely** (`circle:seeders:list`, `seeders:listAll`) — no "Seeding" line, no "Revoked"/"re-admit" line. The seeder simply vanishes.
- Unlike `revoked`, `left` is **not** added to the connection-refusal set (`seederPeerFilter`): a left seeder volunteered to go, and a later re-enroll must be able to reconnect and be auto-admitted.

### In-band leave notice (seed → member)
- Admission channel gains message `[5] left` (seed → member), additive after `[4] admitted`. Payload `{ type:'left', circleId }`; `circleId` is the trusted channel id, the body's is ignored.
- On `seeder:leave`, **before** tearing down, the seeder pushes `left` to every currently-connected member on that circle's admission channel. (Requires a seeder-side registry of its open admission-channel handles, which today are created and discarded.)
- A member receiving `left` resolves the seeder pubkey from the connection (`_connPubkey`) and writes the `left` tombstone for `seeder:{pubkey}` (signed by that member), if it currently holds a non-left row for it.

### Member-side manual removal (the reliable fallback)
- New IPC `circle:seeder:remove ({ circleId, pubkey })`: writes the `left` tombstone directly (member-initiated). Mirrors `circle:seeder:revoke` but produces a `left` row instead of a `revoked` one.
- UI: a **Remove** action in the Seeders list (distinct from **Revoke**), so a seeder that's gone — including one whose in-band notice was never delivered — can always be cleared by hand.

### Re-enrollment resurrection
If the seeder is later re-enrolled, its fresh announce auto-admits it (`handleSeederAnnounce` → `circle:seeder:approve`), writing a new row with `updatedAt = now` and no `left`/`revoked`. LWW (`updatedAt` strictly greater) means the fresh admit out-dates the `left` tombstone and the seeder reappears as live. No separate un-set needed.

### Apply rules (`shouldAcceptSeederRow`)
Extend to accept `left` rows: when `incoming.left === true`, require numeric `leftAt` (not future-dated) and `isHex64(leftBy)`. All existing rules (key match, signature over `writer`, writer-is-current-member, writer-not-removed, LWW on `updatedAt`) unchanged and still apply.

## The unavoidable caveat (no servers)
The in-band notice only reaches members **connected to the seeder at leave time**. If none are connected, the seeder tears down and won't reconnect (its enrollment is gone), so the notice is never delivered — those members keep seeing the seeder until they use **Remove** manually. This is inherent to the serverless design and is exactly why the manual path ships alongside the in-band one.

## Compat
Additive. Message `[5]` is additive on the admission channel (an old seeder never sends it; an old member ignores index 5). The `left` row field is ignored by old builds (they'd still show the seeder, but old builds had no way to remove it anyway). No migration. A `left` row produced by this change is a normal signed seeder row to every peer's apply branch; an old apply branch without the `left` validation would still accept it (the row is well-formed and the extra field is inert) and an old list would show it — acceptable, since the upgraded members get the intended hide.

## Verify
- New unit tests: `seederAdmission` round-trips `[5] left` (seed→member only; member never sends; old-peer index alignment holds). `shouldAcceptSeederRow` accepts a well-formed `left` row, rejects a `left` row missing `leftAt`/`leftBy` or future-dated, and honors LWW (a fresh re-admit with greater `updatedAt` beats a `left` tombstone). `buildSeederGone` shape.
- `npm run verify` green.
- Device smoke: admit a seeder on two member devices; press LEAVE on the seeder while a member is connected → seeder vanishes from both members' Seeders lists (no re-admit lingering). Re-enroll the same seeder → it reappears as live after approval. With no member connected at leave time, confirm **Remove** in Settings clears it.

## Rollback
Additive IPC + one channel message + one row field + UI button. Reverting removes them; any `left` rows already written just read as ordinary (non-revoked) seeder rows again to a reverted build, so the seeder reappears — no corruption.

## Slice plan
- **Slice 1:** pure layer — `seederAdmission.js` message `[5] left` + `sendLeft`/`onLeft`; `seederApply.js` `left` acceptance + `buildSeederGone`; unit tests.
- **Slice 2:** worklet wiring — seeder-side admission-channel registry + `leaveSeederCircle` push; member-side `onLeft` tombstone; apply-branch `left`; list filters; `circle:seeder:remove` IPC.
- **Slice 3:** UI — **Remove** action in `SeedersSection`; verify + build + device test.

## Decisions (2026-06-17)
- A left seeder VANISHES from the member list (not shown as revoked/re-admittable) — the reported desired behavior.
- `left` is a distinct state from `revoked`; only `revoked` drives durable connection refusal, so a re-enrolled seeder reconnects cleanly.
- Ship both the in-band notice and a manual member-side Remove, because the in-band path can't be guaranteed under the no-servers model.
