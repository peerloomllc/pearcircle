const { computeFanOffsets, DEFAULT_BUBBLE_PX, DEFAULT_GAP } = require('../src/lib/fanOut')

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
