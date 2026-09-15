const fs = require('node:fs')
const path = require('node:path')

// Operator settings kept in <dataDir>/settings.json, e.g. { "host": "0.0.0.0" }.
//
// Exists because the Mac and Windows installers rebuild the service definition on
// every update: the .pkg postinstall re-templates the LaunchDaemon plist and the
// NSIS installer removes and re-registers the NSSM service. A SEEDER_HOST added
// to either by hand silently disappears at the next update, including a one-click
// one. The data dir is the one place every installer and updater leaves alone
// (it holds the identity), so a setting written there survives.
//
// Precedence, highest first: command-line flag, environment variable, this file,
// built-in default. A missing file is normal. A malformed file or a bad value is
// reported through `errors` and ignored, so a typo can never stop the seeder.
const SETTINGS_FILE = 'settings.json'

function loadHostSettings (dataDir) {
  const file = path.join(dataDir, SETTINGS_FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, errors: [], file }
    return { settings: {}, errors: [`could not read ${file}: ${err.message}`], file }
  }
  // Windows Notepad can save UTF-8 with a byte-order mark, which JSON.parse
  // rejects. Drop it so a file edited that way still loads.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { settings: {}, errors: [`${file} is not valid JSON: ${err.message}`], file }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: {}, errors: [`${file} must hold a JSON object`], file }
  }
  const settings = {}
  const errors = []
  if (parsed.host !== undefined) {
    if (typeof parsed.host === 'string' && parsed.host.trim().length > 0) settings.host = parsed.host.trim()
    else errors.push(`${file}: "host" must be a non-empty string`)
  }
  if (parsed.port !== undefined) {
    if (Number.isInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535) settings.port = parsed.port
    else errors.push(`${file}: "port" must be a whole number from 1 to 65535`)
  }
  return { settings, errors, file }
}

// Pick the bind address and port. `cli` holds values from flags or environment
// variables (null when neither was given), `file` the loaded settings.
function resolveBind (cli = {}, file = {}) {
  const pick = (key, fallback) => {
    if (cli[key] != null) return { value: cli[key], source: 'flag or environment' }
    if (file[key] != null) return { value: file[key], source: SETTINGS_FILE }
    return { value: fallback, source: 'default' }
  }
  const host = pick('host', '127.0.0.1')
  const port = pick('port', 8730)
  return { host: host.value, port: port.value, hostSource: host.source, portSource: port.source }
}

module.exports = { SETTINGS_FILE, loadHostSettings, resolveBind }
