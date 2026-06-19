// Resolve the authoritative display name for a circle.
//
// The app shows the Autobase view name (the founder-authored `circle` row,
// which tracks renames because rename is a replicated base.append). But
// `circles:joined.name` is a LOCAL cache written only at create/join time and,
// on a rename, only on the renamer's own device (circle:rename mirrors it
// there). On every other member's device that cache freezes at join-time. Any
// consumer that reads the cache instead of the view — notably the seed invite
// (collectSeedInvites) — then leaks a stale name to enrolled seeders, and two
// circles whose cached names happen to coincide show up duplicated on the
// seeder even though the app shows their distinct live names.
//
// Prefer the live view name when it's present and non-empty; otherwise fall
// back to the cached name (the view may not have replicated yet on a fresh
// join / cold boot, and an empty/absent view name must never blank the cache).
//
// `viewRow` accepts either a Hyperbee node ({ value: { name } }) as returned by
// base.view.get('circle'), or a bare value ({ name }) as carried in a snapshot,
// or null.
function resolveCircleName (cachedName, viewRow) {
  const value = viewRow && typeof viewRow === 'object' && 'value' in viewRow
    ? viewRow.value
    : viewRow
  const liveName = value && typeof value.name === 'string' ? value.name : null
  if (liveName && liveName.length > 0) return liveName
  return typeof cachedName === 'string' ? cachedName : null
}

module.exports = { resolveCircleName }
