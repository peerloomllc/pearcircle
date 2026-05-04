# REVIEW — invite link `bootstrap` field amendment

**Date**: 2026-05-04
**Tier**: T3
**Proposal**: `proposals/2026-05-03-wire-protocol.md` (amended)
**Decision**: `DECISIONS.md` 2026-05-04 — invite link gains `bootstrap` field for Autobase discovery

Wire-protocol v1 §2 amended to add a required `bootstrap=<hex(32)>` query field to invite links. The field carries the public key of the per-circle Autobase bootstrap writer core, allowing joiners to call `new Autobase(store, bootstrap, ...)` and anchor the replicated view. Distinct from `inviter`: the inviter is the issuing member, the bootstrap is the original owner's Autobase writer core, and the two are not equal in the any-member-can-invite case. v1 remains the floor — no peers had shipped, so the change is an in-flight amendment, not a version bump. Affects `src/invite.js` (build/parse the new field), `src/bare.js` (`circle:create` provisions the writer core via `corestore.namespace(circleId)`; `circle:join` persists the parsed bootstrap), and the test surfaces. Signed off by Tim.
