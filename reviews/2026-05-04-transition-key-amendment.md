# REVIEW — transition key `:{placeId}` suffix amendment

**Date**: 2026-05-04
**Tier**: T3
**Proposal**: `proposals/2026-05-03-wire-protocol.md` (amended)
**Decision**: `DECISIONS.md` 2026-05-04 — transition key gains `:{placeId}` suffix to prevent same-tick collisions

Wire-protocol v1 §3 amended to extend the transition row key from `transition:{ts}:{pubkey}` to `transition:{ts}:{pubkey}:{placeId}`. The two-segment key collided when one `location:update` tick produced multiple transitions — an exit from one place plus an enter to another, sharing the same `Date.now()` — and the apply branch's second `view.put` silently overwrote the first. ts-prefix is preserved so the reverse-stream lookup in `circle:get` continues to surface the latest transitions in time order; the new placeId suffix disambiguates simultaneous transitions per writer. v1 remains the floor — no peers had shipped beyond the two test devices, so the change is an in-flight amendment, not a version bump. Affects `src/bare.js` (appendTransition writes the new key, the apply branch's `transition:*` arm parses three colon-separated segments and validates each against the value's `pubkey` and `placeId`). Old-format rows on the test devices remain in the view but no longer collide with new writes; they age out as fresh transitions land with strictly higher ts. Signed off by Tim.
