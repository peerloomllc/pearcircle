// Is the seeder still blind? (2026-07-24)
//
// The blind seeder's whole premise is that it holds and serves bytes it cannot
// read: it opens every core with no encryption key, so a member's position is
// ciphertext to it. Nothing verified that premise, and on 2026-07-24 it turned
// out to be false - a join-time race in the app had two members publishing
// their last-known position blocks in the CLEAR for over a month, and the
// seeder was faithfully mirroring readable coordinates.
//
// The seeder already holds each tip block in hand. One parse attempt says
// whether the promise is holding: ciphertext never parses as JSON, so a
// SUCCESSFUL parse means the block was never encrypted.
//
// This reveals nothing new - a plaintext block is readable by anyone who has
// it, which is precisely the problem being detected. What it buys is the alarm
// that was missing for five weeks.
//
// Warn, never purge. Peers recover these positions by fetching the plaintext
// tip from the seeder (PR #176), so deleting it would break the recovery while
// the leak is being cleaned up. The blocks disappear on their own: the seeder
// clears prior blocks whenever it downloads a new tip, so a member's healed
// (encrypted) write replaces the plaintext copy automatically.

// Returns true when `block` is readable content rather than ciphertext.
// Deliberately narrow: only a parse that yields an object counts, so random
// ciphertext that happens to start with a digit cannot raise a false alarm.
function isReadableBlock (block, toString) {
  if (!block || block.length === 0) return false
  try {
    const parsed = JSON.parse(toString(block))
    return !!parsed && typeof parsed === 'object'
  } catch {
    return false
  }
}

// What the seeder should report about a tip it just downloaded. `alreadyWarned`
// keeps one alarm per core rather than one per append - the condition persists
// until the member updates their app, and repeating it every fix would bury it.
function blindnessVerdict ({ block, alreadyWarned = false, toString } = {}) {
  if (!isReadableBlock(block, toString)) return { readable: false, warn: false }
  return { readable: true, warn: !alreadyWarned }
}

module.exports = { isReadableBlock, blindnessVerdict }
