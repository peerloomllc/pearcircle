#!/usr/bin/env node
// Emit the StartOS 0.4 registry payload for a v2 s9pk.
//
// StartOS 0.4 marketplaces do not read the 0.3.5 static tree that
// build-registry.sh produces. They speak JSON-RPC over POST /rpc/v0, so
// `https://peerloomllc.com` fails on 0.4 with "RPC ERROR: Network Error Not
// Found" while still working perfectly on 0.3.5.x boxes.
//
// The whole payload is static per release, so it is generated here and served
// verbatim by a tiny Worker. That keeps the request path dumb: no s9pk
// inspection, no crypto, no start-cli at the edge.
//
// What 0.4 actually demands, established by driving a real 0.4 client
// (`start-cli -r <url> registry package index`) against a stub registry on
// 2026-07-27:
//   - `commitment` is MANDATORY. Omitting it fails deserialization outright.
//     Its value comes from the s9pk itself, so we can generate it.
//   - `signatures` may be an empty object. This is what makes a static
//     registry possible at all; without it we would need Start9's publishing
//     pipeline.
//   - `icon` must be a real base64 data URL. `null` is rejected.
//
// Usage:
//   build-registry-04.js <path-to-v2.s9pk> --url <public-s9pk-url> \
//     [--icon <png>] [--out <file>] [--registry-name <name>]
//
// Env: START_CLI overrides the start-cli binary. It must be the 0.4-era one
// (1.x); the 0.3.5 SDK's start-cli has no `s9pk inspect` and will fail.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function arg (flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const S9PK = process.argv[2]
if (!S9PK || S9PK.startsWith('--')) {
  console.error('usage: build-registry-04.js <v2.s9pk> --url <public-s9pk-url> [--icon f.png] [--out f.json]')
  process.exit(1)
}
if (!fs.existsSync(S9PK)) {
  console.error(`build-registry-04: s9pk not found: ${S9PK}`)
  process.exit(1)
}

const S9PK_URL = arg('--url')
if (!S9PK_URL) {
  console.error('build-registry-04: --url is required (where the s9pk is downloadable)')
  process.exit(1)
}

const START_CLI = process.env.START_CLI || 'start-cli'
const ICON = arg('--icon', path.join(path.dirname(S9PK), 'icon.png'))
const OUT = arg('--out', path.join(path.dirname(S9PK), 'registry-04.json'))
const REGISTRY_NAME = arg('--registry-name', 'PeerLoom Registry')

// Categories are the registry's own vocabulary; package entries reference
// these keys. Kept in step with the 0.3.5 tree so a package does not appear
// under different headings depending on which StartOS version is asking.
const CATEGORIES = {
  featured: { name: 'Featured' },
  networking: { name: 'Networking' },
}
const PACKAGE_CATEGORIES = ['featured', 'networking']

// `inspect` takes the s9pk BEFORE the subcommand (`inspect <s9pk> manifest`),
// which is the opposite of most start-cli commands and an easy hour to lose.
function inspect (sub) {
  const raw = execFileSync(START_CLI, ['s9pk', 'inspect', S9PK, sub], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(raw)
}

// 0.3.5 manifests carry plain strings where 0.4 wants a locale map. Only
// en_US is claimed: asserting a translation we do not have would be worse
// than offering one language.
const loc = (v) => (typeof v === 'string' && v.length > 0 ? { en_US: v } : { en_US: '' })

console.error(`==> inspecting ${path.basename(S9PK)} (this reads the whole package, give it a minute)`)
const manifest = inspect('manifest')
const commitment = inspect('commitment')

if (!fs.existsSync(ICON)) {
  console.error(`build-registry-04: icon not found: ${ICON} (0.4 rejects a null icon)`)
  process.exit(1)
}
const iconDataUrl = 'data:image/png;base64,' + fs.readFileSync(ICON).toString('base64')

const version = manifest.version // already "1.1.0:0" shape in a v2 manifest
if (!version) {
  console.error('build-registry-04: manifest has no version')
  process.exit(1)
}

const arches = manifest.hardwareRequirements?.arch ?? ['x86_64', 'aarch64']

const versionEntry = {
  title: manifest.title,
  description: {
    short: loc(manifest.description?.short),
    long: loc(manifest.description?.long),
  },
  releaseNotes: loc(manifest.releaseNotes),
  // start-cli appends a newline (and "-modified" for a dirty tree) to gitHash.
  gitHash: typeof manifest.gitHash === 'string' ? manifest.gitHash.trim() : null,
  license: manifest.license ?? null,
  packageRepo: manifest.packageRepo ?? null,
  upstreamRepo: manifest.upstreamRepo ?? null,
  marketingUrl: manifest.marketingUrl ?? null,
  donationUrl: manifest.donationUrl ?? null,
  osVersion: manifest.osVersion ?? null,
  sdkVersion: manifest.sdkVersion ?? null,
  hardwareAcceleration: manifest.hardwareAcceleration ?? false,
  userspaceFilesystems: manifest.userspaceFilesystems ?? false,
  virtualNetworking: manifest.virtualNetworking ?? false,
  plugins: manifest.plugins ?? [],
  satisfies: manifest.satisfies ?? [],
  icon: iconDataUrl,
  dependencyMetadata: {},
  sourceVersion: null,
  // One entry: a hardware predicate paired with where to get the file.
  // `signatures: {}` is deliberate and load-bearing - see the header.
  s9pks: [[
    { device: [], ram: null, arch: arches },
    {
      publishedAt: new Date().toISOString().replace('Z', '000000Z'),
      urls: [S9PK_URL],
      commitment,
      signatures: {},
    },
  ]],
}

const payload = {
  info: { name: REGISTRY_NAME, icon: null, categories: CATEGORIES },
  packageIndex: {
    categories: CATEGORIES,
    packages: {
      [manifest.id]: {
        authorized: {},
        categories: PACKAGE_CATEGORIES,
        versions: { [version]: versionEntry },
      },
    },
  },
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.error(`==> wrote ${OUT}`)
console.error(`    ${manifest.id} ${version} | arch ${arches.join(',')} | rootSighash ${commitment.rootSighash}`)
