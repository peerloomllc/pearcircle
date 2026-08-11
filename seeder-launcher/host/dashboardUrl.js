const os = require('node:os')

// Every address the dashboard is actually reachable at, most useful first.
//
// A wildcard bind (0.0.0.0 / ::) is not a dialable address, so expand it to the
// box's own LAN addresses - on a headless install the startup log line is the
// only place the operator learns the URL, and `http://0.0.0.0:8730` sends them
// nowhere (GitHub issue #194). The token rides along unless auth is off
// (container deploys sitting behind a proxy that gates access itself), because
// a URL missing `?t=` just bounces with a 401.
function dashboardUrls (host, port, token, noAuth, interfaces = os.networkInterfaces()) {
  const query = noAuth ? '' : `?t=${token}`
  const wildcard = host === '0.0.0.0' || host === '::'
  if (!wildcard) return [`http://${host}:${port}/${query}`]
  const lan = []
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs || []) {
      if (a.internal) continue
      // Node switched `family` from the string 'IPv4' to the number 4 in v18;
      // accept both so this does not silently return loopback-only.
      if (a.family === 'IPv4' || a.family === 4) lan.push(a.address)
    }
  }
  return [...lan, '127.0.0.1'].map((a) => `http://${a}:${port}/${query}`)
}

module.exports = { dashboardUrls }
