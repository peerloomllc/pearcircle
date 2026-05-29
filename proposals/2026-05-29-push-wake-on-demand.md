# Push wake-on-demand - remote-wake a sleeping phone to publish a fresh fix

**Status**: DEFERRED 2026-05-29 (decision B). We are not building push. The freshness gap is covered by the blind seeder (last-known while offline) plus the Tier 1 visit/self-region wakes (relaunch on movement/arrival, even force-quit) plus the foreground one-shot. Kept as a design reference in case a zero-knowledge relay is revisited. Tracked in TODO.md "Future / not v1".

**Correction to the original draft (the load-bearing reason for deferral)**: the relay is NOT self-hostable. iOS push requires the relay to authenticate to APNs with PearCircle's own credential - a team-scoped `.p8` token key or a per-app push certificate, both tied to the PeerLoom Apple Developer account (G79ALD29NA). Whoever holds it can push to every PearCircle user, so it cannot be distributed to self-hosters, and iOS offers no per-user or per-circle push credential. There is no other remote-wake-from-suspended mechanism on iOS. Therefore any iOS wake relay is necessarily PeerLoom-operated, which conflicts with the decentralization principle ("no PeerLoom-operated central infra"). The only mitigation is the zero-knowledge design below (opaque token in, content-free push out, no location, no identity, no circle data, no logs). The protocol design holds up; the credential reality is why we deferred. Android's equivalent (high-priority FCM data message) has the same Google-held-credential shape.

**Goal**: Let one circle member's app remote-wake another member's suspended or backgrounded phone on demand, so the woken device grabs a current location fix and publishes it over the existing P2P path, using a relay that only ever forwards an opaque wake signal and never sees location, identity, or circle content.

**Tier**: T3. Security-critical (push-token custody, APNs/relay key handling, social-graph metadata exposure), adds a new replicated record kind (`push:{pubkey}`), new IPC, a new iOS entitlement plus background mode, and an optional external relay service. Additive on the wire: old-code peers neither publish tokens nor send wakes, and ignore the new record.

## Background

The co-presence gap between PearCircle and server-mediated apps (Life360) was characterized in `proposals/2026-05-19-blind-seeder-peers.md` and `DECISIONS.md` 2026-05-19:

- Server-mediated: only one peer needs to be alive. Sender pushes to a server, the receiver gets a silent push, the OS briefly launches the receiver app. Asymmetric liveness.
- PearCircle: data flows A to B only when both are reachable on the Hyperswarm topic at the same instant, or via gossip through a third live peer.

Two of the three mitigations from that proposal have shipped:

