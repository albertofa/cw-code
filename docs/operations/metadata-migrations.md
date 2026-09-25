# Metadata migrations and startup recovery

cw-code stores its own metadata in two JSON files under `~/.cw-code/userdata`
(or `$CW_CODE_HOME/userdata`):

| File | Store | Current schema |
| --- | --- | --- |
| `cw-code.db.json` | projects and sessions (`SessionStore`) | 1 |
| `cw-settings.json` | app settings (`SettingsStore`) | 1 |

Only these two files are versioned and migrated. CLI transcripts, CLI session
stores, repositories and worktree contents are never touched.

## Schema versions

Each file has a top-level `schemaVersion` number. A file without the field is
schema 0 (every release up to v0.0.1-alpha.21).

- Schema 0 to 1, sessions: normalizes project roots and worktree paths (strips
  trailing separators), trims and lowercases GitHub account hosts (drops an
  account with an empty host or login), and folds the legacy single `pr` link
  into `prs`. Session statuses `working`/`input-required` become `holding` on
  every load; that is runtime cleanup, not a migration.
- Schema 0 to 1, settings: adds the version stamp only. Known keys are still
  sanitized on every load.

Unknown top-level keys and unknown fields on project/session records are
preserved on every write, so fields added by a newer release that kept the same
schema version survive a round trip through an older release.

## Backup files

All backups sit next to the source file:

- `<file>.v<N>.bak`: the original bytes of a schema-N file, written just before
  the first migration away from schema N. The backup is written atomically and
  read back to confirm the bytes match. An existing backup is never overwritten.
- `<file>.last-good.bak`: a copy of the file after the last successful load.
  It is refreshed only when the bytes changed.
- `<file>.broken-<timestamp>`: the file that was in place when the user
  restored a backup. cw-code never deletes it.
- `<file>.<pid>.<random>.tmp`: a leftover from an interrupted atomic write.
  It is ignored and safe to delete while cw-code is closed.

Writes go to a temp file in the same directory, which is fsynced and then
renamed over the target. If cw-code stops mid-migration, the next start either
finds the original schema-0 file (the backup already exists and is kept) or
the finished schema-1 file.

## Recovery screen

If either file is corrupt JSON, has an unexpected shape, carries a newer
`schemaVersion`, or cannot be backed up or written, cw-code does not start the
CLI drivers or normal services and never overwrites the file. Instead it shows
a recovery screen that lists each affected file with its problem and backups:

- **Restore** (valid backups only, confirmation required): renames the current
  file to `<file>.broken-<timestamp>`, copies the backup bytes into place and
  relaunches the app. Backups are validated again before restoring, and only
  backups of that exact file in the same folder are accepted.
- **Open data folder**: opens `userdata` so the file can be inspected or fixed
  by hand.
- **Retry**: relaunches the app, for example after fixing the file or
  updating cw-code when the file came from a newer release.

Nothing is restored automatically. Recovery issues are also written to
`~/.cw-code/logs/crash.log`.

## Adding a migration

1. Bump the store's schema constant (`SESSION_SCHEMA_VERSION` in
   `apps/desktop/src/main/sessions/SessionStore.ts` or `SETTINGS_SCHEMA_VERSION`
   in `apps/desktop/src/main/settings/SettingsStore.ts`).
2. Add a step keyed by the previous version to `SESSION_MIGRATIONS` or
   `SETTINGS_MIGRATIONS`. A step receives a deep copy of the validated
   document and returns the next version's document. Keep it deterministic,
   keep unknown fields, and do not touch the filesystem.
3. If the shape changes, update the store's `validate` function so it accepts
   every version that can still be migrated, and the result of the migration.
4. Add a sanitized fixture of the previous schema under
   `apps/desktop/src/main/storage/__fixtures__/` and tests for the new step:
   identifiers preserved, no rewrite on the second load, unknown fields kept.

The loader (`apps/desktop/src/main/storage/versionedJson.ts`) handles backups,
atomic writes, the last-good copy and the refusal paths for every store.
