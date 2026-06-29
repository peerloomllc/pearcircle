# Fork-conflict recovery review

**Status: recovery half APPROVED + merged 2026-06-28 (#132). Prevention items 3+4 APPROVED + merged 2026-06-28 (#133, Tim, in-session). Item 2 DEFERRED (no clean API).** Proposal `proposals/2026-06-27-fork-conflict-recovery.md`, branch `bugfix/fork-conflict-recovery`. T3 (the bundled prevention guards change the replication durability invariant). This record gates the prevention implementation (items 2-4); the recovery + seatbelt half is on-device no-regression-validated and merged ahead of the prevention work per owner direction (it is self-contained and strictly safer than today's hard crash).

## What is built and validated (recovery + seatbelt half)

- **Detection → recovery routing.** A hypercore fork conflict is caught (per-Autobase `attachConflictListeners` on `base.local`/`base.view`, plus a source-agnostic `console.log` tap on hypercore's `[hypercore] conflict detected` line) and routed into the existing `flagDegraded` → `needsRepair` → manual `circle:repair` path (fresh writer cores + seeder re-sync + `addWriter` re-admission). Satisfies decision 1 (auto-flag, manual tap) and decision 4 (source-agnostic).
- **Seatbelt.** `Bare.on('uncaughtException'|'unhandledRejection')` swallow ONLY a conflict's fallout (message match within 15s of a real conflict signal, `lib/conflictSeatbelt`) and `Bare.exit(1)` on everything else, preserving fail-fast.
- **Validation.** `npm run verify` green (668 tests, pure decision + parser logic unit-tested). On-device boot clean on the TCL (D2) and Pixel 9 (D1), debug build: `faulthandlers:installed`, `init:done {circles:2}`, zero SIGABRT, worklet stable.
- **Two first-cut regressions found + fixed on-device** (see `reference_bare_worklet_native_addon_traps`): `require('bare-abort')` dlopen-failed (→ `Bare.exit`); `_store.watch` yields corestore's internal Core without `.on` (→ session-level listeners).

## Validation gap (narrowed 2026-06-28)

**No test device has a real fork** (D1's earlier crash-loop was the `bare-abort` regression, not a fork; the genuine fork is on Benjamin's *release* build we can't deploy debug to). Originally this meant the fix was only no-regression-validated. Now narrowed by `tools/repro-fork.js`, which reproduces the bug in-process with real Corestore/Hypercore:
- Reproduces the EXACT signature from Benjamin's log — `[hypercore] conflict detected in <disc> (writable=true,quorum=1)` — and confirms `parseConflictLog` matches it and the seatbelt would swallow the escaping `Closed` (Scenario B, PASS).
- Confirms a same-fork truncation with no divergent append self-heals via replication (Scenario A, PASS), so the danger is truncate-then-append-before-resync — what the rewind guard targets.

On-device seatbelt wiring CONFIRMED 2026-06-28 (TCL, throwaway debug build, since reverted): a debug hook emitted hypercore's exact conflict log line then threw the exact escaping `Error('Closed')`. Logcat showed the full chain — `conflict:log-detected` (the console-tap stamped `_lastConflictAt`) → `conflict:seatbelt-caught {kind:unhandledRejection, msg:Closed}` → zero SIGABRT, worklet alive. So Bare's `unhandledRejection` → `onWorkletFault` → swallow path works on real hardware against the real escaping rejection.

Residual gap: the `circle:repair` heal has not been exercised on hardware against a genuine fork. A faithful on-device fork could not be forged — directly truncating `base.local` wedges autobase's mount (a crude-injection artifact, NOT the real bug, which boots fine and conflicts during replication). The crude injection corrupted the TCL's circle (since wiped with `pm clear`; TCL now fresh, needs re-pairing). Closing this last gap cleanly needs either an offline store-surgery harness or a release build for Benjamin. The repair machinery itself is the existing append-hang path, already validated for that path.

## Decisions to confirm (recorded 2026-06-28, please sign off)

1. Repair trigger: auto-flag + manual tap. ✅ proposed, implemented.
2. Idempotency: pin rebuilt base to seeder + refuse (shed) the conflicting peer. ⛔ DEFERRED 2026-06-28 — no clean hypercore API to identify/shed the offending peer or to prioritise the seeder as a download source (see proposal feasibility finding). Safe to defer: items 3+4 prevent the fork, recovery handles recurrence gracefully (bounded by manual Repair). Follow-up needs an upstream hypercore affordance.
3. Circle-wide eviction: deferred, local repair only for v1. ✅ proposed.
4. Remote forks: source-agnostic seatbelt. ✅ implemented (commit bd74b40).
5. Prevention now, both guards (rewind guard + durability ordering) → T3. ⏳ design only.

## Open review points for the prevention batch (items 2-4)

Carried from the proposal's "Implementation design" section — these are what the T3 review should resolve before code:

- **Item 2 (seeder-pin / refuse):** can a shed be scoped to the offending peer+core, or only the whole connection (which would drop a member legitimately serving other circles)? Confirm graceful degradation if the seeder itself only holds the forked branch (should be "stays needsRepair", never corrupting).
- **Item 3 (rewind guard):** bounded cold-start wait so the first `lastSeen` append isn't blocked indefinitely; queue (don't drop) native-location appends during the gate; gate only `base.local`, never remote cores.
- **Item 4 (durability ordering):** debounce/coalesce flushes off the writer-append path; must NOT reintroduce the 64 MB giant-flush boot wedge (`project_wal_badalloc_wedge`) — layer on the small-frequent-flush cadence.

## Sign-off checklist

- [x] Decisions 1-5 confirmed.
- [x] Validation gap accepted: node repro reproduces Ben's exact signature; on-device seatbelt wiring confirmed on the TCL; residual `circle:repair`-on-hardware heal accepted as a follow-up (offline harness or release build).
- [x] Open review points for items 2-4 resolved or explicitly deferred (item 2 deferred on the upstream-API finding).
- [x] T3 tier acknowledged.

_Approved 2026-06-28 (Tim, in-session) — prevention items 3+4 merged via #133; item 2 deferred to an upstream hypercore ask._
