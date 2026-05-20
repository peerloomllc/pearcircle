# Blind seeder peers - always-on replication without trust

**Status**: Draft 2026-05-19. Open questions resolved 2026-05-19 (see end of doc): Q1 always-on encryption with no user toggle, Q2 one identity per device, Q3 mode fixed at launch, Q4 per-circle list only, Q5 v: 1 on seeder rows, Q6 document anonymity concern only, Q7 any-member admission with transparency, Q8 ship TTL config knob in v1. Awaiting approval.

**Goal**: Let a circle enroll an always-on "blind seeder" device (a Raspberry Pi, a spare phone, eventually a community-run mesh) that replicates encrypted Autobase blocks for the circle but never holds the encryption key, so circle members can sync asynchronously without both being online at the same instant. Closes the structural co-presence gap that today's pure-P2P design has against server-mediated apps like Life360.

**Tier**: T3. Adds Hypercore block encryption per circle, a second invite-link shape (seed-only) that withholds the encryption key, and a new replicated `seeder:{pubkey}` record kind. Old-code peers cannot read encrypted blocks and therefore cannot join circles that opt in. Forced upgrade is required before any user creates an encrypted circle. The wire-protocol-v1 floor is preserved at the record-schema level (no existing record kind changes shape), but the per-circle replication layer is no longer wire-compatible for opt-in circles.

## Background

A separate conversation on 2026-05-19 surfaced the structural reliability gap between PearCircle and server-mediated equivalents (Life360):

- Server-mediated: only one peer needs to be alive at a time. Sender pushes to server, receiver gets APNs/FCM silent push, OS launches the receiver app briefly. Asymmetric liveness.
- PearCircle today: data flows A to B only when both are reachable on the Hyperswarm topic simultaneously (or via gossip through a third live peer). When iOS wakes us from a CLCircularRegion event we get ~30s of CPU - often not enough for Bare cold-start + bundle load + Hyperbee restore + DHT lookup + hole punch + replicate. Receivers can't be remote-woken at all via P2P alone.

Three classes of mitigation exist:
1. Strict co-presence (Android foreground service both sides, local geofence notifications). Already in place. Doesn't help cross-device freshness when one side is fully backgrounded.
2. Always-on relay peer. Reliability win without becoming a server.
3. Tiny push-relay service. Best UX, furthest from serverless purity.

This proposal addresses (2) in its strongest form: a "blind" seeder that participates in replication but cannot decrypt content. A non-blind always-on member would also work and is strictly simpler, but it requires placing trust in whoever runs the hardware, and the design ergonomics of a seeder that "is a member" don't compose well (it counts in member lists, it shows on the map, it has a profile). Blind is the right shape for the role.

## Scope

In scope:

- **Hypercore block encryption** turned on per-circle for the Autobase view core and the per-circle Hyperbee bee. A 32-byte `encryptionKey` is generated at circle-creation time, stored in the circle's local Hyperbee row (never replicated), and threaded into every Hypercore constructor for that circle. Encryption is **mandatory for all circles created post-feature**; there is no user-facing toggle (Q1 resolution).
- **Invite-link grammar amendment**: the existing member invite gains a required `enc={hex(encryptionKey)}` field for encrypted circles. Circles created before this proposal stay unencrypted; their invite grammar is unchanged.
- **Seed-only invite link**: new `/circle/seed` path carrying topic + bootstrap + inviter but no `enc`. Format:
  ```
  https://peerloomllc.com/circle/seed?circle={base64url(circleId)}&name={name}&key={hex(circleKey)}&bootstrap={hex(autobaseBootstrap)}&inviter={hex(memberPubkey)}
  ```
  Legacy `pear://pearcircle/seed?...` accepted in parallel with the existing legacy member-join scheme.
- **New replicated record `seeder:{pubkey}`** on the per-circle autobase view:
  ```
  { pubkey, addedBy, addedAt, label?: string, revoked?: boolean, revokedAt?: number, revokedBy?: string, v: 1 }
  ```
  Any current member can append (signs the row). Apply branch admits the seeder pubkey to the swarm topic. Revocation via `revoked: true` tombstone follows the same LWW-on-`revokedAt` shape as `place:{id}` soft-delete (amendment 2026-05-05).
