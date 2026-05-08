# Network-change handler

**Status**: Approved & shipped 2026-05-08. Open Question #1 resolved: `_swarm.flush()` alone is sufficient — no per-topic leave/rejoin fallback needed. Validated end-to-end on the wifi → cell → wifi scenario (D1 on USB, D2 wifi-only): D2 saw D1 reappear within 1.2s of detecting the disconnect, vs the original 60s+ observation. T1 work; no review file required (Constitution §6).

**Goal**: When the device's default network changes (wifi → cell → wifi, vpn on / off, ethernet plug, hotspot), prompt Hyperswarm to drop dead connections and re-announce on the new network so peers reconverge in seconds instead of waiting on Hyperswarm's internal periodic re-announce.

**Tier**: T1. App-internal: native callback wiring + one new IPC method + one worklet handler. No wire-protocol change, no Hyperbee schema change, no replicated record. Old-code peers and new-code peers continue to talk identically; the difference is purely how fast a single device recovers from its own network event.

## Background

The 2026-05-07 cold-start investigation (DONE.md) established that a true cold-start (force-stop + relaunch) reconnects D1 and D2 in roughly 5 seconds. The user's earlier "60s of foreground app-use to resurrect the flow" observation reproduced only in the network-toggle scenario, where:

1. The foreground location service keeps the JS process alive across swipe-from-recents (this is working as designed).
2. The worklet, Hyperswarm, the DHT announcement and the existing peer sockets all carry over.
3. When wifi drops and the device falls to cell, the local IP changes and the existing TCP / UTP sockets are dead. Hyperswarm's `conn.on('error')` fires but our handler swallows it (now logged after this investigation).
4. The DHT entry announcing this device is now wrong: it points peers at the old wifi IP / port. Until Hyperswarm's internal periodic re-announce triggers (best guess from the 60s observation), peers cannot find this device.
5. When wifi comes back, the local IP changes again and we still don't re-announce.

The fix is to listen for default-network changes on the native side and force a re-announce.

## Scope

In scope (Android-only this slice):

- Native: register `ConnectivityManager.NetworkCallback` on the default network in `PearCircleLocationModule`. Fires `onAvailable`, `onLost`, `onCapabilitiesChanged`. We trigger on transitions of the default network's `Network` handle or its `transport` (a new wifi handle, or wifi → cell, etc.).
- Native → JS bridge: emit `PearCircleLocation:network:changed` with `{ transport: 'wifi'|'cellular'|'ethernet'|'vpn'|'unknown', netHandle: number }`.
- Shell: forward to worklet IPC as `{ method: 'network:changed', args: { transport, netHandle } }` from the same `NativeEventEmitter` that already handles `PearCircleLocation:update`. No WebView-facing event; the UI doesn't need to know.
- Worklet: new `network:changed` handler. Logs a `[coldstart worklet+Nms] network:changed` mark, then calls `_swarm.flush()` to re-announce all joined topics. If empirical testing shows `flush()` alone doesn't refresh the announcement (Hyperswarm 4.x API question, see Open questions), fall back to an explicit `swarm.leave(topic)` + `swarm.join(topic, ...)` sweep over `_topicToCircle`.
- Debounce on the native side: 2s timer that coalesces transient transitions during a single network swap (real wifi → cell flips emit several callbacks). One debounced event reaches JS per actual network identity change.

Out of scope this slice:

- iOS `NWPathMonitor` — bundled with the iOS LocationModule TODO; same shape on the JS side.
- Manual "force reconnect" UI button. The automatic handler covers the observed case; a manual button is a nice-to-have for edge cases (offline-mode just cleared, app left dormant for a long time on the same network) and can land separately.
- Tearing down and re-mounting Autobase / Corestore: not needed. The local cores are healthy; only the swarm-side announcement and live connections are stale.
- Reacting to permission changes (Doze, location permission revoke). Separate concerns.

## Compat

No wire change, no persisted-data change, no IPC shape change visible to peers. An old-code peer (running the pre-handler build) and a new-code peer (running this) interoperate identically; only the new-code peer's recovery is faster on its end. No migration. No `v` field bump.

## Verify

- **Manual two-device** (D1 cell-capable + D2 wifi): warm up both apps, toggle wifi off on D1 → wait 60s → wifi back on. Observe via logcat:
  - `peer:disconnected` shortly after wifi-off (already added in instrumentation)
  - `network:changed` mark from the worklet shortly after each transition (debounced)
  - `peer:reconnected` within ~10s of wifi-on (currently: minute-ish or never)
- **Logcat sanity**: confirm the 2s debounce coalesces the burst of native callbacks during a transition into a single worklet `network:changed`.
- **Jest**: thin worklet-level test mocking `_swarm` and asserting `flush()` is called on `network:changed`. Native `NetworkCallback` registration is left to manual / smoke; we don't run instrumented Android tests in CI.
- **Regression**: existing `npm run verify` chain still green after the changes.

## Rollback

Pure additive: deleting the native callback registration, the IPC method, and the worklet handler restores the previous behavior. No on-disk side effects to clean up. The cold-start instrumentation marks remain (independent of this slice).

## Open questions

1. ~~**Is `swarm.flush()` enough?**~~ **Resolved 2026-05-08:** yes, `flush()` alone is sufficient. wifi → cell → wifi smoke test on D1/D2 showed D2 reconnecting to D1 on its new cellular IP within 1.2s of detecting the disconnect — fresh DHT lookup found the new announcement Hyperswarm published after `flush()`. The proposed `swarm.leave()`/`swarm.join()` sweep fallback is not needed.
2. **VPN flips and tethering.** A VPN coming up or a personal hotspot starting both look like default-network changes. Re-announcing in those cases is correct (the device's reachable address changed) but we should confirm the callback fires on those edges, not only on wifi / cell. Not validated in the 2026-05-08 smoke; flagged for the next time those transitions matter.
3. **iOS WiFi-Assist parity.** When iOS lands, `NWPathMonitor` will fire when WiFi-Assist routes traffic over cell despite wifi staying associated. Whether that should trigger a re-announce is debatable — the device is still reachable on wifi, just slow. Defer the call to the iOS slice.
4. ~~**Foreground gating.**~~ **Decided in implementation:** keep the callback registered always-on. The native callback registers in `init {}` and stays for the module's lifetime; no link to the foreground service's lifecycle. Cheap to leave running, and if sharing is paused but the worklet is still alive, a re-announce on a not-actively-sharing peer is harmless (the swarm announcement makes the device discoverable; whether we then *write* lastSeen rows is a separate gate handled by `_sharingEnabled`).
