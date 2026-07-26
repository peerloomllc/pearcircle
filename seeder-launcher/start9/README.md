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

`../scripts/build-start9-s9pk.sh` wraps that for a release: it pins the version
and image digest first, then emits a **second** artifact,
`pearcircle-seeder-v2.s9pk`, for StartOS 0.4.0+.

### Why two artifacts

StartOS 0.4.0's web UI refuses a v1 package outright - it sniffs the magic bytes
(`3b 3b 01` vs `3b 3b 02`) and reports the format as deprecated. The OS still
installs v1 through `start-cli package install --sideload`, so 0.3.5 boxes are
unaffected and v1 remains the source of truth, but a 0.4.0 operator expects to
drag the file into the browser.

We do not hand-author a second package for that. StartOS ships a converter, and
that is how Start9 migrated its own catalogue; a converted package keeps these
0.3.5-era procedures and gains " (Legacy)" on its title. Porting to the 0.4.x
TypeScript SDK properly is the follow-up that removes both.

The conversion needs machine setup the repo cannot carry, since it involves a
private signing key:

- **A 0.4.x `start-cli`** (the 0.3.5 SDK's `start-cli` cannot convert). Download
  it from the `start-cli/v*` releases of `Start9Labs/start-technologies`. The
  build script finds `start-cli-1.1.0` or any `start-cli` reporting a 1.x
  version; override with `START_CLI_V2`.
- **A packaging workspace**, holding the build key the converted package is
  signed with: `start-cli s9pk init-workspace ~/.start9-workspace`. Override the
  location with `START9_WORKSPACE`. Also needs `tar2sqfs` (`squashfs-tools-ng`)
  and podman able to resolve short image names.

Without both, the build prints a loud `!!` block and ships v1 only.

## Install on a server

Point the SDK at your server, then install:

```bash
# ~/.embassy/config.yaml
# host: https://returned-feline.local

make install    # or: start-cli package install pearcircle-seeder.s9pk
```

Or upload the `.s9pk` through the StartOS UI (System > Sideload Service). On
**0.4.0+ the UI only accepts `pearcircle-seeder-v2.s9pk`**; the v1 file installs
there too, but only via `start-cli package install --sideload <file>`. Note
0.4.0 also moved CLI auth to per-device signing keys, so a 0.3.5-era `start-cli`
fails against it with `missing field __Auth_signer`.

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
