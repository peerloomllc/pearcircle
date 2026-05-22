# PearCircle Seeder Launcher

A desktop app that keeps a PearCircle circle's data online when no member device is.

PearCircle circles sync peer-to-peer, so a circle's history is only reachable while at least one member device is online. The seeder launcher runs the PearCircle blind-seeder worklet as a background service on an always-on machine: it replicates each enrolled circle's encrypted blocks so members stay in sync even when every phone is offline. It is a "blind" seeder because the blocks stay encrypted - it stores and serves a circle's data without ever being able to read it.

## What it does

- Runs the seed-mode worklet as a long-lived background service.
- Serves a small monitoring UI at `http://127.0.0.1:8730` for enrolling circles and watching replication.
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

## Design

The blind-seeder protocol is specified in `proposals/2026-05-19-blind-seeder-peers.md` at the repo root.
