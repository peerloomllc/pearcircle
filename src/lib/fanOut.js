// Fan-out layout for overlapping member avatars on the map.
//
// Member avatars are individual screen-anchored markers. When members
// share a location their avatar bubbles land on the same pixel and hide
// each other. computeFanOffsets groups markers that overlap in screen
// space and assigns each a small pixel offset so the group fans into a
// ring, keeping every avatar visible. A marker with no overlapping
// neighbour gets a zero offset, so once the map is zoomed in far enough
// to separate the members the fan collapses on its own.

// Non-selected avatar diameter in px (see renderBubble in App.jsx).
const DEFAULT_BUBBLE_PX = 60
// Ring spacing factor so fanned avatars keep a small gap rather than
// sitting exactly tangent.
const DEFAULT_GAP = 1.18

// points:  array of { id, x, y } - marker ids and screen-space centres.
// opts:    { bubblePx, gap } - optional overrides.
// returns: Map<id, [dx, dy]> - pixel offset to apply to each marker.
function computeFanOffsets (points, opts = {}) {
  const bubblePx = opts.bubblePx || DEFAULT_BUBBLE_PX
  const gap = opts.gap || DEFAULT_GAP
  const n = points.length

  const offsets = new Map()
  for (let i = 0; i < n; i++) offsets.set(points[i].id, [0, 0])
  if (n < 2) return offsets

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

  // Bucket markers by group root.
  const clusters = new Map()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let bucket = clusters.get(r)
    if (!bucket) { bucket = []; clusters.set(r, bucket) }
    bucket.push(points[i])
  }

  // Fan each group of two or more around a ring centred on the pile.
  // Sorting by id keeps a given member in a stable ring slot frame to
  // frame, so the fan does not visibly reshuffle.
  for (const bucket of clusters.values()) {
    const k = bucket.length
    if (k < 2) continue
    bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    // Radius at which k bubbles of bubblePx sit tangent on the ring,
    // widened by the gap factor.
    const radius = (bubblePx / 2) / Math.sin(Math.PI / k) * gap
    for (let idx = 0; idx < k; idx++) {
      const angle = (2 * Math.PI * idx) / k - Math.PI / 2
      offsets.set(bucket[idx].id, [
        radius * Math.cos(angle),
        radius * Math.sin(angle),
      ])
    }
  }
  return offsets
}

module.exports = { computeFanOffsets, DEFAULT_BUBBLE_PX, DEFAULT_GAP }
