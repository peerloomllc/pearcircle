// Resolve the seeder-launcher build version (proposal 2026-06-05-seeder-update
// slice 1). Precedence:
//   1. A build-time stamp injected by build-host-sea.sh via esbuild
//      `--define:PEARCIRCLE_SEEDER_VERSION='"x.y.z"'` (the release tag). In the
//      shipped single-file bundle this is the authoritative version.
//   2. seeder-launcher/package.json `version` (dev: `node host/index.js`).
//   3. '0.0.0-dev' fallback.
// The typeof guard keeps the un-stamped dev path from throwing a ReferenceError
// on the missing global.
function resolveVersion () {
  try {
    // eslint-disable-next-line no-undef
    if (typeof PEARCIRCLE_SEEDER_VERSION === 'string' && PEARCIRCLE_SEEDER_VERSION) {
      // eslint-disable-next-line no-undef
      return PEARCIRCLE_SEEDER_VERSION
    }
  } catch {}
  try {
    const v = require('../package.json').version
    if (typeof v === 'string' && v) return v
  } catch {}
  return '0.0.0-dev'
}

module.exports = { SEEDER_VERSION: resolveVersion() }
