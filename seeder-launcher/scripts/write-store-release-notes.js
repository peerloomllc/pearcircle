#!/usr/bin/env node
// Write a release's real notes into the Start9 and Umbrel app manifests.
//
// Both stores publish a release-notes field to the people updating the app, and
// both had been fossilised since their first release: `release.sh` bumps the
// VERSION in each manifest but never touched the notes, so every user updating
// to 1.0.25 was told they were installing "the first release". Start9's
// registry republishes whatever it finds as /package/v0/release-notes/<id>, so
// the stale text was being served, not just stored.
//
// Rewrites in place with a targeted block replacement rather than a YAML
// load/dump: both manifests carry comments that explain non-obvious packaging
// choices, and a round-trip through a YAML emitter would silently drop them.
// The result is then parsed with a real YAML parser and the value compared
// against what we meant to write, so a botched rewrite fails loudly here rather
// than shipping a corrupt manifest to a store.
//
// Usage: write-store-release-notes.js <notes-file>

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const REPO_ROOT = path.resolve(__dirname, '..', '..')

// key: the manifest's own spelling of the field. Start9 uses kebab-case, Umbrel
// camelCase; neither is negotiable, they are read by the respective stores.
const TARGETS = [
  { file: 'seeder-launcher/start9/manifest.yaml', key: 'release-notes' },
  { file: 'seeder-launcher/umbrel/umbrel-app.yml', key: 'releaseNotes' },
]

// The generated notes open with a "## What's Changed" banner that makes sense on
// a GitHub release page and reads as noise on a store card, where the context is
// already "here is what changed". The section headings below it are kept, but
// their `###` markers are dropped: the Umbrel store renders releaseNotes as
// plain text, so the hashes would show up literally. Everything else is verbatim
// - it is the text Tim just reviewed, grouped the way rule 13 asks for.
function storeNotes (raw) {
  const body = raw
    .replace(/^\s*##\s*What's Changed\s*\n+/i, '')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, ''))
    .join('\n')
    .trim()
  if (!body) throw new Error('release notes are empty after stripping the header')
  return body
}

// Replace `key:` and the block that belongs to it - every following line that is
// blank or indented - with a literal block scalar. Literal (`|`), never folded
// (`>`), because folding joins the bullet lines into one paragraph.
function replaceBlock (text, key, value) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(key + ':'))
  if (start === -1) throw new Error(`no \`${key}:\` key found`)
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++
  // A trailing blank line belongs to the document's spacing, not to the value.
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  const block = [key + ': |'].concat(value.split('\n').map((l) => (l ? '  ' + l : '')))
  return lines.slice(0, start).concat(block, lines.slice(end)).join('\n')
}

function main () {
  const notesFile = process.argv[2]
  if (!notesFile) {
    console.error('usage: write-store-release-notes.js <notes-file>')
    process.exit(2)
  }
  const notes = storeNotes(fs.readFileSync(notesFile, 'utf8'))

  let wrote = 0
  for (const { file, key } of TARGETS) {
    const full = path.join(REPO_ROOT, file)
    if (!fs.existsSync(full)) {
      console.error(`write-store-release-notes: ${file} is missing`)
      process.exit(1)
    }
    const before = fs.readFileSync(full, 'utf8')
    let after
    try {
      after = replaceBlock(before, key, notes)
    } catch (e) {
      console.error(`write-store-release-notes: ${file}: ${e.message}`)
      process.exit(1)
    }
    // Parse the REWRITTEN text and check the field reads back exactly. Catches a
    // mis-indented block that would otherwise swallow the keys below it.
    let doc
    try {
      doc = yaml.load(after)
    } catch (e) {
      console.error(`write-store-release-notes: ${file} would not parse after the rewrite: ${e.message}`)
      process.exit(1)
    }
    if (String(doc?.[key] ?? '').trim() !== notes.trim()) {
      console.error(`write-store-release-notes: ${file}: ${key} did not read back as written`)
      process.exit(1)
    }
    if (after !== before) {
      fs.writeFileSync(full, after)
      wrote++
      console.log(`    Updated ${file} (${key})`)
    } else {
      console.log(`    ${file} (${key}) already current`)
    }
  }
  console.log(`    Store release notes: ${wrote} file(s) rewritten`)
}

if (require.main === module) main()

module.exports = { storeNotes, replaceBlock }
