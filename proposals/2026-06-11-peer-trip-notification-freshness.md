# Peer-trip notification freshness — persist the notified-set, relax the 10-min cliff

**Status**: Draft 2026-06-11. Root cause confirmed on-device via injected-trip probe (see Background). Awaiting approval.

**Goal**: Stop silently dropping peer "completed a trip" notifications for trips that replicate in more than 10 minutes after they ended, by persisting the already-notified set across cold boots and relaxing the freshness gate, with a one-time baseline so a fresh install does not replay history.

**Tier**: T1. No wire-format, replicated-Hyperbee-key, or IPC-shape change. Trip records (`trip:{pubkey}:{startTs}`) and the `peerTrip:completed` payload are byte-identical on the wire; an old-code peer and a new-code peer interact exactly as before. The only new state is two LOCAL, never-replicated Hyperbee rows on the receiver (`tripNotify:seen`, `tripNotify:baseline`). Documented as a proposal anyway because it changes a user-facing notification policy and resolves a recorded investigation.

## Background

`TODO.md` records: a circle member completes a trip, the trip record replicates and is visible on the receiver (tap the avatar, the trip shows), but no "X completed a trip" OS notification ever fires. Confirmed on-device 2026-06-11 with an injected-trip probe (`trip:debugComplete` + `trip:apply` / `trip:replicated` / `trip:uploaded` marks):

- The notification path itself **works**. A freshly injected trip (Pixel and iPhone both) replicated in `<1s` and the receiver fired the notification (`trip:apply ... willEmit:true`). The toggle, threshold, dedup, and emit are all fine.
- The receiver stores the trip **before** the notification gate (`view.put` then the gate), which is why a dropped trip is still visible in the list.
- The gate that drops it in the field is **freshness**: `Date.now() - endTs <= PEER_TRIP_FRESHNESS_MS` (10 min). A real trip ends when the sender parks, often away from the receiver; the record only replicates when the sender reconnects (drives home, app foregrounds), routinely more than 10 minutes after `endTs`. The receiver applies it stale, drops the notification, keeps the record. Clock skew between devices (observed as negative `lagMs` in the marks) makes the 10-min edge even flakier.

Why the gate exists at all: `_emittedPeerTripKeys` (the "already notified" set) is in-memory only, so it is lost on every cold boot. Without a freshness gate, autobase's historical replay on boot would re-notify for every trip in the log. The 10-min window is a crude proxy for "new". Persisting the set removes the reason for a tight window.

Not in scope here: the iPhone-sender case where the trip record **never** replicates (the app is killed after parking before it uploads the block). That is the deferred iOS background-liveness problem (`proposals/2026-05-29-push-wake-on-demand.md`), a different failure (no record arrives at all), and this change does not address it. It does mean that once such a record eventually arrives, it will still notify instead of being dropped as stale.

## Scope

In scope (all receiver-side, `src/bare.js`):

- **Persist the notified-set.** A capped (`_PERSISTED_TRIP_SEEN_MAX` = 512, FIFO) list in the local Hyperbee under `tripNotify:seen`, loaded into `_emittedPeerTripKeys` on init and rewritten when a key is added. Durable dedup: a trip notified once never re-notifies, across cold boots and autobase replays.
- **One-time baseline.** `tripNotify:baseline` = `Date.now()` written once on first init if absent. The gate suppresses any trip whose `endTs` predates it, so a fresh install / first upgrade does not replay a circle's trip history as notifications.
- **Relax the freshness window.** `PEER_TRIP_FRESHNESS_MS` 10 min -> 24 h. With the persisted dedup as the primary guard and the baseline suppressing first-sync history, the window is only a backstop bounding a long-absence catch-up (a device offline for days notifies only for the last 24 h of unseen trips, not weeks).
- **Future-ts sanity.** Keep an upper bound (`endTs <= Date.now() + FUTURE_TS_TOLERANCE_MS`) so a peer that stamps a far-future `endTs` cannot force a notification.
- **Observability.** Retain the `trip:apply` gate-decision mark (gated to recent / will-emit trips so cold-boot replays do not flood) for future field diagnosis.

Out of scope:

- The sender-side never-replicates case (iPhone killed before upload). Deferred, separate proposal.
- The 500 m / 5 min distance/duration threshold. Unchanged.
- The `trip:debugComplete` inject IPC + Advanced "Inject test trip" button. Diagnostic scaffolding on this branch; gate behind a dev flag or remove before merge (Open questions).
- Trip-record wire format, replication, or storage. Untouched.

## Compat

Fully local and additive. No old/new peer interaction changes: trip records and `peerTrip:completed` are identical on the wire. The two new rows are local-only and never replicated, so a peer never sees them. An old-code receiver keeps its 10-min in-memory behavior; a new-code receiver persists its dedup and uses the wider window. No migration: on first new-code boot, `tripNotify:baseline` is absent so it is set to now (history suppressed) and `tripNotify:seen` starts empty. Reverting to old code simply ignores both rows.

Spam risk and how it is bounded: the relaxed window could in principle replay many notifications when a device first syncs a circle or returns from a long absence. The baseline kills the first-install/upgrade case (history predates it); the persisted dedup kills the repeat-on-restart case; the 24 h window caps the long-absence case. The realistic steady state — one or two shared trips per member per day — produces at most one notification per trip.

## Verify

- `npm run verify` green.
- On-device (Pixel sender + TCL receiver, both on the branch build):
  1. Inject a fresh trip on the Pixel -> TCL notifies (`trip:apply willEmit:true`). Confirms the path still fires.
  2. Restart the TCL within a few minutes, let it re-sync -> TCL does **not** re-notify (persisted dedup; `trip:apply already:true willEmit:false` on the replay). This is the regression the in-memory set could not prevent under the relaxed window.
  3. Confirm `tripNotify:baseline` and `tripNotify:seen` rows exist in the local DB after a notification.
- Real-world: a sender completes a trip away from the receiver and reconnects 10-20 min later -> the receiver now notifies instead of dropping it.

## Rollback

Revert the commit. The two local rows become inert (ignored by old code). No peer-visible or replicated state to unwind. A softer revert is restoring `PEER_TRIP_FRESHNESS_MS` to 10 min, which re-tightens the window while keeping the harmless persisted rows.

## Open questions

- 24 h window vs a smaller value (e.g. 6 h)? 24 h favors "tell me what I missed overnight"; 6 h cuts long-absence bursts further. Tunable constant.
- Global baseline vs per-circle. Global is simpler and, combined with dedup + window, already bounds the "joined a new circle later" burst to 24 h. Per-circle would be tighter but adds a row per circle. Going global unless a circle-join burst shows up in testing.
- Pre-merge: remove or dev-flag the `trip:debugComplete` inject + Advanced button so it does not ship to end users.
