const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// Resolve the per-OS data directory. The seed worklet stores its Hyperbee
// at <dataDir>/pearcircle/store (per src/bare.js init flow). The launcher
// stores its auth token + log alongside it.
//
//   macOS    ~/Library/Application Support/PearCircle Seeder
//   Linux    $XDG_DATA_HOME/pearcircle-seeder  (default ~/.local/share/pearcircle-seeder)
//   Windows  %ProgramData%\PearCircle Seeder
function resolveDataDir (override) {
  if (override) return path.resolve(override)
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'PearCircle Seeder')
  }
  if (process.platform === 'win32') {
    // Machine-wide: the installed launcher runs as a LocalSystem service,
    // whose %APPDATA% resolves under System32\config and is unreadable by
    // ordinary users (the dashboard launcher needs to read auth.token).
    // ProgramData is the machine-wide, user-readable home.
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    return path.join(programData, 'PearCircle Seeder')
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(xdg, 'pearcircle-seeder')
}

function ensureDir (p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

module.exports = { resolveDataDir, ensureDir }
