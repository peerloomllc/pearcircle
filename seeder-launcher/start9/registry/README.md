# PearCircle Seeder - StartOS community registry

Lets StartOS users install the seeder by **adding a registry URL** in their
Marketplace, instead of manually sideloading the `.s9pk` (and it gives them
"update available" notifications on new releases).

A StartOS 0.3.5.x registry is just an HTTP host that answers the marketplace
protocol's `GET /package/v0/...` endpoints — a **static file tree**, no database,
no registry service, no signing keyring (the s9pk is self-signed by `start-sdk
pack`; StartOS only checks the signature is internally valid). `build-registry.sh`
generates that tree from the built `.s9pk`.

StartOS 0.4 reads none of that. It speaks JSON-RPC over `POST /rpc/v0`, answered
on the website by `worker.js` from a single generated payload that
`build-registry-04.js` produces from the **v2** s9pk.

**Combined (multi-package) registry:** PeerLoom serves one registry
(`peerloomllc.com`) that lists several seeders (pearcircle-seeder, pearcal-seeder,
…). `build-registry.sh` is **merge-aware** — it upserts *this* package into
whatever tree already exists at `OUT_DIR` and leaves the others untouched (only
`index`/`latest`/`info` are merged; the per-id files are namespaced by id).

`build-registry-04.js` upserts the same way, and there it matters more: 0.4
serves every package from a **single** document, so writing that file wholesale
delists every other app in one line. It originally did exactly that, which is
why pearcal-seeder was invisible on 0.4 until 2026-07-27 while browsing looked
perfectly healthy on 0.3.5. It now replaces only this id's entry under
`packageIndex.packages`, unions the categories and leaves the registry name
alone. Keep this file in step with the sibling copies in the other PeerLoom
repos — they are deliberately near-identical.

> Every app publishing into the shared registry must use merge-aware tooling
> like this; a legacy `rm -rf package`-style generator would drop the others.

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

### Deployed at www.peerloomllc.com (Cloudflare)

The live registry is the PeerLoom website (a Cloudflare project that deploys on
merge to `main`). Its `_headers` sets the per-route Content-Types and `_redirects`
sends `/package/v0/pearcircle-seeder.s9pk` to the GitHub Release asset (the s9pk
is 720 MiB, over Cloudflare's 25 MiB per-file limit). Registry URL users add:
`https://www.peerloomllc.com`.

On a seeder release this is automated end to end by the release pipeline:
`build-start9-s9pk.sh` builds + uploads the s9pk to the tag, then
`seeder-launcher/scripts/publish-start9-registry.sh` regenerates the metadata,
bumps `_redirects` to the new tag, and (with `WEBSITE_REGISTRY_PR=1`) opens +
squash-merges the website PR — the merge is the deploy. `release.sh` runs both
(step 5d + 7b) when `WEBSITE_DIR` points at a website clone.

To refresh it by hand (e.g. a metadata-only fix), run against a website clone:

```bash
# print the git/gh steps:
WEBSITE_DIR=/path/to/website bash seeder-launcher/scripts/publish-start9-registry.sh
# or do it automatically (commit + PR + merge = deploy):
WEBSITE_DIR=/path/to/website WEBSITE_REGISTRY_PR=1 \
  bash seeder-launcher/scripts/publish-start9-registry.sh
```

Other hosting options, best first:
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
