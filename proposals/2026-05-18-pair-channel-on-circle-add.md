# Pair channel for circles added on a live connection

**Status**: Draft 2026-05-18. Awaiting approval.

**Goal**: Fix a pre-existing bug where a circle created or joined after a Hyperswarm connection is already established never opens its protomux pair channel on that connection. Result: the joiner's `writerHello` never reaches the owner, the owner never appends `addWriter`, and the joiner never becomes a writer — so the joiner's `member:` row is never written and the joiner doesn't appear in the owner's members list. Today's investigation (events.log trace from D1 and D2) confirmed the symptom and the mechanism.

**Tier**: T1. App logic, single peer. No Hyperbee key change, no value-shape change, no IPC shape change, no swarm-topic change, no persisted-field change. The protomux pair-channel protocol itself is unchanged. The fix is purely "when do we *call* `setupPairChannel` and how do we make sure both sides have a channel pending at the same moment?" — local behavior on each peer. Proposal is optional under Constitution §3 for T1 but the fix sits in cross-peer handshake territory, so writing one is good practice and matches the project's pattern. Old peer / new peer compat is preserved (see Compat).

## Background

Hyperswarm reuses one connection per peer pair regardless of how many topics they share. When two peers join a second topic, the existing connection's `info.topics` is updated, but no new `'connection'` event fires. The current code only sets up pair channels inside `onSwarmConnection` (`src/bare.js:1902`), which iterates `_circleBases` at the moment the connection is established. Any circle added to `_circleBases` *after* that moment never gets a pair channel on the existing connection.

Corestore replication has the opposite property: `_store.replicate(conn)` was called at connection time, but the corestore picks up newly-added cores automatically through the same replication stream. So **data flows but writer-key registration doesn't** for circles added post-connection. Today's events.log shows this directly:

```
D2: lastseen:first-remote  G1kDO7OF...   from=D1   at +84418ms  ← data flows
D2: (no writer:first-added — D2 never became a writer)
```

### Why a proactive `setupPairChannel` on both sides is not enough

The first thing one tries — "iterate `_activeConns` and call `setupPairChannel` from `circle:create` and `circle:join`" — looks correct but doesn't work in practice. The owner calls `circle:create` first, opens the channel, but the joiner hasn't called `circle:join` yet. Protomux logs the OPEN frame as an `incoming` entry for `(protocol, id)`, calls `_requestSession`, awaits the registered `notify` callback (none registered), and then rejects: `_rejectSession` runs, sending a close back. The owner's channel `onclose` fires ~26 ms later.

When the joiner eventually opens (seconds later, paced by the user pasting / scanning the invite), the owner no longer has a channel pending for that `(protocol, id)`. Symmetric reject. The joiner's `onclose` fires.

Today's instrumented trace captured this exactly:

```
D1: pair:channel-opened       cid=9UA2ZRwb     (owner opens)
D1: pair:onclose              cid=9UA2ZRwb     (26ms later — rejected by D2)
D2: pair:channel-opened       cid=9UA2ZRwb     (9 seconds later)
D2: pair:onclose              cid=9UA2ZRwb     (228ms later — D1 already gave up)
```

The proactive-open approach is racing on a window of about one network round-trip, while the user-mediated gap between create and join is seconds to minutes. Retrying with jitter doesn't help much — the channel is open for only a fraction of a percent of each retry interval, and aligning two independently-jittered short windows is statistically poor.

## Design

Protomux supports this exact case via `mux.pair({ protocol, id }, notify)` (`node_modules/protomux/index.js:407`). When a remote opens a channel for `(protocol, id)` that has no local channel pending, the protomux `_requestSession` path awaits the registered notify; if the notify calls `createChannel` for that `(protocol, id)` during the await, the queued remote open is grabbed and the channel matches. Onopen fires on both sides. This is the canonical "I'll lazily create the channel when a peer asks for it" mechanism.

The fix is therefore:

1. **Owner side**: register `mux.pair({ protocol: 'pearcircle/pair/1', id: null }, notify)` for every connection at conn-open time. The `id: null` form catches opens for any circle id we don't yet have a channel for. The notify looks up the circle id in `_circleBases`; if we have it, the notify calls `setupPairChannel` (which calls `mux.createChannel`), and protomux grabs the queued remote open and lets the handshake complete.
2. **Joiner side**: when `circle:join` adds a new circle to `_circleBases` on a live connection, iterate the active connections and call `setupPairChannel` to send the OPEN frame.
3. **Owner does NOT proactively open** on `circle:create`. The owner has nothing to do at create time — the joiner will eventually trigger an open, and the owner's pair() notify will lazily match it.
4. **No change to the cold-boot / new-connection path**: `onSwarmConnection` still iterates `_circleBases` and calls `setupPairChannel` for every circle. That's race-free because both sides do this at the same connection-open moment.

A small bookkeeping addition is required: an `_activeConns: Set<conn>` so the joiner can iterate live connections. The set is populated in `onSwarmConnection` and drained in `conn.on('close')`.

`mountCircleAutobase` is the only other site that adds to `_circleBases`. It runs only during init (before any connections exist), so calling the helper there is a no-op in practice. The proposal still calls it defensively, in case future code paths mount circles mid-session.

### Visibility

The pair-channel handshake is hard to reason about without traces. The implementation adds `mark()` calls in `src/pair.js` at every stage:

