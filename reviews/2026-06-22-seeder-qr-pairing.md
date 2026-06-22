# Seeder QR pairing review

Approved 2026-06-22 (Tim, in-session): proposal decisions confirmed, UI layout approved on device + launcher, and the full handshake device-validated. T3 (new pairing flow: a Hyperswarm rendezvous topic, the `pearcircle/seeder-pair/1` protomux protocol, the `pear://pearcircle/seeder-pair` link, and a first-enrollment trust gate). Branch `feature/seeder-qr-pairing`, proposal `proposals/2026-06-22-seeder-qr-pairing.md`, PR #120.

## What shipped

The copy-paste step in seeder setup is gone. The seeder shows a QR encoding a one-time rendezvous key + its pubkey (not the invite - the invite secrets live on the phone, and seeders are headless). The phone scans it with the existing `shell:scanQr`, joins the domain-separated rendezvous topic (`seederPairTopic` = `blake2b('pearcircle/seeder-pair' || rv)`), and pushes its `collectSeedInvites()` bundle over a new one-time channel. The seeder enrolls each invite through the existing `enrollSeedInvite` path and acks the count back; the phone writes `seederfollow:` so future circles auto-push over the steady-state channels with no re-pairing. Five slices: parser+topic, the seeder/member handshake (`src/seederPair.js` + bare.js wiring + `seeder:pair:open/close/scan` IPC), and the UI (launcher "Add circles" section with QR primary + paste tucked; app "Scan seeder QR" button). Behind `SEEDER_PAIR_ENABLED`.

## Trust model (the T3 core)

Two risks, two guards. (1) A member must not leak circle secrets to an impostor who photographed the QR: the phone pushes the bundle ONLY over the connection whose Noise-authenticated remote pubkey equals the QR's `seeder` pubkey (`maybeSetupPairScanChannel`), so topic knowledge alone leaks nothing. (2) The steady-state `isKnownInviter` gate cannot authorize a first enrollment (the seeder is enrolled in nothing yet), so pairing's trust is "a session is open on the minted topic" - the seeder only joins the rendezvous while the operator's panel is open, bounded by a 5-min TTL, and one-shot-closes on success. Worst case (an attacker pushes their own bundle during the open window) is low-harm wasted disk, visible with a Leave control; a dashboard operator-confirm step is a deferred hardening (decision 1).

## Validation

End-to-end on real hardware (Pixel app + native launcher, host networking): scanned the launcher QR, log showed `seeder:pair:open -> seederpair:channel-opened -> bundle-received {count:2} -> seeder:pair:enrolled {enrolled:2} -> seeder:pair:closed {reason:paired} -> ack-sent`, then `writer-opened` x3 and replication - 2 circles linked with zero copy-paste, then steady-state mirroring. Unit coverage: link parser cross-rejection (a circle invite can't parse as a pairing link and vice versa), domain-separated topic derivation (same bytes -> different topic from a circle topic), channel input validation. `npm run verify` green (655). Additive: the paste path is unchanged, so no old/new peer can wedge.

## Follow-ups

Deferred to later slices (in the proposal): the `https://` universal-link form (needs an AASA entry; `pear://` only for v1), and the optional operator-confirm-on-incoming step. Not yet adversarially validated on-device: the wrong-pubkey rejection (the code path + unit-level intent are in place; a staged impostor-on-topic test would confirm the live drop).
