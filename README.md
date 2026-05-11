# 🍐📍 PearCircle

**A peer-to-peer location-sharing app for Android and iOS.**

PearCircle lets you share live location and presence with the people in your circles - no accounts, no servers, no subscriptions. Your family's and friends' positions live only on the devices you pair.

---

## Features

- **Private circles** - create a circle, invite people via a link or QR code, share live location directly with them
- **Multiple circles** - one identity, many circles (family, friends, partners on a trip); switch between them or see everyone at once
- **Places and geofences** - long-press the map to drop a Place; everyone in that circle gets a notification when someone arrives or leaves
- **Trips** - your motion timeline records each drive or walk over ~1 minute / ~100 m; opt in per-circle to let members see each other's trips on the map
- **Motion at a glance** - pins surface walking / driving / flying / stationary state from the device's sensors, with battery and last-seen time
- **Sharing pause** - one tap silences your location for the rest of the day or until you flip it back on; peers see "Sharing paused" instead of stale dots
- **Offline map tiles** - tiles you've viewed stay cached so the map keeps working without a network connection; download an area in advance for trips into dead zones
- **No accounts** - your identity is a cryptographic key pair generated on your device; nothing is tied to an email or phone number
- **No data collection** - PeerLoom, Google, Apple, and no third party ever sees your circle's location data

---

## How It Works

PearCircle uses **peer-to-peer technology** powered by [Hypercore Protocol](https://hypercore-protocol.org) to sync location and presence directly between devices in your circles.

### No servers
Most location-sharing apps (Life360, Find My, etc.) route your location through a central server. The app company can read your data, sell it, get hacked, go down, or shut down. PearCircle has no central server. Your circle's location data never leaves your devices.

### How sync works
When devices in the same circle are online at the same time - whether on the same Wi-Fi network or anywhere on the internet - they find each other using a distributed hash table (DHT), a technology similar to how BitTorrent works. Once connected, they sync directly, device to device, with no middleman.

### Encrypted and signed
All sync traffic is encrypted in transit. Each location update, place change, and trip is cryptographically signed by the writing device. Other circle members only apply updates they can verify came from a paired member.

### Geofences without a server
Place transitions ("arrived at Home", "left School") are computed locally on each device against the Places defined in that circle. When you cross a geofence, your device writes a signed transition record that replicates to peers; their devices fire the local OS notification. The map tiles themselves come from a public tile provider (currently OpenFreeMap), but nothing about you or your locations is sent to them.

### Pairing
You pair into a circle via a one-time invite link or QR code. The link encodes the cryptographic address of the circle - there's no server involved. After joining, every device in the circle remembers every other one and can sync directly.

---

## Privacy

- No accounts or sign-up required
- No analytics, tracking, or telemetry
- No third-party SDKs
- All sync traffic is encrypted end-to-end
- Location data stays on the devices in your circles - never uploaded anywhere
- Map tiles fetched from public providers (e.g. OpenFreeMap) are stateless requests for `(z, x, y)` coordinates; they don't identify you or your circle
- Trip history is local-only by default; per-circle sharing is opt-in

---

## Permissions

Location sharing relies on the OS's standard background-location permission. PearCircle asks for it on first launch and explains why each step is needed:

- **Android** - "Allow all the time" lets the foreground service keep sharing while the app isn't in the foreground. "Only while using the app" works while you have PearCircle open but pauses sharing as soon as you switch away.
- **iOS** - "Always" is required for background sharing. "While Using the App" works only when PearCircle is foregrounded. The first-launch flow surfaces an in-app explanation before the system dialog so the choice is intentional.

If you previously declined, an in-app banner offers a direct deep-link to your OS Settings.

---

## Known Limitations

- **Both devices must be online simultaneously** to sync in real time - changes made offline replicate the next time devices can reach each other
- **Background battery life depends on the OS** - aggressive Doze / app-standby on some Android OEMs (Xiaomi, OnePlus, Huawei) can pause the foreground service after extended idle. PearCircle prompts you to add the app to your battery-optimization whitelist on first run, but per-OEM autostart settings may also need to be enabled manually
- **No desktop client yet** - PearCircle is mobile-only at launch

---

## Feedback & Bug Reports

Please open an [issue](../../issues) on GitHub. Include your platform (Android or iOS), OS version, and a description of what happened.