- **Worklet seed-only mode**: `bare.js` boots into seed mode when launched with `{ mode: 'seed' }` IPC arg. Seed mode:
  - Loads its own persistent identity (`identity:seeder`) from the local Hyperbee
  - For every circle it's been enrolled in (`seeder:enrolled:{circleId}` local rows), joins the swarm topic and opens the Autobase view core in **replication-only** mode (no `encryptionKey`, no `apply` callback, no `addWriter` call)
  - Refuses all `lastSeen` / `transition` / `place` / `member` / `seeder` IPC writes
  - Logs only block-counts and connection events, never plaintext (asserted in code)
- **Seed-enrollment IPC**: on the seeder device, `seeder:enroll({ invite })` parses a `/circle/seed` invite, stores the circle's topic + bootstrap + inviter under `seeder:enrolled:{circleId}`, joins the swarm, and waits for the inviter to publish a `seeder:{seederPubkey}` row admitting it.
- **Member-side IPCs** (the device that mints the invite):
  - `circle:invite:seed({ circleId, label? })` returns the seed-invite string. Doesn't write any record; the `seeder:{pubkey}` row is written reactively when the seeder device connects and announces itself.
  - `circle:seeders:list({ circleId })` returns the current (non-revoked) seeder rows for a circle.
  - `circle:seeder:revoke({ circleId, pubkey })` writes the tombstone.
- **Seeder-self-announce protocol**: on first swarm-connection to a member of a circle the seeder has enrolled in, the seeder sends a one-shot Protomux channel message `seeder:announce { pubkey, label? }`. The receiving member's worklet validates the topic admission, prompts the user once via UI ("Add this device as a seeder for circle X?"), and on approval signs and appends the `seeder:{pubkey}` row.
- **Settings UI**: per-circle "Seeders" section listing enrolled seeders by short pubkey + label, with mint-invite, list, and revoke actions. Counts seeders separately from members; map view does not render seeders.
- **Seeder retention config** (Q8 resolution): a `pruneOlderThan` integer (ms) per enrolled circle on the seeder's local Hyperbee, default `null` (no pruning). Set via `seeder:retention:set({ circleId, pruneOlderThan })` on the seeder process. When non-null, a daily sweep drops Hypercore blocks whose autobase-ordering timestamp is older than the threshold. Members are unaffected; pruning is purely a seeder-local disk-budget knob.
- **Verify + test fixtures** for encryption round-trip, seed-mode write refusal, revocation propagation, and retention-sweep behavior.

Out of scope:

- Hosted seeder service. v1 ships the protocol + worklet mode; users run the seeder on hardware they own. PeerLoom does not operate seeders.
- Encryption-key rotation on member kick. If a removed member kept a copy of `encryptionKey`, they could still decrypt newly-replicated blocks they happen to grab off the DHT. v1 punts; we mitigate operationally (kick implies trust break, full reset of the circle is the recommendation) and track in a follow-up.
- Migrating existing unencrypted circles to encrypted. Users who want blind-seeder protection must recreate the circle.
- Per-record-kind seeder authorization. A seeder either replicates the whole circle or nothing. v1 will not support "this seeder only stores `transition:` rows."
- Seeder operating-mode UX. The seeder runs as a `node bare.js --seed` or `bare-runtime bare.js seed` command on hardware; no GUI. A future companion app could wrap this, but it's a separate effort.
- Cross-circle seeder bundling at the protocol level. One seeder process happens to enroll in multiple circles, but each circle's enrollment is independent (no shared admission, no shared identity per circle).
- Push-wake. This proposal does NOT solve "wake a sleeping iPhone via P2P" - it only solves "the data is there waiting when the iPhone next gets CPU." A seeder + a future push-relay are complementary, not substitutes.

## Compat

Mixed-fleet behavior:

- **Old-code peer + old (unencrypted) circle**: unchanged. Existing fleet keeps working.
- **Old-code peer + new (encrypted) circle**: cannot join. The old member-join code path doesn't know about the `enc` query field, the local `circle:` row write succeeds, the swarm join succeeds (topic seed is unchanged), but the bootstrap-core read returns ciphertext that the old `view.get` chain treats as malformed JSON. Failure is graceful at the parse layer (`JSON.parse` throws inside the apply branch, the apply-branch try/catch logs and continues), so the join "succeeds" but the member never sees any circle state. UX is broken but not catastrophic. **Mitigation**: bump the minimum-shipped app version before any user is told to create encrypted circles. Settings UI for circle creation gates the "Enable blind-seeder protection" toggle on a build-flag we can flip once the fleet is upgraded.
- **New-code peer + old (unencrypted) circle**: unchanged. The new code reads `encrypted: true` from the local `circle:` row, sees it absent or false, and proceeds without encryption.
- **New-code peer + new (encrypted) circle**: full feature. Every new circle is encrypted; there is no unencrypted-circle creation path in the new build (Q1 resolution). The `encrypted: true` field on the `circle:` row is therefore implicit for any circle created post-feature, but we still write it explicitly so old-circle migration tooling can distinguish.
- **Blind seeder + encrypted circle**: blind seeder joins the topic, replicates encrypted blocks, never decrypts.
- **Blind seeder + unencrypted circle**: not supported. Seed invites are only mintable for encrypted circles (the IPC refuses on unencrypted circles with a clear error). This is intentional - a blind seeder for an unencrypted circle is just a full member, and that case is better served by encouraging the user to either (a) recreate the circle encrypted or (b) join a phone as a real member.

Wire-protocol version: existing record kinds keep `v: 1`. The `circle:` row gains an optional `encrypted: true` field which is additive in the same sense as `deleted` on `place:` (amendment 2026-05-05). The truly breaking change is at the Hypercore block-encryption layer, which lives below the record schema. We document this in a 2026-05-19 amendment to the wire-protocol proposal noting that blocks for circles marked `encrypted: true` are ciphertext and cannot be parsed by builds older than the feature ship-date.

## Design

### Encryption key derivation

The encryption key is **derived deterministically** from `circleKey`:

```js
const encryptionKey = sodium.crypto_generichash(32, circleKey, b4a.from('pearcircle-enc-v1'))
```

Two consequences:
- No new field in member invites is strictly required (members already have `circleKey`, derivation runs locally). But we include `enc={hex}` in the invite grammar anyway as a forward-compat hook: future versions can rotate the encryption key independently of the topic seed, and the field gives us the shape to ship that in without an invite-grammar bump.
- Blind seeders, who hold `circleKey` (the swarm topic seed), could theoretically derive `encryptionKey` too - **so we cannot use derivation directly as the privacy boundary**.

This is the load-bearing decision in this proposal. The privacy boundary is enforced by the seed invite carrying a **distinct** swarm topic seed:

```
member invite:   key={circleKey}     → swarm topic = blake2b(circleKey)
seed invite:     key={circleKey}     → swarm topic = blake2b(circleKey)  (same topic, both can find peers)
                                       BUT enc field omitted → seeder never derives encryptionKey
```

Wait - that still gives the seeder enough information to derive `encryptionKey` via the same blake2b. We need to break the derivation chain. Two options:

**Option A (chosen)**: `encryptionKey` is a separate 32-byte random value generated at circle creation, stored in the inviting member's local Hyperbee, and shipped in the `enc` query param of member invites only. Not derivable from `circleKey`. Seeders holding `circleKey` cannot derive `encryptionKey`.

**Option B**: Derive `encryptionKey` from a separate per-circle secret that members hold but seeders don't, layered on top of `circleKey`. More moving parts; nothing gained over A.

The proposal uses A. Updated invite grammar:

```
member invite:
  https://peerloomllc.com/circle/join?circle={base64url(circleId)}&name={name}&key={hex(circleKey)}&enc={hex(encryptionKey)}&bootstrap={hex(autobaseBootstrap)}&inviter={hex(pubkey)}

seed invite:
  https://peerloomllc.com/circle/seed?circle={base64url(circleId)}&name={name}&key={hex(circleKey)}&bootstrap={hex(autobaseBootstrap)}&inviter={hex(pubkey)}
```

Old-shape (no `enc`) member invites continue to be parsed by new builds and treated as unencrypted-circle invites (`circle.encrypted` absent / false). New-shape invites against old builds: the old build sees an extra unknown query param and ignores it - then attempts to read unencrypted blocks and fails per Compat above.