1. **Strict co-presence** - Android foreground service, local geofence notifications. In place.
2. **Always-on blind seeder** (shipped 2026-05-19/20, PRs #35-#42) - async replication so a viewer gets a member's last-known position even when that member is fully offline. This closes "the data is there waiting when the phone next gets CPU."
3. **Push-relay wake** - explicitly deferred as follow-up #3 in the blind-seeder proposal and listed as rejected-for-now alternative (b) in `DECISIONS.md` 2026-05-19: "best UX but furthest from serverless purity."

The blind seeder does NOT wake a sleeping phone. It only makes stale data available. A viewer who opens the app and finds a member's position hours old, with that member offline, has no way to ask for something fresher. This proposal addresses follow-up #3.

The 2026-05-29 work this session is the on-device complement and is already partly done:

- **Foreground one-shot fix** (PR #63, merged) - fresh fix when the user opens their own app.
- **Tier 1 visit + self-region** (branch `feature/ios-visit-and-self-region`) - `CLVisit` and a trailing self-region wake a suspended or force-quit iPhone on arrival or ~120m movement, at negligible battery.

Those handle the cases iOS gives us for free. Push covers the one they cannot: a stationary, backgrounded phone that nobody has a reason to wake except that a circle member is looking at the map right now.

### What iOS push can and cannot do

- A silent push (`content-available: 1`, `remote-notification` background mode) wakes a **backgrounded or suspended** app for ~30s. Enough for: kick the worklet, request a single fix, flush the swarm announce so co-online viewers replicate it.
- A silent push does **not** relaunch a **user-force-quit** app. Region monitoring, SLC, and `CLVisit` (just-shipped Tier 1) do relaunch force-quit apps - so push complements Tier 1, it does not replace it.
- Silent pushes are **budgeted and best-effort**. iOS throttles them, and Low Power Mode can drop them entirely. This is a freshness optimization, never a guarantee.
- A peer cannot send APNs directly: APNs requires the app's signing key (`.p8`), held by a server. That server is the relay, and it is the only new piece of infrastructure.

## Scope

In scope (v1, iOS):

- **APNs registration**. New entitlement `aps-environment`, `remote-notification` added to `UIBackgroundModes` (Info.plist + app.json), device-token capture in `AppDelegate`, and a `registerForPush()` / `getPushToken()` bridge on the `PearCircleLocation` native module (or a sibling `PearCirclePush` module). Registration is gated behind an explicit user opt-in (see Settings below); the app never registers silently.
- **`push:{pubkey}` replicated record** on the per-circle autobase view:
  ```
  { pubkey, platform: 'ios', token, env: 'prod'|'sandbox', updatedAt, v: 1 }
  ```
  Signed by the owning identity. Apply rule: the appending writer pubkey must equal the row's `pubkey` (only you publish your own token). LWW on `updatedAt`. A device republishes on token change (reinstall, restore, OS rotation).
- **Token confidentiality at rest**. The record lives in the circle's already-encrypted autobase (mandatory per blind-seeder Q1), so blind seeders replicate it as ciphertext and never learn a token. Push therefore requires an encrypted circle; legacy unencrypted circles do not get push (the publish path refuses, same gating shape as `circle:invite:seed`).
- **Relay protocol**. A minimal stateless HTTPS endpoint:
  ```
  POST /wake   { platform: 'ios', token }   ->   202 Accepted | 410 Unregistered | 429 Too Many
  ```
  The relay forwards a `content-available` push carrying no body to APNs, returns APNs's verdict, logs nothing. It holds exactly one secret: the APNs `.p8` auth key. NOTE (correction, see Status): this credential is PeerLoom's and team-scoped, so the relay is necessarily PeerLoom-operated and cannot be self-hosted. The zero-knowledge posture (no location, no identity, no logs) is what makes a PeerLoom-operated relay defensible, not self-hosting.
- **On-wake handler**. `AppDelegate application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` recognizes the wake push, sends a `push:wake` IPC to the worklet, the worklet (a) triggers `requestSingleFix`, (b) `flush()`es the swarm announce so co-online viewers replicate the new `lastSeen`, then calls the completion handler. Must finish inside the ~30s budget.
- **Wake trigger + UX**. A "Request update" affordance on a member's detail view, enabled when that member's `lastSeen` is older than a threshold and they appear offline (no open swarm connection). It reads the target's `push:{pubkey}` token from the local view and POSTs to the configured relay. Per-target client-side cooldown to prevent hammering.
- **Settings + privacy explainer**. An opt-in toggle "Let circle members refresh your location" (registers for APNs, publishes the token). A relay-endpoint field defaulting to the optional PeerLoom instance, with a self-host URL option. Clear copy: what the relay sees (an opaque token and the timing of a wake), what it never sees (location, names, circle membership).
- **Verify + tests** per Constitution Section 5.

Out of scope:

- **Android FCM**. Android's foreground service already streams every ~10s while sharing is on, so the gap is far smaller. High-priority FCM data-message wakes for the Doze / force-quit case are a follow-up, not v1.
- **Waking a user-force-quit iOS app**. Impossible via push. Covered by Tier 1 region/SLC/visit and by the seeder's stored last-known.
- **Delivery guarantees**. Silent push is best-effort. No retry storms, no fallback alert push in v1 (see Q6).
- **Relay holding any user data**. The relay never receives or stores location, identity, or circle data. Non-negotiable.
- **Push for notification content**. Geofence and trip alerts stay local notifications. This feature is wake-only.
- **Auto-wake fan-out**. v1 wakes one target per explicit request. No "wake every stale member on app open" (battery and abuse cost; see Q1).

## Compat

- **Old-code peer**: never registers a token, never publishes `push:{pubkey}`, never sends a wake, ignores unknown rows. Fully additive. A new peer only ever wakes a target that has published a token, so an old target is simply un-wakeable (degrades to today's behavior).
- **New peer, target has push off**: no `push:{pubkey}` row exists, the "Request update" affordance is hidden for that member. No-op.
- **Encrypted circles only**: matches the blind-seeder gating. Unencrypted legacy circles get no push; the UI explains why and points at recreating the circle encrypted, same as the seeder path.
- **Token rotation / staleness**: APNs returns `410 Unregistered` for a dead token; the relay surfaces it, the requester drops the stale `push:` view entry locally and waits for the target to republish. No wire change for rotation - it is just a newer `updatedAt` row.
- **Wire-protocol record**: `push:{pubkey}` carries `v: 1` like every other record kind. A 2026-05-29 amendment to `proposals/2026-05-03-wire-protocol.md` documents the new kind and its apply rule.

## Design

### Token publication and apply rule

```js
// publish (self only), on registration and on token change
await base.append({ type: 'put', key: 'push:' + ourKey, value: signValue({
  pubkey: ourKey, platform: 'ios', token, env, updatedAt: stamp, v: 1
}, _identity.secretKey) })

// apply branch
if (op.key.startsWith('push:')) {
  const v = op.value
  if (!verifyValue(v)) continue
  if (op.key.slice('push:'.length) !== v.pubkey) continue   // only self publishes self
  if (op.writer !== v.pubkey) continue
  const existing = await view.get(op.key)
  if (existing && (existing.updatedAt ?? 0) >= (v.updatedAt ?? 0)) continue   // LWW
  await view.put(op.key, v)
  continue
}
```

A token is device-identifying and rotates, so it is the most sensitive thing we replicate. Two guards: it only ever lives in encrypted blocks (seeders see ciphertext), and only the owner can write their own row (the key/value/writer pubkeys must all match).

### Relay

Stateless, single secret, no persistence:

```
POST /wake
  body: { platform: "ios", token: "<hex>" }
  - validates shape, rate-limits per token (Q5)
  - sends APNs content-available push, empty payload + a fixed opaque type tag
  - returns APNs status (202 / 410 / 429); writes no logs tying token to time
```

The relay learns: a token (which only circle members hold) got a wake, and when, plus the requester's IP. It never learns location, who the token belongs to, or which circle. This is the Signal/Matrix posture: dumb wake, E2E-P2P content. Per the decentralization principle it is self-hostable (a circle, a power user, or a community runs it); the PeerLoom reference instance is opt-in and clearly labeled, not load-bearing.

APNs `.p8` custody is the relay's only real risk surface. A compromised relay can spam wakes (battery DoS) but cannot read anything. Mitigations: per-token rate limit at the relay, a matching client cooldown, and the fact that tokens rotate so a leaked token set goes stale.

### Wake flow

1. Viewer opens member M's detail. M's `lastSeen` is stale and M has no open swarm connection.
2. Viewer reads `push:M` from the local encrypted view, POSTs `{ platform, token }` to the relay (subject to client cooldown).
3. Relay sends the silent push to APNs.
4. M's suspended app wakes (~30s). `AppDelegate` -> `push:wake` IPC -> worklet `requestSingleFix` + swarm `flush()`.
5. M publishes a fresh `lastSeen`. If the viewer is still co-online (likely - they just asked), replication delivers it within seconds. If not, the seeder catches it and the viewer gets it on next sync.

Best-effort throughout: if M is force-quit or in Low Power Mode the wake may not arrive, and the viewer falls back to seeder last-known (already shipped). The UI must not imply a guarantee.

### On-wake handler budget

The ~30s window covers Bare resume (not cold-start, since push targets suspended-not-killed apps), a single fix, and a swarm flush. For a suspended app the worklet is resident and resumes fast. We assert the completion handler is always called (a watchdog timer fires it at T+25s even if the fix is slow) so iOS does not penalize our background budget.

### Settings and consent

- Opt-in toggle, default off. Enabling registers for APNs and publishes the token to every encrypted circle the user is in.
- Disabling unregisters and writes a tombstone (`push:{pubkey}` with an empty token + newer `updatedAt`) so members stop showing the affordance.
- Relay endpoint configurable; default the optional hosted instance, with a self-host field and a one-line privacy explainer.

## Verify

Per Constitution Section 5, `npm run verify` (jest + bundle builds) must pass.

New tests:

- `tests/pushApply.test.js` - apply branch: accepts a self-signed row, rejects key/value pubkey mismatch, rejects a row whose writer != pubkey, LWW resolves on `updatedAt`, tombstone (empty token, newer ts) supersedes.
- `tests/pushPublish.test.js` - publish refuses on unencrypted circles; republish on token change writes a newer row; disable writes a tombstone.
- `tests/pushRelay.test.js` - the wake request body carries no location and no circle id (asserted on the serialized payload); 410 maps to "stale token" handling; rate-limit returns 429 and the client respects cooldown.
- `tests/pushWakeHandler.test.js` - a `push:wake` IPC triggers `requestSingleFix` + swarm flush and the completion path always resolves (watchdog fires if the fix stalls).

Manual smoke (D1 owner/cell, D2 joiner/wifi, paired iPhone, a self-hosted relay):

1. **Opt-in + token publish**: enable push on the iPhone. `push:{pubkey}` appears in the encrypted circle; D1/D2 replicate it. Pull the seeder's view core and confirm the token bytes are ciphertext (no token in `strings(1)`).
2. **Wake while backgrounded** (load-bearing demo): iPhone backgrounded and stationary, `lastSeen` aged past the threshold. D1 taps "Request update". iPhone wakes, publishes a fresh fix, D1 sees the pin and timestamp refresh within a few seconds.
3. **Force-quit fallback**: force-quit the iPhone, request a wake. It does not arrive (expected); D1 still shows seeder last-known, no error state implying a guarantee.
4. **Stale token**: reinstall the app (new token), have a peer request a wake against the old token. Relay returns 410, requester drops the stale entry, next republish heals it.
5. **Rate-limit**: spam "Request update". Client cooldown blocks most; relay 429s the rest. No battery storm on the target.
6. **Relay sees nothing**: inspect the relay process and any logs during 1-5; confirm no location, name, or circle id ever reaches it.
7. **Compat**: a pre-feature build ignores `push:` rows and shows no affordance. A peer with push off is un-wakeable and the UI hides the button.
8. **Verify gate** green; build APK + `./scripts/ios-dev-install.sh`, validate on D1/D2/iPhone, wait for user sign-off before PR (project convention).

## Rollback

Cleaner than the blind seeder (no circle-orphaning risk, because nothing about block readability changes):

- Feature is behind a build flag. Disabling stops registration and wake sends; existing `push:{pubkey}` rows become inert data (new code gone, nothing reads them).
- The relay shuts down independently of the app; with no relay, "Request update" simply fails gracefully and the app falls back to seeder/Tier-1 freshness.
- No migration, no key baked into blocks. A revert leaves encrypted circles fully functional.

## RCA readiness

Pre-emptive failure-mode analysis (Constitution Section 6):

- **Token leak**: tokens live only in encrypted blocks and are useless without the relay's APNs key. A leaked token enables at most a wake (battery cost), not data access. Rate-limit + rotation bound it.
- **Relay compromise**: sees tokens and wake timing (social-graph metadata), never content. Mitigate by self-hosting, by minimizing/avoiding logs, and by the ability to rotate the relay and re-register tokens. Documented as the central trust trade-off of the feature.
- **Background budget abuse**: a stalled fix could blow the 30s window and get the app deprioritized by iOS. The T+25s watchdog that force-calls the completion handler prevents this.
- **Silent-push drop (Low Power Mode / force-quit)**: expected and documented; the seeder + Tier 1 are the floor. The UI must never present push as a guarantee.
- **Metadata correlation at the relay**: the relay can infer "member X's token was woken N times today." Self-host removes this; the hosted instance documents it and keeps no logs.

A `DECISIONS.md` row records: push-token confidentiality rides circle encryption, relay is wake-only/self-hostable, push is a best-effort optimization layered on the seeder.

## Open questions

- **Q1: Manual "Request update" only, or auto-wake on opening a stale member?** Recommend manual + an explicit opt-in auto, to bound battery and abuse. Auto-wake-all is out of scope.
- **Q2: Token in the replicated `push:{pubkey}` record, or an ephemeral Protomux exchange on connection?** Recommend the replicated (encrypted) record: a viewer must know the token while the target is offline, which an on-connection exchange cannot provide.
- **Q3: PeerLoom-hosted reference relay, or self-host only in v1?** Recommend shipping the self-host path plus a clearly-optional hosted reference instance, so the common case works without standing up infrastructure.
- **Q4: Android FCM in v1 or follow-up?** Recommend follow-up; the FGS already covers most of Android's gap.
- **Q5: Rate-limit values?** Proposed: 60s client-side cooldown per target, 30s relay-side per token. Tune on device.
- **Q6: Fallback when the silent push is dropped?** Options: (a) rely on seeder/Tier-1 (recommended for v1), (b) a user-visible "tap to update" alert push requiring a separate consent and alert entitlement. Defer (b).
- **Q7: Relay request authentication?** Token-as-capability (only members hold it) + rate-limit for v1. A signed proof-of-membership is a hardening follow-up if abuse appears.
- **Q8: Wake budget across many circles?** A member in many circles publishes the same device token to each; a wake is per-device, not per-circle, so fan-out is naturally deduped at the token level. Confirm the UI dedupes requests by token.
