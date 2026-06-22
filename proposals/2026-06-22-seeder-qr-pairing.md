# Seeder QR pairing (phone scans, pushes the bundle)

## Goal

Eliminate the copy-paste step when linking a seeder to a phone's circles. Today
the phone mints a seed bundle (one `/circle/seed?...` line per circle) and the
user has to ferry that text from phone to a desktop/Pi/Umbrel and paste it into
the launcher. Getting text off a phone onto a headless box is the worst part of
seeder setup. Replace it with: the **seeder shows a QR, the phone scans it, and
the phone pushes its seed bundle to the seeder over the existing P2P channel** -
no copy-paste, works for headless and remote seeders.

## Tier

**T3.** New pairing/rendezvous flow: a new Hyperswarm topic, a new protomux
protocol, a new deep-link/QR format, and a new trust gate for the *first*
enrollment. Pairing surface + new wire = T3 (proposal + rollback + RCA
readiness).

## Background

### Why "seeder shows the QR" and not "phone shows the QR"

The data has to flow **phone -> seeder**: a seed invite carries the circle's
`circleKey` + `bootstrap` (the secrets the seeder needs to join the topic and
replicate), and those live on the member's phone. The intuitive "phone shows a
QR of the invite, seeder scans it" fails because real seeders are headless
(Pi/Umbrel/cloud, no camera). So we invert it: the **seeder** shows a QR that is
a *pairing handle, not the invite*; the **phone** scans it (the phone has the
camera, and we already ship a scanner - `shell:scanQr`, used for circle joins),
then the phone delivers the bundle over the network.

### Most of the delivery machinery already exists

The "followed seeder" auto-follow path already pushes a member's full bundle to
a seeder over a protomux channel, and the seeder auto-enrolls it:

- `collectSeedInvites()` (`src/bare.js:4554`) builds the bundle (one invite per
  encrypted circle, with the franken-guard + live-name resolution).
- The member-side seeder-sync channel (`setupSeederSyncChannel`,
  `src/seederSync.js`; wired at `src/bare.js:4999`) sends the bundle via
  `getBundle`, gated by `isFollowedSeeder` (`:4591`, reads `seederfollow:{pubkey}`).
- The seed-side channel (`:4843`) receives it in `onBundle` and enrolls each
  invite via `enrollSeedInvite(s)` (`src/seeder.js`).

### The one thing that blocks reuse for the *first* enrollment

The seed-side `onBundle` trust gate is `isKnownInviter` (`src/bare.js:4611`): it
only accepts a bundle from a member who is the inviter of a circle the seeder is
**already enrolled in**. That is deliberately strict (so a random peer can't spam
a seeder into enrolling), but it is a chicken-and-egg for pairing: at first
contact the seeder is enrolled in nothing, so `isKnownInviter` returns false and
the push is refused. Pairing's whole job is to authorize that first push. The QR
*is* that authorization.

Also: today's sync channel only exists once a connection has formed over a
**circle** topic. A brand-new seeder is on no circle topic yet, so there is no
rendezvous. Pairing supplies a one-time rendezvous topic.

## Scope

### The pairing QR / deep-link

The seeder mints, per pairing session, a fresh random 32-byte **rendezvous key**
and renders a deep link as a QR on its dashboard. **v1 ships the `pear://`
custom scheme only** (decision 3) - it's what the in-app scanner already routes,
and it needs no AASA/applinks setup:

```
pear://pearcircle/seeder-pair?rv={base64url(32)}&seeder={hex(32)}&v=1
```

- `rv` - the rendezvous key; the Hyperswarm topic is `hash('pearcircle/seeder-pair' || rv)` (domain-separated so it never collides with a circle topic).
- `seeder` - the seeder's identity pubkey. **This is the security anchor** (see below).
- Distinct host/path (`/seeder-pair`) so it never collides with `/join` or `/seed`. `parseSeederPairLink` is a new parser in `src/invite.js`, rejecting circle-shaped links.
- The `https://peerloomllc.com/...` universal-link form is deferred (needs an AASA entry); it can be added later exactly like circle invites gained theirs, with no protocol change.

The QR is live only while the "Pair a phone" panel is open (operator presence)
**and** within a hard **5-minute TTL from when the panel was opened** (decision
2) - whichever ends first. The rendezvous topic is left the moment pairing
completes, the TTL fires, or the panel closes - one-time, short-lived.

### Rendezvous + the pairing channel (new protomux protocol)

Mirrors `src/pair.js` (the existing per-circle member pairing channel), but for
seeder bundle delivery:

- Protocol `pearcircle/seeder-pair/1`, id = the rendezvous key.
- **Seeder side**: on "Pair a phone", join the rendezvous topic
  (`server:true, client:true`); on each connection open the pairing channel; on
  receiving a bundle, run the same enroll path as `onBundle` but gated by the
  *pairing* trust rule (below), then ack with the enrolled circle names/count so
  the phone can show "Paired - now seeding N circles", then leave the topic.
- **Phone side**: on scanning the QR, derive the topic, join it, and on the
  connection whose **remote pubkey === the QR's `seeder` pubkey** (Hyperswarm
  connections are Noise-authenticated by pubkey, so this is verified, not
  claimed), send `collectSeedInvites()`'s bundle. Then write
  `seederfollow:{seeder}` locally so all *future* circles auto-push over the
  normal circle-topic channels, and leave the rendezvous topic.

### Trust model (the heart of the T3)

Two distinct risks, two mitigations:

