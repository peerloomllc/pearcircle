const { stalledGets, writerSummary, unfetchableWriters, keyPrefix, MIN_PENDING_MS, REPORT_LIMIT } = require('../src/lib/appendStall')

const NOW = 1_750_000_000_000
const at = (msAgo, over = {}) => ({ core: 'aabbccdd', index: 7, coreLength: 100, ts: NOW - msAgo, ...over })

describe('stalledGets', () => {
  test('reports only reads pending long enough to be suspects', () => {
    const r = stalledGets([at(9000), at(100), at(MIN_PENDING_MS - 1)], NOW)
    expect(r).toHaveLength(1)
    expect(r[0].pendingMs).toBe(9000)
  })

  test('worst offender first', () => {
    const r = stalledGets([at(5000, { index: 1 }), at(9000, { index: 2 }), at(7000, { index: 3 })], NOW)
    expect(r.map((g) => g.index)).toEqual([2, 3, 1])
  })

  test('caps the report so one line stays readable', () => {
    const many = Array.from({ length: 40 }, (_, i) => at(5000 + i))
    expect(stalledGets(many, NOW)).toHaveLength(REPORT_LIMIT)
  })

  test('carries the block identity through, which is the whole point', () => {
    const r = stalledGets([at(9000, { core: 'df7bd8fd', index: 3799, coreLength: 3800 })], NOW)
    expect(r[0]).toEqual({ core: 'df7bd8fd', index: 3799, coreLength: 3800, pendingMs: 9000 })
  })

  test('an empty result is a real answer, not a failure', () => {
    // Nothing pending when the append times out means it is blocked somewhere
    // other than fetching a block. The caller reports stuckGets: 0.
    expect(stalledGets([], NOW)).toEqual([])
    expect(stalledGets([at(10)], NOW)).toEqual([])
  })

  test('survives junk entries', () => {
    expect(stalledGets([null, undefined, {}, at(9000)], NOW)).toHaveLength(1)
  })

  test('accepts an iterator, not just an array', () => {
    const m = new Map([[1, at(9000)], [2, at(50)]])
    expect(stalledGets(m.values(), NOW)).toHaveLength(1)
  })
})

describe('writerSummary', () => {
  const w = (key, length, contig) => ({ core: { key, length, contiguousLength: contig } })

  test('summarises each writer as key/length/contig', () => {
    const r = writerSummary([w('df7bd8fdaabb', 3800, 0), w('550fb8c7ccdd', 1938, 1938)])
    expect(r).toEqual([
      { core: 'df7bd8fd', length: 3800, contig: 0 },
      { core: '550fb8c7', length: 1938, contig: 1938 },
    ])
  })

  test('tolerates a writer with no core yet', () => {
    const r = writerSummary([{ core: null }])
    expect(r).toEqual([{ core: '?', length: null, contig: null }])
  })

  test('caps the list and tolerates a missing writer set', () => {
    expect(writerSummary(Array.from({ length: 30 }, () => w('aa', 1, 1)))).toHaveLength(12)
    expect(writerSummary(null)).toEqual([])
    expect(writerSummary(undefined)).toEqual([])
  })
})

describe('unfetchableWriters', () => {
  test('counts writers whose fetchable prefix falls short, naming the worst', () => {
    // The real Hudgins shape, 2026-07-24.
    const summary = [
      { core: 'df7bd8fd', length: 3800, contig: 0 },
      { core: '6df31e7e', length: 3233, contig: 99 },
      { core: '550fb8c7', length: 1938, contig: 1938 },
      { core: 'ca172cff', length: 568, contig: 0 },
    ]
    const r = unfetchableWriters(summary)
    expect(r.count).toBe(3)
    expect(r.worst).toBe('df7bd8fd:0/3800')
  })

  test('a fully fetchable circle reports no gaps', () => {
    expect(unfetchableWriters([{ core: 'a', length: 10, contig: 10 }])).toEqual({ count: 0, worst: null })
  })

  test('ignores writers with unknown coverage rather than counting them as gaps', () => {
    expect(unfetchableWriters([{ core: '?', length: null, contig: null }]).count).toBe(0)
    expect(unfetchableWriters([]).count).toBe(0)
    expect(unfetchableWriters(null).count).toBe(0)
  })
})

describe('keyPrefix', () => {
  test('shortens hex strings and buffers alike', () => {
    expect(keyPrefix('df7bd8fdaabbccdd')).toBe('df7bd8fd')
    expect(keyPrefix(Buffer.from('df7bd8fdaabbccdd', 'hex'))).toBe('df7bd8fd')
  })

  test('never throws on junk', () => {
    expect(keyPrefix(null)).toBe('?')
    expect(keyPrefix(undefined)).toBe('?')
  })
})
