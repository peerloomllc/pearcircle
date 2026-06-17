#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveDataDir, ensureDir } = require('./dataDir')
const { loadOrCreateToken } = require('./auth')
const { Worklet } = require('./worklet')
const { createServer } = require('./server')
const { SEEDER_VERSION } = require('./version')
const { UpdateChecker } = require('./updateCheck')
const { UpdateApplier } = require('./updateApply')

function parseArgs (argv) {
  // Defaults bind to loopback with token auth — the desktop install model
  // (any local process is the only reachable client). A containerized deploy
  // (Umbrel) overrides both: it binds 0.0.0.0 so the app_proxy on the Docker
  // network can reach it, and disables the in-app token because the proxy
  // already gates access behind the Umbrel login. Env vars let the container
  // set these without editing the CMD; explicit flags still win.
  const out = {
    dev: false,
    port: process.env.SEEDER_PORT ? Number(process.env.SEEDER_PORT) : 8730,
    host: process.env.SEEDER_HOST || '127.0.0.1',
    noAuth: process.env.SEEDER_NO_AUTH === '1' || process.env.SEEDER_NO_AUTH === 'true',
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dev') out.dev = true
    else if (a === '--bare') out.barePath = argv[++i]
    else if (a === '--bundle') out.bundleEntry = argv[++i]
    else if (a === '--ui') out.uiDir = argv[++i]
    else if (a === '--data-dir') out.dataDirOverride = argv[++i]
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--no-auth') out.noAuth = true
    else if (a === '--no-open') out.noOpen = true
    else if (a === '--help' || a === '-h') {
      printHelp(); process.exit(0)
    }
  }
  return out
}

function printHelp () {
  process.stdout.write([
    'pearcircle-seeder-launcher',
    '',
    'Usage: node host/index.js [options]',
    '',
    'Options:',
    '  --dev               Use repo-root src/bare.js + node_modules/bare instead',
    '                      of the installed-package layout',
    '  --bare <cmd>        Override the bare CLI invocation',
    '  --bundle <path>     Override the worklet entry file',
    '  --ui <dir>          Override the static UI directory',
    '  --data-dir <path>   Override the OS-default data directory',
    '  --port <n>          Bind port (default 8730, env SEEDER_PORT)',
    '  --host <addr>       Bind address (default 127.0.0.1, env SEEDER_HOST;',
    '                      use 0.0.0.0 behind a reverse proxy / in a container)',
    '  --no-auth           Skip the bearer-token check (env SEEDER_NO_AUTH=1);',
    '                      only for when a front proxy already gates access',
    '  --no-open           Suppress launching the default browser',
    '',
  ].join('\n'))
}

// Resolve the platform-native bare-runtime binary. The `node bin/bare` JS
// wrapper installs a no-op SIGTERM handler, so killing the wrapper leaves
// the native bare child running and holding the corestore lock. Skip the
// wrapper and invoke the native binary directly.
function nativeBareBinary (repoRoot) {
  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'win32' ? 'win32' : 'linux'
  const arch = process.arch === 'x64' ? 'x64'
    : process.arch === 'arm64' ? 'arm64' : process.arch
  const ext = platform === 'win32' ? '.exe' : ''
  return path.join(repoRoot, 'node_modules', `bare-runtime-${platform}-${arch}`, 'bin', `bare${ext}`)
}

function resolvePaths (opts) {
  if (opts.dev) {
    const repoRoot = path.resolve(__dirname, '..', '..')
    return {
      barePath: opts.barePath || nativeBareBinary(repoRoot),
      bundleEntry: opts.bundleEntry || path.join(repoRoot, 'src', 'bare.js'),
      uiDir: opts.uiDir || path.join(__dirname, '..', 'ui'),
    }
  }
  // The installer lays everything out flat under the install root
  // (/usr/local/lib/pearcircle-seeder on macOS, the Program Files dir on
  // Windows). host-bundled.js lives at that root, so __dirname IS the
  // install root in production. The bare runtime is `bare` on POSIX and
  // `bare.exe` on Windows - spawn() needs the exact name.
  const installRoot = __dirname
  const bareName = process.platform === 'win32' ? 'bare.exe' : 'bare'
  return {
    barePath: opts.barePath || path.join(installRoot, bareName),
    bundleEntry: opts.bundleEntry || path.join(installRoot, 'worklet', 'worklet.bundle'),
    uiDir: opts.uiDir || path.join(installRoot, 'ui'),
  }
}

function tryOpenBrowser (url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref() } catch {}
}

