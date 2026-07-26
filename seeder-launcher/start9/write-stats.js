// Populate the StartOS "Properties" page.
//
// compat.properties (scripts/procedures/properties.ts) renders whatever is in
// <volume>/start9/stats.yaml. Nothing ever wrote that file, so the menu item
// existed and showed nothing. This polls the seeder's own dashboard API and
// rewrites the file, so Properties reflects live state.
//
// The seeder public key is the point of this: it identifies the seeder and is
// what a member checks to confirm they admitted the right one. On StartOS there
// was previously no way to see it without opening the dashboard.
//
// Deliberately NOT written here: the dashboard auth token. StartOS runs the
// seeder with SEEDER_NO_AUTH=1 (the interface proxy gates access), so the token
// is not needed to reach the UI, and Properties is readable by anyone with
// server access.

const fs = require('fs')
const path = require('path')

// The manifest mounts the package's main volume at /root, and compat reads
// <volume>/start9/stats.yaml.
const STATS_DIR = process.env.START9_STATS_DIR || '/root/start9'
const STATS_FILE = path.join(STATS_DIR, 'stats.yaml')
const BASE = `http://127.0.0.1:${process.env.SEEDER_PORT || 8730}`
const INTERVAL_MS = Number(process.env.START9_STATS_INTERVAL_MS || 60000)

// Values land inside a YAML double-quoted scalar, so escape what would break it.
// The seeder nickname is operator-supplied and reaches here verbatim, as do the
// circle names members chose. Control characters are dropped rather than
// escaped: a raw newline would end the scalar and corrupt the whole document,
// and nothing worth showing on a Properties page needs one. (The nickname setter
// already strips them; circle names arrive from a seed invite and do not.)
const q = (v) => '"' + String(v ?? '')
  .replace(/[\x00-\x1f\x7f]/g, '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"') + '"'

function entry (name, value, description, copyable) {
  return [
    `  ${name}:`,
    '    type: string',
    `    value: ${q(value)}`,
    `    description: ${q(description)}`,
    `    copyable: ${copyable ? 'true' : 'false'}`,
    '    qr: false',
    '    masked: false',
  ].join('\n')
}

function render (status, circlesBody) {
  const st = status ?? {}
  const all = Array.isArray(circlesBody?.circles) ? circlesBody.circles : []
  const active = all.filter((c) => !c?.revoked)
  const names = active.map((c) => c?.name).filter(Boolean).join(', ')
  const revoked = all.length - active.length
  const mb = (Number(st.totalBytesReplicated ?? 0) / 1048576).toFixed(1)
  return [
    'version: 2',
    'data:',
    entry('Seeder Public Key', st.pubkey ?? 'unavailable',
      'Identifies this seeder. Check it matches what the PearCircle app shows when you admit it.', true),
    entry('Nickname', st.nickname || 'not set',
      'Display name shown to members. Change it from the seeder dashboard.', false),
    entry('Circles Seeded', String(active.length) + (revoked > 0 ? ` (${revoked} revoked)` : ''),
      names
        ? `Currently replicating: ${names}`
        : 'No circles enrolled yet. Mint a seed invite in the PearCircle app and paste it into the dashboard.', false),
    entry('Stored', `${mb} MB`,
      'Encrypted circle data held on this server. The seeder cannot read any of it.', false),
    entry('Seeder Version', st.version || 'unknown',
      'Build version the running worklet reports. Updates come from the StartOS marketplace.', false),
    '',
  ].join('\n')
}

async function getJson (pathname) {
  const res = await fetch(BASE + pathname)
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`)
  return res.json()
}

// One failure is logged, then the rest stay quiet: a fully silent catch made
// two of PearCal's four Properties bugs undiagnosable from outside the
// container (pearcal-native PRs #244-#249), while logging every tick would spam
// the journal for the whole time a seeder is down.
let _loggedFailure = false

async function tick () {
  try {
    // Both endpoints are unauthenticated here (SEEDER_NO_AUTH=1). A failure on
    // either aborts the tick rather than writing a half-populated page.
    const [status, circles] = await Promise.all([
      getJson('/api/status'),
      getJson('/api/circles'),
    ])
    fs.mkdirSync(STATS_DIR, { recursive: true })
    // Write-then-rename so StartOS never reads a half-written file.
    const tmp = STATS_FILE + '.tmp'
    fs.writeFileSync(tmp, render(status, circles))
    fs.renameSync(tmp, STATS_FILE)
    return true
  } catch (e) {
    // The seeder may not be listening yet, or may be mid-restart. Properties
    // keeps showing the previous snapshot rather than going blank, so a failed
    // poll is not fatal - but the first one says so.
    if (!_loggedFailure) {
      _loggedFailure = true
      console.error('[start9-stats] first poll failed:', e?.message ?? String(e))
    }
    return false
  }
}

// Boot cadence: retry fast until the first successful write, then settle into the
// slow refresh. The first tick runs before the seeder API is listening, so a
// single attempt followed by the 60s interval leaves Properties empty for the
// first minute after every boot - which reads as "this page does nothing".
const BOOT_RETRY_MS = Number(process.env.START9_STATS_BOOT_RETRY_MS || 3000)

function startPolling ({ setTimeoutFn = setTimeout, setIntervalFn = setInterval } = {}) {
  const settle = () => setIntervalFn(tick, INTERVAL_MS)
  const attempt = async () => {
    const ok = await tick()
    if (ok) settle()
    else setTimeoutFn(attempt, BOOT_RETRY_MS)
  }
  attempt()
}

// Only poll when run as the entrypoint's background process; requiring this
// file (the render test does) must not start a timer.
if (require.main === module) {
  // Deliberately NOT unref'd anywhere below: this runs as its own process next
  // to the seeder, so an unref'd timer would let it exit after the first tick
  // and freeze Properties on the boot-time snapshot, taken before the API is
  // listening.
  startPolling()
}

module.exports = { render, tick, startPolling, STATS_FILE, BOOT_RETRY_MS }
