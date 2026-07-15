# PearCircle Seeder - StartOS (Start9) app

Packages the PearCircle blind-seeder ([`../`](../)) as a StartOS service. Same
worklet, dashboard, and on-disk state as the desktop launcher and the Umbrel app
([`../umbrel/`](../umbrel/)); this wraps it for StartOS's `.s9pk` format.

Targets **StartOS 0.3.5.x** (the stable channel). That release line packages a
service as a `manifest.yaml`, a Docker image tar, and deno-bundled TypeScript
procedures, packed with `start-sdk pack`. The newer 0.4.x TypeScript SDK is a
separate follow-up.

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

Requires `docker` (buildx), `deno`, `yq`, and the StartOS SDK (`start-sdk` /
`start-cli`). See <https://docs.start9.com/0.3.5.x/developer-docs/packaging>.

```bash
cd seeder-launcher/start9
make            # build + verify pearcircle-seeder.s9pk (x86_64)
```

## Install on a server

Point the SDK at your server, then install:

```bash
# ~/.embassy/config.yaml
# host: https://returned-feline.local

make install    # or: start-cli package install pearcircle-seeder.s9pk
```

Or upload the `.s9pk` through the StartOS UI (System > Sideload Service).

## Status / open items

- **amd64 only** for now: the pinned base image is amd64. aarch64 (for an arm
  Start9 server) needs the seeder image published as a multi-arch manifest first.
- **Holepunch through StartOS's podman network is the key thing to smoke-test**:
  enroll a circle and confirm the seeder actually connects to a peer and
  replicates. Outbound UDP for Hyperswarm/DHT worked through Umbrel's Docker NAT;
  StartOS's network path is stricter and must be verified on a real box.
- **Distribution**: publish to a PeerLoom community registry (analogous to the
  Umbrel community store) so users can add it by URL.
