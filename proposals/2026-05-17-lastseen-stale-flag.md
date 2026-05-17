# lastSeen `stale` flag — honest cold-boot heartbeat

**Status**: Draft 2026-05-17. Awaiting approval.

**Goal**: Add an optional `stale: boolean` field to the signed `lastSeen` value so the worklet can publish a cold-boot heartbeat (preloaded position with fresh ts) without lying about the position being current. Peer UIs honor the flag to distinguish "online but position not yet refreshed" from "online and position is live".

**Tier**: T2. Additive field on a replicated, signed value. No new key, no new IPC message shape, no swarm-topic change. Cross-peer behavior changes (new peers render differently when the flag is true) but the wire format is backwards-compat with old peers via the established "ignore unknown fields" rule (§3 of `2026-05-03-wire-protocol.md`). Per Constitution §3, T2 needs a proposal; REVIEWS file is skipped (T3 only).

## Background

PR #20 (merged 2026-05-17) pre-loads `_selfLastSeen` from the persisted view on cold boot so the existing heartbeat can publish "we're alive" within ~15s of opening the app, instead of waiting on the first GPS fix (which on iOS in SLC-only mode or after a long pause can be 30s+ away). Without the pre-load, peers see our 24h-old `lastSeen.ts` and render us as "not Live" even though we just opened the app.

The pre-load works but it embeds a small lie: the **timestamp** on the cold-boot republished heartbeat is fresh (now), while the **position** (lat/lon) is whatever was persisted from the last session — potentially many hours and miles old. Peers downstream of `LiveOrAge` (`src/ui/App.jsx:5802-5811`) gate "Live" purely on `ts` freshness, so a stale position renders as if the user were currently there. Within ~15-60s the organic `location:update` fires and overwrites with truth, but during that window peers see misleading data.

PR #21 (the "Syncing with peers..." pill) papers over this on the catching-up side, but a peer who is NOT cold-booting (their app has been open the whole time) doesn't get the pill — they just see the cold-booting peer "teleport" from their pre-close position to wherever they are now.

This proposal makes the heartbeat honest by carrying a `stale` flag, so the rendering side has the information it needs to show the right state instead of treating "fresh ts" as "current position".

## Scope

In scope:

- Optional `stale: boolean` field on the signed `lastSeen:{pubkey}` value. Default `false` / absent.
- Worklet sets `stale: true` only on heartbeats published from a preloaded `_selfLastSeen` (i.e. the cold-boot window before any real `location:update` has fired since this boot). Cleared on the FIRST real `location:update` for the lifetime of the worklet process.
- Apply branch in `src/bare.js` accepts the field as-is — no new validation, no LWW change, no behavioral filtering.
- `signValue` / `verifyValue` are agnostic to the field (they sign / verify the JSON bytes; an additional key flows through transparently). No crypto change.
- UI: `LiveOrAge` (and any callers that gate on `lastSeen.ts`) reads `stale` and renders three states instead of two:
  - `ts` fresh AND `stale !== true` → "Live" (current behavior, default render)
  - `ts` fresh AND `stale === true` → "Reconnecting" or equivalent (NEW)
  - `ts` not fresh → "X ago" (current behavior, unchanged)
