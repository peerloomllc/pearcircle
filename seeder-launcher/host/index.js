#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveDataDir, ensureDir } = require('./dataDir')
const { loadOrCreateToken } = require('./auth')
const { Worklet } = require('./worklet')
const { createServer } = require('./server')

function parseArgs (argv) {
  const out = { dev: false, port: 8730 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dev') out.dev = true
    else if (a === '--bare') out.barePath = argv[++i]
    else if (a === '--bundle') out.bundleEntry = argv[++i]
    else if (a === '--ui') out.uiDir = argv[++i]
    else if (a === '--data-dir') out.dataDirOverride = argv[++i]
    else if (a === '--port') out.port = Number(argv[++i])
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
    '  --port <n>          Bind port (default 8730)',
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
    bundleEntry: opts.bundleEntry || path.join(installRoot, 'worklet', 'bare.js'),
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

  log('host', `launcher starting (dev=${opts.dev}, dataDir=${dataDir})`)
  log('host', `bare=${paths.barePath} bundle=${paths.bundleEntry}`)
  if (freshToken) log('host', `generated fresh auth token at ${path.join(dataDir, 'auth.token')}`)

  const worklet = new Worklet({
    barePath: paths.barePath,
    bundleEntry: paths.bundleEntry,
    dataDir,
    onLog: log,
  })
  worklet.on('exit', ({ code, signal }) => log('worklet', `exited code=${code} signal=${signal}`))

  await worklet.start()
  log('host', 'worklet ready')

  const { srv, startPolling } = createServer({ worklet, token, uiDir: paths.uiDir, log })
  srv.on('error', (err) => {
    log('host', `server error: ${err.message}`)
    if (err.code === 'EADDRINUSE') process.exit(2)
  })

  await new Promise((resolve, reject) => {
    srv.listen(opts.port, '127.0.0.1', () => resolve())
    srv.once('error', reject)
  })
  startPolling()

  const url = `http://127.0.0.1:${opts.port}/?t=${token}`
  log('host', `UI at ${url}`)
  if (!opts.noOpen && process.stdout.isTTY) tryOpenBrowser(url)

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
