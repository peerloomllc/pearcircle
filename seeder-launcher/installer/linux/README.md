# PearCircle Seeder - Linux install (retired)

The PearCircle Seeder is no longer released. Its last build was 1.1.5, attached to the
PearCircle 1.1.5 and 1.1.6 releases.
**[PeerLoom Seeder](https://github.com/peerloomllc/peerloom-seeder)** replaces
it and keeps PearCircle and the other PeerLoom apps in sync while your phones
sleep. Get the Linux `.deb`, AppImage or tarball from its
[releases page](https://github.com/peerloomllc/peerloom-seeder/releases) and
follow the install steps in its README. More at
[peerloomllc.com/seeder](https://peerloomllc.com/seeder/).

## What `pearcircle-watch` is

From 1.1.7 the PearCircle releases carry `pearcircle-watch_<version>_<arch>.deb`
and `PearCircleWatcher-<version>-<arch>.AppImage`. These are a different app,
not a renamed seeder. The watcher shows a circle's members on a map from a
computer and never shares a location. It runs when you start it
(`pearcircle-watch`, or the PearCircle Watcher menu entry), so it installs no
systemd service and has no seeder token or `~/.local/share/pearcircle-seeder`
folder. See [`watch-desktop/README.md`](../../../watch-desktop/README.md).

## Moving from the old seeder

The old seeder keeps working until you remove it:

```bash
sudo apt purge pearcircle-seeder
```

Then install PeerLoom Seeder and enroll your circles in it again. The two use
separate data folders.
