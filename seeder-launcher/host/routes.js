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
      // Launcher build version + the worklet's echoed version (proposal
      // 2026-06-05-seeder-update slice 1). The update-check + apply hang off this.
      method: 'GET',
      match: (url) => url.pathname === '/api/version',
      handler: async (req, ctx) => {
        const status = await ctx.worklet.call('seeder:status').catch(() => ({}))
        return { version: ctx.version ?? null, workletVersion: status?.version ?? null }
      },
    },
    {
      // Cached GitHub-Releases update check (proposal 2026-06-05-seeder-update
      // slice 2). Returns { updateAvailable, latestVersion, releaseUrl,
      // assetUrl, sha256Url, checkedAt, error }. Notify-only at this slice.
      method: 'GET',
      match: (url) => url.pathname === '/api/update',
      handler: async (req, ctx) => ctx.updateChecker ? ctx.updateChecker.get() : { error: 'update check disabled' },
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
        // The mobile UI mints a bundle: one /circle/seed URL per line,
        // covering every encrypted circle at once. Split + enroll each;
        // the worklet's seeder:enroll stays single-invite. A plain
        // single-invite paste is just a one-line bundle.
        const lines = String(body.invite)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
        if (lines.length === 0) throw new HttpError(400, 'invite required')
        const results = []
        for (const invite of lines) {
          try {
            const r = await ctx.worklet.call('seeder:enroll', { invite })
            results.push({ ok: true, circleId: r?.circleId, name: r?.name, alreadyEnrolled: !!r?.alreadyEnrolled })
          } catch (e) {
            results.push({ ok: false, error: e?.message ?? String(e) })
          }
        }
        return {
          results,
          enrolled: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
        }
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
