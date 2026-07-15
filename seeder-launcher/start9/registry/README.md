# PearCircle Seeder - StartOS community registry

Lets StartOS users install the seeder by **adding a registry URL** in their
Marketplace, instead of manually sideloading the `.s9pk` (and it gives them
"update available" notifications on new releases).

A StartOS 0.3.5.x registry is just an HTTP host that answers the marketplace
protocol's `GET /package/v0/...` endpoints. For a single app that's a **static
file tree** - no database, no registry service, no signing keyring (the s9pk is
self-signed by `start-sdk pack`; StartOS only checks the signature is internally
valid). `build-registry.sh` generates that tree from the built `.s9pk`.

## Generate

```bash
cd seeder-launcher/start9
make                      # build the universal .s9pk first
bash registry/build-registry.sh
# -> registry/dist/package/v0/{info,index,latest,version/…,manifest/…,
#      release-notes/…,instructions/…,license/…,icon/…,pearcircle-seeder.s9pk}
```

The JSON shapes mirror the live `registry.start9.com` exactly (verified against
its `/package/v0/index`): `icon` is raw base64 (no `data:` prefix),
`instructions`/`license` are `/package/v0/...` paths, and each index entry
embeds the normalized manifest.

## Host it

Serve `registry/dist/` as a static site. **The protocol paths are extensionless,
so Content-Type must be set by route, not file extension** - this is the one
thing a static host must get right:

| Path | Content-Type |
|------|--------------|
| `/package/v0/pearcircle-seeder.s9pk` | `application/octet-stream` |
| `/package/v0/icon/pearcircle-seeder` | `image/png` |
| `/package/v0/instructions/pearcircle-seeder` | `text/markdown` |
| `/package/v0/license/pearcircle-seeder` | `text/plain` |
| everything else under `/package/v0` | `application/json` |

`serve-registry.js` is a reference implementation of exactly these rules (used
for local testing): `node registry/serve-registry.js 8099`.

Hosting options, best first:
- **Caddy / nginx on a VPS**, or **S3 + CloudFront**, or **Cloudflare Pages**
  (`_headers` file) - anywhere you control per-route Content-Type. HTTPS.
- **Start9 Pages** (serves over Tor `.onion`) - Start9's own static-hosting path;
  a `.onion` registry URL is accepted by the Marketplace.
- **GitHub Pages is not recommended**: it assigns Content-Type by extension and
  can't serve the extensionless protocol files as `application/json`.

Serve over **HTTPS or a `.onion`** (plain HTTP may be rejected by the
Marketplace).

## Users add it

In StartOS: **Marketplace → Change → Add custom registry →** paste the registry
URL (the site root, e.g. `https://registry.peerloomllc.com`) → Connect. The
PearCircle Seeder appears under its category and installs like any store app.

## Release / update flow

On each seeder release: rebuild the `.s9pk` (`make`), regenerate the tree
(`build-registry.sh`), and re-publish `dist/`. Bumping `latest` + `version/<id>`
is what triggers "Update available" on installed servers. Keep signing every
release with the **same** `~/.embassy/developer.key.pem` so update continuity
holds.

`dist/` is a build artifact (git-ignored); the generator + server are the source
of truth.
