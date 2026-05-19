// HTTP route map. Each entry is { method, match(url), handler(req, ctx, body) }.
// Handlers translate REST shape into worklet IPC calls and return JSON.

function jsonBody (req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) }
      catch (e) { reject(new Error('invalid json body')) }
    })
    req.on('error', reject)
  })
}

function routes () {
  return [
    {
      method: 'GET',
      match: (url) => url.pathname === '/api/status',
      handler: async (req, ctx) => ctx.worklet.call('seeder:status'),
    },
    {
      method: 'GET',
      match: (url) => url.pathname === '/api/circles',
      handler: async (req, ctx) => ctx.worklet.call('seeder:enrolled:list'),
    },
    {
      method: 'POST',
      match: (url) => url.pathname === '/api/enroll',
      handler: async (req, ctx) => {
        const body = await jsonBody(req)
        if (!body.invite) throw new HttpError(400, 'invite required')
        return ctx.worklet.call('seeder:enroll', { invite: body.invite })
      },
    },
    {
      method: 'POST',
      match: (url) => url.pathname === '/api/leave',
      handler: async (req, ctx) => {
        const body = await jsonBody(req)
        if (!body.circleId) throw new HttpError(400, 'circleId required')
        return ctx.worklet.call('seeder:leave', { circleId: body.circleId })
      },
    },
    {
      method: 'GET',
      match: (url) => /^\/api\/retention\/[^/]+$/.test(url.pathname),
      handler: async (req, ctx, url) => {
        const circleId = decodeURIComponent(url.pathname.split('/').pop())
        return ctx.worklet.call('seeder:retention:get', { circleId })
      },
    },
    {
      method: 'PUT',
      match: (url) => /^\/api\/retention\/[^/]+$/.test(url.pathname),
      handler: async (req, ctx, url) => {
        const circleId = decodeURIComponent(url.pathname.split('/').pop())
        const body = await jsonBody(req)
        const pruneOlderThan = body.pruneOlderThan ?? null
        return ctx.worklet.call('seeder:retention:set', { circleId, pruneOlderThan })
      },
    },
  ]
}

class HttpError extends Error {
  constructor (status, message) { super(message); this.status = status }
}

module.exports = { routes, jsonBody, HttpError }
