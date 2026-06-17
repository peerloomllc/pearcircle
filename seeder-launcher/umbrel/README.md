# PearCircle Seeder - Umbrel app

Packages the PearCircle blind-seeder ([`../`](../)) as a Docker container so it
can run as an always-on Umbrel app. Same worklet, dashboard, and on-disk state
as the desktop launcher; just containerized and reachable through Umbrel's
proxy instead of loopback.

## Layout

- `Dockerfile` - multi-stage build. Reuses `../scripts/stage-payload-linux.sh`
  to produce the flat payload (esbuilt host, `bare` runtime, bare-packed
  worklet bundle + native prebuilds, UI), then a slim runtime image.
- `docker-compose.yml` / `umbrel-app.yml` - the Umbrel app manifests.

## Container behaviour vs the desktop launcher

Two env vars (set in the Dockerfile / compose) adapt the host for a container:

- `SEEDER_HOST=0.0.0.0` - bind all interfaces so the `app_proxy` can reach the
  dashboard (desktop default is `127.0.0.1`).
- `SEEDER_NO_AUTH=1` - skip the in-app bearer token; Umbrel's `app_proxy`
  already gates the dashboard behind the Umbrel login. Outside Umbrel, leave
  this unset so the token protects the dashboard.

State persists in the `/data` volume (mapped to `${APP_DATA_DIR}/data`): seeder
identity, per-circle enrollments, retention state, and logs.

## Build the image

From the **repo root** (the worklet bundle needs the repo's node_modules):

```bash
docker build -f seeder-launcher/umbrel/Dockerfile -t ghcr.io/peerloomllc/pearcircle-seeder:0.1.0 .
```

For a multi-arch image (amd64 + the arm64 a Raspberry Pi uses):

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg BARE_HOST=linux-arm64 \
  -f seeder-launcher/umbrel/Dockerfile \
  -t ghcr.io/peerloomllc/pearcircle-seeder:0.1.0 --push .
```

(`BARE_HOST` selects the `bare` runtime + native prebuilds; it must match the
target platform. A real multi-arch push uses one builder per platform with the
matching `BARE_HOST`.)

## Test on an Umbrel without publishing

Build for the Umbrel's arch, copy the image over, and load it so the compose
`image:` resolves locally:

```bash
docker save ghcr.io/peerloomllc/pearcircle-seeder:0.1.0 | gzip | \
  ssh umbrel@umbrel.local 'gunzip | docker load'
```

Then either install through a Community App Store (below), or smoke-test the
container directly on the Umbrel host:

```bash
ssh umbrel@umbrel.local \
  'docker run -d --name pcseeder -p 8730:8730 -v ~/pcseeder-data:/data \
     ghcr.io/peerloomllc/pearcircle-seeder:0.1.0'
# dashboard at http://umbrel.local:8730
```

## Install as an Umbrel app

The published image lives at `ghcr.io/peerloomllc/pearcircle-seeder` (public),
and it's listed in the PeerLoom community app store:

  https://github.com/peerloomllc/peerloom-umbrel-app-store

In Umbrel: App Store - top-right "⋯" - "Community App Stores" - add that URL,
then install **PearCircle Seeder** from the PeerLoom section. Umbrel pulls the
image, assigns the port, and runs it behind `app_proxy` (dashboard gated by the
Umbrel login). Validated on an x86_64 umbrelOS 0.5.4 box (enroll + replicate).

Note: the store id is `peerloom`, so the app id is `peerloom-pearcircle-seeder`
(Umbrel requires every app id to be prefixed with the store id). The files in
THIS directory are the source of truth; the store repo mirrors them.

The official route is a PR to `getumbrel/umbrel-apps` once a multi-arch image
(amd64 + arm64) is published.

## Networking note

Hyperswarm/HyperDHT uses UDP with NAT hole-punching, which normally traverses
Docker's bridge NAT fine. If replication never connects from inside the
container, the fallback is host networking - but that bypasses `app_proxy`, so
prefer confirming bridge works first.
