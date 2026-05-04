# PearCircle

Peer-to-peer location sharing for friends and family. No accounts. No servers. No subscriptions.

PearCircle lets you create a private **circle** of trusted people, share live location with each other, and define **places** (Home, School, Work, Mom's house) so the circle gets notified when someone arrives or leaves.

## Status

Pre-alpha. Scaffold only. See `proposals/` for open design work and `DECISIONS.md` for the choices already made.

## How it works

- **Identity**: each device generates a cryptographic keypair on first launch. Lose your phone, get a new key, ask anyone in your circle to re-invite you.
- **Pairing**: the circle owner generates an invite link or QR code. Scanning it adds the new device as a writer to the circle's shared state.
- **Sync**: peers discover each other through the Hyperswarm DHT, replicate state via Autobase, and exchange location updates directly. There is no PearCircle server.
- **Privacy**: location data lives only on devices in your circle. Map tiles come from OpenStreetMap via MapLibre, no Google or Apple involvement.
- **Geofencing**: OS-level region monitoring wakes the app on Place enter/exit so battery use stays reasonable.

## Stack

Same three-layer runtime as PearCal and PearGuard:
- React Native (Expo) shell hosts a WebView and bridges to native modules
- WebView renders the React UI and the MapLibre map
- Bare worklet runs the P2P stack (Hypercore / Hyperbee / Hyperswarm / Autobase) on its own pthread, surviving iOS background suspension
- Native location modules (CoreLocation, FusedLocationProvider) feed events into the worklet

See `CLAUDE.md` for the full architectural breakdown.

## License

TBD.
