# circleId binding - stop trusting an unbound label as a channel id

**Status**: Draft 2026-06-11. Awaiting approval.

**Tier**: T2. Changes the seeder-admission protomux channel id derivation (old/new peers stop pairing that one channel until both update - graceful, bootstrap-core replication is unaffected). Adds a join-time validation that rejects malformed invites. No replicated-record / invite-grammar / encryption / local-schema change.

## Background

`circleId` is 32 random bytes (`generateCircleId`, base64url) chosen at circle creation. It is carried verbatim in invite links and used as the protomux `id` for three per-circle channels and as the key for seeder enrollment and most per-circle local state. **Nothing binds it to the circle's cryptographic identity** (the autobase `bootstrap` key or `circleKey`), and nothing validates that an invite's circleId matches the circle it points to.

Field-confirmed failure (2026-06-11, "New"/"Test" test circles): the seeder enrolled circle "New" (bootstrap `34f47458`) under a *different* circle's circleId (`6qCcXe2k`, which legitimately belongs to "Test"). Because the seeder-admission channel id is `b4a.from(circleId)`, the seeder's "New"-as-`6qCcXe2k` channel **cross-paired** with the Pixel's real "Test" admission channel (same id `6qCcXe2k`), so Test's members pushed lastknown cores to a seeder serving New. New's real members (on circleId `KeBQFa0i`) could never pair, so lastknown and slice-3d writerCores silently failed for New.

Blast radius (all use `id: b4a.from(circleId)`):
- `src/seederAdmission.js:149` - seeder-admission (announce / revoked / lastknownCores / writerCores)
- `src/pair.js:47` - pair channel (writer admission)
- `src/liveLocation.js:37` - live channel (live position broadcast - a cross-circle privacy concern)

The swarm topic (`blake2b(circleKey)`, `src/swarm.js`) and the device-level seeder-sync channel (fixed id) are NOT affected.

## Root cause

Two distinct parties can disagree on, or share, a circleId for a given autobase, and the channels key off that label rather than the circle's identity:
- **Members** can store a circle under a wrong circleId because `circle:join` adopts `parsed.circleId` verbatim (`src/bare.js:760, 832`) and never compares it to the canonical `circle` view row's `id` (written by the founder at creation, `src/bare.js:714`). The only read of that row at join checks `deleted`, not `id` (`src/bare.js:806`).
- **The blind seeder** cannot validate at all - it has no encryption key, so it can never read the canonical `circle.id`. It must trust whatever circleId a seed invite carries.

## Design

Two complementary fixes, split by who can validate.

### Fix 1 - member side: reject invites whose circleId doesn't match the circle (no wire change)

In `circle:join`, after `base.update()` and the existing circle-row fetch, add:

```js
const canonical = circleRow?.value?.id
if (canonical && canonical !== circleId) {
  // roll back the same way the deleted-circle branch does, then:
  throw new Error('invite does not match this circle (malformed or stale invite)')
}
```

This guarantees every member's local circleId equals the founder's canonical id. Consequence: two members of the same circle always agree on circleId, and members of different circles always have distinct (unique-random) circleIds. So the **pair and live channels can never cross-pair between members** - they stay keyed by circleId with no wire change, because circleId is now guaranteed unique-and-correct on every member.

Reject (not reconcile): adopting a different circleId post-mount would require re-keying every piece of local state (the corestore namespace, `_circleBases`, `circles:joined:{id}`, the autobase view) - expensive and error-prone. A mismatched invite is always a bug or a stale/malformed link, so failing fast with a clear error is correct.

### Fix 2 - seeder side: bind the admission channel + enrollment to the bootstrap (wire change)

The blind seeder can't do Fix 1, so make the channel it keys on derive from the `bootstrap` (the autobase identity, unique per circle, already known to both sides) instead of the arbitrary circleId.

**Admission channel id**: `blake2b("pearcircle/seeder-admission" || bootstrap)` instead of `b4a.from(circleId)`, in both the `seed` and `member` roles. Mirrors the existing `topicForCircleKey` blake2b pattern (`src/swarm.js`), domain-separated by a label prefix so it can never equal the swarm topic. The member has the bootstrap via `base.key` (`src/bare.js:2634`); the seed has it in the `seeder:enrolled:` row (passed through `mountSeederCircle` into the `_seederCircles` entry). `setupSeederAdmissionChannel` takes a `bootstrap` arg and derives the id internally. Protocol string bumped `pearcircle/seeder-admission/1` -> `/2`.

Result: even a franken seed invite (wrong circleId) is harmless to pairing - the channel id is the real bootstrap's hash, so the seeder pairs with the right circle's members and cannot cross-pair with a different circle that happens to share a circleId. circleId becomes a cosmetic label on the admission channel.

Pair and live channels are deliberately left on circleId - Fix 1 already prevents member-to-member collisions, so changing three wire ids when one suffices is unnecessary risk.

### Deferred hardening (not in this change)

Keying `seeder:enrolled:` rows by bootstrap instead of circleId (so a franken circleId can't squat a legit circle's enrollment slot via the idempotency check) is a separate, milder concern: Fix 1 stops members from generating franken seed invites in the first place, and Fix 2 makes any residual franken harmless to pairing. Re-keying enrollment ripples into the `leave` path, the boot remount, and `_seederCircles`, so it's deferred as optional hardening rather than bundled here. Tracked, not done.

## Compat / rollout

- The seeder-admission channel id changes, so an old member (id = circleId) and a new seeder (id = blake2b(bootstrap)) will NOT open a shared admission channel until both are updated. During that window: bootstrap-core replication (topic-based, unchanged) keeps the founder core seeding; announce / lastknownCores / writerCores pause for the un-updated pair. No data loss, no corruption - graceful degradation to today's bootstrap-only behavior. Acceptable for the small controlled fleet (forced upgrade of seeder + member builds).
- Protocol string bumped `pearcircle/seeder-admission/1` -> `/2` to make the version boundary explicit.
- No persisted-schema change: enrollment rows stay keyed by circleId (the channel no longer depends on that key being correct).

## Verify

- Unit: the `blake2b("pearcircle/seeder-admission" || bootstrap)` admission id is stable, differs for different bootstraps, and differs from the swarm topic for the same circle. `circle:join` mismatch logic (a helper that compares canonical id vs invite id) rejects a mismatch and accepts a match.
- Integration / on-device: re-run the "New"/"Test" scenario - two circles no longer cross-pair; each member's lastknown/writerCores reach only the seeder serving their own circle. `tools/seeder-coverage.js` for both circles stays correct.
- Regression: Hudgins (clean) keeps working end to end (admission pairs, slice-3d writerCores still land) after both sides update.

## Rollback

Revert the channel-id derivation (back to circleId) and the `/2` protocol string. Fix 1 is independently revertable - it only adds a guard. No persisted-record schema change to undo either way.
