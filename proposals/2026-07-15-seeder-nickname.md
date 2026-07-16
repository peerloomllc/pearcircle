# Seeder nickname (operator-set, propagated to members)

## Goal
Let a seeder operator set a human nickname in the seeder dashboard (e.g. "Home
Pi", "Office NAS") so members' apps show that name instead of the raw hex
pubkey, and so an operator running several seeders can tell them apart. One
nickname per seeder device (global), shown in every circle it serves.

## Tier
T2. Additive: it reuses the existing seeder→member announce `label` field and
the existing `seeder:<pubkey>` admission row + list + UI render. No change to the
circle-data wire format. The new surface is a seeder-side IPC + persistence and a
member-side "apply the label on re-announce, not just first admit".

## Background
Most of the path already exists:
- The announce message `{ pubkey, label, version }` (`handleSeederAnnounce`)
  already carries `label`, verified against the seeder's authenticated pubkey.
- On first admit, `approveSeederRow` writes `label` into the durable, shared
  `seeder:<pubkey>` row (member-signed) in the circle Autobase.
- `circle:seeders:list` / `seeders:listAll` already return `label`.
- The mobile UI already renders `seeder.label || ('Seeder ' + pubkey.slice(0,8))`.

Gaps: (1) the seeder never sets `label` (announces `enrollment?.label`, empty);
(2) no dashboard field to set it; (3) `handleSeederAnnounce` applies `label` only
when there is no row yet, so a later rename never reaches already-admitted
members.

## Decisions (2026-07-15)
- **Global**, not per-circle: one nickname stored on the seeder, sent as `label`
  in every circle's announce.
- **Reuse the announce `label`** — no new wire message, no admission-row schema
  change (`label` is already there).
- **Seeder is authoritative** for the display label. There is no member-set-label
  UI today (approve is called without a label), so making the seeder's nickname
  the label conflicts with nothing. A member override can be layered later.
- **Propagate on change**: when a re-announce carries a `label` that differs from
  the stored row, a connected writable member rewrites the row (LWW convergence).
  Bounded: nickname changes are rare operator actions.
- **Persist on the seeder** (local Hyperbee) so it survives restart, and it lives
  durably in the admission row on the member side (shows even when the seeder is
  briefly offline).

## Scope
### In scope
- Seeder worklet: persist nickname (`seeder:nickname` in `_localDb`), load at
  seed init into `_seederNickname`, send it as the announce `label`, and a
  `seeder:nickname:get`/`seeder:nickname:set` IPC that updates + persists +
  re-announces to all live connections.
- Seeder host + dashboard: `/api/nickname` GET/POST, a nickname field in the
  dashboard UI.
- Member worklet: in `handleSeederAnnounce`, when already admitted and the
  announced `label` differs from the row's, rewrite via `approveSeederRow`
  (length-capped, trimmed, only on change).

### Does not change
- Circle-data wire format; the `seeder:` admission row schema (label already
  exists); the mobile Seeders UI render (already label-or-hex).

### Trust boundary
The nickname is seeder-authored but only ever reaches a member over the
pubkey-authenticated announce channel, and is stored by the member's own worklet
into a member-signed row. A malicious admitted seeder can only set its *own*
display name (it could pick a misleading one — acceptable; the member admitted
it, and it's a display label, not an identity). Cap length (≤ 48 chars), trim,
strip control chars.

## Compat
- Old seeder (no/empty label) → members show `Seeder <hex>` (unchanged).
- Old member (applies label on first admit only) → shows the first-admit label,
  ignores later renames; new members propagate renames. No break either way.

## Verify
Set a nickname in the dashboard → it appears in a paired phone's Seeders list.
Rename it → an already-admitted member's list updates. Blank it → falls back to
`Seeder <hex>`. Run two seeders with different nicknames → both distinguishable.

## Rollback
Advisory display metadata: revert = ignore the field (members fall back to hex).

## Slice plan
1. Seeder side: persist + announce `label` from nickname + IPC + dashboard field.
2. Member side: apply label change on re-announce.

## Open questions
- Member-set override (rename a seeder locally, ignoring its self-nickname) —
  deferred; no demand yet and the seeder-authoritative model is simpler.
