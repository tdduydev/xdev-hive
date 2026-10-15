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

### CA riêng của hub nội bộ

Caddy phục vụ chứng chỉ CA công khai tại `https://<hub>/ca.crt`, đọc từ
`/data/caddy/pki/authorities/local/root.crt`. Route này không phục vụ khoá riêng. Với hub dùng
`tls internal`, quản trị viên lấy SHA-256 từ bản CA trên máy chủ bằng
`openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -subject -fingerprint -sha256`
và gửi tên cùng vân tay qua kênh đáng tin cậy cho người dùng đối chiếu.

Khi kiểm địa chỉ HTTPS gặp CA chưa tin, app desktop hiện tên và SHA-256 của CA. Bước đầu chỉ
bắt tay TLS để xem chứng chỉ; app tải `/ca.crt` qua kết nối ghim đúng chứng chỉ vừa thấy, rồi
kiểm tra CA xác thực được chuỗi, tên máy và hạn dùng của hub trước khi cho phép xác nhận.
Chỉ đồng ý sau khi đối chiếu với quản trị viên. CA đổi thì app hiện cả vân tay cũ và mới;
không tự thay CA đã tin. Không suy ra vân tay đầy đủ từ một vân tay bị cắt ngắn.

App lưu CA đã đồng ý tại `~/.xdev-hive/hub-ca.pem` (Unix: quyền `0600`), cộng với kho CA hệ
thống. Worker và `hive` CLI đọc cùng file cho HTTP và WSS. Có thể đặt `HIVE_CA_FILE` tới một
file CA đã kiểm tra (app cũng hỗ trợ biến này). Trên Windows, thư mục nhà là `%USERPROFILE%`.
Không cần cài CA vào hệ điều hành để app, worker hay CLI gọi hub. Sau khi xác nhận, bấm lại
đăng nhập/đổi địa chỉ. Nút **Quên chứng chỉ đã tin** xoá file CA; các kết nối mới không còn
sử dụng CA đó. Khởi động lại worker để đóng kết nối WSS đang mở. Chỉ lưu một CA riêng tại
một thời điểm; thay CA cũng thay CA mà worker và CLI dùng ở lần kết nối tiếp theo.

Các trang web đầy đủ và luồng đăng nhập bằng trình duyệt mở trình duyệt hệ thống, có kho chứng chỉ riêng.
Có thể dán mã đăng ký hoặc token cá nhân để kết nối app mà không cài CA vào hệ điều hành. Để
trình duyệt cũng tin hub, hoặc nếu không muốn dùng xác nhận trong app, xin CA và đối chiếu
SHA-256 rồi cài vào hệ điều hành:

- **macOS:** mở bằng Keychain Access, thêm vào System, chọn Always Trust.
- **Windows:** Install Certificate → Local Machine → Trusted Root Certification Authorities.
- **iOS:** cài hồ sơ ở Cài đặt → Cài đặt chung → VPN và quản lý thiết bị; sau đó bật CA ở
  Cài đặt chung → Giới thiệu → Cài đặt tin cậy chứng chỉ.
- **Android:** Cài đặt → Bảo mật → Mã hoá và thông tin xác thực → Cài chứng chỉ CA
  (tên mục có thể khác theo hãng).

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

While the hub has no organization, `/login` shows a *Tạo tài khoản quản trị đầu tiên* (create the first administrator account) form (name, email,
password of at least 10 characters). Use an address listed in `HIVE_ORG_CREATORS`; the hub rejects every other address
with the same error, so the page does not reveal which addresses are allowed. The form disappears once an organization
exists. Email sign-up does not
verify the mailbox: whoever registers an address listed in `HIVE_ORG_CREATORS` first owns that account. That is why the
hub only opens this path while no organization exists; register right after the first deploy. Once an organization
exists, other administrators join through GitHub/GitLab or invitations. `HIVE_ALLOW_EMAIL_SIGNUP=1` disables the
invite-only rule entirely and is meant for development only.

### SSO domains

Organization SSO only creates accounts and auto-joins people (directly or pending approval, per policy) when the SSO
domain is verified. Each domain belongs to at most one organization, and public mail domains (gmail.com, outlook.com,
…) are rejected. An organization administrator proves ownership on the sign-in settings page (`/admin/sign-in-settings`): request a TXT
record, publish it at `_xdev-hive-verification.<domain>`, then run the check from the same page. The hub stores only a hash of the code, and the
record expires if it is not checked in time. An organization that verifies a domain takes it over from an organization
that only declared it without verification (both sides get an audit entry). SSO routing uses exact domain matches;
subdomains only follow a parent domain that is verified. Changing the domain in the SSO settings clears the
verification. Every day the hub deletes accounts older than 7 days
that belong to no organization and have no pending invitation (addresses in `HIVE_ORG_CREATORS` are kept), for example
accounts whose invitation was revoked.

## Connecting machines

Create a one-time registration token in the web app (Machines → Add machine), then on each machine run the install
script. It needs no Go toolchain:

```sh
# Linux, macOS: installs to ~/.local/bin
curl -fsSL https://github.com/tdduydev/xdev-hive/releases/latest/download/install.sh | sh -s -- --hub https://hive.example.com --token <token>
```

```powershell
# Windows (PowerShell 5.1 or later): installs to %LOCALAPPDATA%\xdev-hive\bin and adds it to the user PATH
irm https://github.com/tdduydev/xdev-hive/releases/latest/download/install.ps1 -OutFile "$env:TEMP\hive-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\hive-install.ps1" -Hub https://hive.example.com -Token <token>
```

