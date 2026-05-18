# Swarm-connected as the contact signal — drop heartbeat, drop `LiveOrAge` from member rows

**Status**: Draft 2026-05-17. Awaiting approval.

**Goal**: Replace the `lastSeen.ts`-derived "Live" label with the Hyperswarm peer-connected signal that already drives the map's green-dot indicator. Stop emitting the every-15s lastSeen heartbeat and the cold-boot `stale` flag entirely. The UI then has two independent, honest signals: "where this person is and when they got there" (place transitions + lastSeen position) and "are we in P2P contact right now" (swarm session).

**Tier**: T2. Removes peer-visible behavior (the heartbeat republish) that old-code receivers gate "Live" on. Old peers will mark new-code peers as not-Live within `LIVE_THRESHOLD_MS = 60_000` of stillness. Same cross-peer effect as the withdrawn coalescing proposal but stronger — there is no checkpoint emission to catch the old fleet. Constitution §3 says T2 needs a proposal; REVIEWS file is skipped (T3 only).

## Background

Today's investigation traced a "Live indicator not showing on the member row even after walking" report. Findings:

1. **The heartbeat coalescing proposal solved a real cold-boot-replication problem (every-15s lastSeen log churn) but at the wrong layer.** The UI symptom that triggered the work is mostly a UI display rule, not a wire issue.
2. **`<LiveOrAge>` in the Member row is gated behind there being no recent transition record.** `src/ui/App.jsx:5740-5750` renders one of three things: "Sharing paused" / "arrived at {place} · {transitionTs}" / `<LiveOrAge>` from lastSeen. For a member sitting at a familiar geofenced place (home, work, school), the transition branch wins and `<LiveOrAge>` is never called. Users almost never see "Live" in normal use.
3. **The user's mental model is "are we in contact right now"** — not "is their position fresh". `lastSeen.ts` answers the second question; the first is a swarm-session-state question and is already tracked.
4. **The infrastructure is already in place.** The worklet emits `peer:connected` / `peer:disconnected` IPC events with `{ circleId, remotePublicKey }` (`src/bare.js:1964, 1971`); the shell forwards them (`app/index.tsx:495-496`); the UI maintains `peersByCircle` from the `circles:peers` IPC and re-fetches on every event (`App.jsx:1225, 1273-1274`). The map renders green dots on pins from this exact data. Member rows just don't consume it.

So the heartbeat exists primarily to keep `lastSeen.ts` fresh for the small fraction of UI paths that use `<LiveOrAge>`, which is itself the wrong question for the UX. Removing the heartbeat is therefore not just safe — it lets us delete a class of complexity (preload, stale flag, syncing pill).

## Scope

In scope:

