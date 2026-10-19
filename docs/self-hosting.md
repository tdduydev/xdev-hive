# Self-hosting xDev Hive

This guide covers running the hub on your own server, creating the first administrator, connecting machines, backups,
and optional sandboxed runs.

## Requirements

- A Linux server with Docker and Docker Compose v2.
- SSH access from a development machine that has a checkout of this repository.
- For HTTPS (the Compose stack includes an optional Caddy profile), one of:
  - a public DNS name pointing at the server (Caddy gets a certificate over HTTP);
  - an internal DNS name in a Cloudflare zone that points at a private IP (Let's Encrypt over DNS-01, see
    [Internal domain with a Let's Encrypt certificate](#internal-domain-with-a-lets-encrypt-certificate));
  - only an IP address (Caddy's internal CA; users trust it once, see [CA riêng của hub nội bộ](#ca-riêng-của-hub-nội-bộ)).

## Deploy with `deploy/remote.sh`

From the development machine:

```sh
HIVE_PUBLIC_URL=https://hive.example.com HIVE_ORG_CREATORS=admin@example.com deploy/remote.sh user@server [git-ref]
```

- The script sends the selected commit (default `HEAD`) with `git archive` over SSH, so the server needs no access to
  the repository. Code lands in `<dir>/src`; `<dir>` defaults to `/opt/xdev-hive` and can be changed with
  `HIVE_REMOTE_DIR`. The script then runs `docker compose up -d --build` and waits until the hub reports healthy.
- On the first run, database passwords, `HIVE_AUTH_SECRET` and `HIVE_MASTER_KEY` are generated on the server into
  `<dir>/.env` (mode 600). They are never printed and never copied back. **Keep a copy of `<dir>/.env`** where only
  administrators can read it: backups do not include it ([Backup and restore](#backup-and-restore)), and losing
  `HIVE_MASTER_KEY` means losing every stored secret (Git tokens, notification channels).
- Later runs keep existing secrets and only add variables that are missing. `HIVE_PUBLIC_URL`, `HIVE_BIND`,
  `HIVE_TLS`, `HIVE_POSTGRES_IMAGE` and `HIVE_NODE_IMAGE` follow the command line.
- `HIVE_PUBLIC_URL=https://<IP>` turns on the `https` profile with Caddy's internal CA. `https://<domain name>` turns on
  the `https` profile with `HIVE_TLS=dns-cloudflare` (Let's Encrypt over DNS-01) unless you pass `HIVE_TLS=auto`; with
  `auto`, Caddy gets a certificate over HTTP and the script leaves `COMPOSE_PROFILES` as it is.
- If the server already runs another Compose project named `xdev-hive`, set `HIVE_COMPOSE_PROJECT` to a different name
  on the first run; otherwise Compose treats the other stack's containers as its own. The name is saved in `<dir>/.env`.
- If the SSH user is not in the `docker` group, set `HIVE_REMOTE_DOCKER="sudo docker"`.
- The hub always builds with Docker's default builder, so a CI runner on the same machine cannot break a deploy by
  removing its own buildx builder.
- With the `https` profile enabled, the script compares SHA-256 hashes of the Caddyfile visible inside the running
  container and the deployed file. If they differ, it recreates only Caddy to refresh its single-file bind mount;
  this briefly interrupts HTTPS. An unchanged Caddyfile does not trigger a restart. A directory mount alone would
  not fix this because deployment replaces the entire `src` directory.
- After the hub is healthy, HTTPS deployments check the certificate from inside the hub container. A failure prints a
  warning with the Caddy log command without failing the hub deploy.
  - IP address: `/ca.crt` must return HTTP 200 and a valid PEM certificate, retrying up to three times. This check
    accepts the untrusted internal CA without installing it.
  - Domain name: `/api/v1/health` must answer over TLS verified with the system CA store (no `/ca.crt` needed),
    retrying for up to two minutes while Let's Encrypt issues the certificate.

Health check: `GET /api/v1/health` returns the running commit.

### HTTPS, LAN servers and MCP over HTTP

- With a public DNS name, keep the default `HIVE_BIND`, deploy with `HIVE_TLS=auto` and add the Compose profile
  `https` (Caddy). For a DNS name that points at a private IP, see the next section.
- On a LAN without HTTPS, set `HIVE_BIND=0.0.0.0`. The MCP endpoint `/mcp` then switches off automatically because
  `HIVE_PUBLIC_URL` is not HTTPS.
- To let agents in runs keep calling MCP tools over plain HTTP on a network you trust, set `HIVE_MCP_ALLOW_HTTP=1`
  (off by default). `/mcp` then accepts **only run tokens**: OAuth tokens and requests without a run token get 401, and
  OAuth discovery and user login stay HTTPS-only. Run tokens travel in clear text, so only enable this when the network
  between the server and the worker machines is trusted. The hub logs a warning at start-up.

### Internal domain with a Let's Encrypt certificate

A hub reachable only on the LAN can still have a certificate that every browser, app and worker trusts: point a name in
a Cloudflare zone at the private IP and let Caddy prove ownership with a DNS TXT record (ACME DNS-01). Let's Encrypt
never connects to the server; the server only needs outbound HTTPS to Let's Encrypt and the Cloudflare API. Example:
`hive.example.com` (zone `example.com`) → `192.0.2.10`. The name is published in Certificate Transparency logs and anyone
can resolve it to the private IP; the hub itself stays unreachable from the Internet.

1. **DNS record.** In the Cloudflare dashboard, zone `example.com` → DNS → Records → Add record: type `A`, name `hive`,
   IPv4 `192.0.2.10`, proxy status **DNS only** (grey cloud). A proxied record cannot work because Cloudflare cannot
   reach a private IP. Some routers and resolvers drop public answers that point at private IPs (DNS rebinding
   protection); if clients cannot resolve the name, allow the domain there or add the same record to the internal DNS.
2. **API token with the smallest scope.** My Profile → API Tokens → Create Token → Create Custom Token:
   - Permissions: `Zone` · `Zone` · `Read` and `Zone` · `DNS` · `Edit` (the module looks up the zone, then writes TXT
     records);
   - Zone Resources: `Include` · `Specific zone` · `example.com`;
   - optionally Client IP Address Filtering with the server's outbound IP, and an expiry date you will track.

   The token is shown once. Do not paste it into chat, tickets or a command line.
3. **Store the token on the server only**, in `<dir>/.env` (default `/opt/xdev-hive/.env`, mode 600). `remote.sh` never
   takes the token as an argument, so it does not end up in shell history or in `ps`. From the development machine,
   this prompts without echo and appends the line on the server:

   ```sh
   ssh -t user@server 'umask 077; mkdir -p /opt/xdev-hive; printf "CF_API_TOKEN: "; stty -echo; IFS= read -r t;
     stty echo; echo; printf "CF_API_TOKEN=%s\n" "$t" >>/opt/xdev-hive/.env; chmod 600 /opt/xdev-hive/.env'
   ```

   Or edit the file with an editor on the server and add `CF_API_TOKEN=<token>` without quotes. The deploy stops with
   an error, without printing the value, when the token is missing or malformed (the Cloudflare module would otherwise
   log a malformed token verbatim). To rotate the token, replace the line and deploy again.
4. **Deploy:**

   ```sh
   HIVE_PUBLIC_URL=https://hive.example.com deploy/remote.sh user@server
   ```

   The script saves `HIVE_TLS=dns-cloudflare` and `COMPOSE_PROFILES=https`. Compose builds the Caddy image from
   `deploy/caddy/Dockerfile` (Caddy 2.11.7 with `github.com/caddy-dns/cloudflare`, both pinned), so the first deploy
   needs a few minutes and outbound access to Docker Hub and the Go module proxy. Caddy does not query DNS itself to
   wait for the TXT record (internal networks often block outbound DNS); it waits a fixed
   `HIVE_DNS_PROPAGATION_DELAY` (default `60s`) and lets Let's Encrypt check the record. The check after deploy waits up to
   two minutes for the certificate; logs: `docker compose … logs caddy`.

**Moving from `https://<IP>`.** If the hub ran on `https://192.0.2.10` before, `HIVE_DEFAULT_SNI=192.0.2.10` stays in
`.env` and Caddy keeps serving the IP with the internal CA (and `/ca.crt`) next to the domain, so machines that still use
the IP keep working while you switch them over. Sign-in links and OAuth redirects use `HIVE_PUBLIC_URL`, so browsers
should move to the domain first. When nothing uses the IP any more, remove `HIVE_DEFAULT_SNI` from `.env` and deploy
again. To go back to the IP, deploy with `HIVE_PUBLIC_URL=https://192.0.2.10`; the script resets `HIVE_TLS=auto`.

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

Add `COMPOSE_PROFILES=https` to the env file for Caddy. For an internal domain, also set `HIVE_TLS=dns-cloudflare` and
`CF_API_TOKEN` there (see the section above).

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

## AI SDLC worker machines

The AI SDLC mode ([specs/011](../specs/011-ai-sdlc-mode/spec.md), ADR 0021) writes specs, plans and task breakdowns with
agent runs of kind `sdlc`, then turns approved tasks into ordinary code runs. A team usually keeps a few always-on
machines for this work, separate from developers' laptops.

1. **Add the machine.** On AI SDLC → Fleet (`/sdlc/fleet`), press **Add machine**. The dialog creates a registration
   token that is shared (no owner), carries the label `sdlc` and turns on **Labelled runs only**, then shows the install
   command from [Connecting machines](#connecting-machines). Run it on the machine. The hub only offers `sdlc` runs to
   workers that declare the `sdlc` capability, so update old workers first.
2. **Keep it running.** Headless Linux machines need lingering so the systemd user service survives logout; the install
   script prints the exact `sudo loginctl enable-linger <user>` command when lingering is off. On Windows the
   Task Scheduler task starts at logon, so keep a user logged in.
3. **Log in the CLIs and add accounts.** The worker drives CLIs that are already logged in. A team administrator can add
   accounts of a shared machine and log them in from **Agent accounts** on the Machines page; the login runs on the
   machine and the hub stores no token. On the machine itself use `hive-worker accounts add` and
   `hive-worker accounts update --stop-at-session N --stop-at-week N` to stop using an account before its 5-hour session
   or weekly quota runs out.
4. **Labels.** A machine has up to 10 labels (`[a-z0-9-]`, 32 characters). A run that requires labels only goes to a
   machine that has all of them. A machine with **Labelled runs only** never takes runs that require no label, so normal
   task runs do not fill its slots. Change labels on the Machines page; they apply from the next assignment.
5. **Turn on AI SDLC for a project** in Project → Settings → AI SDLC. Fields of `settings.sdlc`:
   - `defaultMode` and `modes`: the preset (Spec Kit, AI-DLC, BMAD) or custom mode items start with.
   - `runner`: `team` (shared machines, the default) or `requester` (the machine of the person who started the step).
   - `labels`: labels required by the project's `sdlc` runs and by code runs of item tasks, e.g. `sdlc`.
   - `repoSync`: `pr` (default), `direct` or `off` for writing approved documents into the repository.
   - `maxParallel` (1–10, default 2) and `autoRunWaves` for running task waves.
   - `autoApprove`: off by default. It can only make the mode's auto-approval stricter (higher minimum score, fewer
     phases, longer revoke window, extra denied paths and keywords).

### Items that span several projects

An item can list participant projects. Every `sdlc` run gets a short summary of each participant repository under
`.hive/sdlc/projects/<key>.md`. Machines that also declare `sdlc-multirepo` (developer machines and shared machines, not
runner hosts) additionally receive a read-only, shallow checkout of up to seven participant repositories in
`.hive/repos/<key>/`, without `.git`. The worker clones with the machine's own Git credentials: the hub sends no token.
Give the machine read access to the participant repositories (SSH key or credential helper) or those repositories fall
back to the summary; `.hive/repos/STATUS.md` tells the agent which ones are missing and why. Limits and permissions are in
[run-permissions.md](run-permissions.md#run-ai-sdlc-sdlc).

### AI auto-approval

Off by default. The hub approves a human checkpoint of an item's document on the reviewer's behalf only when the mode
allows it for that phase, the project turned it on, the organization agent policy allows it, and the AI checkpoint of
the same review scored at least the threshold with no major finding. Contracts, the requirements of heavy modes or
items, and documents that touch a denied path or keyword are never auto-approved. Every auto-approval is audited and
notified; eligible reviewers can revoke it within the revoke window (24 hours by default), which reopens the human
checkpoints and blocks new code runs that depend on the document until a person approves it.

### Roles

The team role **BA/PO** (`ba`) ranks between viewer and member. It reads and writes AI SDLC items, proposes document
changes and can be picked as a document reviewer, but cannot run agents or manage machines. In the desktop app a user
whose only roles are viewer or BA/PO gets the `writer` profile, which has the AI SDLC menu.

An item that spans projects of several teams is visible to members of any participant team. Each team can only run and
read run logs of its own projects' tasks, and a task breakdown that touches several teams needs a reviewer from each.

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

- A backup contains `hive.dump` (pg_dump custom format), `meta` and `SHA256SUMS` (covering `hive.dump` and `meta`).
  `meta` holds no secret: only `HIVE_COMPOSE_PROJECT` and `HIVE_MASTER_KEY_SHA256`, the SHA-256 of the master key.
  Directories are mode 700 and files mode 600. The dump is validated with `pg_restore --list`; on failure the script
  exits non-zero and keeps older backups.
- **Backups do not include `<dir>/.env`.** The dump holds the stored secrets encrypted with `HIVE_MASTER_KEY`; a backup
  that also carried `.env` would let anyone who obtains it decrypt them all. Keep your own copy of `<dir>/.env`, apart
  from the backups, somewhere only administrators can read (a password manager or secret store), and update it whenever
  `.env` changes. **If you lose `.env`, the stored secrets cannot be recovered**: a backup restores only with the same
  `HIVE_MASTER_KEY`.
- `HIVE_BACKUP_KEEP` (default 14) can be set in `<dir>/.env` or the environment. Old backups are pruned only after the
  new one completes. Copy backups off the server.
- Restore uses the `.env` already on the server. Before stopping the hub it verifies checksums, the dump, that `meta`
  names the same Compose project and that `HIVE_MASTER_KEY` in `<dir>/.env` matches the fingerprint in `meta`. If the
  key differs it stops without changing anything and asks for the original `.env`: put it at `<dir>/.env` and run
  restore again. It then restores in a single transaction while keeping roles, ownership and ACLs, recreates the hub
  from the existing image and waits up to 3 minutes for it to become healthy.
- To restore on a new server, put your copy of `.env` at `<dir>/.env` before the first `deploy/remote.sh` run (it keeps
  existing secrets and only adds missing variables), deploy, then restore.
- **Older backups still contain `.env`.** Backups made before `meta` was introduced hold `.env`, including
  `HIVE_MASTER_KEY` and the database passwords. Restore still accepts them as before: it asks before replacing a
  different `.env` (or use `--yes`). They stay on the server until you delete them or retention prunes them (once
  `HIVE_BACKUP_KEEP` newer backups exist); copies made elsewhere are not touched. Whether to delete them earlier is the
  administrator's decision. Before deleting them, make sure you have your own copy of `.env`, since an old backup may
  hold the only other copy of the key.
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
`sh deploy/test-backup.sh` tests the failure paths, the key check, older backups with `.env` and cron handling with fake
Docker and SSH.

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