```
pair:onopen               (writable, hasLocal)
pair:hello-sent
pair:hello-received       (writable, valid)
pair:addwriter-appended   (pubkey)
pair:hello-send-failed    (err)        — if writerHello.send throws
pair:addwriter-failed     (err)        — if base.append throws
pair:create-failed                     — if mux.createChannel returns null
pair:channel-opened
pair:onclose
```

Plus, in `src/bare.js`:

```
pair:open-for-circle       (circleId, conns, opened, writable)   — joiner-initiated iteration
pair:remote-open-matched   (circleId, writable)                  — owner's notify found the circle
pair:remote-open-no-base   (circleId)                            — owner's notify didn't have the circle
```

These would have saved several hours of investigation today. They cost nothing in steady state (no IPC, no file write — `mark()` only calls `console.warn` and appends to the in-memory `_coldStartLines` buffer that flushes once at init).

`src/pair.js` accepts a `mark` callback in its options, threaded through from each `setupPairChannel` callsite in `src/bare.js`. Pair.js stays decoupled from the bare module's state; the trace calls are no-ops when `mark` is absent.

## Compat

The fix is purely additive in behavior on each side:

- **New code peer**: registers `mux.pair(...)` at conn-open time (extra). Opens pair channels on `circle:join` over active connections (extra). Does *not* proactively open on `circle:create` (removed).
- **Old code peer**: only opens pair channels at `onSwarmConnection`. No `mux.pair()`. No `circle:join`-time open.

Mixed-fleet pair behavior:

- **New + new** (the case that motivated the work): joiner opens via `circle:join`, owner's notify lazily creates the matching channel, handshake completes. **Fixed.**
- **New owner + old joiner**: new owner has `mux.pair()` registered. Old joiner doesn't open from `circle:join` (no such code), only from `onSwarmConnection`. On the existing connection, joiner never opens for the new circle → owner's notify is never invoked. Same broken behavior as today, no regression. Recovery via reconnect (cold-boot) keeps working.
- **Old owner + new joiner**: new joiner opens via `circle:join`. Old owner has no `mux.pair()`, no channel pending. Protomux rejects. Same broken behavior, no regression.
- **Old + old**: unchanged.

So new peers benefit when they upgrade together; old peers see no regression. No coordinated rollout required. No wire-version bump.

`v` stays at 1. No Hyperbee, IPC, or invite-link change.

## Verify

1. **Repro the original failure on the current build** (no fix): documented in today's investigation. Joiner stays absent from the owner's members list after joining a circle created post-init. (Already captured in events.log on the abandoned diagnostic branch.)
2. **Same scenario on the fixed build**: expected events.log timeline:
   - D2 (joiner) `circle:join` → `pair:open-for-circle` with `conns>0, opened>0` → `pair:channel-opened` → `pair:onopen (writable=false)` → `pair:hello-sent`.
   - D1 (owner) within ~1 RTT → `pair:remote-open-matched (writable=true)` → `pair:channel-opened` → `pair:onopen (writable=true)` → `pair:hello-received (valid=true)` → `pair:addwriter-appended`.
   - D2 receives the addWriter via replication → `writer:first-added` → autoAppendMemberRow appends `member:{D2pub}`.
   - D1 receives the `member:` row → UI shows D2 in the members list.
3. **Existing-circle paths unchanged**: D1 + D2 cold-boot with the same pre-existing circles. Confirm the boot-time pair-channel setup still completes for every circle in `_circleBases` (no regression).
4. **Multiple circles created in sequence on a live connection**: D1 creates circle B, then circle C, while D2 is connected. D2 joins each in turn. Both handshakes complete.
5. **Disconnect / reconnect**: connection drops and reopens. The reconnection goes through `onSwarmConnection` which iterates `_circleBases` (now including the post-init-added circles) and `mux.pair()` is re-registered on the new connection. Handshakes work via either path.
6. **Compat smoke**: install on D1, leave D2 on the prior build. Re-run the new-circle scenario. Expect broken behavior as before (D1 doesn't see D2 on the new circle, since old D2 doesn't open the channel via `circle:join`). Confirm no new symptoms — crash, hang, replication breakage — on either side.
7. **Verify gate**: `npm run verify` passes (Constitution §5).
8. **Build + install before PR**: per project conventions.

## Rollback

Small set of additions: one module-scope Set, one helper function, one notify-registration helper, a few added lines in `onSwarmConnection` / `circle:join` / `mountCircleAutobase`. Rollback is `git revert` of the implementation commit. No data migration, no wire-format coordination.

## Open questions

- **Q1: Should `circle:create` ever proactively open?** Default: no. The owner has no information about which peers might be connected, and even if it did, the joiner side has to open eventually anyway (to send `writerHello`). Owner waits via `pair()` notify.
- **Q2: Should `mountCircleAutobase` also call the helper?** Mount happens during init before any swarm connections exist; the helper is a no-op there. But it's defensive against future code paths that mount circles mid-session. **Default: include it.**
- **Q3: Tier classification.** Called T1 because nothing about the wire/schema/IPC shape changes. The cross-peer behavior changes only in the sense that previously-impossible handshakes now succeed; nothing previously-working breaks. T2 framing would be defensible under a strict reading of "any visible cross-peer behavior change is T2", but pragmatically this is a bug fix in the connection lifecycle, not a protocol amendment.
