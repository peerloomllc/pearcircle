#!/usr/bin/env node
// On-device update-validation harness (proposal 2026-06-05-seeder-update 3b/3c).
//
// Serves a GitHub-Releases-shaped `/latest` JSON plus the installer assets in a
// local directory, so a seeder pointed at it with
//   PEARCIRCLE_UPDATE_LATEST_URL=http://127.0.0.1:<port>/latest
// runs its REAL update path (check -> select asset -> download -> sha256-verify
// -> per-platform apply) against a locally-built installer, with no GitHub
// release published. Reusable for every desktop platform: it just serves
// whatever installer + `.sha256` files are in the directory.
//
// Usage:
//   node serve-local-release.js <artifactsDir> <version> [port] [host]
//
//   <artifactsDir>  dir holding the built installer(s) + their .sha256 sidecars
//   <version>       release version to advertise, e.g. 1.0.21 (tag becomes vX)
//   [port]          listen port (default 8731)
//   [host]          host:port the asset URLs resolve to (default 127.0.0.1:port)
//
// The seeder fetches /latest then the asset URLs it contains, so [host] must be
// reachable from the seeder. Same-machine validation: leave it at 127.0.0.1.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const [dirArg, version, portArg, hostArg] = process.argv.slice(2)
if (!dirArg || !version) {
  console.error('usage: serve-local-release.js <artifactsDir> <version> [port] [host]')
  process.exit(1)
}
const dir = path.resolve(dirArg)
const port = Number(portArg) || 8731
const hostBase = hostArg || `127.0.0.1:${port}`

// A real GitHub release holds one installer per arch, but a local dist dir
// accumulates many builds — serving all of them would let selectAsset grab a
// stale same-arch installer (wrong version) silently. So advertise only files
// whose name carries the target version (the installer naming embeds it:
// `..._1.0.21_amd64.deb`, `...-Setup-1.0.21.exe`, `...-1.0.21.pkg`). If none
// match (e.g. version-less AppImage names), fall back to all files — point the
// harness at a clean dir in that case.
const ver = version.replace(/^v/, '')
const all = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
const versioned = all.filter((f) => f.includes(ver))
const files = versioned.length ? versioned : all
if (files.length === 0) { console.error(`no files in ${dir}`); process.exit(1) }
if (!versioned.length) console.warn(`WARN: no file name contains "${ver}"; serving ALL files in ${dir} — use a clean dir to avoid a wrong-version pick`)

// Every file (installer + its .sha256) is advertised as a release asset; the
// seeder's selectAsset / selectSha256For pick the platform installer + sidecar.
const assets = files.map((name) => ({
  name,
  browser_download_url: `http://${hostBase}/dl/${encodeURIComponent(name)}`,
}))
const release = {
  tag_name: `v${version.replace(/^v/, '')}`,
  html_url: `http://${hostBase}/`,
  assets,
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || hostBase}`)
  if (url.pathname === '/latest') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(release))
    return
  }
  if (url.pathname.startsWith('/dl/')) {
    const name = decodeURIComponent(url.pathname.slice('/dl/'.length))
    const file = path.join(dir, name)
    if (path.dirname(file) !== dir || !fs.existsSync(file)) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
    fs.createReadStream(file).pipe(res)
    return
  }
  res.writeHead(404); res.end('no')
})

server.listen(port, () => {
  console.log(`serving fake release v${version} from ${dir}`)
  console.log(`  ${assets.length} assets:`)
  for (const a of assets) console.log(`    ${a.name}`)
  console.log(`\npoint the seeder at it:`)
  console.log(`  PEARCIRCLE_UPDATE_LATEST_URL=http://${hostBase}/latest`)
  console.log(`\nlistening on http://0.0.0.0:${port} (asset URLs -> http://${hostBase})`)
})
