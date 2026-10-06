# Owner continuity: co-owners and account backup

**Status**: Approved 2026-10-06 by Tim, with every open question resolved as proposed: co-owners can delete, the owner or any co-owner can revoke a co-owner, a password is required on account backups (optional on circle exports), auto-backup runs on change plus at most daily with a 14-day reminder, and two-phone detection waits (the restore screen warns instead).

**Goal**: A circle keeps a working owner when the owner loses their app data, and anyone who saved a backup gets their whole account back after a reinstall.

**Tier**: T3. Changes who the apply rules trust for owner actions (an auth gate), adds key material export (the account backup) and adds new replicated keys. Old peers keep the old rules, so the compat section matters.

## Background

On 2026-10-06 a user on a stock Pixel 10 Pro XL lost all app data for the second time, most likely through Zapstore's force update (an uninstall and reinstall, zapstore/zapstore#347). Rejoining gave him a new identity, so:

- His old identity stayed in every member list. PR #230 lets any member hide it.
- In circles he created, nobody can rename, delete, remove members or recreate any more, because owner power is tied to the phone that created the circle:
  - `circle` (rename, delete) is accepted only when written by the bootstrap writer core (`applyCircleNodes`, `fromHex !== bootstrapHex`).
  - `removed:` is the same (`shouldAcceptRemovedRow`).
  - `supersede:` must be signed by the circle row's `ownerKey` identity.
  - `circle:recreate` checks the local `role === 'owner'`.

Adding members is not affected: any writer answers a joiner's `writerHello` (`src/pair.js`), which is why he could rejoin.

