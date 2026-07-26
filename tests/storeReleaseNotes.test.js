// Store release-notes rewriter - seeder-launcher/scripts/write-store-release-notes.js.
//
// Both app-store manifests shipped "first release" text for six releases while
// their version field was bumped every time, so the failure mode to guard is a
// rewrite that looks fine and quietly corrupts or drops something: the keys
// below the block, the comments that explain the packaging, or the notes
// themselves.

const yaml = require('js-yaml')
const { storeNotes, replaceBlock } = require('../seeder-launcher/scripts/write-store-release-notes')

const NOTES = `## What's Changed

### Improvements

- Pairing shows what it is doing
- The dashboard confirms success

### Bug Fixes

- Properties renders again
`

const START9 = `id: pearcircle-seeder
# StartOS packaging revision. Kept in lockstep with the seeder image tag.
version: 1.0.25
release-notes: |
  First StartOS release of the PearCircle blind-seeder. Runs the seed-mode
  worklet as an always-on service.
license: MIT
`

const UMBREL = `version: "1.0.25"
gallery: []
releaseNotes: >-
  First release of the PearCircle seeder for Umbrel. Runs the blind-seeder
  worklet as an always-on service.
path: ""
`

describe('storeNotes', () => {
  test('drops the GitHub banner and the markdown heading markers', () => {
    const out = storeNotes(NOTES)
    expect(out).not.toMatch(/What's Changed/)
    expect(out).not.toMatch(/^#/m)          // Umbrel renders this as plain text
    expect(out).toMatch(/^Improvements$/m)  // the heading itself survives
    expect(out).toMatch(/- Pairing shows what it is doing/)
  })

  test('refuses empty notes rather than writing a blank field', () => {
    expect(() => storeNotes("## What's Changed\n\n")).toThrow(/empty/)
  })
})

describe('replaceBlock', () => {
  test('replaces a literal block and leaves the rest of the document intact', () => {
    const out = replaceBlock(START9, 'release-notes', storeNotes(NOTES))
    const doc = yaml.load(out)
    expect(doc['release-notes']).toMatch(/- Properties renders again/)
    expect(doc['release-notes']).not.toMatch(/First StartOS release/)
    expect(doc.version).toBe('1.0.25') // the key above the block is untouched
    expect(doc.id).toBe('pearcircle-seeder')
    expect(doc.license).toBe('MIT')
    expect(out).toMatch(/# StartOS packaging revision/) // comments survive
  })

  test('replaces a folded block too, since the two manifests differ', () => {
    const out = replaceBlock(UMBREL, 'releaseNotes', storeNotes(NOTES))
    const doc = yaml.load(out)
    expect(doc.releaseNotes).toMatch(/- The dashboard confirms success/)
    expect(doc.releaseNotes).not.toMatch(/First release of the PearCircle seeder/)
    expect(doc.path).toBe('')
    expect(doc.gallery).toEqual([])
  })

  test('a multi-line value stays one value and does not swallow the next key', () => {
    const doc = yaml.load(replaceBlock(START9, 'release-notes', storeNotes(NOTES)))
    expect(Object.keys(doc)).toEqual(['id', 'version', 'release-notes', 'license'])
  })

  test('fails loudly when the key is missing rather than appending a stray one', () => {
    expect(() => replaceBlock('id: x\n', 'release-notes', 'hi')).toThrow(/release-notes/)
  })
})
