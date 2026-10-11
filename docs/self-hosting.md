# Self-hosting xDev Hive

This guide covers running the hub on your own server, creating the first administrator, connecting machines, backups,
and optional sandboxed runs.

## Requirements

- A Linux server with Docker and Docker Compose v2.
- SSH access from a development machine that has a checkout of this repository.
- For HTTPS: a DNS name pointing at the server (the Compose stack includes an optional Caddy profile).

## Deploy with `deploy/remote.sh`

From the development machine:

```sh
HIVE_PUBLIC_URL=https://hive.example.com HIVE_ORG_CREATORS=admin@example.com deploy/remote.sh user@server [git-ref]
```

- The script sends the selected commit (default `HEAD`) with `git archive` over SSH, so the server needs no access to
  the repository. Code lands in `<dir>/src`; `<dir>` defaults to `/opt/xdev-hive` and can be changed with
  `HIVE_REMOTE_DIR`. The script then runs `docker compose up -d --build` and waits until the hub reports healthy.
- On the first run, database passwords, `HIVE_AUTH_SECRET` and `HIVE_MASTER_KEY` are generated on the server into
  `<dir>/.env` (mode 600). They are never printed and never copied back. **Back up `HIVE_MASTER_KEY`**: losing it
  means losing every stored secret (Git tokens, notification channels).
- Later runs keep existing secrets and only add variables that are missing. `HIVE_PUBLIC_URL`, `HIVE_BIND`,
  `HIVE_POSTGRES_IMAGE` and `HIVE_NODE_IMAGE` follow the command line.
- If the server already runs another Compose project named `xdev-hive`, set `HIVE_COMPOSE_PROJECT` to a different name
  on the first run; otherwise Compose treats the other stack's containers as its own. The name is saved in `<dir>/.env`.
- If the SSH user is not in the `docker` group, set `HIVE_REMOTE_DOCKER="sudo docker"`.
- The hub always builds with Docker's default builder, so a CI runner on the same machine cannot break a deploy by
  removing its own buildx builder.

Health check: `GET /api/v1/health` returns the running commit.

### HTTPS, LAN servers and MCP over HTTP

- With a public DNS name, keep the default `HIVE_BIND` and add the Compose profile `https` (Caddy).
- On a LAN without HTTPS, set `HIVE_BIND=0.0.0.0`. The MCP endpoint `/mcp` then switches off automatically because
  `HIVE_PUBLIC_URL` is not HTTPS.
- To let agents in runs keep calling MCP tools over plain HTTP on a network you trust, set `HIVE_MCP_ALLOW_HTTP=1`
  (off by default). `/mcp` then accepts **only run tokens**: OAuth tokens and requests without a run token get 401, and
  OAuth discovery and user login stay HTTPS-only. Run tokens travel in clear text, so only enable this when the network
  between the server and the worker machines is trusted. The hub logs a warning at start-up.

### Running Compose by hand

Copy `deploy/.env.example` to `deploy/.env`, set passwords, secrets and `HIVE_ORG_CREATORS`, then:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

The hub bootstraps its database roles (including `hive_jobs` for the job queue), runs migrations and starts the API.

## The first administrator

Accounts are invite-only for every sign-in method (email and password, GitHub, GitLab, SSO). GitHub and GitLab only
create an account when the provider reports the email as verified. A brand-new hub has nobody to send invitations, so
list the hub administrators in `HIVE_ORG_CREATORS` (comma separated). Those people may create organizations and may
create an account without an invitation: with GitHub or GitLab using that verified email, or with email and password
**while the hub has no organization yet**.

If GitHub and GitLab sign-in are not configured, create the first account with the API, then sign in at `/login`:

```sh
curl -X POST https://hive.example.com/api/auth/sign-up/email -H 'content-type: application/json' \
  -H 'origin: https://hive.example.com' \
  -d '{"name":"Admin","email":"admin@example.com","password":"<at least 10 characters>"}'
```

Run this in your own terminal so the password does not end up in shell transcripts you share. Email sign-up does not
verify the mailbox: whoever registers an address listed in `HIVE_ORG_CREATORS` first owns that account. That is why the
hub only opens this path while no organization exists; register right after the first deploy. Once an organization
exists, other administrators join through GitHub/GitLab or invitations. `HIVE_ALLOW_EMAIL_SIGNUP=1` disables the
invite-only rule entirely and is meant for development only.

### SSO domains

Organization SSO only creates accounts and auto-joins people (directly or pending approval, per policy) when the SSO
domain is verified. Each domain belongs to at most one organization, and public mail domains (gmail.com, outlook.com,
…) are rejected. Until DNS TXT verification is available in the UI, a hub administrator verifies ownership out of band
and marks the domain in the database:

```sql
UPDATE auth."ssoProvider" SET "domainVerified" = true WHERE "providerId" = 'org-<organization id>';
```

Changing the domain in the SSO settings clears the verification. Every day the hub deletes accounts older than 7 days
that belong to no organization and have no pending invitation (addresses in `HIVE_ORG_CREATORS` are kept), for example
accounts whose invitation was revoked.

## Connecting machines

Create a one-time registration token in the web app (Machines → Add machine), then on each machine:

```sh
hive-worker register --hub https://hive.example.com --token <token>
hive-worker service install [--config PATH] [--capacity N]
hive-worker service status
hive-worker service uninstall
```

`--dry-run` prints the service definition and commands without installing anything. The worker only drives CLIs that
are already logged in on that machine; the hub never receives CLI credentials.

- **Linux** installs a systemd user service. It runs only while the user is logged in unless you enable lingering:
  `loginctl enable-linger USER`. Logs: `journalctl --user -u hive-worker`.
- **macOS** installs a LaunchAgent; logs go to `~/Library/Logs/xdev-hive/worker.log`. If the hub rejects the machine,
  the agent exits cleanly instead of restarting in a loop; register again and rerun `service install`.
- **Windows** creates a Task Scheduler task at normal privilege that starts at logon; logs go to
  `%LOCALAPPDATA%\xdev-hive\worker.log`.

Machines can be paused from the web app: a paused machine takes no new runs while its current runs finish.

## Sandboxed runs (optional)

Projects with the `sandbox` feature run on a **runner host** instead of developer machines. Each run gets a single-use
gVisor container with `--network=none`, a read-only root filesystem, no capabilities, `no-new-privileges`, a non-root
user and CPU, memory and PID limits. The only way out is the egress proxy, which applies the effective allowlist
(suggested defaults, organization entries and project entries; an organization can lock its list).

On the runner host (Linux):

1. Install gVisor from the [official instructions](https://gvisor.dev/docs/user_guide/install/) and register it with
   Docker (`sudo runsc install && sudo systemctl reload docker`). Check with
   `docker run --rm --runtime=runsc --network=none busybox dmesg | head -1`, which should print `Starting gVisor...`.
2. Create a **host** registration token (the web app does not offer this yet; call
   `POST /api/v1/teams/{teamId}/machines/registrations` with `{"kind":"host"}` as a team administrator), register the
   machine with `hive-worker register`, then start `hive-worker host`. The host refuses to start without `runsc` unless
   you pass `--allow-runc` for development.

`pnpm e2e:sandbox` exercises the full sandbox path and exits with code 77 (skipped) when Docker or `runsc` is missing.

## Backup and restore

With the layout created by `deploy/remote.sh` (`<dir>/.env`, `<dir>/src`), on the server:

```sh
cd <dir>/src
deploy/backup.sh
HIVE_BACKUP_KEEP=30 deploy/backup.sh
deploy/restore.sh <dir>/backups/20261011T030000Z
deploy/restore.sh <dir>/backups/20261011T030000Z --yes   # non-interactive
```

- A backup contains `hive.dump` (pg_dump custom format), `.env` **including `HIVE_MASTER_KEY`**, and `SHA256SUMS`.
  Directories are mode 700 and files mode 600. The dump is validated with `pg_restore --list`; on failure the script
  exits non-zero and keeps older backups.
- `HIVE_BACKUP_KEEP` (default 14) can be set in `<dir>/.env` or the environment. Old backups are pruned only after the
  new one completes. Copy backups off the server; anyone who can read `.env` can read your secrets.
- Restore verifies checksums, the dump and the Compose project before stopping the hub, asks before replacing a
  different `.env` (or use `--yes`), restores in a single transaction while keeping roles, ownership and ACLs, recreates
  the hub from the existing image and waits up to 3 minutes for it to become healthy.
- **Restore overwrites current data.** Back up first. Restore only trusted backups into the same bootstrapped project
  and a compatible code version. Dumps do not include cluster-wide roles, source code, blobs outside PostgreSQL or
  infrastructure configuration.
- Backup and restore share the lock `<dir>/.backup-restore.lock`; do not run them during a deploy or while editing
  `.env`.

From the development machine, using the scripts already deployed on the server:

```sh
deploy/remote-backup.sh user@server
HIVE_REMOTE_DIR=/opt/xdev-hive deploy/remote-backup.sh user@server --cron "0 3 * * *"
```

`--cron` installs a schedule in the SSH user's crontab (rerunning replaces the schedule for the same `<dir>`). Cron uses
the server's time zone and logs to `<dir>/backups/cron.log` (mode 600). Dumps and `.env` are never downloaded.
`sh deploy/test-backup.sh` tests the failure paths and cron handling with fake Docker and SSH.

## Importing knowledge from an older hub

If you migrate from the previous xDev Hive (SQLite) generation, place a copy of its database in `.legacy/` (ignored by
Git and Biome; never commit real data), create the target organization, teams, systems and projects, and run:

```sh
pnpm --filter @xdev-hive/hub import:legacy --db ../../.legacy/hub.db --org example --dry-run
pnpm --filter @xdev-hive/hub import:legacy --db ../../.legacy/hub.db --org example --project-map old-app=new-app
```

The importer uses `HIVE_DATABASE_URL` for the `hive_app` role (loading `apps/hub/.env` if present), is idempotent
(source and target IDs are recorded in `legacy_imports`), reports counts per kind without printing content, and exits
with `0` (success), `1` (some records failed, each rolled back individually) or `2` (could not run). Memory vectors
are recomputed by the hub's embedding job when embeddings are configured. Attachments are imported as metadata with
`status=missing` until their blobs are copied over.
