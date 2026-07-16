# Repair: finish the staged rebuild on foreground, and show real progress

## Goal
Make a staged `circle:repair` complete when the user reopens the app, instead of stranding an undismissable "Reopen the app to finish repairing" banner that only a force-stop can clear.

## Tier
T2. Amends `proposals/2026-06-03-autobase-append-hang.md` (Part B) and its gen+1 remount strategy. No wire-protocol, IPC envelope, or Hyperbee-key change: `circleDegraded:{id}` / `circleRepairing:{id}` keep their shapes and meanings. What changes is *when* the gen+1 mount is retried, so it lands in the same tier as the mechanism it amends.

## Background — what was observed on-device
Reported 2026-07-16 by Tim on a real device, in a circle whose banner offered Repair:

1. Tapped **Repair**, confirmed the modal. The UI showed no progress — no spinner, no disabled button — for the better part of 20 seconds.
2. The banner then reported the repair finished and asked him to restart the app.
3. He dismissed the app and reopened it. **The banner came back unchanged**, with no way to dismiss it.
4. Only **force-stopping** the app and relaunching cleared it.

All three symptoms are explained by the staged path, and the trace matches exactly.

### Why the banner survived a reopen
`circle:repair` (`src/bare.js:1737-1810`) has two endings. The good ending (`:1777-1797`) builds the gen+1 base in-process, swaps it in, and clears the flags. The staged ending (`:1798-1809`) runs when `buildCircleAutobase` loses the 18s race at `:1772`: it keeps the OLD base mounted, sets `_repairStaged`, persists `circleRepairing:{id}`, and emits `circle:repaired {restartRequired: true}`.

Nothing ever retries the mount. The staged path waits for a process restart, where boot hydration (`src/bare.js:5991-5996`) plus the gen+1 mount loop finishes the job; once the rebuilt base is writable, the `circles:getAll` poll calls `clearRepairing` (`src/bare.js:1107`) and the banner clears.

The flaw is that **the Bare worklet deliberately outlives the UI**. It is started once at `app/index.tsx:712` and kept alive so background location keeps feeding it (`app/index.tsx:441-444`). Swiping the app away destroys the activity but not the process, so `_repairStaged` — in-memory only, by design — survives, and the reopened UI reads the identical state. `RepairingBanner` (`src/ui/App.jsx:1303-1367`) has no dismiss control, unlike `RepairBanner`. The app therefore instructs the user to perform an action that the UI cannot deliver, and force-stop is the only escape. That is the bug.

### Why there was no spinner
Two independent gaps stack up:

- Confirming the modal (`src/ui/App.jsx:2920-2925`) fires `circle:repair` fire-and-forget with `.catch(() => {})` and no local pending state. Until the worklet flips a flag, the banner priority chain (`src/ui/App.jsx:2549-2562`) still resolves to `repair`, so the user keeps looking at the old "needs repair" banner with a live Repair button for up to 18 seconds. Nothing acknowledges the tap.
- When the staged flag finally lands, `RepairingBanner` suppresses the spinner precisely in the `needsRestart` variant (`src/ui/App.jsx:1352`). The one moment that most warrants a progress indicator is the one moment it is hidden.

The member-detail sheet already gets this right (`src/ui/App.jsx:7263`, `:7384-7398`): a local `repairing` state disables the button and swaps the label. The banner path never got the same treatment.

## Scope

### Part A — Retry the staged mount on foreground
- Extract the mount-race + swap/stage logic out of the `circle:repair` handler into one shared `attemptRepairMount(circleId)` helper, so the IPC handler and the retry cannot drift apart. Behavior of the two endings is unchanged.
- In the worklet's `app:state` handler, when `state === 'active'` and `_repairStaged` is non-empty, call `attemptRepairMount` for each staged circle. A success swaps the base, clears `_repairStaged`, and takes the existing `:1777-1797` path (`setRepairing` + `circle:repaired {restartRequired: false}`); a failure leaves the circle staged and the copy stands.
- Guard re-entrancy with an in-flight `_repairRetrying` set, so rapid background/foreground toggles cannot stack concurrent mounts of the same circle.
- This makes the existing "Reopen the app to finish repairing" copy literally true: a dismiss-and-reopen fires `AppState` `active` (`app/index.tsx:809-810`) and finishes the repair. Force-stop keeps working as it does today via boot hydration.

### Part B — Acknowledge the tap
- Add a local `repairPending` state in `App.jsx`, set on modal confirm and cleared once the circle reports `repairing || repairStaged` or the `circle:repaired` event arrives. Feed it into `repairingBannerEligible` so `RepairingBanner` with its spinner takes the slot immediately, covering the up-to-18s dead zone.
- Render the spinner in the `needsRestart` variant too. With Part A the restart state is transient rather than terminal, so an indeterminate indicator is now honest.

### Out of scope
- The 75s escalation watchdog (`REPAIR_ESCALATE_MS`, `src/ui/App.jsx:1295`) and its leave-and-rejoin guidance stay as the backstop for a retry that keeps failing.
- No auto-repair on `circle:degraded`. Repair still changes the local writer key, so it stays user-driven per the parent proposal.
- No change to the 18s mount timeout. Tuning it is a separate on-device question.

## Compat
Peer-invisible: repair is a device-local rebuild and no message crosses the wire. An old-code peer sees only the same gen+1 writer re-admission it already handles. `circleDegraded:{id}` and `circleRepairing:{id}` are unchanged, so a device that boots old code after this change (or vice versa) hydrates the same state; the worst case is the pre-change behavior, i.e. waiting for a restart. No migration.

## Verify
- `npm run verify` green.
- New `node` test: a staged repair (mount loses the race) followed by an `app:state active` retries the mount, and on success clears `_repairStaged`, clears `circleRepairing:{id}`, and emits `circle:repaired {restartRequired: false}`.
- New `node` test: two `app:state active` events in quick succession while a retry is in flight produce exactly one mount attempt.
- New `jsdom` test: confirming the modal shows `RepairingBanner` with a spinner before any worklet event arrives.
- Device smoke reproducing the report: force the staged path, confirm the tap shows a spinner immediately, then dismiss and reopen (**not** force-stop) and confirm the banner clears on its own.

## Rollback
Part A is one helper plus a branch in the `app:state` handler — single-commit revert restores the wait-for-restart behavior. Part B is UI-local state. Neither writes a new persisted field, so a revert needs no cleanup.

## Open questions
- Should a staged repair that survives N foreground retries auto-escalate to the leave-and-rejoin flow, or keep only the 75s watchdog copy?
- Should `RepairingBanner` gain a dismiss control as a last-resort escape, given the banner is now self-clearing and dismissing it would hide a genuinely unfinished repair?
