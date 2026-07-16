# Repair: finish the staged rebuild on foreground, and show real progress

## Goal
Make a staged `circle:repair` complete when the user reopens the app — and escalate to leave-and-rejoin when it cannot — instead of stranding an undismissable "Reopen the app to finish repairing" banner that only a force-stop can clear.

## Tier
T2. Amends `proposals/2026-06-03-autobase-append-hang.md` (Part B) and its gen+1 remount strategy. No wire-protocol or IPC envelope change, and no new Hyperbee key: `circleDegraded:{id}` is untouched and `circleRepairing:{id}` gains one additive field in its value. What changes is *when* the gen+1 mount is retried, so it lands in the same tier as the mechanism it amends.

## Background — what was observed on-device
Reported 2026-07-16 by Tim on a real device, in a circle whose banner offered Repair:

1. Tapped **Repair**, confirmed the modal. The UI showed no progress — no spinner, no disabled button — for the better part of 20 seconds.
2. The banner then reported the repair finished and asked him to restart the app.
3. He dismissed the app and reopened it. **The banner came back unchanged**, with no way to dismiss it.
4. Only **force-stopping** the app and relaunching cleared it.

All three symptoms are explained by the staged path, and the trace matches exactly.

### Confirmed: the worklet survived the swipe-away
Established 2026-07-16, and worth recording because the obvious test device gives the wrong answer.

The copy Tim saw after reopening — "Reopen the app to finish repairing" — renders only when `repairStaged` is true, and `_repairStaged` (`src/bare.js:214`) is an **in-memory-only** Set. It cannot survive a process restart. Seeing that exact string after a reopen is therefore proof that the worklet process was never restarted, which is the whole bug.

Device behavior differs, and the difference is load-bearing:

| Gesture | Pixel 9 (stock, reported) | TCL test phone (measured) |
|---|---|---|
| Home / app-switch | worklet survives (same pid, uptime runs through) | worklet survives (same pid 26303, `coldstart worklet+56170ms` across the cycle) |
| Swipe away from recents | **worklet survives** (deduced from the banner copy) | **worklet killed**, location FGS does not restart it |

Stock Android keeps a process holding an active foreground service (`PearCircleLocationService`, `foregroundServiceType="location"`) alive when its task is swiped away; the TCL reaps it anyway. So **the TCL cannot reproduce this class of bug** — it destroys the in-memory state the bug depends on. Reproduce worklet-lifetime bugs on the Pixel, or by backgrounding rather than swiping.

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

### Part C — Auto-escalate a repair that will not converge
A staged repair can never escalate today. The watchdog only arms for `repairInProgress = repairingCircles.length > 0 && !repairStagedPending` (`src/ui/App.jsx:2536`), and the escalated banner bails out on `escalated && !needsRestart` (`src/ui/App.jsx:1315`) — deliberately, because "reopen the app" was believed to be a real path. Part A makes that belief testable: if the mount still loses the race after repeated foregrounds, the wedge is one the gen+1 rebuild cannot fix (bloated oplog, forked view), and no amount of reopening will help.

- Count failed mount attempts per circle, persisted in the existing `circleRepairing:{id}` value as an additive `attempts` field. The key and its meaning are unchanged; old code ignores the field.
- After `REPAIR_MAX_ATTEMPTS` failures (proposed **3** total: the original `circle:repair` plus two foreground retries), mark the circle escalated and stop auto-retrying. Continuing to burn an 18s mount on every foreground buys nothing once it is established that the mount does not converge.
- Surface it as a per-circle `repairEscalated` flag in the `circles:getAll` snapshot (`src/bare.js:3225-3233`), alongside `needsRepair` / `repairing` / `repairStaged`.
- UI: `RepairingBanner` shows the existing leave-and-rejoin copy and its "Open circle settings" button when the circle is escalated, **including** the `needsRestart` case — so the `escalated && !needsRestart` guard at `:1315` relaxes to fire on the worklet flag regardless of staging. The 75s `REPAIR_ESCALATE_MS` watchdog stays as-is for the non-staged path, which has no attempt count to key off.
- The escalated state clears the same way everything else does: if the circle ever becomes writable, `clearRepairing` (`src/bare.js:1107`, `:2803-2809`) deletes `circleRepairing:{id}` and the attempt count with it.

