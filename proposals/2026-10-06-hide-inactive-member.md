# Hide an inactive member for the whole circle

**Status**: Approved 2026-10-06 by Tim, with the open questions resolved as proposed: 30 days, no unhiding of others, no notification.

**Goal**: Let any member hide a member who has not been seen for 30 days, for everyone in the circle, so the old entry left behind by someone who lost their app data stops showing. A member who is still around comes back by themselves.

**Tier**: T2. Adds one new replicated Hyperbee key (`hidden:{pubkey}`), one new IPC method and one new apply rule. No change to invites, pairing, encryption, writer admission or the owner-only `removed:` kick.

## Background

A user lost all app data twice on a stock Pixel 10 Pro XL, most likely through Zapstore's force update, which uninstalls and reinstalls (zapstore/zapstore#347). Rejoining with a fresh invite gives a new identity, so each circle now lists him twice: the new entry and a dead one.

Today only the owner can get rid of the dead one, through `removed:{pubkey}`. That doesn't work here:

- `shouldAcceptRemovedRow` (`src/lib/circleFilter.js`) accepts a removal only when it was written by the circle's bootstrap writer core, meaning the phone that created the circle. If the person who lost their data was the owner, nobody can remove anyone again. Restoring the person's identity would not help either, since the rule checks the writer core and not the identity.
- A removal also makes the removed person's phone drop the circle (`circle:removed-self`). Letting any member remove anyone would let one member kick all the others, so the owner-only rule has to stay.

What we need is weaker than a kick: hide the entry from the member list for everyone, and change nothing else.

## Design

### The record

```
hidden:{pubkey} = {
  pubkey,      // the member being hidden
  hiddenBy,    // identity pubkey of the member who hid them
  ts,          // when
  v: 1,
  sig          // signature by hiddenBy
}
```

Apply rule, next to `left:` and `removed:` in `applyCircleNodes`:

- Verify the signature against `hiddenBy` (`verifyValueWithSigner(incoming, 'hiddenBy')`).
- Require `op.key === 'hidden:' + incoming.pubkey` and `incoming.pubkey !== incoming.hiddenBy`.
- Reject `ts` more than `FUTURE_TS_TOLERANCE_MS` (5 min) in the future.
- Last write wins on `ts`, the same as `removed:`.
- No event and no notification. Hiding is silent.

Any writer can write it, the same as `member:` rows. There is no time check in apply, because apply can't reliably tell when a member was last seen. The 30-day rule is enforced in the app (below), and a real member who is wrongly hidden fixes it themselves (next section).

### Who disappears

A new filter `memberHiddenByHide(hiddenTs, joinedAt)` in `circleFilter.js`, with the same shape as `memberHiddenByRemoved`: hide while `hidden.ts > member.joinedAt`. `snapshotCircle` applies it alongside the `left:` and `removed:` checks, so a hidden member drops out of the member list, the map and the member count on every up-to-date phone.

Nothing else changes for the hidden member. They stay a writer, seeders keep mirroring their core and Places they created stay. If the hidden member is the owner, the circle stays owned by them. Owner-only actions stay impossible in that case, and the way out is export + import (PR #228).

### Real members come back by themselves

`autoAppendMemberRow` already runs on every refresh (about every 3 s) and rewrites our own `member:` row with a fresh `joinedAt` when a `left:` or `removed:` row currently hides us. Add `hidden:` to that check. A member who was hidden while their phone was off rewrites their row the next time the app runs, and `joinedAt > hidden.ts` shows them again on every phone. A dead identity never runs the app again, so it stays hidden.

That rewrite would make `emitMemberJoined` tell everyone "X joined". Add `rejoin: 'unhide'` to the rewritten row and have `emitMemberJoined` skip rows carrying it. Old peers ignore the field and still show the notice once, which is acceptable.

### The app

- New IPC `member:hide({ circleId, pubkey })`. The worklet refuses when: the circle is unknown or not writable, `pubkey` is our own, there is no member row for `pubkey` or the member was seen in the last 30 days. "Seen" means the newest of their `lastSeen` `ts` (view row or last-known core), their live position and their `member.joinedAt`.
- In the member detail sheet, show "Hide from circle" when the circle is a single circle in view, the member is not us and hasn't been seen in 30 days. The confirm text says it hides them for everyone, nobody is removed and they come back by themselves if they open PearCircle again.
- Debug builds read the 30-day threshold from a dev setting so it can be tested in minutes.

## Compat

- Old peers drop `hidden:` rows (applyCircleNodes ends with "Other prefixes not yet wired - silently dropped"), so on old versions the hidden member still shows. Nothing breaks.
- A member on an old version can't hide anyone, and if they are hidden they won't come back by themselves until they update. The 30-day rule makes that unlikely: an old version that is running posts positions, so it is never offered for hiding.
- No migration. The record is new and additive.

## Verify

- Unit tests: `memberHiddenByHide` truth table; apply accepts a valid row and rejects a bad signature, a key/pubkey mismatch, hiding yourself, a timestamp too far in the future and an older `ts` (LWW); `member:hide` refusals; `autoAppendMemberRow` rewrites when hidden; `emitMemberJoined` skips `rejoin: 'unhide'`.
- `npm run verify` green.
- Devices (emulator + TCL, since two emulators won't pair): TCL creates a circle, the emulator joins. Clear the emulator's app data and rejoin, so the circle lists the emulator twice. With the debug threshold at 1 minute, hide the dead entry from the TCL. It disappears on both. Then hide the live emulator entry and confirm it comes back within a few seconds with no "joined" notice.

## Rollback

Remove the menu item, or revert the release. Builds without the apply rule drop `hidden:` rows, so hidden members simply show again. The rows already written stay in the log and do nothing.

## Open questions

1. **30 days?** Long enough that a phone left off over a holiday isn't offered, short enough to clean up within a month. A phone that comes back unhides itself anyway.
2. **Can anyone unhide someone else?** Proposed: no. A real member unhides themselves, and a dead entry has no reason to come back. Can be added later as a newer row with an `unhidden` flag.
3. **Should the hide be announced** ("Tim hid Old Phone")? Proposed: no notification, to keep it quiet. Could be added to the circle's activity history later.
