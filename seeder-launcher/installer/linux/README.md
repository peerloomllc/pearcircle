# PearCircle Seeder - Linux install

Two package formats are shipped, each for `x86_64` and `arm64` (the arm64
build targets a Raspberry Pi, the canonical always-on seeder box):

- **`.deb`** - for Debian, Ubuntu, Raspberry Pi OS and derivatives.
- **`.AppImage`** - a single portable file for any other distribution.

Both run the seeder as a **systemd user service** that auto-starts on login.
`loginctl enable-linger` keeps it running across logout and reboot; the
installers enable linger for you.

Download the latest packages from the
[releases page](https://github.com/peerloomllc/pearcircle/releases).

## Install - Debian / Ubuntu / Raspberry Pi OS (.deb)

```bash
sudo apt install ./pearcircle-seeder_<version>_amd64.deb     # or _arm64.deb
```

The leading `./` is required - it tells `apt` to install a local file rather
than look the name up in a repository.

The package installs to `/opt/pearcircle-seeder`, adds a `pearcircle-seeder`
command on your `PATH`, and enables the `pearcircle-seeder` systemd user
service for the user who ran the install. The service starts immediately.

## Install - other distributions (.AppImage)

```bash
chmod +x PearCircleSeeder-x86_64.AppImage              # or -aarch64
./PearCircleSeeder-x86_64.AppImage --install-service
```

`--install-service` registers the systemd user service (its `ExecStart`
points back at the AppImage file, so keep the AppImage where it is).

You can also just **double-click the AppImage** in a file manager, or
integrate it with a tool like Gear Lever. The first desktop launch sets the
seeder up as a background service (exactly what `--install-service` does)
and opens the dashboard in your browser; every later launch just opens the
dashboard. A desktop notification confirms what happened.

Run from a terminal with no arguments, the AppImage instead starts the
seeder in the foreground - handy for a quick look or debugging.

AppImages self-mount with FUSE. If you see `dlopen(): libfuse.so.2`, either
install FUSE 2 (`sudo apt install libfuse2` / `sudo dnf install fuse-libs`)
or run the AppImage extracted:

```bash
./PearCircleSeeder-x86_64.AppImage --appimage-extract-and-run --install-service
```

## Open the monitoring UI

The dashboard is protected by an auth token. Find its URL in the seeder log:

```bash
grep 'UI at' ~/.local/share/pearcircle-seeder/seeder.log
```

Open that URL in a browser to enroll circles and watch replication. Service
status and logs:

```bash
systemctl --user status pearcircle-seeder
journalctl --user -u pearcircle-seeder -f
```

## Reach the dashboard from another machine on your LAN

By default the dashboard binds to loopback only, so it is reachable from the
seeder box itself and nowhere else. That is the right default for a desktop
install and the wrong one for a headless box, where there is no browser to
open it with. Bind to all interfaces instead:

```bash
systemctl --user edit pearcircle-seeder
```

Add this to the drop-in the editor opens, save, then restart the service with
`systemctl --user restart pearcircle-seeder`:

```ini
[Service]
Environment=SEEDER_HOST=0.0.0.0
```

The startup log then lists the box's LAN addresses, token included, so
`grep 'UI at' ~/.local/share/pearcircle-seeder/seeder.log` gives you a URL you
can paste into a browser on another machine. Running in the foreground,
`pearcircle-seeder --host 0.0.0.0` does the same thing.

Two things to keep in mind:

- **The token is the only gate.** Anything that can reach port 8730 can reach
  the dashboard with that token. On a home LAN that is normally fine. Bind to
  one address (`SEEDER_HOST=192.168.1.50`) to narrow it.
- **Do not expose the port to the internet** directly. Put it behind a reverse
  proxy or a tunnel (Tailscale, Cloudflare Tunnel, WireGuard) that does its own
  authentication. Seeding itself does not need any inbound port forwarded - the
  P2P side holepunches.

## Update

The seeder checks GitHub Releases hourly and surfaces a newer version in the
monitoring dashboard (and in the mobile app's seeder list). Click **Update
now** to apply it one-click - no manual download:

- **`.deb`:** the unprivileged service runs the root updater
  (`/opt/pearcircle-seeder/updater-helper.sh`) through `pkexec`. A polkit rule
  installed by the package (`/etc/polkit-1/rules.d/49-pearcircle-seeder-updater.rules`)
  lets your user run *only that one root-owned script* with no password, so the
  background service can apply updates unattended. The helper re-verifies the
  download's SHA-256 against the release's `.sha256` sidecar before `dpkg -i`,
  then restarts the service. Requires polkit >= 0.106 (modern Debian/Ubuntu).
  If polkit is missing the dashboard falls back to a verified download link.
- **`.AppImage`:** the running image is swapped in place and the user service is
  restarted - no privilege needed.

The integrity boundary is HTTPS to GitHub plus the release `.sha256` (Linux
artifacts are unsigned). The one-click apply is operator-gated - nothing
self-updates without a click.

You can still update by hand: re-run `apt install` with the newer `.deb`, or
replace the `.AppImage` file in place. The seeder identity and circle
enrollments under `~/.local/share/pearcircle-seeder` are preserved either way.

## Uninstall

```bash
sudo apt remove pearcircle-seeder                        # .deb (keeps identity)
sudo apt purge  pearcircle-seeder                        # .deb (also wipes identity)
./PearCircleSeeder-x86_64.AppImage --uninstall-service   # AppImage (keeps identity)
./PearCircleSeeder-x86_64.AppImage --uninstall-service --purge   # AppImage (wipes identity)
```

All paths stop the service, remove the per-user systemd unit, and drop the
`enable-linger` the install set. `remove` / plain `--uninstall-service` leave
`~/.local/share/pearcircle-seeder` (identity + enrollments) in place so a
reinstall stays the same seeder; `purge` / `--purge` wipe it.

The `.deb` also cleans up correctly when removed through a graphical software
centre (GNOME Software, KDE Discover), which runs without `sudo`. After
removing the AppImage's service, delete the `.AppImage` file to finish, and
remove any menu entry you created with a tool like Gear Lever.

## Build from source

The Linux packages build locally on a Linux x86_64 host - no VM or remote
build machine, unlike the macOS and Windows installers.

Prereqs:

- Node.js 20+ and npm on `PATH`
- `dpkg-deb` (Debian: built in; Fedora: `sudo dnf install dpkg`)
- `appimagetool` is downloaded automatically by the build script
- internet access (to fetch the pinned Node.js runtime and appimagetool)

Build from the repo root:

```bash
npm install
cd seeder-launcher && npm install

bash scripts/build-linux.sh                 # all four: deb + AppImage, x86_64 + arm64
```

Subset the build with environment variables:

```bash
LINUX_ARCHES=x86_64 LINUX_FORMATS=deb bash scripts/build-linux.sh
```

Outputs land in `seeder-launcher/dist/linux/`. The arm64 packages are
cross-built on an x86_64 host and are build-verified only - run-test them on
real arm64 hardware before relying on them.