This gives every repair a terminal state. It either completes, or it tells the user to leave and rejoin. Neither outcome requires a force-stop, which is what went wrong in the report.

### Out of scope
- No auto-repair on `circle:degraded`. Repair still changes the local writer key, so it stays user-driven per the parent proposal.
- No auto-*leave*. Escalation surfaces the guidance and the settings entry point; leaving a circle needs a fresh invite to undo, so it stays a deliberate user action.
- No change to the 18s mount timeout. Tuning it is a separate on-device question.

## Compat
Peer-invisible: repair is a device-local rebuild and no message crosses the wire. An old-code peer sees only the same gen+1 writer re-admission it already handles.

The one persisted change is the additive `attempts` field inside `circleRepairing:{id}`. Both directions are safe: old code reading a new value ignores the field and behaves exactly as it does today (wait for restart); new code reading an old value finds `attempts` undefined and treats it as 0, costing at most a fresh set of retries for a repair staged before the upgrade. `circleDegraded:{id}` is untouched. No migration.

## Verify
- `npm run verify` green.
- New `node` test: a staged repair (mount loses the race) followed by an `app:state active` retries the mount, and on success clears `_repairStaged`, clears `circleRepairing:{id}`, and emits `circle:repaired {restartRequired: false}`.
- New `node` test: two `app:state active` events in quick succession while a retry is in flight produce exactly one mount attempt.
- New `node` test: a mount that never converges escalates on the `REPAIR_MAX_ATTEMPTS`-th failure, sets `repairEscalated` in the snapshot, and attempts no further mount on the next foreground.
- New `node` test: `attempts` round-trips through `circleRepairing:{id}` across a simulated boot, and a value written without the field reads back as 0.
- New `jsdom` test: confirming the modal shows `RepairingBanner` with a spinner before any worklet event arrives.
- New `jsdom` test: an escalated circle shows the leave-and-rejoin copy even when `needsRestart` is true (the case `:1315` excludes today).
- Device smoke reproducing the report: force the staged path, confirm the tap shows a spinner immediately, then dismiss and reopen (**not** force-stop) and confirm the banner clears on its own. **Must run on the Pixel**, per the table above — the TCL kills the worklet on swipe-away and would pass this vacuously.

### Validation status (2026-07-16)
- `npm run verify` green (711 tests, 47 suites); Android debug build installs and launches clean on the TCL, worklet ready at +1.8s, no regression from the component move.
- The `app:state` foreground path was exercised on-device (`conn:probe {"reason":"foreground"}` fires from the handler the retry now hangs off).
- **Not exercised: the retry itself.** It only runs for a staged circle, which needs a genuinely wedged Autobase — the same environmental block the parent proposal hit (2026-06-03, "Not yet observed on-device"). The escalation math and retry gating are unit-tested; the wiring that calls them is reviewed, not proven. Real validation waits for the next wedge on the Pixel.

## Rollback
Part A is one helper plus a branch in the `app:state` handler — single-commit revert restores the wait-for-restart behavior. Part B is UI-local state. Part C adds one snapshot flag and one field inside an existing value; a revert leaves stray `attempts` fields that old code already ignores, so no cleanup is needed.

## Open questions
- Is 3 the right `REPAIR_MAX_ATTEMPTS`? It is a guess. Each attempt costs up to 18s of mount, and the failure mode it screens for (bloated oplog / forked view) is unlikely to heal between foregrounds, so a lower number may serve users better. Worth tuning on-device.
- Should `RepairingBanner` gain a dismiss control as a last-resort escape? Part C arguably removes the need: every repair now reaches a terminal state with an actionable button, and dismissing would hide a genuinely unfinished repair.
