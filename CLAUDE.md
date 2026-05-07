# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

Constitution applies. See `/home/tim/peerloomllc/CONSTITUTION.md` for risk tiers, proposal gate, DECISIONS convention, verify gate, and wiki-sync rules.

## Project Overview

PearCircle is a peer-to-peer location-sharing app for Android and iOS. Users form private circles, share live location and presence, and get notified on geofence transitions (arrived at / left a Place). No accounts. No servers. No subscriptions.

It uses the same three-layer architecture as PearCal and PearGuard:
- React Native (Expo) shell: `app/index.tsx`
- WebView React UI: `src/ui/`
- Bare worklet (P2P backend): `src/bare.js`

A native location layer (CoreLocation on iOS, FusedLocationProvider + GeofencingClient on Android) is registered on top of the shell and feeds events into the worklet.

## Status

Wire protocol v1 locked 2026-05-03. See `proposals/2026-05-03-wire-protocol.md` (T3) for the spec and `reviews/2026-05-03-wire-protocol.md` for the approval record. Implementation work tracked in `TODO.md`.

## Build & Deploy

To be filled in once a first device build runs. Will mirror PearCal/PearGuard:
- `npm run build:bare` then `npm run build:ui` then `cd android && ./gradlew assembleDebug`
- iOS via Mac Mini SSH using the same `Tims-Mac-mini.local` keychain pattern PearCal uses
- `adb install -r` on Android, `ideviceinstaller` on iOS
- Never uninstall on a paired device — wipes Hyperbee identity and forces a fresh invite

## Verify gate

Per Constitution §5, the canonical gate is `npm run verify`, which chains:
- `npm test` (jest projects: `node` for `tests/**/*.test.js`, `jsdom` for `src/ui/**/*.test.jsx`)
- `npm run build:bare` (bare worklet bundle)
- `npm run build:ui` (esbuild UI bundle)

Run before committing protocol or worklet changes; first failure halts the chain. Manual smoke is a separate step on top of the green gate: pair two devices, share location, trigger a geofence enter / exit, confirm the OS notification fires on the receiving device.

## Architecture

### Three-Layer Runtime (with native location)

```
┌─────────────────────────────────────────┐
│  React Native (Expo) Shell              │  app/index.tsx
│  - Loads bundles, owns native bridges   │
│  - Routes IPC between all layers        │
├─────────────────────────────────────────┤
│  WebView (React UI + MapLibre)          │  src/ui/
│  - Map view, circle list, places, trips │
│  - Communicates via postMessage         │
├─────────────────────────────────────────┤
│  Bare Worklet (P2P Backend)             │  src/bare.js
│  - Identity keypair (sodium-universal)  │
│  - Hyperswarm peer discovery per circle │
│  - Autobase per circle (multi-writer)   │
│  - Hyperbee local DB                    │
├─────────────────────────────────────────┤
│  Native Location Layer                  │  android/.../LocationModule
│  - CLLocationManager (iOS)              │  ios/PearCircle/LocationModule
│  - FusedLocationProvider (Android)      │
│  - OS geofencing (CLCircularRegion /    │
│    GeofencingClient)                    │
│  - Pushes location/transition events    │
│    into worklet via shell IPC           │
└─────────────────────────────────────────┘
```

### IPC Message Flow

JSON-over-newline, dispatched by `method`, identical to PearCal/PearGuard:

- WebView → RN: `window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))`
- RN → Bare worklet: `_worklet.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))`
- Bare → RN: `BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))`
- RN → WebView: `webViewRef.current.injectJavaScript('window.__pearResponse(...); true;')`
- RN → WebView (events): `webViewRef.current.injectJavaScript('window.__pearEvent("name", data); true;')`

### Hyperbee Keys (provisional, finalized in proposal)

| Key | Value |
|-----|-------|
| `identity` | `{ publicKey: hex, secretKey: hex }` |
| `profile` | `{ displayName, avatarBlobId, updatedAt }` |
| `circles:{id}` | `{ id, name, ownerKey, createdAt }` |
| `members:{circleId}:{pubkey}` | `{ pubkey, displayName, joinedAt }` |
| `places:{circleId}:{id}` | `{ id, name, lat, lon, radiusMeters, createdAt }` |
| `lastSeen:{circleId}:{pubkey}` | `{ lat, lon, accuracy, ts, battery, isMoving }` |
| `transitions:{circleId}:{ts}:{pubkey}` | `{ placeId, kind: 'enter'|'exit', ts }` |
| `trips:{pubkey}:{ts}` | `{ start, end, polyline, distance }` (local-only by default) |

### Invite Link Protocol (provisional)

Format: `https://peerloomllc.com/circle/join?circle={base64(circleId)}&name={name}&key={circleKey}&inviter={publicKey}`

Per-app path prefix (`/circle/join`) avoids collision with PearCal's `/join` on the shared host.

Legacy custom scheme also accepted: `pear://pearcircle/join?...`

## Branch Strategy

Always create a branch before starting work. Never commit directly to master.
- Feature branches: `feature/description`
- Bug fix branches: `bugfix/description`
- Long-lived branches OK for big surfaces (e.g. `feature/native-location`)
- Merge via GitHub PR

## Patching Rules

Same conventions as PearCal/PearGuard — see `/home/tim/peerloomllc/p2p-wiki/wiki/concepts/PatchingRules.md`.

## TypeScript / Path Aliases

`@/*` maps to the repo root. `app/` is TypeScript (`.tsx`). `src/` is plain JavaScript (`.js`, `.jsx`).