The script picks the build for the OS and CPU, verifies the ECDSA signature of `checksums.txt` and the archive's
SHA-256, then runs `hive-worker register` and `hive-worker service install`. Options: `--machine NAME`,
`--capacity N`, `--version X.Y.Z`, `--dir DIR`, `--no-service` (PowerShell: `-Machine`, `-Capacity`, `-Version`, `-Dir`,
`-NoService`). `HIVE_RELEASES_URL` points the script at an internal mirror with the same layout as GitHub Releases.

The same steps by hand:

```sh
hive-worker register --hub https://hive.example.com --token <token>
hive-worker service install [--config PATH] [--capacity N]
hive-worker service status
hive-worker service restart
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

### Updating workers

```sh
hive-worker update --check     # running and latest version
hive-worker update             # install the latest release and restart the background service
hive-worker update --version 0.1.0   # install exactly this version, also to roll back
```

The update downloads the release for the machine's OS and CPU, checks the signature of `checksums.txt` against the
public key built into the worker (`worker/internal/update/release-signing.pem`) and the archive's SHA-256, runs the new
binary once to confirm its version, and only then replaces the running file. Restarting the service interrupts runs in
progress; they are reported as interrupted when the worker comes back. Running the install script again without
`--token` also upgrades. The worker bundled with the desktop app is updated with the app and ignores update requests.

The Machines page shows each machine's worker version and marks machines behind the latest release; the hub asks the
GitHub releases API at most once an hour (set `HIVE_WORKER_RELEASES=off` when the hub cannot reach the Internet). A team
administrator can press **Update** on an online machine: the worker stops taking new runs, waits for its current runs
to finish, updates itself and restarts with the same arguments, so nothing is interrupted.

To check a release by hand:

```sh
openssl dgst -sha256 -verify worker/internal/update/release-signing.pem -signature checksums.txt.sig checksums.txt
sha256sum --check --ignore-missing checksums.txt
gh attestation verify hive-worker_linux_amd64.tar.gz --repo tdduydev/xdev-hive
```

## Sandboxed runs (optional)

Projects with the `sandbox` feature run on a **runner host** instead of developer machines. Each run gets a single-use
gVisor container with `--network=none`, a read-only root filesystem, no capabilities, `no-new-privileges`, a non-root
user and CPU, memory and PID limits. The only way out is the egress proxy, which applies the effective allowlist
(suggested defaults, organization entries and project entries; an organization can lock its list).

On the runner host (Linux):

1. Install gVisor from the [official instructions](https://gvisor.dev/docs/user_guide/install/) and register it with
   Docker, allowing containers to connect to the egress proxy's Unix socket (gVisor blocks host Unix sockets by
   default, and the runner host refuses to start without this):
   `sudo runsc install -- --host-uds=open && sudo systemctl reload docker`. Check with
   `docker run --rm --runtime=runsc --network=none busybox dmesg | head -1`, which should print `Starting gVisor...`.
2. Create a **runner host** registration token (Machines → Add machine → Runner host), install the worker with
   `--no-service`, then start `hive-worker host`. The host refuses to start without `runsc` unless
   you pass `--allow-runc` for development.

`pnpm e2e:sandbox` exercises the full sandbox path and exits with code 77 (skipped) when Docker or `runsc` is missing.

## Artifacts

Artifacts (versioned pages and files that agents and people create, see [ADR 0023](adr/0023-artifacts.md)) need no extra
service: content lives in PostgreSQL, so the database backup covers it. Set these in `.env` only to change the defaults;
`deploy/compose.yaml` passes them to the hub, and an empty value means the default.

| Variable | Default | Meaning |
|---|---|---|
| `HIVE_ARTIFACT_MAX_VERSION_BYTES` | `1048576` (1 MiB) | Largest text version. Organization policy can only lower it |
| `HIVE_ARTIFACT_MAX_BLOB_BYTES` | `20971520` (20 MiB) | Largest image or PDF (not used until blob types ship) |
| `HIVE_ARTIFACT_ORG_QUOTA_BYTES` | `2147483648` (2 GiB) | Storage per organization, trash included |
| `HIVE_ARTIFACT_LINK_MAX_DAYS` | `30` | Longest life of a public link; organization policy can only lower it |
| `HIVE_TRUSTED_PROXIES` | empty | Comma-separated IPs or CIDRs of the reverse proxy in front of the hub, for example the Docker network of Caddy |

- **Rate limits on public links.** The hub limits `/_artifact/s/*` to 60 requests a minute per IP. It reads the client
  IP from `X-Forwarded-For` only when the connection comes from `HIVE_TRUSTED_PROXIES`. Behind Caddy, set it to the
  Compose network (`docker network inspect` shows the subnet); left empty, every viewer shares the proxy's IP and one
  noisy visitor can lock out the others.
- **Public link tokens in logs.** A public link carries its secret in the path (`/_artifact/s/<token>`), so anyone who
  can read an access log can open the link until it expires. The bundled `deploy/caddy/Caddyfile` masks the token in
  `request>uri` and `Referer`. If you put another proxy in front, mask the same path there and keep the log files
  readable by the administrators only.
- **Same host.** Interactive content is served from `/_artifact/frame/` on the hub's own host, inside a sandboxed
  `iframe` with a restrictive CSP. Do not route `/_artifact/` to another origin or strip the hub's `Content-Security-Policy`
  header in the proxy.
- **Rolling out on an existing server.** The MCP tools `artifact_create`, `artifact_update`, `artifact_get` and
  `artifact_list` are on by default for every organization once the hub is updated. To keep agents from creating
  artifacts that nobody can see yet, an administrator can switch them off first in *Admin → MCP* (MCP-04) and turn them
  on after the web screens are deployed.

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