The only way out today is export + import into a new circle (PR #228), which loses history and makes everyone rejoin.

## Design

### Part 1: owner actions follow an identity

Owner actions become valid when signed by an authorized identity, whichever writer core appends them. The bootstrap-core rule stays as a second way in, so nothing an existing owner does changes.

Authorized identities for a circle: the `ownerKey` in the circle row, plus every current co-owner (Part 2).

New signed shapes (signature over every non-`sig` field, `src/lib/sign.js`):

- `circle` row: adds `by` (signer identity), `updatedAt` and `sig`. Accepted when bootstrap-authored (as today) or when `by` is authorized and the signature verifies. A non-bootstrap write may not change `ownerKey` or `id`. Last write wins on `updatedAt`, so an older signed row replayed by any writer is ignored.
- `removed:{pubkey}`: adds `removedBy` (already present) as the signer and `sig`. Accepted when bootstrap-authored or signed by an authorized identity. Nobody can remove the `ownerKey` identity this way. Still LWW on `ts`.
- `supersede:` already verifies against `ownerKey`. Extend it to co-owners.
- `circle:recreate` and the UI's owner checks use "our identity is authorized" instead of `role === 'owner'`.

### Part 2: co-owners

```
coowner:{pubkey} = { pubkey, by, ts, revoked: false, v: 1, sig }
```

- Accepted when `by` is authorized at the time of apply and the signature verifies. LWW on `ts`.
- `revoked: true` with a newer `ts` removes the co-owner.
- A co-owner can do everything the owner can (rename, delete, remove, recreate, appoint co-owners), except remove or revoke the `ownerKey` identity.
- Who can revoke a co-owner: see open question 2.
- UI: in a member's sheet, the owner or a co-owner sees "Make co-owner" / "Remove co-owner". The member list shows a co-owner badge next to the owner badge. Settings > Circles shows the owner icons (rename, recreate, delete) to co-owners.

### Part 3: account backup

A file that brings back the whole account on a fresh install.

**Contents** (before encryption):

```
{
  type: 'pearcircle.account-backup', v: 1, createdAt,
  identity: { publicKey, secretKey },
  profile: { displayName, avatar? },
  circles: [ { circleId, name, circleKey, bootstrap, encryptionKey, role, joinedAt } ]
}
```

**Password protection.** The file holds the account's secret key and every circle's keys, so anyone holding it can read the circles and act as the user. When a password is set, the worklet derives a key with `crypto_pwhash` (Argon2id, `OPSLIMIT_INTERACTIVE` / `MEMLIMIT_INTERACTIVE`, 64 MB, a random salt) and seals the contents with `crypto_secretbox_easy`. The file then stores `{ type, v, kdf: { alg, ops, mem, salt }, nonce, ciphertext }`. Whether the password is required is open question 3. The same option is offered on circle exports (PR #228 files), which hold Place coordinates.

**Restore.** On a fresh install, onboarding and Settings get "Restore from backup". The worklet decrypts the file, writes the `identity`, `profile` and `circles:joined:*` rows, and mounts each circle. This is the same path as a cold boot, so it needs no new code there. Each circle opens read-only on a new local writer core until any online member's phone admits it through the existing `writerHello` flow, the same way a repair does today. Because the identity is the same, the member row already exists and no duplicate appears. If the restored identity is the `ownerKey` or a co-owner, Part 1 gives owner actions back. Restore is refused if this install already has circles, so it can't mix two accounts.

**Auto-backup.** An optional switch in Settings: "Back up automatically". The user picks a folder once (on Android the same saved folder grant circle export uses, `pc:export:dirUri`; on iOS a folder picked in Files). The app rewrites `pearcircle-backup.json` in that folder when something in the backup changes (joining, leaving or creating a circle, a profile edit) and at most once a day otherwise. With a password, the derived key is kept in `expo-secure-store` so auto-backup can encrypt without asking each time. It is never stored in plain text. The user can pick a folder that syncs off the phone (Nextcloud, Syncthing, Proton Drive, iCloud Drive) so the backup survives losing the phone, and PearCircle runs no server. Settings shows when the last backup was written, and a reminder appears if it is more than 14 days old.

**Using one backup on two phones.** Both would run the same identity on different writer cores. Positions would flip between them (lastSeen is LWW on `ts`). The restore screen says to use a backup on one phone at a time. Detecting it is open question 5.

## Compat

Old peers keep the bootstrap-only rule and drop a co-owner's or restored owner's rename, delete or removal. Autobase applies each node once, so a peer that dropped a row keeps missing it even after it updates. Left alone, old and new versions would disagree about the circle's name, its members or whether it still exists.

So the new owner actions are switched on per circle, only once every visible member can apply them:

- New versions add `caps: ['owner-v2']` to their own `member:` row. The profile-edit path already rewrites the row without changing `joinedAt`, so this sends no "joined" notice.
- A circle is ready when every visible member's row carries the cap. Hidden members (PR #230), left and removed members don't count, so a dead identity doesn't block it.
- Until a circle is ready, co-owner menu items and owner actions through Part 1 are not offered, and the worklet refuses them. The UI says who still needs to update. The original owner's phone keeps working as today through the bootstrap rule.
- Apply still accepts Part 1 rows whenever they arrive. The check above only stops new versions creating them early.

Other compat:

- Old peers drop `coowner:` rows (unknown prefixes are silently dropped).
- The extra fields on `circle` and `removed:` rows are ignored by old peers, which still accept those rows when bootstrap-authored.
- Backup and restore are local, so they work as soon as the user has the new version. A restored identity that is the `ownerKey` gets owner actions back once the circle is ready.

## Verify

- Unit tests: authorization (owner, co-owner, revoked co-owner, stranger), signature and replay rejection on `circle`, `removed:` and `coowner:`, no `ownerKey` change from a non-bootstrap writer, no removal of the owner, backup encrypt/decrypt round trip, wrong password, tampered file.
- `npm run verify` green.
- Devices (emulator + TCL):
  1. TCL creates a circle and makes the emulator a co-owner. Clear the TCL's data and rejoin. The emulator renames the circle and removes the TCL's old entry; both apply on both phones.
  2. Emulator backs up with a password, its data is cleared, it restores. Same name, no duplicate entry, it can write again once the TCL is online, and its owner or co-owner actions work.
  3. Auto-backup: turn it on, join a circle, check the file in the folder changed and decrypts.
  4. An old release on a third device keeps the circle from being ready: co-owner actions are refused and the UI names that device. After it updates, the actions unlock.
- iOS Simulator: backup, restore and the folder picker.

## Rollback

Ship behind a feature flag: with it off, the menu items, restore and auto-backup are hidden and the new apply rules are skipped (bootstrap-only, as today). Turning it off after rows exist leaves them in the log, ignored, as on old peers. Backups already written stay valid for a later version.

## RCA readiness

- `mark()` lines for every owner action accepted or rejected through Part 1 (signer prefix, rule, reason), co-owner changes and backup write, restore and decrypt failures. The secret key, passwords and circle keys are never logged.
- The geofence diagnostics screen (tap the version 7x) lists, per circle, the owner, co-owners and whether our identity is authorized.

## Related risk, not in scope

Every writer is added as an Autobase indexer (`addWriter` defaults to `indexer: true`, autobase 7.27.3). A phone that is gone for good stays an indexer, and each reinstall, repair or restore adds a new one. Enough dead indexers could stop the circle's history from being confirmed. Removing dead writers needs its own proposal. Tracked in TODO.

## Open questions

1. **Can co-owners delete the circle?** Proposed: yes, they can do everything the owner can except act against the owner. The alternative keeps delete owner-only.
2. **Who can revoke a co-owner?** Proposed: the owner, or any co-owner. If only the owner could, a bad co-owner could not be revoked once the owner is gone.
3. **Is a password required on account backups?** Proposed: required for account backups, which hold the secret key; optional for circle exports.
4. **Auto-backup frequency.** Proposed: on change plus at most daily, and a reminder after 14 days without a backup.
5. **Detect the same account on two phones?** Proposed: not in v1. Note it on the restore screen.