- The home-screen syncing pill (PR #21) becomes redundant for the cold-boot case once this lands — but is kept for the "no peer connected yet" case where we have no fresh data at all. Decision deferred to verification; could remove the pill in a follow-up if it turns out to be dead weight.

Out of scope:

- Trip records (`trip:`) — different surface, no equivalent staleness problem.
- Presence records (`presence:`) — value-only ("visible" / "muted"), no positional staleness.
- Transition records — point-in-time events, not subject to "is this current?" questions.
- Heartbeat cadence changes. `HEARTBEAT_CHECK_INTERVAL_MS = 15s` and `HEARTBEAT_STALE_MS = 30s` are unchanged.
- New IPC events between worklet and shell. The flag rides on the existing `lastSeen` flow.

## Compat

The field is additive under the established §3 rule ("Other prefixes silently dropped" generalizes to "other fields silently ignored" for additive evolution within `v: 1`).

Mixed-fleet behavior:

- **New peer writes (`stale: true`), old peer reads**: old peer's `verifyValue` accepts (signature is over the whole JSON, both peers serialize-deserialize identically). Old peer's apply path `view.put`s the value as-is including the unknown `stale` key. Old peer's `LiveOrAge` doesn't read it, so it renders the value as "Live" based on fresh ts — same as today's behavior (the lie continues for old-build peers, but no functional break).
- **New peer writes (`stale: true`), new peer reads**: renders "Reconnecting" / equivalent.
- **Old peer writes (no `stale` field)**: new peer treats absence as `stale: false` (the default), renders "Live" based on fresh ts. No regression.
- **New peer's organic update (no `stale` field, fresh ts)**: renders "Live" as today.

So the worst case for old peers is "no improvement" (they continue showing the cold-boot lie as Live). New peers see the truth. Migration is purely client-driven; no peer-side coordination required.

`v` stays at 1. Future shape changes that ARE incompatible would bump to `v: 2` per the wire-protocol convention; that's not this proposal.

## Design

### Value schema

`lastSeen:{pubkey}` signed value, updated from `2026-05-03-wire-protocol.md` §3:

```js
{
  pubkey: hex,
  lat: number,
  lon: number,
  accuracy: number | null,
  ts: number,           // ms epoch
  speed: number | null,
  battery: number | null,    // 0-100 or null
  isCharging: boolean | null,
  stale?: boolean,      // NEW; absent / false = position is current
  v: 1,
  // sig added by signValue()
}
```

### Worklet state

Add one module-scope variable to `src/bare.js`:

```js
// Track whether _selfLastSeen is a cold-boot preload (lat/lon may be
// many hours stale even though we'll republish with a fresh ts).
// Set true after the preload pass in init. Cleared on the first real
// location:update since this boot — that's when we have ground truth
// and the heartbeat can publish honest data.
let _selfPositionIsStale = false
```

Set after the preload assignment in init:

```js
if (newest) {
  _selfLastSeen = newest
  _selfPositionIsStale = true   // NEW
  mark('coldboot:selfLastSeen:preloaded', { ... })
}
```

Clear in the `location:update` handler, immediately after `_selfLastSeen = value`:

```js
_selfLastSeen = value
_selfPositionIsStale = false   // NEW
```

Heartbeat includes the flag when set:

```js
const refreshed = signValue({
  pubkey: ourKey,
  lat: _selfLastSeen.lat,
  lon: _selfLastSeen.lon,
  accuracy: _selfLastSeen.accuracy ?? null,
  ts: Date.now(),
  speed: _selfLastSeen.speed ?? null,
  battery: _selfLastSeen.battery ?? null,
  isCharging: _selfLastSeen.isCharging ?? null,
  ...(_selfPositionIsStale ? { stale: true } : {}),   // NEW
  v: 1,
}, _identity.secretKey)
```

Apply branch: NO CHANGE. The existing unconditional `view.put` at `src/bare.js:1672` writes the whole value including the new field.

### UI render

`LiveOrAge` in `src/ui/App.jsx:5803` becomes a three-way:

```jsx
function LiveOrAge ({ ts, stale, prefix = 'updated ' }) {
  if (!ts) return null
  const fresh = (Date.now() - ts) < LIVE_THRESHOLD_MS
  if (fresh && stale) return 'Reconnecting'   // NEW
  if (fresh) return 'Live'
  return prefix + formatRelative(ts)
}
```

Callers pass `stale={seen.stale}` alongside `ts={seen.ts}`. Two callers, both in `App.jsx` (member detail sheet around line 4980, pin / focus bar around line 5662).

### Sig coverage

`signValue` signs the canonical JSON serialization of the value object. Adding a key changes the serialization which changes the signature. New writers sign with the field; new readers verify against the same serialization. Old readers receive the JSON, parse it (extra keys allowed), and their `verifyValue` reads the same bytes and signature — verification passes because the canonical JSON is identical. This is the same mechanism that has carried every prior additive field (`isCharging`, `placeId` suffix, `deleted`, `avatar`, etc).

### Naming

`stale` over `live` because the absence-default reads naturally: rows without the field are treated as "not stale" → "live", matching how peers behave today. `stale: true` flips a flag rather than removing one. Symmetric with `deleted: true` on places.

Alternative names considered and rejected: `provisional` (jargon-y), `reconnecting` (describes the UI state not the data state), `cached` (the data IS cached but that's not the user-facing meaning), `recovered` (implies a fault).

## Verify

1. **Unit**: extend `tests/` with coverage for a small helper that produces the heartbeat value object given `_selfPositionIsStale` and a known `_selfLastSeen`. Assert presence/absence of the `stale` field correctly tracks the input flag. The signing path doesn't need its own test — `tests/sign.test.js` already covers `signValue` agnostically.
2. **Worklet smoke**: on a paired-device cold-boot, capture the first heartbeat the cold-booting device emits (worklet-side log via `mark()`); confirm `stale: true`. Capture the heartbeat AFTER the first organic `location:update`; confirm `stale` is absent.
3. **UI smoke**: on the receiving (non-cold-booting) device, observe the cold-booting peer's pin renders "Reconnecting" for the gap window, then flips to "Live" when the organic update arrives.
4. **Compat smoke**: install the new build on D1, leave D2 on the previous build (old build), repeat the cold-boot. Confirm new D1 → old D2 still renders as "Live" (per design, old peers ignore the flag). Confirm old D2 → new D1: when D2 republishes from preloaded state, new D1 sees no `stale` field, renders "Live" — same as today's behavior, no regression.

## Rollback

Single-knob: a worklet-side feature flag `LASTSEEN_STALE_FLAG_ENABLED` (default true) that short-circuits the `stale: true` set in the preload + heartbeat paths. Flipping it false reverts to pre-proposal write behavior (lie continues, no field emitted). UI continues to read `stale` from incoming values — that side stays on because it's harmless when no peer is writing the field. No wire-format coordination needed.

If the UI side needs a separate rollback, gate the three-way `LiveOrAge` branch on a UI-local toggle.

## Open questions

- **Q1: UI copy for the new state.** "Reconnecting" suggests a network problem the user can do something about. "Updating" is vague. "Last seen: \<age\>" is honest but verbose. "Live (cached)" is short but parenthetical. Default for v1: **"Reconnecting"**, since the actual underlying truth — "this peer is online but their app hasn't published a fresh GPS fix yet" — is most accurately framed as a transient connectivity-shaped event. Revisit on user feedback.
- **Q2: Map pin styling for stale-but-fresh-ts.** Should the pin look different (dimmed avatar, dashed online dot)? Or just the text below it? Default: text-only change in `LiveOrAge`; pin styling unchanged. Smaller diff, lower regression risk; pin treatment can be a follow-up if the text alone is too subtle.
- **Q3: When to clear `_selfPositionIsStale`.** Default rule above clears on first `location:update` since boot. Alternative: clear on EVERY `location:update` (no-op when already false). Both behave identically once cleared; the chosen rule is cheaper to reason about ("did we have ground truth yet this session?").
- **Q4: Per-circle preload divergence.** Phase 1's preload picks the newest `lastSeen:{ourKey}` across writable circles. If those circles disagree (e.g. one circle hasn't synced from us in days while another has), the staler one's row is dropped on the floor. Should we union somehow? Default: no, the newest-wins rule is correct; older rows are just less informative and we have nothing better to do with them.
- **Q5: Should the syncing pill (PR #21) be removed once this lands?** The pill covers the cold-booting USER'S view ("we're catching up"). The `stale` field covers the cold-booting USER'S APPEARANCE to peers. They're complementary: the pill helps me when I just opened the app; the flag helps my peers seeing me. Default: keep both, they serve different sides of the same gap.
