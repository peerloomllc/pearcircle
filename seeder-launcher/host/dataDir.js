const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// Resolve the per-OS data directory. The seed worklet stores its Hyperbee
// at <dataDir>/pearcircle/store (per src/bare.js init flow). The launcher
// stores its auth token + log alongside it.
//
//   macOS    ~/Library/Application Support/PearCircle Seeder
//   Linux    $XDG_DATA_HOME/pearcircle-seeder  (default ~/.local/share/pearcircle-seeder)
//   Windows  %APPDATA%/PearCircle Seeder
function resolveDataDir (override) {
  if (override) return path.resolve(override)
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'PearCircle Seeder')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(appData, 'PearCircle Seeder')
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(xdg, 'pearcircle-seeder')
}

function ensureDir (p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

module.exports = { resolveDataDir, ensureDir }
