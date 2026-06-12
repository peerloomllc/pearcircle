# Seeder revoke/re-admit — explicit admission signal, drop the fragile auto-clear

**Status**: Validated 2026-06-12. Root causes confirmed on-device (see Background); two-app validation passed (Pixel member + TCL member + macOS seeder v1.0.17). Revoke stuck on a live connection, a stale-row TCL reconnect was ordered out as `seeder:admit-notice-stale` (no flap), and re-admit cleared via the newer timestamp — see the Verify section and DECISIONS 2026-06-12.

**Goal**: Make seeder revoke actually stick and re-admit actually restore the seeder, by clearing the seeder's revoked flag on an explicit `admitted` admission-channel signal (mirroring the existing `revoked` one) instead of on any downloaded block, and by resuming replication to a re-admitted seeder.

**Tier**: T2. Adds one protomux message (`[4] admitted`, member -> seed) to the seeder-admission channel. Additive: registered after the existing messages so indices line up with older peers, no protocol-version bump. An old seed without `[4]` ignores it; an old member never sends it. Plus a local replication-lifecycle change (resume on re-admit) and removal of the seed-side download-triggered auto-clear.

## Amendment 2026-06-12 — order the on-open push with a last-writer-wins clock

First-cut testing surfaced a third flap. The on-open push (Scope item 4) sends the member's *local* seeder row, which on a freshly-reconnected, not-yet-synced device is stale. A device that still held the old `admitted` row would, on channel open, push `admitted` and clear a revoke another member had just applied — the same divergence the explicit signal was meant to kill, now driven by a lagging reader instead of `onDownload`.

Fix: both notices carry a timestamp from the seeder row's `updatedAt` (the row's monotonic LWW field, bumped on every revoke/admit) — `revoked` already carried `revokedAt` (== `updatedAt` at revoke time); `admitted` now carries `updatedAt` too. The blind seed keeps an in-memory `_seederFlagTs` Map (circleId → last-applied verdict ts), seeded at boot from the persisted `seeder:revoked:*` `revokedAt`, and ignores any notice older than the stored ts (`seeder:revoke-notice-stale` / `seeder:admit-notice-stale`). A null ts from a legacy peer is unorderable and still applies, so no regression. `approveSeederRow` returns `updatedAt` so `circle:seeder:approve` can stamp the live re-admit push.

Validated on-device 2026-06-12: a stale TCL reconnect pushed `admitted` with `updatedAt:1781270933422` against an applied revoke at `1781274116063`; the seed logged `seeder:admit-notice-stale` and held the revoke. Re-admit (newer `updatedAt`) then cleared it.

## Background

Two bugs in the blind-seeder revoke/re-admit flow, both confirmed on-device 2026-06-11 (member = Pixel debug build, seed = macOS seeder rebuilt to the current `/2` admission protocol):

1. **Revoke doesn't stick on a live connection.** The seed records the revoke from the admission-channel notice, then clears it ~12ms later. Cause: revoking also appends a `seeder:{pubkey}` block to the member's core; on a still-live connection the seed downloads that very block, and the seed's `onDownload` auto-clear ("a downloaded block is proof members are replicating again, clear the revoke") fires on it. Trace: `seeder:revocation-noticed` at 13:06:03.831 -> `seeder:revocation-cleared` at 13:06:03.843. The member shows the seeder revoked (it wrote the row); the seed shows it not revoked and keeps seeding. The two diverge.

2. **Re-admit doesn't restore a revoked-everywhere seeder.** When a seeder is revoked from every circle, the member skips `_store.replicate(conn)` at connect time (`classifySeederConnection` -> `revoked-everywhere`). After a reconnect the seed is stuck revoked (no blocks flow, nothing to auto-clear), and "Re-admit all" writes the new row but never resumes replication, so it stays stuck.

