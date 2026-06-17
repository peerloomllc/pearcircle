# Owner "Recreate Circle" + circle-config export / import

## Goal
Give a Circle owner a one-tap way to start a Circle over on a fresh, empty Autobase while keeping the hand-curated config (name + Places + per-circle toggles), and a file-based export / import of that same config. Turns the `2026-06-04-lastseen-ephemeral` remediation ("owner re-creates a bloated circle and re-invites members") from a manual re-enter-every-Place chore into a supported action.

## Tier
T2. Adds new IPC methods (`circle:export`, `circle:import`, `circle:recreate`, `circle:supersede`), a new on-disk JSON export format, and one new replicated Hyperbee key for the migration nudge (`supersede:{newCircleId}`, an owner-signed record in the *old* circle's view, harmlessly ignored by old builds). It reuses the existing `circle:create` / `place:create` / `buildInvite` primitives unchanged and introduces no wire-protocol, crypto or invite-format change. A recreated circle is just a brand-new circle to every peer. Backwards-compat is covered below; the only key management is embedding the freshly-created circle's own invite into a record readable solely by the old circle's existing members, so this stays T2, not T3.

## Background
A Circle's Autobase oplog is append-only and only grows. The `2026-06-04-lastseen-ephemeral` cutover stops *future* lastSeen growth once members converge, but it does not shrink history already accumulated, and the documented remedy for an already-bloated circle is "the owner re-creates the circle for a fresh empty autobase and re-invites members." Re-creating today means making a new circle from scratch and re-entering every Place by hand, so nobody does it. The same gap showed up in the `2026-06-17` WAL-bad_alloc recovery (memory `project_wal_badalloc_wedge`): the only way to shed a device's accumulated history is a fresh circle, and there is no in-app path to one that preserves the Places a user spent time setting up.

Note on priority: cutover (growth stopped) plus the merged WAL flush (`bugfix/store-wal-flush-maintenance`, PR #104, wedge prevented) mean bloat no longer *forces* a recreate. This is a convenience and a clean-slate / troubleshooting tool, not an urgent fix.

## Scope

### What recreate does
A recreate is `circle:create` followed by replaying the source circle's Places and per-circle toggles into the new circle, then returning a fresh invite. Concretely:
1. Read the source circle's config from its live view + local records: `circle.name`, every `place:*` (`name, lat, lon, radiusMeters`), and the per-circle toggles (`sharing:{circleId}` default, `trips:sharing:{circleId}`).
2. Create a brand-new circle via the existing `circle:create` path (fresh `circleId`, `circleKey`, `encryptionKey`, Autobase, owner member row, local `circles:joined` record, invite, seeder auto-follow).
3. Re-add each Place via the existing `place:create` append path (new `place:` ids, `createdBy` = the owner, fresh `createdAt`). Re-validate every field against the existing `place:create` bounds.
4. Apply the per-circle toggles to the new circle.
5. Return `{ circleId, name, invite }`. The owner shares the new invite so members rejoin.

### Payload (circle-scoped only)
The export object and the in-app recreate carry the same payload:
- `circle.name`
- `places[]`: `{ name, lat, lon, radiusMeters }` (no id, no createdBy, no createdAt - the new circle mints its own)
- `settings`: `{ sharingDefault, tripSharing }` (the per-circle toggles)

Deliberately NOT carried:
- **Members.** Each member must re-accept an invite with their own identity; you cannot fabricate a member row for someone else's keypair. Recreate always means re-inviting.
- **History.** Trips, transitions and lastSeen are dropped on purpose - a fresh oplog is the entire point.
- **Keys / identity / corestore seed.** The export carries no key material. Architecture note from the design dig: a member's identity keypair and their Autobase writer core are decoupled (the writer core derives from the corestore's own random persisted seed via `_store.namespace(circleId)`, not from identity), so a full cross-install "restore the same circle" would also need the corestore seed. That is explicitly out of scope (see Out of scope). Because the file has no keys, importing it always creates a *new* circle, never re-opens an existing one.

### File format
A versioned, human-readable JSON envelope, no keys:
```json
{
  "type": "pearcircle.circle-export",
  "v": 1,
  "exportedAt": 0,
  "circle": { "name": "Family" },
  "places": [ { "name": "Home", "lat": 0, "lon": 0, "radiusMeters": 150 } ],
  "settings": { "sharingDefault": true, "tripSharing": false }
}
```
Privacy note: this contains Place coordinates (home / work), which are location-sensitive, even though it holds no account credential. The UI should surface that when exporting.

### IPC surface (new)
- `circle:export ({ circleId }) -> exportObject` - read-only; the shell writes it to a file via the share sheet.
- `circle:import ({ payload }) -> { circleId, name, invite }` - validates the envelope (type, version, field bounds, caps on place count / name lengths), then runs the create-new-circle path above.
- `circle:recreate ({ circleId }) -> { circleId, name, invite, sourceCircleId }` - in-app one-shot. Builds the export object from the live source circle in memory and feeds it straight through the import path. No file round-trip. Equivalent to `circle:export` + `circle:import` composed. Also writes the local recreate link (below) and posts the supersede record to the source circle.
- `circle:supersede ({ oldCircleId, newCircleId }) -> { ok }` - owner-only; appends the owner-signed `supersede:` record to the old circle's Autobase. Called by `circle:recreate`; also exposed so the owner can re-post the nudge later. A no-op for a non-owner of the old circle.

### Migration nudge, disambiguation, and safe deletion
A recreated circle keeps the old one's name on purpose, so the owner ends up with two identically-named circles and the Settings delete screen is exactly where deleting the wrong one is unrecoverable. The name cannot disambiguate, so metadata and affordances do.

Recreate never auto-deletes the source. Instead:

**Owner-side (local, no wire change).** Recreate writes a link into each local `circles:joined` record: the new circle gets `recreatedFrom: oldCircleId` + `recreatedAt`, the old gets `recreatedTo: newCircleId`. The circle-list IPC surfaces these so the UI can:
- show created date + live member count on every circle row (distinguishes the pair even with no badge: "Created <newdate> · 1 member" vs "Created <olddate> · N members"),
- badge the old circle "Being replaced" and the new one "New", and
- in the `circle:delete` confirmation, name the target by date + member count and warn when the owner is about to delete the *newer* of a recreated pair.

**Member-side via the migration nudge (in-band).** Recreate posts an owner-signed `supersede:{newCircleId}` record into the *old* circle's Autobase carrying the new invite. The old circle's view is encrypted with the old `encryptionKey`, so only current members can read it (the blind seeder cannot), which is exactly the migration audience. In `applyCircleNodes` the record is accepted only when its signature verifies against the circle's `ownerKey` (no other writer can fake a "we moved" notice). A member's app then shows "Your group moved - join the new <name>" with a one-tap join + leave-old, so members never silently face two same-named circles either. Re-postable via `circle:supersede`.

A lighter out-of-band fallback (if the replicated record is unwanted): a "Invite everyone to the new Circle" button that just opens the share sheet with the new invite, leaving members to join manually with no auto-disambiguation. The in-band record is recommended because it solves migration and member-side disambiguation together.

### In-app explainer (chosen, troubleshooting-led)
> **Recreate Circle**
> Stuck, slow, or cluttered? Recreating rebuilds this Circle from scratch while keeping its name and Places. Members rejoin with a fresh invite, and history starts clean.

### Out of scope
- Cross-install / new-device restore, identity continuity, app-global settings (notifications, tile style, profile). Recreate is in-place: same install, same identity, so global settings already survive it. Identity continuity stays the separate "Identity persistence across reinstall" TODO.
- Importing a Place set into an *existing* circle (merge). See Open questions.
- Auto-deleting the source circle on the owner's behalf, and auto-leaving the old circle for members who decline the nudge. The owner deletes the source via `circle:delete` once migration is done.

## Compat
Additive. New IPC methods, a new file artifact, and one new replicated key (`supersede:`). To every peer a recreated circle is an ordinary new circle reached through the normal join flow. The `supersede:` record is the only schema addition: old-build members ignore the unknown key (the view read filters by known prefixes), so they see no change and migrate manually whenever the owner shares the new invite; upgraded members get the in-app nudge. No migration of existing data; existing circles are read, never rewritten apart from that one owner-authored record appended to the source circle. The file format is versioned (`v`), and `circle:import` rejects unknown `type` or a `v` it does not understand.

## Verify
- `npm run verify` green.
- New `node` tests (`tests/circleExport.test.js`, against an extracted `src/lib/circleExport.js` builder + validator): config round-trips (export then import yields the same name / Places / toggles); validator rejects wrong `type`, unknown `v`, out-of-bounds lat / lon / radius / name length, and over-cap place counts; the builder emits no ids, keys or member rows. Supersede apply: a record signed by the owner is accepted, one signed by any other writer is rejected.
- Device smoke: recreate a test circle on a paired device; confirm the new circle has the same name + Places + toggles, a working fresh invite, an empty history (no old transitions / trips), and that the source circle is still present and untouched. Confirm the two same-named circles are distinguishable in Settings (date + member count + badges) and that the delete confirmation warns when the newer one is selected. From a second device still in the old circle, confirm the "your group moved" nudge appears and one-tap join + leave-old works. Export to a file, import on the same device, confirm an equivalent new circle.

## Rollback
Additive IPC + UI only. Reverting removes the methods and the buttons; nothing persisted or peer-visible needs undoing, because a circle produced by recreate is byte-indistinguishable from a normally-created one. Any circles already recreated keep working.

## Slice plan
- **Slice 1:** `src/lib/circleExport.js` - pure `buildExport(circleConfig)` + `validateImport(payload)` (type / version / bounds / caps), unit-tested. No worklet wiring yet.
- **Slice 2:** worklet IPC - `circle:export` (read config from view + local records), `circle:import` (validate -> create-new-circle -> replay Places -> apply toggles), and `circle:recreate` (compose the two in memory, write the `recreatedFrom`/`recreatedTo` local link). Reuses `circle:create` / `place:create` / `buildInvite`.
- **Slice 3:** migration nudge + disambiguation - the owner-signed `supersede:` record (`circle:supersede`, append + `applyCircleNodes` accept-on-ownerKey-signature), the supersede read surfaced to the UI, and the recreate-link fields plumbed through the circle-list IPC. Member-side "your group moved" join + leave-old, owner-side delete-confirmation guard.
- **Slice 4:** UI - a "Recreate Circle" action with the troubleshooting explainer that surfaces the new invite, the date + member-count + badges on circle rows, file export (share sheet) and import (file picker) with the coordinate-privacy note on export.

## Decisions (2026-06-17, from design discussion)
- Export carries config only - no keys, ids or member rows - so import always creates a fresh circle. Cross-install key / identity restore is out of scope (identity / writer-core decoupling).
- In-place only; app-global settings are not carried because they already survive an in-place recreate.
- Recreate leaves the source circle untouched; the owner deletes it manually after members migrate.
- Explainer is the troubleshooting-led copy above.
- Both delivery forms ship: in-app one-shot recreate and file export / import.
- Two same-named circles are disambiguated by local recreate-link metadata (date + member-count + badges + a delete-confirmation guard), not by mangling the name.
- The migration nudge ships in-band as an owner-signed `supersede:` record (recommended), which also handles member-side disambiguation; the out-of-band share-sheet nudge is the fallback if the replicated record is rejected in review.

## Open questions
- Allow `circle:import` into an existing circle (merge a Place set), or only ever create a new circle? Starting with create-new only; merge would need Place dedup by name + coordinates.
- Should recreate optionally schedule / prompt deletion of the source circle once a quorum of members has joined the new one, or always leave cleanup manual? Starting manual; the `recreatedTo` link makes a future "old circle, everyone has moved - delete?" prompt easy to add.
- Expiry / dismissal of the `supersede:` nudge on the member side (one-shot dismiss vs persistent until they leave the old circle). Starting persistent until they join or leave.
