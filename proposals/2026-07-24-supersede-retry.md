# Migration nudge: retry it, and tell the owner when it hasn't landed

## Goal
Stop the "your group moved" notice from being silently lost when an owner recreates a wedged circle: retry the post until it lands, and until it does, say so on the circle's row with a manual re-post button.

## Tier
T2. No wire change - the `supersede:{newCircleId}` record, its signature rules and `shouldAcceptSupersede` are all untouched, so an old-code peer and a new-code peer read exactly the same thing. What is new is one **local-only** Hyperbee key (`supersede:pending:{oldCircleId}`, never replicated), one additive field in the `circles:getAll` reply (`supersedePending`) and one additive argument on the existing `circle:supersede` IPC (`manual`). Additive persisted field + IPC shape change puts it at T2 by §2 rather than T1.

## Background - what is broken
`circle:recreate` mints the replacement circle and then posts an owner-signed `supersede:` record **into the old circle** so upgraded members get a one-tap "your group moved" prompt carrying the new invite (proposal 2026-06-17 slice 3).

That post is the one structural weakness of the recreate flow, because of who recreates a circle. Owners recreate circles that have gone bad. A bad circle is very often a wedged one - the `needsRepair` / escalated-repair state where the base is not writable, or where reads and appends hit their bounds. **A wedged base is exactly what cannot be appended to.** So the notice fails precisely on the circles that most need it, and before PR #173 the failure was swallowed entirely:

```js
try {
  await handlers['circle:supersede']({ oldCircleId: circleId, newCircleId: created.circleId })
} catch (e) { console.warn('[bare] circle:supersede during recreate failed', e?.message) }
```

Observed 2026-07-24: recreate reported success, the members of the old circle were never prompted, and nothing anywhere said why.

PR #173 made the failure honest - the success sheet now tells the owner members will not be prompted, and the post is bounded so it cannot hang the worklet. It did not make the notice eventually arrive. That is this proposal.

## Scope

### Changes
1. **`postSupersede(oldCircleId, newCircleId)`** - the existing post, extracted from the handler, returning `{ ok }` or `{ ok: false, reason }`. Reasons: `not_writable`, `append_timeout`, `append_failed`, `circle_unreadable` (retryable); `not_owner`, `unknown_new_circle`, `unknown_old_circle` (terminal).
2. **Pending row** `supersede:pending:{oldCircleId}` = `{ newCircleId, attempts, reason, since, v: 1 }` in the local Hyperbee. Written on a retryable failure, deleted on success or on a terminal failure. Mirrored in memory (`_supersedePending`) so the ~3s `circles:getAll` poll costs no DB read; restored at init.
3. **`circle:supersede` owns its own bookkeeping.** Every path through the handler folds its outcome into the pending row via the pure `supersedePendingNext`, so the automatic and manual callers can never disagree about the state.
4. **Retry sweep** `retryPendingSupersedes(trigger)`, fire-and-forget from the two moments a wedged base plausibly became writable:
   - **foreground** (`app:state` active), alongside the existing `retryStagedRepairs` - the owner may never open Settings;
   - **a settled repair** (`clearRepairing`), which can happen with the app already open, so waiting for the next foreground would leave the notice unposted for hours.
   The sweep is serial (each attempt can sit out its bounds; racing them buys nothing) and self-heals: if either half of the recreated pair is gone, the row goes with it.
5. **Attempt cap** `SUPERSEDE_MAX_ATTEMPTS = 30`. At roughly one attempt per foreground that is days of trying, well past the point where an automatic retry is still plausibly what will fix it. On the cap, the row is cleared and it becomes the owner's call.
6. **UI.** The old circle's row in Settings shows "Members not told about the move yet" plus a **Notify members** button while `supersedePending`. A manual tap resets the attempt tally, so it always buys another run of automatic retries. Failures render `supersedeFailureMessage(reason)`, which is written in the user's terms and always points back at the invite link, since that route always works.

### Not in scope
- **Any change to how members receive the notice.** They already poll `supersedes` out of their own copy of the old circle's view; a member whose copy is healthy sees the prompt as soon as the owner's block replicates. This is only about the owner-side write landing at all.
- **Re-posting into a circle the owner has left or deleted.** The row is dropped instead.
- **Notifying members out-of-band** (push, the new circle, the relay). The notice is deliberately in-band and encrypted under the old circle's key so the blind seeder cannot read it; carrying it anywhere else is a different, larger design.

## Compat
- Old peers: unaffected. Nothing new goes on the wire; the record posted by a retry is byte-identical to one posted first time, and `postedAt` is stamped at post time so LWW behaves as before.
- Old local state: a device upgrading mid-migration has no `supersede:pending:` rows, so it starts clean. An owner who already hit the silent failure gets no retroactive row - the **Notify members** button is unavailable to them because nothing is pending, which is honest: their recreate predates the tracking. They can still re-post by recreating again or sharing the invite, and PR #173's sheet told them so.
- Downgrade: the pending rows become inert local garbage under the `supersede:pending:` prefix. Nothing reads them, nothing breaks.

## Verify
- `npm run verify` (50 suites).
- Unit: `shouldRetrySupersede` (retryable vs terminal vs capped), `supersedePendingNext` (first failure starts the tally, further failures bump it and preserve `since`, success clears, terminal clears, cap clears, manual resets), `supersedeFailureMessage` (jargon-free, always points at the invite).
- On-device: recreate a circle whose old half is wedged. Expect the sheet to say members were not nudged, the old row to show "Members not told about the move yet", and `circle:supersede:retry` marks in logcat on each foreground. Then repair or otherwise unwedge the old circle and confirm `circle:supersede:posted` fires and the row's warning clears without a tap.

## Rollback
Revert the commit. The pending rows are local-only and unread by anything else, so nothing has to be migrated back; the flow returns to post-once-and-report (PR #173 behavior), not to the silent swallow.

## Open questions
- Should a repair that **escalates** (gives up) also drop the pending row? Today it keeps retrying to the cap, on the theory that an escalated circle can still become writable through a writer re-admission that has nothing to do with the repair. Cheap either way; revisit if the marks show pointless attempts.
- Is foreground the right cadence, or should the sweep also run on a long timer for a device left open for days? Foreground plus repair-settled covers every observed case so far; a timer is easy to add if the marks show notices sitting pending across long open sessions.
