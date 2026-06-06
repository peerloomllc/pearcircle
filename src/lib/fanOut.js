// Layout for overlapping member avatars on the map.
//
// Member avatars are individual screen-anchored markers. When members
// share a location their avatar bubbles land on the same pixel and hide
// each other. We group markers that overlap in screen space (a cluster)
// and lay each cluster out in one of two ways:
//
//   - collapsed: a tight cascade (computeStackOffsets) so a cluster takes
//     up little room, especially when zoomed out. One member is the
//     "front" of the stack; the UI cycles which one over time.
//   - expanded: an even, equidistant ring (computeRingOffsets) so every
//     avatar is tappable. The UI expands a cluster when the user taps it.
//
// A marker with no overlapping neighbour is its own size-1 cluster and
// gets a zero offset, so once the map is zoomed in far enough to separate
// members the cluster dissolves on its own.

// Non-selected avatar diameter in px (see renderBubble in App.jsx).
const DEFAULT_BUBBLE_PX = 60
// Ring spacing factor so fanned avatars keep a small gap rather than
// sitting exactly tangent.
const DEFAULT_GAP = 1.18
// Cluster a set of screen points by overlap.
// points:  array of { id, x, y } - marker ids and screen-space centres.
// opts:    { bubblePx } - optional override.
// returns: Array<Array<id>> - one bucket per cluster, ids sorted so a
//          given member keeps a stable slot frame to frame. Singletons
//          are returned as 1-element buckets.
function computeClusters (points, opts = {}) {
  const bubblePx = opts.bubblePx || DEFAULT_BUBBLE_PX
  const n = points.length
  if (n === 0) return []

  // Union-find: markers whose bubble centres are within one bubble width
  // overlap and belong to the same group.
  const parent = []
  for (let i = 0; i < n; i++) parent.push(i)
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const overlapSq = bubblePx * bubblePx
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i].x - points[j].x
      const dy = points[i].y - points[j].y
      if (dx * dx + dy * dy < overlapSq) {
        const ri = find(i)
        const rj = find(j)
        if (ri !== rj) parent[ri] = rj
      }
    }
  }

  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let bucket = buckets.get(r)
    if (!bucket) { bucket = []; buckets.set(r, bucket) }
    bucket.push(points[i].id)
  }
  const out = []
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    out.push(bucket)
  }
  return out
}

// Stable key for a cluster. ids are expected sorted (as computeClusters
// returns them) so the key is order-independent for the same membership.
function clusterKey (ids) {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')
}

// Even, equidistant offsets for a cluster of k >= 2 members, laid out as
// a regular polygon keyed to the count: 2 -> a horizontal line, 3 -> a
// triangle (apex up, two below), 4 -> a cross (up/right/down/left), 5 ->
// a pentagon, and a regular k-gon beyond that. ids are sorted by caller
// for a stable slot per member.
// opts.gap widens the ring; opts.minRadius is a floor so small clusters
// still spread far enough to read the connector spokes.
// returns: Map<id, [dx, dy]>.
function computeRingOffsets (ids, opts = {}) {
  const bubblePx = opts.bubblePx || DEFAULT_BUBBLE_PX
  const gap = opts.gap || DEFAULT_GAP
  const minRadius = opts.minRadius || 0
  const k = ids.length
  const offsets = new Map()
  if (k < 2) {
    for (const id of ids) offsets.set(id, [0, 0])
    return offsets
  }
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  // Radius at which k bubbles of bubblePx sit tangent on the ring,
  // widened by the gap factor, then floored by minRadius.
  const radius = Math.max((bubblePx / 2) / Math.sin(Math.PI / k) * gap, minRadius)
  for (let idx = 0; idx < k; idx++) {
    // Two members read best as a left/right pair rather than the
    // top/bottom the generic polygon would give; every larger count
    // starts its first vertex at the top (-90 degrees).
    const angle = k === 2
      ? Math.PI * idx
      : (2 * Math.PI * idx) / k - Math.PI / 2
    offsets.set(sorted[idx], [
      radius * Math.cos(angle),
      radius * Math.sin(angle),
    ])
  }
  return offsets
}

// Backward-compatible all-in-one: cluster the points and ring every
// cluster of two or more. Retained for callers/tests that want the
// flat "fan everything that overlaps" behaviour.
// returns: Map<id, [dx, dy]>.
function computeFanOffsets (points, opts = {}) {
  const offsets = new Map()
  for (const p of points) offsets.set(p.id, [0, 0])
  for (const ids of computeClusters(points, opts)) {
    if (ids.length < 2) continue
    const ring = computeRingOffsets(ids, opts)
    for (const [id, off] of ring) offsets.set(id, off)
  }
  return offsets
}

module.exports = {
  computeClusters,
  clusterKey,
  computeRingOffsets,
  computeFanOffsets,
  DEFAULT_BUBBLE_PX,
  DEFAULT_GAP,
}
