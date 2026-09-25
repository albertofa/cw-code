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
- Schema 0 to 1, settings: adds the version stamp only.

Unknown top-level keys and unknown fields on project/session records are
preserved on every write, so fields added by a newer release that kept the same
schema version survive a round trip through an older release.

### Downgrading to v0.0.1-alpha.21 or older

Old releases do not know about `schemaVersion`:

- The old session store keeps the whole parsed file, so `schemaVersion` and
  unknown fields survive; the next start of a new release loads it as schema 1.
- The old settings store rewrites the file with known keys only, dropping
  `schemaVersion` and unknown keys. The next start of a new release treats it
  as schema 0 again and migrates it. The first `.v0.bak` is kept; if the bytes
  differ from it, a timestamped `.v0.<timestamp>.bak` is added (see below).
  Settings that only the newer release knew about are lost in that round trip.

### Settings repair

Known settings are sanitized on every load. A known key with the wrong type
(for example a number where a string is expected) falls back to its default
instead of blocking startup. If sanitizing changes any known key that is
present in the file, cw-code first saves the file's current bytes to
`<file>.before-repair.bak`, logs a warning naming the repaired keys, and then
writes the repaired file. Only corrupt JSON, a non-object root, or a newer
schema stop startup for settings.

## Backup files

All backups sit next to the source file:

- `<file>.v<N>.bak`: the original bytes of a schema-N file, written just before
  the first migration away from schema N. It is written atomically and read
  back to confirm the bytes match. An existing one is never overwritten.
- `<file>.v<N>.<timestamp>.bak`: written before migrating a schema-N file whose
  bytes differ from every existing schema-N backup (for example after a
  downgrade round trip).
- `<file>.last-good.bak`: a copy of the file after the last successful load,
  refreshed only when the bytes changed.
- `<file>.last-good.<timestamp>.bak`: a verified copy of `.last-good.bak` made
  before a restore or a fresh start, because the next successful load replaces
  `.last-good.bak`. Listed on the recovery screen as "last good (<date>)".
- `<file>.before-repair.bak`: the settings file as it was before the last
  load-time repair. Replaced only when a new repair sees different bytes. It is
  not offered on the recovery screen; open it by hand if needed.
- `<file>.broken-<timestamp>`: a verified copy of the file that was in place
  when the user restored a backup or chose to start fresh. Never deleted.
- `<file>.<pid>.<random>.tmp`: a leftover from an interrupted atomic write.
  It is ignored and safe to delete while cw-code is closed.

Writes go to a temp file in the same directory, which is fsynced and then
renamed over the target (retried up to five times, with a logged warning each
time, when Windows reports the file as busy or locked). If cw-code stops mid-migration, the next start either finds the
original schema-0 file (its backup already exists and is reused) or the
finished schema-1 file.

The one-time copy of legacy files from Electron's userData folder
(`migrateFromUserData`) skips `cw-code.db.json` and `cw-settings.json` when any
of the backups above exist for them, so a legacy snapshot never silently
replaces a missing file that has backups.

## Recovery screen

cw-code shows a recovery screen instead of starting the CLI drivers and normal
services when either file:

| Kind | Cause |
| --- | --- |
| corrupt | not valid JSON |
| invalid-shape | valid JSON with an unexpected structure |
| future-schema | `schemaVersion` newer than this release supports |
| missing | the file is gone but a restorable backup of it exists |
| io | the file, its backup or its replacement could not be read or written (the OS error code is shown) |

The file is never overwritten on startup in these cases. A missing file with
no restorable backup is a first run and starts with empty data or defaults.

Actions per file:

- **Restore** (valid backups only, confirmation required): copies the current
  file to `<file>.broken-<timestamp>` (verified), then atomically replaces it
  with the backup bytes and relaunches. Backups are validated again first, and
  only backups of that exact file in the same folder are accepted.
- **Start with no projects / Start with default settings** (confirmation
  required): copies the current file, if any, to `<file>.broken-<timestamp>`
  (verified), then atomically writes an empty document and relaunches. This is
  the way out for a corrupt file that has no backups yet. Not offered for `io`
  issues, where the file is probably intact behind a lock; those show Retry
  with a note to close the program holding the file.

Global actions:

- **Open data folder**: opens `userdata` so the file can be inspected or fixed
  by hand.
- **Retry**: relaunches the app, for example after fixing the file or
  updating cw-code when the file came from a newer release.

Nothing is restored automatically. Recovery issues are also written to
`~/.cw-code/logs/crash.log`. If startup fails for any other reason, cw-code
shows an error dialog pointing to that log and exits instead of running
without a window.

## Adding a migration

1. Bump the store's schema constant (`SESSION_SCHEMA_VERSION` in
   `apps/desktop/src/main/sessions/SessionStore.ts` or `SETTINGS_SCHEMA_VERSION`
   in `apps/desktop/src/main/settings/SettingsStore.ts`) and its `empty()`
   document if the shape changed.
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
