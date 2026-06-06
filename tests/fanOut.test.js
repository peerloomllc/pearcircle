const {
  computeFanOffsets,
  computeClusters,
  clusterKey,
  computeRingOffsets,
  DEFAULT_BUBBLE_PX,
  DEFAULT_GAP,
} = require('../src/lib/fanOut')

describe('computeFanOffsets', () => {
  test('empty input returns an empty map', () => {
    expect(computeFanOffsets([]).size).toBe(0)
  })

  test('a single marker gets a zero offset', () => {
    const o = computeFanOffsets([{ id: 'a', x: 100, y: 100 }])
    expect(o.get('a')).toEqual([0, 0])
  })

  test('markers that do not overlap are left untouched', () => {
    const o = computeFanOffsets([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 500, y: 500 },
    ])
    expect(o.get('a')).toEqual([0, 0])
    expect(o.get('b')).toEqual([0, 0])
  })

  test('two coincident markers fan apart symmetrically', () => {
    const o = computeFanOffsets([
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 100, y: 100 },
    ])
    const a = o.get('a')
    const b = o.get('b')
    expect(Math.hypot(a[0], a[1])).toBeGreaterThan(0)
    expect(a[0]).toBeCloseTo(-b[0])
    expect(a[1]).toBeCloseTo(-b[1])
  })

  test('a fanned group ends up non-overlapping', () => {
    // Three coincident markers: after offsets, every pair must sit at
    // least a bubble width apart.
    const pts = [
      { id: 'a', x: 50, y: 50 },
      { id: 'b', x: 50, y: 50 },
      { id: 'c', x: 50, y: 50 },
    ]
    const o = computeFanOffsets(pts)
    const moved = pts.map((p) => {
      const off = o.get(p.id)
      return { x: p.x + off[0], y: p.y + off[1] }
    })
    for (let i = 0; i < moved.length; i++) {
      for (let j = i + 1; j < moved.length; j++) {
        const d = Math.hypot(moved[i].x - moved[j].x, moved[i].y - moved[j].y)
        expect(d).toBeGreaterThanOrEqual(DEFAULT_BUBBLE_PX)
      }
    }
  })

  test('a far-away marker is independent of an overlapping pair', () => {
    const o = computeFanOffsets([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 0 },
      { id: 'far', x: 800, y: 800 },
    ])
    expect(o.get('far')).toEqual([0, 0])
    expect(Math.hypot(...o.get('a'))).toBeGreaterThan(0)
  })

  test('a chain of overlaps clusters transitively', () => {
    // a-b overlap, b-c overlap, a-c do not directly - single linkage
    // still puts all three in one group, so all three are offset.
    const o = computeFanOffsets([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 40, y: 0 },
      { id: 'c', x: 80, y: 0 },
    ])
    for (const id of ['a', 'b', 'c']) {
      expect(Math.hypot(...o.get(id))).toBeGreaterThan(0)
    }
  })

  test('ring slots are stable regardless of input order', () => {
    const a = computeFanOffsets([
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 12, y: 11 },
      { id: 'c', x: 11, y: 9 },
    ])
    const b = computeFanOffsets([
      { id: 'c', x: 11, y: 9 },
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 12, y: 11 },
    ])
    for (const id of ['a', 'b', 'c']) {
      expect(a.get(id)[0]).toBeCloseTo(b.get(id)[0])
      expect(a.get(id)[1]).toBeCloseTo(b.get(id)[1])
    }
  })

  test('gap factor widens the ring', () => {
    const tight = computeFanOffsets(
      [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }], { gap: 1 })
    const wide = computeFanOffsets(
      [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }], { gap: 1.5 })
    expect(Math.hypot(...wide.get('a'))).toBeGreaterThan(Math.hypot(...tight.get('a')))
  })

  test('DEFAULT_BUBBLE_PX and DEFAULT_GAP are exported', () => {
    expect(DEFAULT_BUBBLE_PX).toBe(60)
    expect(typeof DEFAULT_GAP).toBe('number')
  })
})