### Hypercore block encryption wiring

In `src/bare.js`, wherever a Hypercore is opened for a circle, pass `{ encryptionKey }` if the circle's local row carries one:

```js
const encryptionKey = circleRow.encryptionKey  // Buffer or null
const core = corestore.get({ key: viewKey, encryptionKey: encryptionKey || null })
```

Same for the Hyperbee constructor on the bee that wraps the autobase view. Members hold `encryptionKey`; seeders pass `null` (the seeder's local circle row literally has no `encryptionKey` field).

Hypercore's encrypted-block reads on the seeder return a "missing key" error. The seeder's code path never calls `bee.get` or `view.get` - it only calls `core.replicate(stream)` against incoming swarm streams. Replication operates at the block-byte layer below decryption, so this works without any key.

### Seeder admission protocol

The chicken-and-egg problem: how does a freshly-enrolled seeder get its pubkey written into the `seeder:{pubkey}` admission row? The seeder can't write (it's not a member). A member has to write it.

Flow:

1. Member A mints a seed invite via `circle:invite:seed`. Receives the invite string.
2. Member A delivers the invite to the seeder out-of-band (QR scan from the seeder operator's phone, file copy, etc).
3. Seeder process receives the invite via `seeder:enroll({ invite })`. Stores `seeder:enrolled:{circleId}` locally, generates or loads its persistent identity, joins the swarm topic.
4. When the seeder establishes its first Hyperswarm connection to **any** member of that circle, both ends open a Protomux channel named `seeder/admission/v1`.
5. Seeder sends one message: `{ kind: 'announce', pubkey, label }`.
6. Member's worklet validates: topic matches, message wellformed. Emits an IPC event `seeder:announce` to the shell.
7. Shell prompts user: "A new seeder wants to join {circleName}. Approve?" - one-shot, persisted across app restarts via a pending-approvals queue.
8. On approval, member signs and appends `seeder:{seederPubkey}` to the circle's autobase. Replicates as usual.
9. Seeder's replication of the autobase view now includes its own admission row, but the seeder can't decrypt it (the row is in an encrypted block). The seeder doesn't need to; admission is enforced at the swarm-topic level by members, not by the seeder itself.

For revocation:
- Any member writes `seeder:{pubkey}` again with `revoked: true`. Other members observe the tombstone and stop streaming to that seeder pubkey (peer-filter callback on Hyperswarm connections).
- The seeder itself doesn't know it's revoked (encrypted blocks) but it stops receiving traffic, which it logs as connection churn. Optional follow-up: a clear "you've been revoked" channel message from any member that detects the revoked seeder still trying to peer.

### Apply branch for `seeder:{pubkey}`

```js
if (op.key.startsWith('seeder:')) {
  const incoming = op.value
  if (!verifyValue(incoming)) continue
  if (typeof incoming.pubkey !== 'string') continue
  const keyPubkey = op.key.slice('seeder:'.length)
  if (keyPubkey !== incoming.pubkey) continue
  const writer = op.writer  // pubkey of the appending member
  // Only admitted members (already in member:) can admit seeders.
  const writerMember = await view.get('member:' + writer)
  if (!writerMember) continue
  if (await view.get('removed:' + writer)) continue
  const existing = await view.get(op.key)
  if (existing && (existing.revokedAt ?? 0) > (incoming.revokedAt ?? 0)) continue
  await view.put(op.key, incoming)
  continue
}
```

LWW on `revokedAt` matches the place-soft-delete pattern. Re-admission after revocation is allowed by writing a fresh `seeder:{pubkey}` with `revoked: false` (absent) and a newer implicit timestamp via the autobase ordering.

### Hyperswarm peer-filter for revocation enforcement

Members refuse to stream to seeder pubkeys that have a current `revoked: true` row. The check runs on every incoming connection in `joinCircleTopic`:

```js
swarm.on('connection', async (conn, info) => {
  const remotePubkey = b4a.toString(conn.remotePublicKey, 'hex')
  const seederRow = await view.get('seeder:' + remotePubkey)
  if (seederRow?.revoked) {
    conn.destroy(new Error('seeder revoked'))
    return
  }
  // ... existing connection-handling
})
```

This is the only mechanism we have to enforce revocation - the seeder's swarm presence cannot be removed remotely; we can only refuse to talk to it. Other circle members do the same check independently and arrive at the same outcome.

### Seed-mode worklet structure

`bare.js` gains a top-level branch:

```js
const mode = process?.argv?.includes('--seed') ? 'seed' : 'member'
if (mode === 'seed') {
  await runSeederMode()
} else {
  await runMemberMode()  // existing init path
}
```

`runSeederMode`:
- Loads / generates `identity:seeder` from local Hyperbee
- Reads all `seeder:enrolled:{circleId}` rows
- For each, opens the autobase view core via the bootstrap key, joins the swarm topic, replicates
- Sets up the admission-announce Protomux channel on first connection per circle
- Never imports or instantiates anything in the location, places, transitions, or trips paths
- IPC surface is restricted: only `seeder:status`, `seeder:enroll`, `seeder:enrolled:list`, `seeder:leave`. All other IPC methods return an error.

### Settings UI

New "Seeders" section in the per-circle settings view (`src/ui/App.jsx` per-circle settings sheet). Surfaces:
- A list of currently-admitted seeders for this circle (short pubkey + label)
- A "Mint seed invite" button → opens an invite-display modal with QR + copy-text
- A "Revoke" action per seeder
- Self-state row when this device is itself a seeder (for the dev / Pi case): "This device is a seeder, not a member" + no other circle settings

Encryption is always-on for new circles (Q1 resolution). There is no creation-time checkbox. The circle-creation flow is unchanged in terms of user choices; the worklet just always generates an `encryptionKey` and the invite always carries `enc=<hex>`. We do not support converting existing unencrypted circles - users who want blind-seeder protection on a legacy circle must recreate it.

### IPC additions

| IPC | Caller | Args | Returns |
|-----|--------|------|---------|
| `circle:create` (amended) | shell | existing args + `{ encrypted: boolean }` | existing returns + `{ encryptionKey: hex \| null }` |
| `circle:invite:seed` | shell | `{ circleId, label? }` | `{ invite: string }` |
| `circle:seeders:list` | shell | `{ circleId }` | `{ seeders: [{ pubkey, addedBy, addedAt, label, revoked? }] }` |
| `circle:seeder:revoke` | shell | `{ circleId, pubkey }` | `{ ok: true }` |
| `seeder:enroll` | shell (seed mode) | `{ invite }` | `{ circleId }` |
| `seeder:enrolled:list` | shell (seed mode) | `{}` | `{ circles: [{ circleId, name, inviter, connectedPeers }] }` |
| `seeder:leave` | shell (seed mode) | `{ circleId }` | `{ ok: true }` |
| `seeder:status` | shell (seed mode) | `{}` | `{ pubkey, uptime, totalBytesReplicated }` |
| `seeder:retention:get` | shell (seed mode) | `{ circleId }` | `{ pruneOlderThan: number \| null }` |
| `seeder:retention:set` | shell (seed mode) | `{ circleId, pruneOlderThan }` | `{ ok: true }` |

IPC events emitted by member-mode worklet:
- `seeder:announced` `{ circleId, pubkey, label }` - shell shows an approval prompt
- `seeder:admitted` `{ circleId, pubkey }` - on successful admission write
- `seeder:revoked` `{ circleId, pubkey }` - on successful revoke write

IPC events emitted by seed-mode worklet:
- `seeder:connected` `{ circleId, remotePubkey }`
- `seeder:disconnected` `{ circleId, remotePubkey }`
- `seeder:bytes` `{ circleId, totalBytes }` (rate-limited to once per 60s)

## Verify

Per Constitution §5, `npm run verify` (jest + bundle builds) must pass.

New tests:

- `tests/circleEncryption.test.js` - circle creation with `encrypted: true` populates `encryptionKey`; circle creation without it leaves the field absent. Hypercore opened with the encryptionKey round-trips puts and gets. Hypercore opened against the same store WITHOUT the encryptionKey returns block-decrypt-failed on get.
- `tests/seedInvite.test.js` - `buildSeedInvite` and `parseSeedInvite` round-trip; missing `enc` field accepted (seed shape); `circle:invite:seed` refuses on unencrypted circles with a clear error.
- `tests/seederApply.test.js` - apply branch for `seeder:{pubkey}`:
  - Accepts well-formed signed rows from current members
  - Rejects rows from non-members (writer pubkey not in `member:`)
  - Rejects rows from removed members (writer pubkey in `removed:`)
  - Rejects mismatched key/value pubkey
  - LWW resolves by `revokedAt`: newer revoke wins, newer un-revoke (no `revoked` field) wins
- `tests/seederMode.test.js` - boot `bare.js` with `{ mode: 'seed' }`, attempt to call `lastSeen:write`, `transition:write`, `place:create`. All return `error: 'not-permitted-in-seed-mode'`. Seeder identity persists across two boots.
- `tests/seederAdmission.test.js` - end-to-end in a single process: spin up a member-mode worklet + a seed-mode worklet against an in-memory swarm; seeder enrolls, sends announce; member's `seeder:announced` event fires; shell-emulator approves; `seeder:{pubkey}` row appears in autobase view; member's peer-filter accepts the seeder connection. Then revoke; verify peer-filter drops a freshly-replayed seeder connection.
- `tests/seederRevocation.test.js` - revocation writes propagate to all members; each member's peer-filter independently refuses the seeder connection.
- `tests/seederRetention.test.js` - seed-mode worklet with `pruneOlderThan = 86_400_000` (1 day) drops blocks whose autobase-ordering timestamp is older than the threshold on the daily sweep; blocks newer than the threshold remain; setting `pruneOlderThan = null` disables the sweep.

Manual smoke (D1 owner / cell, D2 joiner / wifi-only, dev box running seeder):

1. **Encrypted-circle creation**: D1 creates a circle with "Enable blind-seeder protection" checked. Circle local row carries `encrypted: true` and `encryptionKey`. Invite to D2 includes the `enc` query field. D2 joins; both write and read lastSeen as before.
2. **Seeder enrollment**: D1 mints seed invite. Dev-box runs `node bare.js --seed`, calls `seeder:enroll` with the invite via a tiny CLI helper. Seeder joins the topic.
3. **Seeder admission**: D1's UI surfaces a "New seeder wants to join {circle}" prompt. D1 approves. `seeder:{seederPubkey}` row written. D2 observes the row via its own replication. Dev-box logs `seeder:admitted` event.
4. **Async sync via seeder** (the load-bearing demo):
   - D2 force-quit. D1 walks outside (geofence exit fires). lastSeen + transition appended. Seeder replicates the encrypted blocks within ~5s.
   - D1 force-quit. Seeder still running.
   - D2 launched. D2 connects to seeder (no D1 in the swarm). Replicates D1's exit transition + lastSeen from the seeder. UI shows D1's last known position and the "left Home" transition - **without D1 ever being co-online with D2.**
5. **Seeder cannot decrypt**: pull the seeder's autobase view core file off the dev box. Open it via a script that doesn't pass the encryptionKey. Confirm all block bodies are ciphertext (no JSON parses, no plaintext field names appear in `strings(1)` output).
6. **Revocation**: D1 revokes the seeder via Settings → Seeders → Revoke. Seeder's connection drops within one peer-event. New connection attempts from the seeder are refused by both D1 and D2 independently.
7. **Compat with old-app peer**: install a pre-feature build on a spare device. Try to join an encrypted circle via the new-shape invite. Verify the failure is graceful (no crash, error message in the join dialog) rather than the worklet hanging.
8. **Verify gate**: `npm run verify` green.
9. **Build + install before PR** per project convention: build APK, run `./scripts/ios-dev-install.sh`, install on D1 / D2 / paired iPhone, run smoke 1-7, wait for user validation.

## Rollback

Code-level rollback is safe per-circle:

- Reverting the feature commits: members of unencrypted circles are unaffected. Members of encrypted circles created during the feature window cannot read those circles after revert (the build no longer knows about block encryption). Seeder rows replicated to other members remain in autobase views as unparseable encrypted blocks. **Therefore: if we revert, encrypted circles created during the feature window become orphaned and must be re-created.**
- This is a strong reason to soak the feature on dev devices before any user is told to use it. Recommend a one-week soak in a single test circle before exposing the creation toggle in production builds.

Field-level rollback within the feature:
- Adding `revoked: true` to a seeder row is a forward-only operation that any member can perform.
- Encryption can't be disabled on a circle without re-creating it; the encryptionKey is baked into every block of the autobase view.
- A seeder can leave a circle voluntarily via `seeder:leave` (drops the swarm join, removes the local enrollment row). Members will still see the historical `seeder:{pubkey}` admission row; revoking it cleans up.

## RCA readiness

The Constitution §6 RCA requirement attaches to any T3 change that breaks in prod. Pre-emptive analysis of failure modes:

- **Encryption key escape into seeder context**: most-fragile assumption. If a bug copies `encryptionKey` into the seed invite path, seeders gain the ability to decrypt. Mitigation: a single helper `buildSeedInvite` that takes a circleId, reads the circle's local row, and explicitly omits the `encryptionKey` field. Unit test asserts the returned invite string doesn't contain the encryption key hex. Code-review checklist item: any new touchpoint that adds query params to a seed invite must NOT read from `encryptionKey`.
- **Block-encryption layer skipped on a write path**: if a worklet appends to a circle's autobase without passing `encryptionKey` to the Hypercore constructor, the block is written in plaintext, and from that block forward the core is mixed plaintext/ciphertext. Mitigation: a single accessor `getCoreForCircle(circleId)` is the only constructor site. Unit-test asserts that opening a circle whose row has `encrypted: true` without `encryptionKey` throws.
- **Revocation race**: a member writes the revoke tombstone, but another member's peer-filter hasn't observed it yet, so that member streams to the revoked seeder. Acceptable: the window is bounded by autobase replication latency (seconds in practice). The seeder doesn't gain new privileges - it was already receiving encrypted blocks - so the worst-case is a few extra blocks of replication after the revoke moment. Documented as expected behavior.
- **Old-peer encounters encrypted circle**: covered in Compat above. Pre-shipping the feature behind a build flag and bumping the minimum-shipped app version before flipping the flag mitigates user-visible breakage.
- **Seeder identity loss**: if the seeder's local Hyperbee is wiped, its pubkey changes on next boot, and every member has to re-admit it. Acceptable but annoying. The CLI helper warns when starting fresh ("No identity:seeder row found; generating a new identity. Existing circles will need to re-admit this device.").

Wire-protocol amendment record in `proposals/2026-05-03-wire-protocol.md` will be added as a 2026-05-19 entry noting (a) `enc=<hex>` field on member invites, (b) `/circle/seed` invite shape, (c) `seeder:{pubkey}` record kind with apply rules above, (d) Hypercore block encryption for circles marked `encrypted: true`. A `DECISIONS.md` row records the encryption-key-not-derived-from-circleKey choice.

## Open questions (resolved 2026-05-19)

- **Q1: Default-on or default-off for new circles?** **Resolved: always-on, no toggle.** Stronger than the original recommendation. Every new circle is encrypted; there is no creation-time choice for the user. Drops the toggle UI, drops the unencrypted-new-circle code path entirely. Build-flag gating on the minimum-shipped version still applies before exposing the feature to the fleet.
- **Q2: One seeder identity per device or one per circle?** **Resolved: one per device.** Single keypair stored under `identity:seeder` in the seeder's local Hyperbee, reused across every circle it enrolls in. Revoke is per-circle either way.
- **Q3: Should member-mode worklets be allowed to also run as seeders for circles they're not members of?** **Resolved: no, mode fixed at launch.** `bare.js --seed` is one process shape; the default member-mode worklet is another. No mixed mode in v1. Future companion app could run a long-lived background seeder process separately.
- **Q4: Seeder discovery: should there be a Settings affordance to list "seeders available to me" beyond the per-circle list?** **Resolved: no, per-circle list only.** No cross-circle view, no community directory. Keeps the trust model simple (you only see seeders someone explicitly invited).
- **Q5: Wire-protocol v field on seeder rows?** **Resolved: yes, `v: 1`.** Consistent with every other replicated record kind.
- **Q6: Should the seeder operate over Tor / VPN by default?** **Resolved: document only, no routing.** v1 ships plain Hyperswarm. Docs note the IP-via-DHT exposure; running behind a VPN is a power-user mitigation. Revisit if a real user asks.
- **Q7: What stops a malicious member from minting and admitting their own seeder for surveillance?** **Resolved: any-member admission with transparency.** Nothing at the protocol level prevents it - matches the existing any-member-invite decision (DECISIONS 2026-05-03). Mitigation is social: the admission prompt names the admitting member, all members see seeder rows, revoke is one tap. If real-world abuse emerges, a follow-up could add owner-veto.
- **Q8: Storage growth on seeders without pruning?** **Resolved: ship a TTL config knob in v1.** Stronger than the original recommendation. `pruneOlderThan` per enrolled circle, default `null` (no pruning). Daily sweep when set. Saves a follow-up proposal and gives Pi operators an immediate disk-budget tool.

## Sketch of follow-up work

If approved and shipped:
1. Companion app or systemd unit for running the seeder on a Pi without a graphical shell
2. Encryption-key rotation on member kick (T3, separate proposal)
3. Push-relay service to complement seeder for cross-device wake (T3, separate proposal, much larger trust trade-off)
4. Seeder mesh discovery (peer-to-peer ledger of "circles I would seed if invited"; opt-in community-run mesh) - speculative, not before v2

## Amendments

### 2026-05-19 — global seeder setup (one bundle mint for all circles)

**Tier: T2.** No wire-protocol change — no new record kind, no invite-grammar change. Additive IPCs + a UI restructure. See `DECISIONS.md` 2026-05-19.

**Motivation.** Slices 3b/4 shipped seeder management per-circle: a member minted a `/circle/seed` invite one circle at a time (`circle:invite:seed`) from a per-circle Broadcast icon in Settings → Circles, and the desktop seeder enrolled one invite per call. Real usage doesn't match that shape — someone setting up a Pi or spare phone as a seeder wants it covering every circle they're in, and minting/pasting N invites by hand is busywork. The desktop-launcher Phase 4 smoke surfaced this directly.

**Change.**

- **Bundle = newline-joined `/circle/seed` URLs.** A "bundle" is not a new invite grammar — it is simply multiple existing seed-invite URLs joined by `\n`. Each line independently round-trips through `parseSeedInvite`. Nothing on the wire changes.
- **New IPC `circle:invite:seed:all`** (member side, args `{}`): iterates the device's `circles:joined:` rows, mints a seed invite via the existing `buildSeedInvite` for every circle whose local row carries an `encryptionKey`, and returns `{ bundle: string, invites: [{ circleId, name }], skipped: number }`. Legacy unencrypted circles cannot host a blind seeder (no encryption boundary) and are skipped + counted. `circle:invite:seed` (single-circle) remains as the underlying primitive.
- **New IPC `seeders:listAll`** (member side, args `{}`): returns every seeder across every circle the device is in, grouped by seeder pubkey — `{ seeders: [{ pubkey, label, circles: [{ circleId, name, revoked }] }] }` — so the UI renders one row per seeder *device* rather than per circle.
- **Settings UI.** The per-circle Broadcast icon + per-circle `SeederManageView` are removed. A single top-level Settings → Seeders section replaces them: "Set up a seeder device" mints the bundle (copy-text + Share; no QR — a multi-circle bundle is too dense for one); the admitted-seeder list shows each device with the circles it covers and a "revoke everywhere" action.
- **Desktop launcher.** The enroll endpoint accepts a multi-line bundle, splits on newlines, and calls the unchanged single-invite `seeder:enroll` per line, returning aggregated per-circle results.

**Unchanged.** Admission and revocation stay per-circle at the protocol level. Each circle's members still independently approve a seeder (Q7 any-member-admission-with-transparency) and `circle:seeder:revoke` is still per-circle — "revoke everywhere" is a UI convenience that loops it. The `seeder:{pubkey}` record kind, the admission Protomux channel, and the revocation peer-filter are untouched.

**Trust note.** A bundle hands the seeder operator the swarm topics for every circle in it at once — a broader grant than the original opt-in-per-circle mint. This is acceptable for the intended use (your own hardware) and the admission step is still per-circle, so other members remain the gate. Documented, not gated.
