# PearCircle Seeder Launcher

A desktop app that keeps a PearCircle circle's data online when no member device is.

PearCircle circles sync peer-to-peer, so a circle's history is only reachable while at least one member device is online. The seeder launcher runs the PearCircle blind-seeder worklet as a background service on an always-on machine: it replicates each enrolled circle's encrypted blocks so members stay in sync even when every phone is offline. It is a "blind" seeder because the blocks stay encrypted - it stores and serves a circle's data without ever being able to read it.

## What it does

- Runs the seed-mode worklet as a long-lived background service.
- Serves a small monitoring UI at `http://127.0.0.1:8730` for enrolling circles and watching replication. Loopback-only by default; set `SEEDER_HOST=0.0.0.0` (or `--host 0.0.0.0`) to reach it from elsewhere on the LAN, which is what a headless install wants.
- Stores the seeder identity and per-circle enrollments in a local on-disk database.
- Starts automatically at login.

## How it's used

- A circle member mints a seed invite from the PearCircle app; pasting it into the launcher UI enrolls that circle.
- Each enrolled circle has a retention setting (Forever, 30 days, 7 days, or 24 hours) that bounds how much history the seeder keeps.
- Circle members stay in control: they admit a seeder when it enrolls and can revoke it at any time.

## Architecture

```
Browser (http://127.0.0.1:8730)
   |
   |  HTTP /api/*  +  WebSocket /ws
   v
Host process (single binary)
   |
   |  JSON-newline IPC over stdin/stdout
   v
Blind-seeder worklet (src/bare.js, seed mode)
   |
   |  encrypted Autobase blocks over Hyperswarm
   v
PearCircle members of the enrolled circles
```

The host keeps the seeder identity, enrollments, and logs in a per-OS application-support directory; that state is preserved across updates.

## Install

Installer guides live alongside each platform's packaging files under `installer/`:

- macOS: [installer/macos/README.md](installer/macos/README.md)
- Windows: [installer/windows/README.md](installer/windows/README.md)
- Linux: [installer/linux/README.md](installer/linux/README.md)
- Umbrel: [umbrel/README.md](umbrel/README.md)
- Start9: [start9/README.md](start9/README.md)

### Run the Docker image yourself

The image is `ghcr.io/peerloomllc/pearcircle-seeder`, tagged by release (for
example `1.1.0`). Outside Umbrel, run it with **host networking** and **turn the
dashboard token back on**:

```bash
docker run -d --name pearcircle-seeder --restart unless-stopped --network host -e SEEDER_NO_AUTH=0 -v ~/pearcircle-seeder-data:/data ghcr.io/peerloomllc/pearcircle-seeder:1.1.0
```

- **Host networking.** Under rootless Podman (slirp4netns or pasta) the
  container's connections form but hole-punched traffic never flows, so the
  seeder drops and re-dials every connection and never replicates, while the
  dashboard still works through the port map and hides the problem. Umbrel's
  rootful Docker bridge does carry it, which is why the Umbrel app does not use
  host networking. Anywhere else, use `--network host` rather than `-p`.
- **The token.** The image is built for Umbrel, where the Umbrel login guards the
  dashboard, so it defaults to `SEEDER_NO_AUTH=1` and binds `0.0.0.0`. With host
  networking that puts an unauthenticated dashboard on your LAN. `-e
  SEEDER_NO_AUTH=0` requires the token again; it is in `auth.token` in the data
  folder (`sudo cat ~/pearcircle-seeder-data/auth.token`, or `podman unshare cat`
  for rootless Podman), and you open the dashboard at `http://<host>:8730/?t=<token>`.
- **Local only.** Add `-e SEEDER_HOST=127.0.0.1` to keep the dashboard off the
  LAN entirely.
- **SELinux** (Fedora, RHEL): append `:Z` to the volume, e.g.
  `-v ~/pearcircle-seeder-data:/data:Z`.

## Design

The blind-seeder protocol is specified in `proposals/2026-05-19-blind-seeder-peers.md` at the repo root.
