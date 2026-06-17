# PearCircle blind-seeder as a container, for Umbrel (and any Docker host).
#
# Build context is the REPO ROOT (the worklet bundle needs the repo's
# node_modules + native addon prebuilds), so build with:
#   docker build -f seeder-launcher/umbrel/Dockerfile -t pearcircle/seeder:<ver> .
#
# Two stages: a heavy builder that runs the existing stage-payload-linux.sh
# (UI build, esbuilt host, bare runtime, bare-pack worklet bundle + prebuilds)
# into a flat /payload, and a slim runtime that just runs it. Builder and
# runtime share the same Debian release so the staged `bare` binary and the
# native addon prebuilds match the runtime glibc.

# ---- builder ---------------------------------------------------------------
FROM node:20-bookworm AS builder
WORKDIR /src
# Full repo (see .dockerignore for what's excluded — notably node_modules,
# which we regenerate so the prebuilds match this Linux/x64 builder).
COPY . .
# Worklet deps + bare-pack + native prebuilds for the worklet bundle, then the
# launcher's own build deps (esbuild, preact, ws).
RUN npm ci --no-audit --no-fund \
 && npm --prefix seeder-launcher ci --no-audit --no-fund
# Stage the flat payload (host-bundled.js, bare, worklet/, ui/, node) exactly
# as the .deb/.AppImage builds do. BARE_HOST tracks the build arch.
ARG BARE_HOST=linux-x64
RUN BARE_HOST=${BARE_HOST} OUT_DIR=/payload \
      bash seeder-launcher/scripts/stage-payload-linux.sh \
 && rm -f /payload/node /payload/pearcircle-seeder
# ^ drop the payload's bundled Node + wrapper: the runtime image already has
#   node, and we invoke host-bundled.js directly.

# ---- runtime ---------------------------------------------------------------
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
