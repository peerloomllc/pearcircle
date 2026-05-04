describe('node env smoke', () => {
  test('Buffer roundtrip works', () => {
    expect(Buffer.from('pearcircle').toString()).toBe('pearcircle')
  })

  test('process is the node process', () => {
    expect(typeof process.versions.node).toBe('string')
  })
})