describe('computeClusters', () => {
  test('empty input returns no buckets', () => {
    expect(computeClusters([])).toEqual([])
  })

  test('non-overlapping markers each form a singleton bucket', () => {
    const buckets = computeClusters([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 500, y: 500 },
    ])
    expect(buckets).toHaveLength(2)
    expect(buckets.every((b) => b.length === 1)).toBe(true)
  })

  test('overlapping markers land in one bucket, sorted by id', () => {
    const buckets = computeClusters([
      { id: 'c', x: 1, y: 1 },
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 2, y: 2 },
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toEqual(['a', 'b', 'c'])
  })

  test('overlap is transitive via single linkage', () => {
    const buckets = computeClusters([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 40, y: 0 },
      { id: 'c', x: 80, y: 0 },
      { id: 'far', x: 800, y: 800 },
    ])
    const big = buckets.find((b) => b.length > 1)
    expect(big).toEqual(['a', 'b', 'c'])
    expect(buckets.some((b) => b.length === 1 && b[0] === 'far')).toBe(true)
  })
})

describe('clusterKey', () => {
  test('is stable regardless of id order', () => {
    expect(clusterKey(['b', 'a', 'c'])).toBe(clusterKey(['c', 'b', 'a']))
    expect(clusterKey(['a', 'b'])).toBe('a,b')
  })
})

describe('computeRingOffsets', () => {
  test('a single id gets a zero offset', () => {
    expect(computeRingOffsets(['a']).get('a')).toEqual([0, 0])
  })

  test('two ids fan apart symmetrically', () => {
    const o = computeRingOffsets(['a', 'b'])
    const a = o.get('a')
    const b = o.get('b')
    expect(Math.hypot(...a)).toBeGreaterThan(0)
    expect(a[0]).toBeCloseTo(-b[0])
    expect(a[1]).toBeCloseTo(-b[1])
  })

  test('slots are stable regardless of input order', () => {
    const a = computeRingOffsets(['c', 'a', 'b'])
    const b = computeRingOffsets(['b', 'c', 'a'])
    for (const id of ['a', 'b', 'c']) {
      expect(a.get(id)[0]).toBeCloseTo(b.get(id)[0])
      expect(a.get(id)[1]).toBeCloseTo(b.get(id)[1])
    }
  })

  test('two members form a horizontal line, not a vertical one', () => {
    const o = computeRingOffsets(['a', 'b'])
    const a = o.get('a')
    const b = o.get('b')
    // Same y (horizontal), opposite x.
    expect(a[1]).toBeCloseTo(0)
    expect(b[1]).toBeCloseTo(0)
    expect(a[0]).toBeCloseTo(-b[0])
    expect(Math.abs(a[0])).toBeGreaterThan(0)
  })

  test('three members make a triangle with one apex at the top', () => {
    const o = computeRingOffsets(['a', 'b', 'c'])
    const ys = ['a', 'b', 'c'].map((id) => o.get(id)[1])
    // One member sits above the centre (most-negative y), two below it.
    const top = Math.min(...ys)
    expect(ys.filter((y) => y < top + 1)).toHaveLength(1)
    expect(ys.filter((y) => y > 0)).toHaveLength(2)
  })

  test('four members make a cross (up/right/down/left)', () => {
    const o = computeRingOffsets(['a', 'b', 'c', 'd'])
    const vecs = ['a', 'b', 'c', 'd'].map((id) => o.get(id))
    // Each member lies on an axis: one of its components is ~0.
    for (const [x, y] of vecs) {
      expect(Math.min(Math.abs(x), Math.abs(y))).toBeCloseTo(0)
    }
  })

  test('minRadius floors the spread for small clusters', () => {
    const o = computeRingOffsets(['a', 'b'], { minRadius: 200 })
    expect(Math.hypot(...o.get('a'))).toBeCloseTo(200)
  })
})
