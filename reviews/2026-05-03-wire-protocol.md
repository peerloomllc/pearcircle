# REVIEW — Wire protocol v1

**Date**: 2026-05-03
**Tier**: T3
**Proposal**: `proposals/2026-05-03-wire-protocol.md`
**Decision**: `DECISIONS.md` 2026-05-03 — wire-protocol v1 approved

Wire protocol v1 shipped as the floor for all PearCircle P2P code: invite link grammar (`https://peerloomllc.com/circle/join?circle=&name=&key=&inviter=` plus legacy `pear://pearcircle/join?...`), local-only and replicated Hyperbee key schema, per-record-kind Autobase apply branches with owner-vs-member write rules, signed `lastSeen` and `transition` envelope with monotonic `ts` and 5-minute future-clock reject, Hyperswarm topic = `blake2b(circleKey)`, OS-geofence-driven transition flow with the iOS 20-region cap acknowledged. All six original open questions resolved in `DECISIONS.md` (tile host, 30-day transition retention, battery + isMoving in v1, presence/mute as a separate replicated row, any-member-invites + owner-only-removes, inline base64 avatars). Signed off by Tim. No prior peers exist, so the rollback story is a code revert until the first public build ships.
