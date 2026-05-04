describe('jsdom env smoke', () => {
  test('document is available', () => {
    expect(document).toBeDefined()
    expect(document.body).toBeDefined()
  })

  test('jest.setup.js created the #root element', () => {
    expect(document.getElementById('root')).not.toBeNull()
  })

  test('jest.setup.js stubbed window.ReactNativeWebView', () => {
    expect(window.ReactNativeWebView.postMessage).toBeDefined()
    expect(typeof window.ReactNativeWebView.postMessage).toBe('function')
  })
})
