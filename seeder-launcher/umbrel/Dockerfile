# PearCircle blind-seeder as a container, for Umbrel (and any Docker host).
#
# Build context is the REPO ROOT (the worklet bundle needs the repo's
# node_modules + native addon prebuilds), so build with:
#   docker build -f seeder-launcher/umbrel/Dockerfile -t pearcircle/seeder:<ver> .
#
# Multi-arch (amd64 + arm64 for a Raspberry Pi). Cross-build pattern: the heavy
# builder runs on the NATIVE build platform (so npm/bare-pack/esbuild never run
# under emulation — slow + flaky), and only the thin runtime stage targets the
# requested arch. The payload is arch-portable to stage: stage-payload-linux.sh
# fetches the target's `bare` runtime via `npm pack` and copies the target's
# native prebuilds (prebuildify ships every arch), so an amd64 builder produces
# a complete arm64 payload — exactly how the .deb/.AppImage arm64 builds work.
# Build both arches + a manifest with:
#   podman build --platform=linux/amd64,linux/arm64 --manifest <tag> \
#     -f seeder-launcher/umbrel/Dockerfile .
# (arm64 needs qemu-user-static on the build host for the runtime apt step.)

# ---- builder (always native via $BUILDPLATFORM) ----------------------------
FROM --platform=$BUILDPLATFORM node:20-bookworm AS builder
WORKDIR /src
# Full repo (see .dockerignore for what's excluded — notably node_modules,
# which we regenerate so the prebuilds match).
COPY . .
# Worklet deps + bare-pack + native prebuilds for the worklet bundle, then the
# launcher's own build deps (esbuild, preact, ws).
RUN npm ci --no-audit --no-fund \
 && npm --prefix seeder-launcher ci --no-audit --no-fund
# Stage the flat payload (host-bundled.js, bare, worklet/, ui/) for the TARGET
# arch. TARGETARCH (amd64 | arm64) is provided by the build platform; map it to
# the bare-runtime triple.
ARG TARGETARCH
RUN BARE_HOST="$([ "$TARGETARCH" = arm64 ] && echo linux-arm64 || echo linux-x64)"; \
    echo "staging payload for TARGETARCH=$TARGETARCH BARE_HOST=$BARE_HOST"; \
    BARE_HOST="$BARE_HOST" OUT_DIR=/payload \
      bash seeder-launcher/scripts/stage-payload-linux.sh \
 && rm -f /payload/node /payload/pearcircle-seeder
# ^ drop the payload's bundled Node + wrapper: the runtime image already has
#   node, and we invoke host-bundled.js directly.

# ---- runtime (targets the requested arch) ----------------------------------
FROM node:20-bookworm-slim
# Runtime libs the slim image lacks but the worklet's native addons need:
#   libatomic1 - rocksdb-native links libatomic.so.1
#   ca-certificates - the background GitHub-Releases update check (fail-open)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /payload /app

# Containerized defaults (overridable): bind all interfaces so Umbrel's
# app_proxy on the Docker network can reach the UI, and skip the in-app bearer
# token because the proxy already gates access behind the Umbrel login. The
# seeder identity + per-circle enrollments + logs persist under /data.
ENV SEEDER_HOST=0.0.0.0 \
    SEEDER_PORT=8730 \
    SEEDER_NO_AUTH=1
VOLUME /data
EXPOSE 8730

# Runs as root (the default for the node image): Umbrel mounts ${APP_DATA_DIR}
# root-owned, so this avoids a first-run chmod dance on /data. The worklet
# stores only encrypted blocks, and compose sets no-new-privileges.
CMD ["node", "/app/host-bundled.js", "--data-dir", "/data", "--no-open"]