The shared root cause is that the seed (blind, no encryption key, can't read its own admission row) inferred its admission state from incidental block downloads. That heuristic is wrong in both directions.

## Scope

In scope:

- **New `[4] admitted` admission-channel message** (`src/seederAdmission.js`), member -> seed, symmetric to `[1] revoked`. `sendAdmitted()` (member) + `onAdmitted` (seed). Additive after `[3] writerCores`.
- **Explicit clear on the seed** (`src/bare.js`, `handleSeederAdmittedNotice`): an `admitted` notice clears `seeder:revoked:{circleId}` + the in-memory set. Wired into both seed-role channel setups.
- **Remove the `onDownload` auto-clear** (`mountSeederCircle`). This is the fragile piece behind bug 1; the explicit signal replaces it.
- **On-open state push** (`setupMemberAdmissionChannel` now async): the member reads its `seeder:{pubkey}` row for the connection and, on channel open, sends `revoked` if revoked or `admitted` if admitted. This converges the seed's flag on every reconnect, so a re-admit that happened while the seeder was disconnected still clears once it returns (replacing the robustness the auto-clear used to give).
- **Resume replication on re-admit** (`resumeSeederReplication`, kept from the earlier T1 draft): re-attach `_store.replicate(conn)` to the seeder's live connection (tracked via `_replicatingConns` so it's never double-attached) so a revoked-everywhere seeder re-seeds. Called from `circle:seeder:approve` alongside `notifySeederAdmitted` when `reAdmit` is true.
- **Observability.** `admission:admit-sent` / `admission:admit-received`, `seeder:admit-noticed`, `seeder:admit-notice-pushed`, `seeder:replication-resumed`.

Out of scope:

- Making revoke a HARD cutoff (tearing down replication immediately so a live-connected revoked seeder stops getting ciphertext). The blind seeder only sees ciphertext, so revoke stays a soft, advisory cutoff that becomes a replication stop on the next reconnect (unchanged from today). The flag now reflects the member's verdict correctly, which is the user-facing fix.
- The `seederRowByCircle` map in `onSwarmConnection` is now write-only (the member channel computes its own notices); leaving it is harmless, flagged for a later cleanup.

## Compat

The `[4] admitted` message is additive on the existing `pearcircle/seeder-admission/2` protocol (precedent: `[2]` and `[3]` were added the same way without a bump). Mixed pairs:
- **New member + new seed:** full fix.
- **New member + old seed (no `[4]`):** member sends `admitted`, old seed ignores it and keeps its old `onDownload` auto-clear, so re-admit still clears the old way. No regression.
- **Old member (no `[4]`) + new seed:** the old member never sends `admitted`, and the new seed no longer auto-clears, so the old member can't clear a revoke on the new seed. This window is narrow: only a member built between the `/2` channel-id change (2026-06-11) and this change, i.e. debug builds we control. The release app is either pre-`/2` (can't pair the admission channel with the new seed at all, so it can't revoke it either) or rebuilt to current (has `[4]`). Documented; acceptable.

No persisted-schema or replicated-data change. Reverting restores the `onDownload` auto-clear and drops the message + resume; the local rows are inert to old code.

## Verify

- `npm run verify` green.
- Two-app on-device (Pixel member on the new build + macOS seeder rebuilt to this code):
  1. Revoke the seeder from a circle -> seed logs `seeder:revocation-noticed` and **stays** revoked (no `seeder:revocation-cleared` follows); dashboard shows revoked. (Bug 1 fixed.)
  2. Re-admit -> member logs `seeder:admit-notice-pushed` (+ `seeder:replication-resumed` if it had stopped); seed logs `admission:admit-received` + `seeder:admit-noticed`; dashboard un-revokes and bytes climb. (Bug 2 fixed.)
  3. Re-admit while the seeder is briefly disconnected, then reconnect -> the on-open `admitted` push clears it (`seeder:admit-noticed` on reconnect).

## Rollback

Revert the commit: the `admitted` message, the explicit clear, the resume, and the on-open push go away, and the `onDownload` auto-clear returns. No peer-visible or persisted state to unwind.

## Open questions

- Bump `seeder-admission/2 -> /3` for a clean break instead of additive `[4]`? Rejected: additive matches the established pattern and degrades gracefully; a bump would needlessly break the new-member/old-seed pair.
- Should revoke also stop replication immediately (hard cutoff)? Deferred; the blind seeder only holds ciphertext, so the soft cutoff is acceptable and the flag is now correct.