- **Worklet**: remove the heartbeat `setInterval` (`src/bare.js:2099-2145` in the current main; equivalent block in the withdrawn coalescing branch). Remove `_selfPositionIsStale` module state and all its set / clear sites. Remove the `stale` field from heartbeat-emitted lastSeen values (no heartbeats means no stale emissions). The `_selfLastSeen` preload stays (the home-screen empty-state still consumes it locally; nothing replicated).
- **UI**: member row swaps `<LiveOrAge>` for a small connection-state dot derived from `peersByCircle`. Render rule: dot is "in contact" if `peersByCircle[circleId]` includes this member's pubkey; "not in contact" otherwise. Self-row gets a special "you" state — not a connection signal at all.
- **UI**: keep the "arrived at {place} · {age}" branch unchanged. The transition-led narrative continues to be the main status copy.
- **UI**: keep `<LiveOrAge>` in the member detail sheet (`MemberDetailSheet`, `App.jsx:5067`), where it sits next to the absolute timestamp and answers "how fresh is this position" — that question is still useful in the detail context.
- **UI**: remove the "Syncing with peers..." pill (PR #21, `App.jsx:1455-1468`). With no heartbeat, the pill's "all connected peers have old lastSeen" condition fires constantly for any stationary member, and the pill loses its meaning ("are we catching up after cold boot?"). The cold-boot answer is now "look at the dot — if green, we are in contact; if gray, we are not, and the position you see is necessarily not current".
- **Tests**: drop `liveStatus.test.js`'s coverage of the threshold (keeps the `liveStatus()` function for the detail-sheet use). Drop nothing in `sign.test.js` — the value schema is unchanged; the `stale` field becomes optional-and-unused but readers still tolerate it.

Out of scope:

- Sparse replication (separate proposal, future).
- Trip cadence, transition cadence, place writes — untouched.
- Foreground / background app-state adaptation — irrelevant once the heartbeat is gone.
- Visual design of the connection dot (color, size, animation) — defer to a small follow-up PR with a real design pass. v1 ships a functional dot reusing the existing green-dot color token.
- Renaming `lastSeen` to something else even though "lastSeen" is now literally accurate (it really is the last seen position, no more heartbeat fakery). Rename churns too much code for the value; keep the name.

## Compat

`lastSeen` value schema is unchanged. The `stale` field shipped in `2026-05-17-lastseen-stale-flag.md` is honored by readers and not emitted by writers — same evolution path as any deprecated additive field.

Mixed-fleet behavior:

- **New writer (no heartbeat) + new receiver (uses swarm dot)**: connection state drives the dot in real time. The member row's status copy is the transition story. Working as intended.
- **New writer + old receiver (uses `LiveOrAge`)**: stationary new-code peer is marked "X ago" within 60s of stillness because lastSeen.ts is no longer refreshed. Soft cosmetic regression on old builds — the position pin is still rendered, the label just says "Xm ago" instead of "Live". No functional break.
- **Old writer (still heartbeats every 15s) + new receiver (ignores lastSeen.ts in the row, uses swarm dot)**: dot reflects connection state; old writer's heartbeat churn happens but new receivers don't care about lastSeen.ts for liveness. The transition branch keeps working. The "X ago" age is shown only in detail sheet.
- **Old writer + old receiver**: unchanged from today.

The blast radius of the old-receiver regression is the same as the prior coalescing proposal: small fleet today (D1, D2, paired iPhone, Leah's iPhone), forced upgrade is realistic. Confirm in Q1 below.

`v` stays at 1. No new fields, no removed required fields. The `stale` field is documented as deprecated-but-tolerated in a follow-up wire-protocol note.

## Design

### Worklet (`src/bare.js`)

Delete the heartbeat block at lines 2099-2145 wholesale. Delete:

```js
let _selfPositionIsStale = false   // module state, line ~106
```

In `'location:update'` (line 894), delete:

```js
_selfPositionIsStale = false   // ~line 931
```

In the cold-boot preload (line 2168-2186), delete:

```js
_selfPositionIsStale = true   // ~line 2181
```

Keep `_selfLastSeen` and its preload — the home-screen empty-state and the position pin still rely on it. Note in the preload comment that this is a *local-only* preload now: nothing gets republished to peers from it.

`signValue` callers stop carrying the `stale` field. Readers' apply branch (`verifyValue` + `view.put`) continues to accept it for compat with the existing old fleet.

### UI (`src/ui/App.jsx`)

In the Member list row (around line 5740), pass through `connectedPubkeys` (a `Set<string>` derived from `peersByCircle[circleId]`) and render a dot next to the name:

```jsx
<div style={s.memberHeader}>
  <span style={s.memberName}>{member.displayName ?? formatPubkeyShort(member.pubkey)}</span>
  {!isSelf && (
    <ConnectionDot connected={connectedPubkeys.has(member.pubkey)} />
  )}
</div>
```

Remove the third (`seen ?`) branch of the status line; the row now renders only:

```jsx
{isPaused ? (
  <div style={s.lastSeenMuted}>Sharing paused</div>
) : transition ? (
  <div style={s.status}>{transitionCopy}</div>
) : seen ? (
  <div style={s.lastSeen}>{geoLabel ? 'near ' + geoLabel : 'no place yet'}</div>
) : (
  <div style={s.lastSeenMuted}>no location yet</div>
)}
```

`<LiveOrAge>` is no longer called from the row. The "near X" fallback when no transition exists is just descriptive — no liveness claim is made in the row.

In `MemberDetailSheet` (line 4990+), keep `<LiveOrAge ts={seen.ts} stale={seen.stale} />` next to the absolute timestamp on line 5067. Add a connection-state line below it that consumes `connectedPubkeys`:

```jsx
<div>{formatAbsoluteTime(seen.ts)} · <LiveOrAge ts={seen.ts} stale={seen.stale} /></div>
<div>{connectedPubkeys.has(member.pubkey) ? 'In contact' : 'Not in contact'}</div>
```

Remove the syncing pill component and its mount site (around `App.jsx:1455-1468`).

### `ConnectionDot` component

New tiny component in `src/ui/components/` (or inline if there's no components dir):

```jsx
function ConnectionDot ({ connected }) {
  return (
    <span
      title={connected ? 'In contact' : 'Not in contact'}
      style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: 4,
        background: connected ? colorsRaw.success : colorsRaw.text.muted,
        marginLeft: 6,
        verticalAlign: 'middle',
      }}
    />
  )
}
```

`colorsRaw.success` matches the existing green-dot pin color (or close — verify on real devices). Per memory `feedback_colorsRaw_for_literals.md`, raw color literals are required here because this is a styled inline element, not a CSS-var context.

### `liveStatus.js`

`LIVE_THRESHOLD_MS` stays at 60_000. `liveStatus()` keeps its three-way classification — still used by the detail sheet. No code change required in this file.

### Existing `peersByCircle` data path

`circles:peers` IPC returns `peers: { [circleId]: string[] }` from the worklet (`src/bare.js` — search `circles:peers` handler). `App.jsx:1266` stores this in `peersByCircle`. To derive `connectedPubkeys` for a given member render, convert the entry to a Set in the snapshot-merge layer (`mergeSnapshots`, around `App.jsx:1182`) and pass it through to the member list / detail sheet via props.

Re-fetch cadence is already 3 seconds + on every peer-event (`App.jsx:1272-1274`). The dot will flip within one peer-event of an actual connect / disconnect, which is real-time enough for the UX.

## Verify

1. **Unit**: no new tests in `liveStatus.test.js` (we're removing the threshold-edge tests that asserted a 6-minute threshold — never landed on master anyway since the coalescing branch was abandoned). Keep the existing three-way classification tests.
2. **Unit**: add `tests/connectedDot.test.jsx` — render `<ConnectionDot connected={true} />` and assert color matches `colorsRaw.success`; same for `connected={false}` and `colorsRaw.text.muted`. Verify via jsdom project.
3. **Worklet smoke**: install on D1 and D2. Confirm the heartbeat is gone: tail `adb logcat | grep com.pearcircle.debug` while both apps are foregrounded and stationary for 10+ minutes. There should be no `lastseen:first-write` after the initial one (it fires only on first write per circle anyway; ongoing writes are silent — verify by listing the autobase head and confirming block count is stable). Compare to a baseline of the current build, which adds ~40 blocks in the same window.
4. **UI smoke (two peers)**: D1 and D2 in the same test circle. Both foregrounded, both inside the home geofence. Confirm both rows show the green dot. Force-quit D2's app. Within a few seconds (one peer-event), D1's view of D2 flips the dot to gray. The transition copy ("arrived at Home · Xh ago") remains unchanged. Bring D2 back; dot returns to green.
5. **UI smoke (walking)**: D1 leaves the home geofence on foot. Confirm the row flips to the no-transition fallback ("near {wherever}") on D1's own view AND on D2's view of D1. Both views show the dot reflecting actual swarm state, not lastSeen freshness.
6. **Compat smoke**: install new build on D1, leave D2 on the prior build (with the heartbeat). D2's `<LiveOrAge>` of D1 should fall to "X ago" within 60s of D1 going stationary. Position pin still renders correctly. Tolerable per "Compat" above.
7. **Self-row check**: own row never shows a connection dot (we're trivially "in contact" with ourselves). Confirm no regression in self-row rendering.
8. **Verify gate**: `npm run verify` passes (Constitution §5).
9. **Build + install before PR**: per project conventions, build the Android APK, run `./scripts/ios-dev-install.sh`, install on D1 / D2 / paired iPhone, eyeball the smoke flows, wait for user confirmation before opening the PR.

## Rollback

The heartbeat and stale-flag code are deleted, not feature-flagged. Per CLAUDE.md ("Don't use feature flags or backwards-compatibility shims when you can just change the code"), rollback is a `git revert` of the implementation commit. The proposal's wire is additive on the read side (still tolerates `stale` flag on incoming values) and subtractive on the write side; reverting the worklet half restores the heartbeat without coordinated UI changes — the dot continues to work even with heartbeat re-enabled.

If the dot turns out to be the wrong UX, the UI change reverts independently of the worklet change. Member rows would fall back to the prior "transition / LiveOrAge / no location yet" tree.

## Open questions

- **Q1: Acceptable rollout posture for the old-receiver "X ago" regression?** Same question as the withdrawn coalescing proposal. Fleet is small, forced upgrade is realistic. Confirm before merging.
- **Q2: Drop the syncing pill or keep it?** Recommend drop — its trigger condition is "all connected peers have lastSeen older than 5 min" which becomes the steady state for any stationary peer, so the pill would be on constantly. Easier to remove than rewire. If a follow-up surfaces a real "first cold-boot sync in progress" need, we can rebuild around hypercore download progress events instead of ts thresholds.
- **Q3: Should the dot also appear on map pins?** Already there — the green pin dot is the same signal. Member-row dot is just a duplicate read of the same data, which is fine and visually unifies the two views.
- **Q4: Self-row treatment.** v1: no dot. Alternative: a small "you" badge in the same slot. Defer to v1 ship and design feedback.
- **Q5: Should `stale` flag and `LiveOrAge` be removed entirely once old peers are off?** Yes, eventually. Track in TODO under a "post-fleet-upgrade cleanup" item. Not part of this proposal.
- **Q6: Does the abandoned coalescing branch need a formal "withdrawn" note?** It never landed on master; the branch can be deleted with no audit obligation. The proposal file on the branch documents the explore-then-decide reasoning, which is useful institutional history — I'd leave the branch in place but unreferenced.
