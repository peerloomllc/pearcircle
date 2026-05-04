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

Scaffold only. Wire protocol unspecified. See `proposals/2026-05-03-wire-protocol.md` (T3) for the open design before any P2P code lands.

## Build & Deploy

To be filled in once a first device build runs. Will mirror PearCal/PearGuard:
- `npm run build:bare` then `npm run build:ui` then `cd android && ./gradlew assembleDebug`
- iOS via Mac Mini SSH using the same `Tims-Mac-mini.local` keychain pattern PearCal uses
- `adb install -r` on Android, `ideviceinstaller` on iOS
- Never uninstall on a paired device — wipes Hyperbee identity and forces a fresh invite

## Verify gate

Per Constitution §5, this app needs a single canonical `npm run verify`. Initial definition once tests exist:
- `npm test` (jest: invite encode/decode, geofence math, message signing)
- `npm run build:bare` and `npm run build:ui` must complete clean
- Manual smoke: pair two devices, share location, trigger a geofence enter/exit

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
