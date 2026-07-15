# PearCircle Seeder - StartOS (Start9) app

Packages the PearCircle blind-seeder ([`../`](../)) as a StartOS service. Same
worklet, dashboard, and on-disk state as the desktop launcher and the Umbrel app
([`../umbrel/`](../umbrel/)); this wraps it for StartOS's `.s9pk` format.

Targets **StartOS 0.3.5.x** (the stable channel). That release line packages a
service as a `manifest.yaml`, one Docker image tar per arch, and deno-bundled
TypeScript procedures, packed with `start-sdk pack`. The newer 0.4.x TypeScript
SDK is a separate follow-up.

## Layout

- `manifest.yaml` - service metadata, main entrypoint, interface (Tor + LAN),
  health check, backup, migrations.
- `Dockerfile` - `FROM` the same digest-pinned `ghcr.io/peerloomllc/pearcircle-seeder`
  image the Umbrel app runs, plus `tini` and the StartOS entrypoint. Reuses the
  proven cross-arch worklet build instead of re-implementing it.
- `docker_entrypoint.sh` - sets container env (`0.0.0.0`, no-auth, no
  update-check) and runs the host with `--data-dir /root/data`.
- `scripts/` - deno-bundled TS procedures (health, config, migrations,
  properties) using `embassyd_sdk@v0.3.3.0.11`.

## Container behaviour vs the desktop launcher

Same two env vars as the Umbrel image (set in `docker_entrypoint.sh`):

- `SEEDER_HOST=0.0.0.0` - bind all interfaces so StartOS's interface proxy can
  reach the dashboard (desktop default is loopback).
- `SEEDER_NO_AUTH=1` - skip the in-app bearer token; StartOS already gates the
  interface behind the server.

Plus `SEEDER_NO_UPDATE_CHECK=1` - updates come from the StartOS marketplace.

State persists in the `main` data volume (mounted at `/root`); the seeder writes
under `/root/data` (identity, per-circle enrollments, retention state, logs).

## Build

Requires `deno`, `yq`, the StartOS SDK (`start-sdk` / `start-cli`), and either
`docker` (buildx) or `podman` (+ `qemu-user-static` for the arm64 tar on an x86
host). See <https://docs.start9.com/0.3.5.x/developer-docs/packaging>.

```bash
cd seeder-launcher/start9
make            # build + verify a universal pearcircle-seeder.s9pk (x86_64 + aarch64)
```

## Install on a server

Point the SDK at your server, then install:

```bash
# ~/.embassy/config.yaml
# host: https://returned-feline.local

make install    # or: start-cli package install pearcircle-seeder.s9pk
```

Or upload the `.s9pk` through the StartOS UI (System > Sideload Service).

## Status

Validated end to end on StartOS 0.3.5.1 (returned-feline): sideloaded, service
runs, dashboard reachable, and a real circle enrolls + replicates
(`totalBytesReplicated` climbs, `seeder:block-downloaded` events flow).

### Known caveat: same-WiFi pairing

StartOS runs the service on an isolated podman bridge, so the seeder is not
discoverable via **LAN local discovery**. A phone on the **same WiFi as the
server** therefore can't pair (local multicast doesn't cross the bridge, and
home routers rarely NAT-hairpin). On **cellular / remote**, the phone reaches the
seeder over the DHT (the container gets an endpoint-independent "cone" NAT
mapping, verified via STUN) and pairing + replication work normally. Documented
in `instructions.md` as "turn off WiFi to pair." A full fix (same-LAN too) would
require **host networking**, which the 0.3.5.x manifest does not expose - a
possible future item (or via the 0.4.x SDK).

## Architectures

Universal s9pk carrying **x86_64 + aarch64** (a typical x86 Start9 server and an
arm one, e.g. a Raspberry Pi). The pinned base image is a multi-arch manifest
list, so each arch tar just pulls its own layer. Building the arm64 tar on an
x86 host runs a tiny apt step under qemu (`qemu-user-static` binfmt); the arm64
image was smoke-tested under emulation (boots, dashboard serves, worklet reaches
`init:done` in seed mode). Real arm-hardware P2P is unverified for lack of an arm
Start9 box.

## Open items

- **Distribution**: publish to a PeerLoom community registry (analogous to the
  Umbrel community store) so users can add it by URL.
