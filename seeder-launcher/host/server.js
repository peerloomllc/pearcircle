const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const auth = require('./auth')
const { routes, HttpError } = require('./routes')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

// Snapshot cadence: the seed-mode worklet does not emit live events yet
// (slice 3c+ TODO). The server polls status + circles every 5s and fans
// the result out over WS so clients have something current to render.
const SNAPSHOT_INTERVAL_MS = 5000

function createServer ({ worklet, token, uiDir, log }) {
  const routeTable = routes()
  const ctx = { worklet }

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (!auth.verify(req, token)) return sendUnauth(res)
        return sendFile(res, path.join(uiDir, 'index.html'))
      }

      if (req.method === 'GET' && url.pathname.startsWith('/ui/')) {
        if (!auth.verify(req, token)) return sendUnauth(res)
        const rel = url.pathname.replace(/^\/ui\//, '')
        const file = path.join(uiDir, rel)
        if (!file.startsWith(uiDir)) return sendStatus(res, 403, 'forbidden')
        return sendFile(res, file)
      }

      if (url.pathname.startsWith('/api/')) {
        if (!auth.verify(req, token)) return sendUnauth(res)
        const route = routeTable.find((r) => r.method === req.method && r.match(url))
        if (!route) return sendStatus(res, 404, 'not found')
        const result = await route.handler(req, ctx, url)
        return sendJson(res, 200, result)
      }

      sendStatus(res, 404, 'not found')
    } catch (err) {
      log('http', `error: ${err.message}`)
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message })
      else sendJson(res, 500, { error: err.message })
    }
  })

  const wss = new WebSocketServer({ noServer: true })
  srv.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/ws') return sock.destroy()
    if (!auth.verify(req, token)) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return sock.destroy()
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req))
  })

  const broadcast = (msg) => {
    const json = JSON.stringify(msg)
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(json)
    }
  }

  wss.on('connection', async (ws) => {
    log('ws', 'client connected')
    ws.on('close', () => log('ws', 'client disconnected'))
    try {
      const snap = await snapshot(worklet)
      ws.send(JSON.stringify({ type: 'snapshot', ...snap }))
    } catch (e) {
      ws.send(JSON.stringify({ type: 'snapshot:error', error: e.message }))
    }
  })

  worklet.on('event', ({ name, data }) => {
    broadcast({ type: 'event', name, data })
  })
  worklet.on('ready', (result) => {
    broadcast({ type: 'ready', ...result })
  })
  worklet.on('exit', ({ code, signal }) => {
    broadcast({ type: 'exit', code, signal })
  })

  let snapTimer = null
  const startPolling = () => {
    if (snapTimer) return
    snapTimer = setInterval(async () => {
      try {
        const snap = await snapshot(worklet)
        broadcast({ type: 'snapshot', ...snap })
      } catch (e) {
        broadcast({ type: 'snapshot:error', error: e.message })
      }
    }, SNAPSHOT_INTERVAL_MS)
  }
  const stopPolling = () => { if (snapTimer) clearInterval(snapTimer); snapTimer = null }

  return { srv, wss, broadcast, startPolling, stopPolling }
}

async function snapshot (worklet) {
  const [status, circles] = await Promise.all([
    worklet.call('seeder:status').catch((e) => ({ error: e.message })),
    worklet.call('seeder:enrolled:list').catch((e) => ({ error: e.message })),
  ])
  return { status, circles, at: Date.now() }
}

function sendJson (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function sendStatus (res, status, msg) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(msg)
}
function sendUnauth (res) {
  sendStatus(res, 401, 'unauthorized')
}
function sendFile (res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendStatus(res, 404, 'not found')
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}

module.exports = { createServer, snapshot }
