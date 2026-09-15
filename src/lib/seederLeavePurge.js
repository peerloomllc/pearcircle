// Which stored cores a seeder may wipe when it leaves a circle.
//
// Leaving used to stop serving a circle and forget its rows, but every block the
// seeder had mirrored stayed on disk: closing a core never deletes its data, and
// when the circle was not mounted at the time the rows survived as well (found
// 2026-07-27 on the Umbrel after leaving the old Hudgins circle, whose last-known
// cores still held plaintext positions from before #176/#177).
//
// A core is wiped only if no OTHER enrolled circle still references its key, as
// a bootstrap, a member writer core or a member last-known core. Keys are
// normally unique per circle, but a duplicate enrollment of the same circle
// (the franken-enrollment case) would share them, and wiping a core another
// circle still serves is the one mistake this must not make.
//
// Pure, so it is unit-testable: the caller reads the rows and does the clearing.
//   enrolled:  [{ circleId, bootstrap }]
//   writers:   [{ circleId, coreKey }]
//   lastknown: [{ circleId, coreKey }]
function planSeederLeavePurge ({ circleId, enrolled = [], writers = [], lastknown = [] } = {}) {
  const own = new Set()
  const elsewhere = new Set()
  const note = (rowCircleId, key) => {
    if (typeof key !== 'string' || key.length === 0) return
    if (rowCircleId === circleId) own.add(key)
    else elsewhere.add(key)
  }
  for (const r of enrolled) note(r?.circleId, r?.bootstrap)
  for (const r of writers) note(r?.circleId, r?.coreKey)
  for (const r of lastknown) note(r?.circleId, r?.coreKey)
  const clear = []
  const shared = []
  for (const key of own) (elsewhere.has(key) ? shared : clear).push(key)
  return { clear, shared }
}

module.exports = { planSeederLeavePurge }