function rotatingLogger (logPath, maxBytes = 5 * 1024 * 1024) {
  return (channel, line) => {
    const stamp = new Date().toISOString()
    const text = `${stamp} [${channel}] ${String(line).trimEnd()}\n`
    try {
      const st = fs.statSync(logPath)
      if (st.size > maxBytes) fs.renameSync(logPath, logPath + '.old')
    } catch {}
    fs.appendFileSync(logPath, text)
    if (process.stdout.isTTY) process.stdout.write(text)
  }
}

async function main () {
  const opts = parseArgs(process.argv)
  const dataDir = ensureDir(resolveDataDir(opts.dataDirOverride))
  const paths = resolvePaths(opts)
  const { token, fresh: freshToken } = loadOrCreateToken(dataDir)
  const logPath = path.join(dataDir, 'seeder.log')
  const log = rotatingLogger(logPath)

  log('host', `launcher starting v${SEEDER_VERSION} (dev=${opts.dev}, dataDir=${dataDir})`)
  log('host', `bare=${paths.barePath} bundle=${paths.bundleEntry}`)
  if (freshToken) log('host', `generated fresh auth token at ${path.join(dataDir, 'auth.token')}`)

  const worklet = new Worklet({
    barePath: paths.barePath,
    bundleEntry: paths.bundleEntry,
    dataDir,
    version: SEEDER_VERSION,
    onLog: log,
  })
  worklet.on('exit', ({ code, signal }) => log('worklet', `exited code=${code} signal=${signal}`))

  await worklet.start()
  log('host', 'worklet ready')

  // Background GitHub-Releases update check (proposal 2026-06-05-seeder-update
  // slice 2). Fail-open; surfaced via /api/update + the WS snapshot.
  const updateChecker = new UpdateChecker({ currentVersion: SEEDER_VERSION, log }).start()

  // One-click apply (slice 3a). Self-apply on Linux AppImage when launched as
  // one (process.env.APPIMAGE is the running image path to swap) + Windows;
  // macOS .pkg / Linux .deb land on `needs-helper` (download fallback) until the
  // privileged helper ships (slice 3b). The actual child commands are spawned by
  // `exec`; a failure leaves the running service untouched.
  const { spawn: spawnChild } = require('node:child_process')
  const exec = (argv) => new Promise((resolve, reject) => {
    const p = spawnChild(argv[0], argv.slice(1), { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}`)))
  })
  // macOS privileged-helper drop dir (slice 3b): the host (unprivileged
  // LaunchAgent) drops a verified-pkg request here and the root
  // com.pearcircle.seeder.updater LaunchDaemon installs it. Absent when the
  // helper isn't installed (old build) -> apply falls back to a download.
  const macRequestDir = process.platform === 'darwin'
    ? '/Library/Application Support/PearCircle Seeder/updates/requests'
    : null
  // Linux .deb privileged updater (slice 3c): the .deb postinst drops this
  // root-owned helper and a passwordless polkit rule for the seeder user. Absent
  // on an AppImage install or an old .deb -> apply falls back to a download.
  const debHelperPath = process.platform === 'linux'
    ? '/opt/pearcircle-seeder/updater-helper.sh'
    : null
  const updateApplier = new UpdateApplier({
    getUpdate: () => updateChecker.get(),
    target: process.env.APPIMAGE || null,
    requestDir: macRequestDir,
    helperPath: debHelperPath,
    user: process.platform === 'linux' ? os.userInfo().username : null,
    exec,
    log,
  })

  if (opts.noAuth) log('host', 'auth: bearer-token check DISABLED (--no-auth); relying on a front proxy')
  const { srv, startPolling } = createServer({ worklet, token, requireAuth: !opts.noAuth, uiDir: paths.uiDir, log, version: SEEDER_VERSION, updateChecker, updateApplier })
  srv.on('error', (err) => {
    log('host', `server error: ${err.message}`)
    if (err.code === 'EADDRINUSE') process.exit(2)
  })

  await new Promise((resolve, reject) => {
    srv.listen(opts.port, opts.host, () => resolve())
    srv.once('error', reject)
  })
  startPolling()

  // Loopback URL carries the token for the auto-opened browser; a non-loopback
  // bind (container) is reached through the proxy, so just log host:port.
  const onLoopback = opts.host === '127.0.0.1' || opts.host === 'localhost'
  const url = onLoopback ? `http://127.0.0.1:${opts.port}/?t=${token}` : `http://${opts.host}:${opts.port}/`
  log('host', `UI at ${url}`)
  if (!opts.noOpen && onLoopback && process.stdout.isTTY) tryOpenBrowser(url)

  const shutdown = async (sig) => {
    log('host', `received ${sig}, shutting down`)
    try { srv.close() } catch {}
    try { await worklet.stop() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('fatal:', err.stack || err.message)
  process.exit(1)
})
