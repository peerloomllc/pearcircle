# PearCircle Seeder - Linux install

Two package formats are shipped, each for `x86_64` and `arm64` (the arm64
build targets a Raspberry Pi, the canonical always-on seeder box):

- **`.deb`** - for Debian, Ubuntu, Raspberry Pi OS and derivatives.
- **`.AppImage`** - a single portable file for any other distribution.

Both run the seeder as a **systemd user service** that auto-starts on login.
`loginctl enable-linger` keeps it running across logout and reboot; the
installers enable linger for you.

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

## Update

Re-run `apt install` with the newer `.deb`, or replace the `.AppImage` file
in place. The seeder identity and circle enrollments under
`~/.local/share/pearcircle-seeder` are preserved.

## Uninstall

```bash
sudo apt remove pearcircle-seeder                        # .deb
./PearCircleSeeder-x86_64.AppImage --uninstall-service   # AppImage
```

Both stop and remove the service but leave `~/.local/share/pearcircle-seeder`
in place so a reinstall keeps the seeder identity. Delete that directory by
hand for a full wipe.

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