1. **Member must not leak circle secrets to an impostor on the topic.** The
   rendezvous key is in a QR anyone in the room could photograph. If a member
   blindly pushed its bundle to whoever is on the topic, an attacker who saw the
   QR could harvest circle secrets. **Mitigation: the QR binds the target
   pubkey.** The phone pushes the bundle *only* over the connection whose
   authenticated remote pubkey equals the QR's `seeder`. An impostor cannot be
   that pubkey without the seeder's secret key. So topic knowledge alone leaks
   nothing.
2. **Seeder must not be spammed into enrolling junk.** Replacing `isKnownInviter`
   for the pairing path, the seed side accepts a bundle on the pairing channel
   only while a pairing session is **open** (operator opened the panel) and only
   on the rendezvous topic it minted this session. After enroll it leaves the
   topic. Worst case (an attacker who saw the QR pushes their own bundle): the
   seeder enrolls the attacker's circles and wastes disk - low-harm, bounded by
   the open panel window + the 5-minute TTL, and visible to the operator (the
   dashboard shows what got enrolled, with a Leave control). **Decision 1: v1
   keeps the one-tap happy path** (no operator confirm on incoming pairing). A
   confirm-on-dashboard step ("Approve this phone, pubkey abcd...?") is the
   obvious later hardening if abuse shows up; no data-model change needed to add
   it.

No new long-lived secret: the rendezvous key is one-time and dropped. The
durable trust that remains is exactly today's model - `seederfollow:` on the
phone, `seeder:enrolled:` + the signed `seeder:{pubkey}` admission on the
member's autobase.

### After pairing: the existing path takes over

Once paired, the seeder is enrolled and the phone has `seederfollow:{seeder}`, so
every future circle the phone joins/creates auto-pushes over the normal sync
channels (`repushFollowedSeeders`) with no re-pairing. Pairing is a one-time
bootstrap that reuses, not replaces, the steady-state machinery.

### Reuse summary (what is genuinely new)

Reused as-is: `collectSeedInvites`, the bundle/enroll logic behind `onBundle`
(`enrollSeedInvite(s)`), `seederfollow:` follow-state, the `shell:scanQr` scanner,
the deep-link delivery path in `app/index.tsx`.

New: the `pear://pearcircle/seeder-pair` parser; the `pearcircle/seeder-pair/1` protomux
channel; the seeder dashboard "Pair a phone" panel + QR (launcher UI + a host
endpoint that asks the worklet to open/close a pairing session); a worklet
`seeder:pair:open` / `seeder:pair:close` IPC; a phone-side `seeder:pair:scan`
handler that joins the rendezvous, verifies the target pubkey, and pushes.

## Compat

Purely additive; no change to existing wire records or the paste path.

- Old seeder + new phone: the phone can still paste (the launcher `/api/enroll`
  is unchanged). The new phone simply has no QR to scan, so it falls back.
- New seeder + old phone: the old phone has no pair-scan handler; the operator
  pastes as before. The QR panel is just unused.
- New + new: QR pairing available; paste remains as a manual fallback.

No old/new peer can be wedged because nothing existing changes shape; the new
topic + protocol are only spoken by two new-code endpoints that both opted into a
pairing session.

## Verify

On top of a green `npm run verify`:

1. Unit: `parseSeederPairLink` round-trips + rejects `/circle/*` links; topic
   derivation is domain-separated from circle topics; the pubkey-binding check
   refuses a bundle send to a non-matching remote.
2. Headless e2e (the real win): run the launcher (`--network=host` per
   `reference_seeder_container_testing`), open "Pair a phone", scan the QR from a
   phone in a 2-member circle, confirm `seeder:writer-opened` for both members'
   circles with **no paste**, and that the dashboard shows "seeding N circles".
3. Impostor check: a second node joins the rendezvous topic with a different
   pubkey; confirm the phone does **not** push to it (no bundle delivered).
4. Steady-state: after pairing, join a new circle on the phone; confirm it
   auto-pushes to the now-followed seeder with no re-pairing.

## Rollback

Behind a `SEEDER_PAIR_ENABLED` kill-switch (worklet + launcher). Off => the QR
panel is hidden and the rendezvous topic is never joined; paste is the only path,
identical to today. The pairing topic/protocol are spoken only inside an opted-in
session, so disabling is total and leaves no residue.

## Slice plan

1. **Parser + topic derivation** (`src/invite.js`, tests). No I/O.
2. **Seeder side**: `seeder:pair:open/close` IPC, rendezvous join, the
   `pearcircle/seeder-pair/1` receive-and-enroll channel reusing the `onBundle`
   enroll path with the pairing trust gate.
3. **Phone side**: `seeder:pair:scan` - join rendezvous, verify target pubkey,
   push `collectSeedInvites()`, write `seederfollow:`.
4. **Launcher UI**: "Pair a phone" panel with the QR + live status; host
   endpoints to open/close the session and stream the result.
5. **App UI**: a "Scan seeder QR" entry point in the Seeders screen using the
   existing scanner, with a paired-confirmation toast.
6. Kill-switch, verify pass, REVIEW.

## Decisions (2026-06-22)

1. **Operator confirm on incoming pairing: NO for v1.** Keep the one-tap happy
   path. The abuse case is low-harm (wasted disk, bounded by the open session +
   TTL, visible with a Leave control). A confirm-on-dashboard step is a later
   hardening that needs no data-model change.
2. **QR expiry: hard TTL.** The pairing session ends on the earlier of the panel
   closing or a 5-minute TTL from when it opened, so a backgrounded/forgotten
   panel can't keep a rendezvous topic live.
3. **`pear://` only for v1.** Ship the custom-scheme link the in-app scanner
   already routes; defer the `https://` universal-link form (and its AASA entry)
   to a later slice, mirroring how circle invites evolved.
