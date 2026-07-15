# StartOS runtime image for the PearCircle seeder.
#
# Rather than re-run the heavy cross-arch worklet build, this reuses the exact
# published, digest-pinned image the Umbrel app runs (see
# ../umbrel/docker-compose.yml). We only add a proper init (tini, to reap the
# `bare` child the host spawns) and the StartOS entrypoint. `docker buildx`
# selects the right arch layer from the base image's manifest; the s9pk
# packer expects the built tar tagged start9/<id>/main:<version>.
FROM ghcr.io/peerloomllc/pearcircle-seeder:1.0.20@sha256:388a7ba689336af7994d2b2d8267bdb2d631c38e6a81e201d1c5bce02460040c

# The published image is node:20-bookworm-slim (Debian), which has no init.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ADD ./docker_entrypoint.sh /usr/local/bin/docker_entrypoint.sh
RUN chmod a+x /usr/local/bin/docker_entrypoint.sh
