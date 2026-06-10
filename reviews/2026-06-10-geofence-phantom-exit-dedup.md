# Geofence phantom-exit + duplicate-transition fix review

Approved 2026-06-10 (Tim, in-session). Behavioral bugfix, no wire-format change (the `transition:{ts}:{pubkey}:{placeId}` record and key shape are untouched), so no proposal gate. Branch `bugfix/geofence-phantom-exit-dup-transition`.

## Symptom

A stationary iPhone user's activity feed showed `left Home (7m) / arrived at Home (4m) / arrived at Home (4m)` for a single circle with a single "Home" place. She never left. Two independent bugs:

1. **Phantom exit then re-entry.** `classify()` was a bare `distance <= radius` test and `checkPlaceTransitions` ignored the fix `accuracy`. A lone low-confidence fix (common when a phone sits still and GPS error balloons) read tens of metres off, flipping the user "outside" (left), and the next clean fix flipped them back (arrived).

2. **Duplicate enter.** Two `enter` rows for one place/circle with no `exit` between. The in-memory classifier plus `applyRegionEvent` dedup the common case, but on iOS three writer paths (JS classifier, native `CLCircularRegion`, cold-boot restore) can disagree about the running state across a worklet relaunch or region re-registration long enough for two enters to land.

## Fix

- **Accuracy-aware exit hysteresis** (`src/lib/geofence.js`). `classify` takes an optional `accuracy`; an inside user must measure clear of `radius + min(accuracy, radius)` before an exit registers. Entry is undamped (prompt arrivals). Margin is 0 when no accuracy is supplied, so all existing callers/tests are byte-identical. `checkPlaceTransitions` now forwards the fix accuracy.
- **Structural same-kind guard** (`src/bare.js`). New `_lastAppendedKind` map; `appendTransition` refuses to write the same kind twice in a row for a place, so a duplicate enter/exit can never reach the autobase regardless of which path raced. Seeded from the persisted classification on boot (catches a redundant post-boot native enter), cleared on place/circle teardown and full reset, and bypassed by the manual debug-fire via `force: true`.

## Verify

`npm run verify` clean: 554 tests pass (added 5 hysteresis cases to `tests/geofence.test.js`), bare + UI bundles build.

Deployed for validation: Pixel 9 (GrapheneOS, `com.pearcircle.debug`, same-keystore `install -r`) and the paired iPhone (`com.pearcircle` via `ios-dev-install.sh`). On-device soak (stationary phone at a Place for ~30-45 min, watch the peer's activity feed for a phantom pair; one real arrival → exactly one "arrived"; a real out-and-back still fires a clean left/arrived) is the interactive step on top of the green gate. The duplicate-enter guard was reproducible only by reasoning, not in a unit test, so device confirmation matters most there. Next suspect if a duplicate recurs: iOS native region re-registration firing an enter on `requestState`.
