# Stop condemning a circle for one slow append

## Goal
A circle that is merely slow to start writing must not be permanently marked broken, and a circle that starts writing again must be able to say so.

## Tier
T2. No wire change, no new persisted key - `circleDegraded:{id}` keeps its shape. What changes is *when* a circle is declared degraded and *how* it recovers, which is user-visible (the needs-repair banner) and amends `proposals/2026-06-03-autobase-append-hang.md`, so it lands in the same tier as the mechanism it amends.

## Background - measured, not inferred
The first `base.append` after a cold boot or a repair mount blocks until Hyperswarm discovery flushes. This is known and documented in TODO under the cold-boot write-lag item: ~1.8s when peers are found immediately, **~66s measured on D1 when they are not**.

`safeAppend` gives every append a flat `APPEND_TIMEOUT_MS` of 10s. On timeout it calls `flagDegraded`, and three things follow:

1. `circleDegraded:{id}` is persisted, so the verdict survives restarts.
2. Every later `safeAppend` to that circle returns false at its first line.
3. Nothing clears it except a `circle:repair` mount - the only two `clearDegraded` callers are both inside `attemptRepairMount`.

Point 2 is the trap: the flag suppresses exactly the operation that would prove the circle healthy, so recovery is impossible by construction. Point 3 means the only exit is a manual repair, which is itself followed by a cold mount and another race against the same 10s deadline.

**Observed on the Pixel 9, same circle, 34 minutes apart, 2026-07-24:**

| boot | repair settled | first append | verdict |
|---|---|---|---|
| 14:27:55 | +2081ms | timed out at +10918ms | `circle:degraded {label:"append:lastSeen"}` |
| 15:01:29 | +1771ms | succeeded at +11221ms | healthy, still writing 4 min later |

The margin between "working circle" and "permanently broken circle" was under a second of startup latency.

This is the wedge that has recurred across circles and devices for months. Everything previously blamed for it is cleared by measurement: not oplog bloat (the circle holds 7,942 ops), not the seeder's retention sweeps, not the unfetchable prefixes, not the view fork. A read-only replica of the same circle linearizes every op with zero stuck reads.

## Scope

### Changes
1. **The first append after a mount never degrades the circle.** Its slowness is expected - the discovery gate causes it - so a timeout there is marked (`append:first-slow`) and nothing more. Exemption is per mount and covers the first *attempt*, not the first success, so a genuinely dead base still reaches the streak rule below.
2. **Three consecutive timeouts before condemning.** `flagDegraded` fires on a streak, not a single miss. Any success resets the streak. With the first-attempt exemption that is four timeouts, ~40s of sustained failure, before a circle is called broken.
3. **Degraded self-clears on a successful append.** A circle that writes again is not broken, whatever it did a minute ago. This alone turns a permanent wedge into a transient blip.
4. **Degraded throttles appends instead of blocking them.** One probe append per `DEGRADED_PROBE_INTERVAL_MS` (60s) rather than a hard skip, so (3) is reachable. The original reason for the hard skip - never stack hung appends on a wedged base - is preserved by the interval: at most one in flight per minute per circle.

`APPEND_TIMEOUT_MS` stays at 10s. Raising it was the obvious move and is wrong: `safeAppend` runs inside the `location:update` IPC handler, and the dispatcher awaits handlers serially, so a 90s bound would hand back exactly the frozen worklet that proposal 2026-06-03 exists to prevent. The bound is right; the *consequence* was wrong. The append promise also keeps running after the race is lost, so a slow write still lands - we simply stop treating "not yet" as "never".

### Not in scope
- The read-side degradation path (`safeSnapshot`). It uses the same flag and benefits from (3) for free, but its own thresholds are untouched.
- The repair mount timeout (`repair_mount_timeout`, 18s), which staged twice today. Once circles stop being falsely condemned, far fewer repairs run at all; revisit with data afterwards.
- The cold-boot write lag itself. Fixing the Autobase discovery gate is the deeper cure and stays deferred - this proposal makes its symptom harmless.

## Compat
- Old peers: unaffected, nothing crosses the wire.
- Existing `circleDegraded:` rows: honoured on boot as today, and now clearable by a successful append instead of only by repair. Users currently stuck behind a false positive heal on their next successful write, with no action and no repair.
- Downgrade: older code re-reads the same key and returns to condemning on the first timeout. No migration either way.

## Verify
- `npm run verify`.
- Unit: the pure decision (`src/lib/appendHealth.js`) - first attempt exempt, streak threshold, success resets, probe interval gating.
- On-device: the reproduction is already scripted by today's session. Force-stop, reopen, and watch a cold boot whose first append exceeds 10s produce `append:first-slow` and **no** `circle:degraded`, then a later successful append with no degraded state to clear. The inverse check matters as much: a truly wedged base must still reach `circle:degraded` after the streak, which the appendStall tracer can confirm by showing stuck reads on every attempt.

## Rollback
Revert. The flag's shape is unchanged, so a reverted build reads existing rows normally.

## Open questions
- Is 3 the right streak? It is a guess bounded by "roughly 40s of failure". The `append:timeout` marks now carry the streak, so real devices will say.
- Should a probe that times out extend the interval (backoff) rather than retry every 60s? Probably, if the marks show repeated probes on genuinely dead bases.
