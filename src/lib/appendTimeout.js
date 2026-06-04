// Append timeout helper (proposal 2026-06-03-autobase-append-hang).
//
// On-device, a corrupt local Autobase writer core left `base.append()`
// hanging forever in the advance/apply loop. Because the worklet's IPC
// dispatcher awaits each handler serially, that single stuck append froze
// the entire backend: the device's own location never updated and every
// later IPC (trips, circle snapshot) queued behind it and never returned.
//
// raceAppend bounds an append against a timeout so a wedged base can never
// hang the dispatcher. The caller (safeAppend in bare.js) flags the circle
// for repair on a timeout and skips further appends to it.

const APPEND_TIMEOUT_MS = 10000
const TIMEOUT = Symbol('append-timeout')

// Race `appendPromise` against `timeoutMs`. Returns:
//   { ok: true,  timedOut: false } — the append settled first
//   { ok: false, timedOut: true  } — the timeout won (base is wedged)
//   { ok: false, timedOut: false } — the append rejected (e.g. base closed)
// The append promise is never awaited past the timeout, so a never-resolving
// append cannot block the caller. setTimeoutFn / clearTimeoutFn are injectable
// for tests.
async function raceAppend (appendPromise, timeoutMs = APPEND_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve(TIMEOUT), timeoutMs)
  })
  try {
    const r = await Promise.race([
      appendPromise.then(() => 'ok', () => 'rejected'),
      timeout,
    ])
    if (r === TIMEOUT) return { ok: false, timedOut: true }
    return { ok: r === 'ok', timedOut: false }
  } finally {
    if (timer) clearTimeoutFn(timer)
  }
}

module.exports = { raceAppend, APPEND_TIMEOUT_MS }
