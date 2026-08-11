const { dashboardUrls } = require('../seeder-launcher/host/dashboardUrl')

// GitHub issue #194: a headless seeder bound to the LAN logged a tokenless
// `http://0.0.0.0:8730/`, which is neither dialable nor authorized, leaving the
// operator locked out of their own dashboard. These cover the URL the startup
// log hands them in each bind mode.

const IFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [
    { address: '192.168.1.50', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
}

const TOKEN = 'a'.repeat(64)

test('loopback bind yields one tokenized URL', () => {
  expect(dashboardUrls('127.0.0.1', 8730, TOKEN, false, IFACES))
    .toEqual([`http://127.0.0.1:8730/?t=${TOKEN}`])
})

test('wildcard bind expands to LAN addresses first, loopback last', () => {
  expect(dashboardUrls('0.0.0.0', 8730, TOKEN, false, IFACES)).toEqual([
    `http://192.168.1.50:8730/?t=${TOKEN}`,
    `http://127.0.0.1:8730/?t=${TOKEN}`,
  ])
})

test('wildcard bind never advertises 0.0.0.0 itself', () => {
  for (const url of dashboardUrls('0.0.0.0', 8730, TOKEN, false, IFACES)) {
    expect(url).not.toContain('0.0.0.0')
  }
})

test('IPv6 wildcard is expanded the same way', () => {
  expect(dashboardUrls('::', 8730, TOKEN, false, IFACES)).toEqual([
    `http://192.168.1.50:8730/?t=${TOKEN}`,
    `http://127.0.0.1:8730/?t=${TOKEN}`,
  ])
})

test('numeric family (Node >= 18) is recognized as IPv4', () => {
  const numeric = { eth0: [{ address: '10.0.0.7', family: 4, internal: false }] }
  expect(dashboardUrls('0.0.0.0', 8730, TOKEN, false, numeric))
    .toEqual([`http://10.0.0.7:8730/?t=${TOKEN}`, `http://127.0.0.1:8730/?t=${TOKEN}`])
})

test('link-local IPv6 is not advertised', () => {
  expect(dashboardUrls('0.0.0.0', 8730, TOKEN, false, IFACES).join(' '))
    .not.toContain('fe80')
})

test('noAuth (container behind a proxy) drops the token from the URL', () => {
  expect(dashboardUrls('0.0.0.0', 8730, TOKEN, true, IFACES)).toEqual([
    'http://192.168.1.50:8730/',
    'http://127.0.0.1:8730/',
  ])
})

test('an explicit non-wildcard host is used verbatim', () => {
  expect(dashboardUrls('192.168.1.50', 8730, TOKEN, false, IFACES))
    .toEqual([`http://192.168.1.50:8730/?t=${TOKEN}`])
})

test('a box with no non-internal interface still yields loopback', () => {
  expect(dashboardUrls('0.0.0.0', 8730, TOKEN, false, { lo: IFACES.lo }))
    .toEqual([`http://127.0.0.1:8730/?t=${TOKEN}`])
})
