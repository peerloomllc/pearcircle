# Android location fallback for devices without Google Play Services

## Goal
Make location acquisition work on de-Googled Android (LineageOS/GrapheneOS without microG) by falling back to the platform `LocationManager` when Google Play Services is absent.

## Tier
T1 - Android-native only. No wire protocol, IPC shape, Hyperbee key, or permission change. The fallback feeds an identical `android.location.Location` into the existing `emitToJs` -> `location:update` path, so peers and the worklet see no difference.

## Background
Both Android location surfaces use Google's FusedLocationProvider (`com.google.android.gms:play-services-location`):
- `PearCircleLocationService.startLocationUpdates` - streaming foreground updates
- `PearCircleLocationModule.requestSingleFix` - one-shot fix on app-foreground

On a ROM without Play Services and without microG, the fused provider has no backing implementation. The calls do not throw at construction time (the GMS client classes are bundled in our APK), they just never deliver a fix: `requestLocationUpdates` produces no callbacks and `getCurrentLocation` resolves null. Every failure path is silent (`requestSingleFix` resolves `false`, the service emits nothing), so the app shows no location and gives no error. A new user on LineageOS reported exactly this 2026-06-03: permission granted, app cannot find them, while Organic Maps (which talks to `LocationManager` directly) works.

Geofencing is unaffected by this: there is no `GeofencingClient` usage on Android - transitions are computed in the worklet from the `location:update` stream. Restoring that stream restores geofencing too.

## Scope
**Changes**
- Add a shared `gmsAvailable(Context): Boolean` helper using `GoogleApiAvailability.isGooglePlayServicesAvailable` (returns true only on `ConnectionResult.SUCCESS`). The detection code is in play-services-base, bundled in the APK, so it runs even when GMS is not installed on the device.
- `PearCircleLocationService`: when `gmsAvailable` is false, stream via `LocationManager` instead of fused. GPS_PROVIDER is primary; NETWORK_PROVIDER is used only when GPS is unavailable (on de-Googled devices NETWORK usually has no backend). Same cadence as fused: `minTime` 10s, `minDistance` 10m. Remove the right listener type in `onDestroy`.
- `PearCircleLocationModule.requestSingleFix`: when `gmsAvailable` is false, one-shot via `LocationManager`. API 30+ uses `getCurrentLocation`; API 29 uses `requestSingleUpdate` (deprecated but functional), falling back to `getLastKnownLocation`.
- Both fallbacks route through the existing `emitToJs`, so battery metadata and the `location:update` payload are identical to the fused path.

**Does not change**
- The fused path on GMS devices (unchanged - no battery/accuracy regression for the ~99%).
- Manifest, permissions, IPC, Hyperbee keys, the worklet, iOS.
- No provider fusion/blending in the fallback: raw GPS is sufficient for the target audience. Out of scope.

## Compat
No cross-peer surface touched. A device on the fallback path emits the same `location:update` shape an old peer already understands. Old and new app builds interoperate with zero migration.

## Verify
- `npm run verify` (test + build:bare + build:ui) stays green - no JS change beyond the proposal doc, but run it for the gate.
- `./gradlew assembleDebug` compiles the Kotlin (verify gate does not cover native).
- Device smoke, GMS path (regression): install on a Play-Services device (53071FDAP00038 / 4H65K7MFZXSCSWPR), confirm self-location dot appears and streams as before.
- Device smoke, fallback path (the fix): install on a GMS-less target - the reporter's LineageOS device, or an AOSP/`google_apis`-free emulator image with a mock GPS route. Confirm the self-location dot appears, updates while moving, and a geofence enter/exit still fires.

## Rollback
Single-commit revert. The change is additive (a branch inside each call site); reverting restores the fused-only behavior. No persisted state or peer-visible artifact to unwind.

## Open questions
- Register NETWORK_PROVIDER alongside GPS for faster cold/indoor acquisition, accepting possible coarse-vs-fine jitter on the map? Current plan: GPS-primary, NETWORK only as a fallback when GPS is absent. Revisit if cold-fix latency on the fallback path is poor in testing.
- Should we surface a one-time UI hint on the fallback path (e.g. "using device GPS")? Deferred - no behavior the user must act on.
