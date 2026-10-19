# Release notes

A `## vX.Y.Z` section here becomes the whole release body for that version (release page and the app's update notice),
replacing the notes generated from merged PR titles (`scripts/release/notes.sh`).

## v0.2.25

### Upgrade notes

- **Save `<dir>/.env` before redeploying the hub.** Hub backups (`deploy/backup.sh`) no longer contain `.env`, which
  holds `HIVE_MASTER_KEY` and the database passwords. Copy it to a place only administrators can read before deploying
  this version: without it, no backup can be restored with its stored secrets. Older backups that still contain `.env`
  are removed by retention, about 14 days after the update with a daily cron and the default `HIVE_BACKUP_KEEP=14`.
- Each new backup has a `meta` file with the Compose project and `HIVE_MASTER_KEY_SHA256`. Restore uses the `.env` on
  the server and stops if its key does not match. To check that a saved `.env` matches a backup (`shasum -a 256` on
  macOS):

  ```sh
  fp=$(sed -n 's/^HIVE_MASTER_KEY=//p' saved.env | tail -n 1 | sed 's/#.*//' | tr -d "[:space:]\"'=" | tr '_-' '/+' | sha256sum | cut -d ' ' -f 1)
  grep -qx "HIVE_MASTER_KEY_SHA256=$fp" <dir>/backups/20261011T030000Z/meta && echo 'same key' || echo 'DIFFERENT key'
  ```

  Details: "Backup and restore" in `docs/self-hosting.md`.

### Fixes

- **deploy:** keep `.env` out of hub backups; restore checks the key fingerprint and still accepts older backups that
  contain `.env` (#428)

Full list of changes: https://github.com/tdduydev/xdev-hive/compare/v0.2.24...v0.2.25
