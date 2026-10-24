# Release notes

A `## vX.Y.Z` section here becomes the whole release body for that version (release page and the app's update notice),
replacing the notes generated from merged PR titles (`scripts/release/notes.sh`).

## v0.2.42

### Upgrade notes

- **The hub now runs as two containers.** `hub` serves HTTP, MCP and worker connections; the new `hub-jobs` runs the
  job queue and starts once `hub` is healthy. `deploy/remote.sh` starts both. If you run Compose by hand, either start
  `hub-jobs` too (`docker compose up -d`) or set `HIVE_ROLES=api,jobs` and start only `postgres` and `hub`; otherwise
  scheduled and queued work stops running.
- **`postgres` is now built from `deploy/postgres`** on top of `HIVE_POSTGRES_IMAGE`, adding pgBackRest. The first
  deploy builds the image, so it takes a few minutes longer. Existing data is kept.
- Optional continuous backup with point-in-time restore: set `HIVE_BACKUP_REPO` (S3, MinIO or SFTP on another machine)
  and `HIVE_BACKUP_CIPHER_PASS`, and keep that password with `HIVE_MASTER_KEY`. Without them, backups stay daily
  `pg_dump` as before. See [Continuous backup](https://github.com/tdduydev/xdev-hive/blob/main/docs/self-hosting.md#continuous-backup-and-point-in-time-restore).
- Update workers together with the hub: after a database restore, workers resend events the hub may have lost.

### Desktop: local secrets

- **Back up and move secrets.** On the Secrets screen, **Xuất** saves the secrets you pick to a `.hivesecrets` file
  encrypted with your password; **Nhập** restores it on another machine after a preview, matching projects by git
  remote, then by name. A forgotten password cannot be recovered. The hub never sees the file. See
  [Local secrets](https://github.com/tdduydev/xdev-hive/blob/main/docs/local-secrets.md).
- **Import from `.env`.** Pick a `.env` file and a project (or every project) instead of typing secrets one by one.
- **Secrets for every project.** Tick "Dùng cho mọi dự án" to give a secret to every project on the machine.

### Worker

- Reads GitLab test reports as a delivery job (`test-report`), groundwork for test results on the delivery board.

## v0.2.26

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
