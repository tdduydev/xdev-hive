# Research: Bảng điều khiển CI/CD và triển khai lên máy chủ

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Ngày**: 2026-10-17

## 1. CI/CD của ACME hiện nay

Đọc file trong các repo `gitlab.example.com/acme-ai/*` đã clone về máy dev. Repo GitOps trên Gitea và Argo CD chưa clone
nên chưa kiểm được.

**Jenkins là nơi build và deploy chính.**
- Chạy ở `198.51.100.53:8080`, ra ngoài qua `jenkins.example.com` (nginx `198.51.100.55`).
- Đăng nhập bằng Keycloak OIDC, realm `devops`, các vai trò admin, developer, viewer.
- Thư viện chung `deploy/infa/vars/acmeBuild.groovy` chạy lần lượt:
  - checkout;
  - quét bí mật (Gitleaks);
  - quét thư viện (Trivy fs);
  - quality gate;
  - build image;
  - Black Duck, Coverity;
  - quét image (Trivy);
  - đồng bộ DefectDojo;
  - push lên Harbor;
  - ghi tag vào repo GitOps (Gitea), Argo CD tự sync.
- Tag image là `dev-<BUILD_NUMBER>` và `dev-latest`.
- `acmePromote.groovy` đẩy cùng image lên môi trường khác (tham số `APP`, `FROM_ENV`, `TO_ENV`, `BUILD`) bằng cách gắn lại
  tag (`dev-N` → `stg-N` → `prod-N`). Lên prod có bước `input` chờ duyệt 8 giờ, nhưng mặc định `approvers` để trống:
  ai build được thì duyệt được.
- Khoảng 20 job (`jenkins/job-stubs.md`): his-service (`build-dev-v3`), các portal (`build-dev`), keycloak-theme,
  sign-service, ai-studio…
- Job chỉ chạy khi bấm **Build Now** hoặc theo lịch poll (`H/2 * * * *`). **Không có webhook**, vì GitLab không gọi vào
  được mạng `198.51.100.x` (RUNBOOK).

**GitLab CI chỉ kiểm tra và publish.**
- `system-portal-v2`: `check`, `e2e-testenv`. E2E chờ Jenkins deploy xong bằng cách hỏi `build-info.json` của trang.
- `ui-component`: publish npm lên registry của GitLab.
- `keycloak-theme`: build image lên registry của GitLab, chưa thấy nơi nào dùng image này [Inference].
- `his-portal` và `ai-studio` đã bỏ GitLab CI; `his-service` không có.

**Môi trường.**
- Chỉ `dev` đang chạy thật.
- Staging và prod mới có trong tham số mặc định của `acmePromote`. Repo GitOps chưa có thư mục theo môi trường.

**Hạ tầng** (`deploy/infa/docs/ARCHITECTURE.md`): Jenkins, Harbor `.53`; nginx `.55`; RKE2 ba node `.57/.60/.54`; MSSQL
`.59`.

**Chưa có:**
- quay về bản cũ tự động: phải sửa `tag:` trong `values.yaml` rồi push, và `acmePromote` không cho đi lùi;
- duyệt thật trước khi lên prod;
- một chỗ xem chung trạng thái của Jenkins và GitLab CI;
- thông báo khi đỏ.

Theo comment trong file, mọi máy chủ đều đăng nhập SSH bằng mật khẩu.

**ai-studio** triển khai riêng bằng docker compose (`make deploy-build`, `deploy/release.sh` kiểm `/console/api/healthz`),
không qua Jenkins.

## 2. Máy chủ Ubuntu riêng: máy chạy hub

`app-host` (`192.0.2.10`, user `deploy`) là máy Ubuntu riêng, **không thuộc** hạ tầng Jenkins/RKE2 của ACME
(chủ dự án xác nhận 2026-10-17).
- Hub chạy bằng docker compose, project `xdev-hive`, thư mục `/home/deploy/xdev-hive`.
- Triển khai bằng `deploy/remote.sh` từ máy dev:
  1. gửi `git archive` qua SSH;
  2. `docker compose up -d --build`;
  3. chờ healthcheck `/api/v1/health`.
- Sao lưu bằng cron 19:00 UTC (`deploy/backup.sh`, giữ 14 bản).
- Lần triển khai 2026-10-17 làm tay theo đúng các bước mà phần C của spec muốn tự động:
  1. kiểm thư mục và project đang chạy;
  2. sao lưu;
  3. triển khai `origin/main`;
  4. kiểm `/api/v1/health` báo `9947aeb1`.
- Thời gian: sao lưu xong lúc 05:33:42 UTC (`backups/20261017T053342Z`), health báo đúng `9947aeb1` lúc 05:39:08 UTC,
  tức khoảng 5,5 phút cho phần sao lưu xong → dựng image → chạy lại → health. Mốc so cho SC-002.
- Suýt có lỗi: script mặc định dùng `/opt/xdev-hive`, còn bản đang chạy ở `/home/deploy/xdev-hive`. Chạy mặc định sẽ
  tạo `.env` với secret mới cho cùng compose project.

**Kết nối mạng đo từ `app-host`** (2026-10-17, chỉ lấy mã HTTP, không đăng nhập):

| Đích | Kết quả |
|---|---|
| `https://jenkins.example.com/login` | 200, 0,43 s |
| `http://198.51.100.53:8080/login` | quá 8 s, không vào được |
| `https://harbor.example.com/api/v2.0/ping` | 200 |
| `https://git.example.com/` (Gitea) | 200 |
| `https://gitlab.example.com/users/sign_in` | 200 |

Chiều ngược lại (Jenkins và GitLab gọi về hub `hive.example.com`) chưa đo.

**Đo mạng từ trong container hub (T006, 2026-10-19 khoảng 07:40 UTC).**
- Máy đo: container `xdev-hive-hub-1` trên `app-host`, hub ở commit `81f6cc98`.
- Cách đo: mở kết nối TCP (chờ 5 giây) hoặc lấy mã HTTP (chờ 8 giây). Không đăng nhập.

| Đích | Kết quả |
|---|---|
| cổng 22 của `198.51.100.53`, `.54`, `.55`, `.57`, `.59`, `.60` | quá 5 s, không vào được |
| `https://198.51.100.{57,60,54,55}:6443/version` (API Kubernetes) | quá 8 s, không vào được |
| `https://198.51.100.55/version` (nginx cổng 443) | 404, chứng chỉ không khớp khi gọi bằng IP: không có API Kubernetes qua đường này |
| `192.0.2.10:22` từ mạng bridge của Docker | mở: hub SSH được tới chính máy nó |
| `http://198.51.100.53:8080/login` | quá 8 s, như lần đo 2026-10-17 |
| `https://jenkins.example.com/login` | 200 |
| `https://gitlab.example.com/users/sign_in` | 200 |
| `https://argocd.example.com/api/version` | 200, `{"Version":"v3.5.1"}` |

Ghi chú về các con số trên:
- Tên `argocd.example.com` là tên đoán theo mẫu tên của Jenkins và Harbor. [Inference] Đây là Argo CD của
  ACME; chờ chủ dự án xác nhận ở T007.
- Chiều GitLab gọi về hub vẫn chưa đo được: log của hub không ghi đường dẫn request.

**Sự cố và hệ quả:**
- **Lần đo này làm SOC báo động "quét SSH" từ `192.0.2.10` tới các IP của FCI.** Chủ dự án đã gỡ hẳn hub khỏi máy
  `app-host` (container, volume database, `.env`, bản sao lưu).
- Từ nay **không đo bằng cách mở cổng tới máy nội bộ** khi SOC chưa đồng ý. Việc đo mạng là của chủ dự án hoặc quản trị
  hạ tầng.
- Mọi chỗ trong spec, plan, tasks nói hub chạy trên `app-host` hoặc `hive.example.com` đã cũ. Cần chọn máy mới cho hub
  trước khi làm phần triển khai (US3, US4, SC-002).
- Hub không SSH được tới các máy `198.51.100.x`, cũng không gọi được API Kubernetes của chúng. Vì vậy triển khai lên hạ
  tầng ACME phải đi qua `jenkins-job` hoặc `argocd`, không qua `ssh-script` hay `kubectl` (máy runner để sau, Q14).

## 3. Hive hiện có gì để dùng lại

| Phần | Đã có | Thiếu |
|---|---|---|
| `scm` (GitLab, GitHub) | Token mã hoá trong `scm_connections`. GitLab đã gọi `pipelines?sha=` (chỉ lấy pipeline mới nhất) và `statuses`. GitHub gọi `check-runs`. Webhook `/hooks/git/:projectId` xác thực HMAC/token, chống trùng qua `webhook_deliveries`, hàng đợi `scm.event` | Liệt kê pipeline, job, log job, chạy lại, huỷ, bấm job manual. GitHub Actions. Sự kiện pipeline/job trong webhook (GitLab hook chỉ đăng ký push, MR, issue, note) |
| `fleet`, `runs` | Máy đăng ký, nối ra hub qua WebSocket; job có lease 90 s, huỷ qua heartbeat; log `bytea` + SSE `/api/v1/runs/:id/stream`; chọn máy theo nhãn, năng lực, ghim máy | Worker chỉ chạy agent CLI. Lệnh shell chỉ có ở setup script, `checks.commands`, hook chính sách. `task_id` của run cho phép rỗng, nhưng đoạn giao việc cần task (trừ kiểu run prompt), và `project_id`, `branch`, `policy_snapshot` bắt buộc. Nhãn máy do quản trị đội gắn trên hub |
| `sandbox` | Container gVisor trên máy runner, mạng tắt, proxy egress | Không áp dụng cho việc SSH tới máy chủ |
| Secret | `platform/secrets.ts`: AES-256-GCM, khoá dữ liệu mỗi bản ghi, bọc bởi `HIVE_MASTER_KEY`, ngữ cảnh theo bảng và id | Không có kho secret chung cho tổ chức hay dự án |
| `audit`, `notify` | `recordAudit` trong giao dịch. Kênh Telegram, email của tổ chức lọc theo loại sự kiện; hộp thư trong app do module gửi chọn người nhận | Sự kiện CI/deploy trong danh sách sự kiện (enum cố định); đăng ký riêng từng người |
| Che bí mật | Worker có bộ che khi đọc output (`worker/internal/terminal/redact.go`, `runner/checks.go`). `scanSecrets` của contracts chỉ phát hiện | — |
| Quyền | Vai trò ở cấp tổ chức và đội (`contracts/roles.ts`) | Thành viên theo dự án hay môi trường |
| Phê duyệt | `leader.approvals`, `approvals` của review; cây quyền `contracts/roles.ts` | Quyền deploy, duyệt deploy |
| `catalog` | Tổ chức → đội → hệ thống → dự án; một repo mỗi dự án | Môi trường, máy chủ, đích triển khai, bản phát hành |
| Web | `run-page.tsx` (`LogCard`, `EventsCard`, `RunActions`), `use-run-stream.ts` | Màn pipeline, môi trường, máy chủ |
| Desktop | SSH chỉ dùng để clone | Quản lý khoá SSH: đang làm ở phiên riêng ("Client: chuyển đăng nhập SSH mật khẩu sang ssh-key") |

ADR ràng buộc: 0001 (module chỉ gọi nhau qua `index.ts`), 0003 (chỉ PostgreSQL), 0004 (RLS), 0005 (contract-first, giao
thức worker có fixture chung), 0006 (worker nối ra), 0010 (máy chỉ chạy việc của đội mình), 0017 (máy cá nhân chỉ chạy
việc của chủ máy). ADR 0000: thêm dịch vụ, kho, hàng đợi, phụ thuộc ngoài hoặc đổi giao thức thì cần ADR mới.

## 4. Kết quả spike (T001)

**Ngày thử**: 2026-10-19. Mỗi dòng: **có** / **không** / **chưa rõ**.

**Môi trường thử** (một máy dev Windows, mọi kết nối chỉ tới `127.0.0.1`):
- Client: Node 24.18.0 trên Windows (và Node 22.22.1 trong WSL cho phép đo thông lượng).
- Máy chủ SSH giả: WSL Ubuntu **26.04**, OpenSSH 10.2p1 (`openssh-server` 1:10.2p1-2ubuntu3.8), `sshd` riêng chỉ nghe `127.0.0.1:2222`, user `spike`. Chưa thử Ubuntu 22.04/24.04 (xem "Chưa thử được").
- PostgreSQL 18 (gói Ubuntu) trong WSL, cổng `55432`, chỉ nghe `127.0.0.1`.
- Script tạm nằm ngoài repo; không có file nào vào repo ngoài file này.

### 4.1 `ssh2`

| Điểm kiểm | Kết quả | Chi tiết |
|---|---|---|
| Bản mới nhất, giấy phép | **có** | `ssh2` 1.17.0 (bản cập nhật 2026-05-13), MIT. `@types/ssh2` 1.15.6, MIT. Phụ thuộc chạy: `asn1` (MIT), `bcrypt-pbkdf` (BSD-3), `tweetnacl` (Unlicense), `safer-buffer` (MIT) |
| `pnpm audit` | **có** | "No known vulnerabilities found" (pnpm 11.21.0, `ssh2@1.17.0` + `@types/ssh2@1.15.6`); `npm audit` cũng 0 lỗ hổng |
| Kích thước cài đặt | **có** | `ssh2` 1,07 MB + `asn1` 19 KB + `bcrypt-pbkdf` 28 KB + `safer-buffer` 41 KB + `tweetnacl` 170 KB ≈ **1,35 MB** (pnpm thêm 11 gói kể cả optional). `@types/ssh2` 84 KB |
| Chạy khi không có addon C++ | **có** | Không có file `.node` nào được build; `bindingAvailable === false`; ssh2 vẫn nạp và đăng nhập, SFTP, exec đều chạy trên Node 24 (Windows) và Node 22 (Linux). Dùng bản JS thuần của `sshcrypto`. **pnpm chặn script cài đặt**: `pnpm add` báo `ERR_PNPM_IGNORED_BUILDS` cho `ssh2` và `cpu-features`. `pnpm-workspace.yaml` đã có `cpu-features: false` trong `allowBuilds`, T008 phải thêm `ssh2: false` |
| Chạy trong image hub (`node:24.21-bookworm-slim`) | **chưa rõ** | Cần Docker, máy này không có. [Inference] Image slim không có trình biên dịch nên đi đường JS thuần, giống kết quả trên |
| Sinh khoá: `ssh2.utils.generateKeyPairSync('ed25519')` | **có** | Cho khoá riêng dạng `OPENSSH PRIVATE KEY` và dòng công khai `ssh-ed25519 …`. Đăng nhập thành công với `authorized_keys`. `ssh-keygen -y -f` đọc được khoá riêng này. Có tuỳ chọn `passphrase`: đăng nhập được khi truyền `passphrase` |
| Sinh khoá: `crypto.generateKeyPairSync('ed25519')` của Node | **không** (trực tiếp) / **có** (qua đóng gói) | Xuất PKCS#8 (`BEGIN PRIVATE KEY`), `ssh2.utils.parseKey` và `connect({privateKey})` báo `Unsupported key format`. Tự đóng gói seed (`jwk.d`) và khoá công khai (`jwk.x`) thành `openssh-key-v1` không mã hoá (~15 dòng) thì ssh2 đọc được và đăng nhập được. **Đề xuất cho T008/T012: dùng `ssh2.utils.generateKeyPairSync`**, plan mục 5 đang ghi `crypto.generateKeyPairSync` nên sửa |
| Khoá công khai cài vào `authorized_keys` đăng nhập được | **có** | Cả ba cách: ssh2, ssh2 + passphrase, Node đóng gói lại |
| `hostVerifier`: SHA256 khớp `ssh-keygen -lf` | **có** | `base64(sha256(blob))` bỏ `=` cuối, thêm `SHA256:` khớp từng ký tự với `ssh-keygen -lf` cho cả ed25519 và RSA. `hostHash: 'sha256'` trả hex, đổi sang base64 cũng khớp. `hostVerifier` dạng `(key, cb)` bất đồng bộ chạy được |
| Máy có nhiều host key | **có**, cần lưu ý | Server có cả ed25519 và RSA: dấu vân tay hub thấy phụ thuộc thuật toán thương lượng. Ép bằng `algorithms: { serverHostKey: ['ssh-ed25519'] }` cho ra đúng dấu vân tay của thuật toán đó. **Nên lưu cả thuật toán cùng dấu vân tay và ép lúc kết nối**, nếu không có thể báo nhầm "host key đổi" khi máy chủ thương lượng thuật toán khác |
| `hostVerifier` trả `false` | **có** | Lỗi `Host denied (verification failed)`, `level: 'handshake'`, **không** chạy lệnh nào. Thông báo không phân biệt "chưa có dấu vân tay" với "dấu vân tay đổi": hub phải tự ghi nhận lý do trong closure (`hostkey_unknown` / `hostkey_changed`) và lấy dấu vân tay từ đó |
| Phân loại lỗi | **có** | Cổng đóng: `err.code === 'ECONNREFUSED'`, `level: 'client-socket'`. Sai khoá hoặc user lạ: không có `code`, `level: 'client-authentication'`, "All configured authentication methods failed" (hai trường hợp giống nhau). Server nhận kết nối nhưng không nói SSH: `level: 'client-timeout'`, "Timed out while waiting for handshake" đúng `readyTimeout`. `ETIMEDOUT` thật (máy không trả lời gói tin): **chưa rõ**, cần địa chỉ không phản hồi, không thử để tránh dò mạng |
| Lỗi thứ hai sau lỗi đầu | **có**, bẫy | Sau lỗi timeout, `Client` còn phát thêm `error` "Connection lost before handshake". Gắn `once('error')` thì lần thứ hai làm sập tiến trình (`Unhandled 'error' event`). Phải `on('error')` suốt đời kết nối |
| `exec` cần đọc hết stream | **có**, bẫy | Không `resume()` stdout thì `close` không phát với lệnh không in gì (`cat > file`) → treo |

### 4.2 SFTP

| Điểm kiểm | Kết quả | Chi tiết |
|---|---|---|
| Ghi từ `ReadableStream` (Web), tarball vài chục MB | **có** | `Readable.fromWeb(stream)` + `pipeline` vào `sftp.createWriteStream(path, { mode: 0o600 })`: 40 MiB, sha256 hai đầu khớp, RSS đỉnh 78–101 MiB (client). `git archive --format=tar.gz HEAD` của repo này (24,6 MiB, 3903 mục) qua SFTP: sha256 khớp, `tar -tzf` đọc được |
| `chmod 600` | **có** | `createWriteStream` với `mode: 0o600` cho file `600`. `writeFile` với `mode: 0o644` cho `644`, sau `sftp.chmod(…, 0o600)` thành `600`. Không đặt `mode` thì ra `664` (umask của máy thử), nên **luôn đặt `mode` hoặc `chmod` cho file biến** |
| `sftp.mkdir` | **có**, cần lưu ý | Không đệ quy: tạo từng cấp (hoặc `exec mkdir -p` như plan) |
| Thông lượng | **có**, chậm với stream | Gửi 24 MiB qua localhost (client Windows và client trong WSL, mỗi nơi một lần): `createWriteStream` **5–10 MiB/s** (`highWaterMark` 1 MiB không giúp rõ rệt), `fastPut` (từ file, `concurrency: 64`) **37–67 MiB/s**, `exec cat > file` 54–73 MiB/s. Số đo qua localhost, không đại diện mạng thật. Lần chạy `git archive` 24,6 MiB qua `createWriteStream` mất 25 s (gồm cả nén gzip của `git archive`, không tách riêng). Nếu tarball lớn thì T016 nên ghi ra file tạm rồi `fastPut`, hoặc gửi qua `exec cat >`; chưa thử hai cách này trên mạng thật |
| Đứt kết nối giữa lúc ghi | **có**, bẫy | Không có `c.on('close', () => ws.destroy())` thì `pipeline` treo vĩnh viễn (thấy ở lần chạy đầu, process thoát với "unsettled top-level await"). Có handler thì lỗi `No response from server`, để lại file dở dang (917504 byte). Cần timeout và `destroy` rõ ràng, ghi vào `src.new.tar.gz` rồi `mv` hoặc kiểm sha256 |

### 4.3 Chạy bước tách khỏi phiên SSH

Thử với `run.sh` ba bước, bắt `TERM`, ghi `log` và `status.json`, trên `sh` = dash của Ubuntu 26.04.

| Điểm kiểm | Kết quả | Chi tiết |
|---|---|---|
| `nohup setsid sh run.sh >/dev/null 2>&1 & echo $!` vẫn chạy sau khi đóng phiên | **có** | `exec` trả về sau ~90 ms; đóng phiên; phiên mới sau 0,5 s thấy tiến trình còn sống và `status.json` đang cập nhật; chạy xong cả 3 bước |
| `$!` là pgid | **có** | Qua `exec` (shell không tương tác), `setsid` không fork: `pid = pgid = sid` (`ps -o pid,pgid,sid`), tty `?`. Không có `setsid` (chỉ `nohup`): `pgid` khác `pid`, chung nhóm với shell của phiên. [Inference] Trong shell tương tác `setsid` có thể fork và `$!` khác pgid; plan chỉ chạy qua `exec` nên không gặp |
| **Bẫy `cd dir && lệnh &`** | **có**, bẫy | `&` gắn vào cả danh sách `cd … && …`, shell con giữ stdout nên `exec` chỉ trả về sau 9 s (khi `run.sh` xong) và `$!` là pid của shell con. Dùng **`cd dir; lệnh >/dev/null 2>&1 & echo $!`** (dấu `;`), hoặc `sh -c`/`cd` riêng. Đã đo lại với `;`: 90 ms |
| Thiếu chuyển hướng stdout | **có** | `sleep 4 & echo $!` không chuyển hướng: `exec` không trả về sau 2,5 s (kênh bị giữ). Chuyển hướng cả stdout và stderr là bắt buộc |
| `kill -TERM -- -<pgid>` | **có** | `run.sh` bắt `TERM`, ghi `status.json` `{"done":true,"exit":143}` và dòng log, thoát sau **352 ms**, không sót tiến trình trong nhóm (kể cả `sleep` con) |
| `kill -TERM <pid>` (chỉ tiến trình, không nhóm) | **có**, kém | Dash chỉ chạy `trap` khi lệnh đang chạy ở foreground xong: `run.sh` thoát sau **19,1 s** (bằng `sleep 20` còn lại). Hub phải dùng `kill -TERM -- -<pgid>` |
| `tail -c +<n>` | **có**, cần lưu ý | `n` tính theo **byte, từ 1**: đọc từ `offset + 1`. Log tiếng Việt: cắt giữa ký tự 3 byte sinh ký tự lỗi nếu giải mã từng đoạn. Lưu offset theo byte và nối `Buffer` (hoặc `StringDecoder`) trước khi giải mã |
| Watch qua phiên ngắn và nối lại | **có** | Mô phỏng job theo dõi: mỗi lần mở một phiên (`connect` + `tail` + `cat status.json` + `end`), lưu offset ngay sau mỗi lần; `kill -9` watcher giữa chừng, chờ 3 s, chạy lại: log ghép = log trên máy chủ (432 byte, 8 dòng), không trùng, không thiếu. Giả lập bằng file trạng thái; trong hub là giao dịch Postgres |
| Chi phí mỗi lần poll | **có** | ~**445 ms** cho một phiên ngắn (bắt tay + xác thực bằng JS thuần, qua localhost/WSL). Poll 2 giây một lần nghĩa là cứ 2 giây hub làm một lần bắt tay đầy đủ; nhiều lần triển khai song song tốn CPU hub. [Inference] Có thể giữ phiên mở suốt lần triển khai, mở lại khi đứt (chưa thử) |
| Ubuntu 22.04 và 24.04 | **chưa rõ** | Chỉ có 26.04. `setsid` (util-linux) và `dash` giống nhau về cách dùng; [Inference] kết quả như trên, chưa kiểm |
| Trong image `sshd` dự định cho test | **chưa rõ** | Cần Docker |

### 4.4 pg-boss

pg-boss **12.37.1** (hub đang dùng `^12.37.1`; bản mới nhất 12.38.0, yêu cầu Node ≥ 22.12), PostgreSQL 18 trong WSL, queue giống `mergeQueue` (`policy: 'stately'`, `retryLimit: 3`, `expireInSeconds: 600`), worker `batchSize: 1`.

| Điểm kiểm | Kết quả | Chi tiết |
|---|---|---|
| Tự xếp lại sau **2 giây** bằng `singletonKey` + `startAfter` | **có** | Handler gọi `send(queue, data, { singletonKey, startAfter: now+2000 })` ngay trong lúc chạy: `send` trả id (không bị chặn), khoảng cách giữa các lần chạy 2005, 2015, 2020, 4009, 2008, 2014 ms với `pollingIntervalSeconds: 2` (**trung bình 2,35 s, một lần 4 s**); với `pollingIntervalSeconds: 0.5` luôn **2,00–2,04 s** (2026, 2035, 2002, 2013, 2027, 2007) |
| Tự xếp lại sau **15 giây** | **có** | Khoảng cách thật **16,06–16,07 s** (3 lần), `pollingIntervalSeconds: 2`. Nghĩa là trễ thêm ~1 s so với `startAfter` |
| `singletonKey` với policy `stately` | **có** | Job đầu còn chờ: `send` thứ hai cùng khoá trả `null`. Khoá khác: được. Khi có một job đang chạy: `send` đầu (có `startAfter`) được thêm làm job chờ, `send` thứ hai trả `null`, tức tối đa **một chạy + một chờ** |
| Dừng êm rồi bật instance khác | **có** | Job hẹn giờ do instance 1 xếp được instance 2 (tiến trình mới) xử lý sau 5,08 s kể từ lúc xếp (`startAfter` 4 s), `retryCount = 0` |
| `boss.stop({ graceful: true, timeout: 10_000 })` khi job đang chạy dở | **có** | `stop` trả về sau 10,05 s; `job.signal` bị abort sau 10,02 s; instance mới nhận lại **11,1 s** sau lúc stop, `retryCount = 1`. Handler cần tôn trọng `signal` và idempotent |
| Hub chết đột ngột (`kill -9`) khi job đang chạy | **có**, chậm | Instance mới nhận lại job sau **60,0 s** (`expireInSeconds: 20`, không heartbeat) hoặc **45,8 s** (`heartbeatSeconds: 10`, `expireInSeconds: 600`), `retryCount = 1`. Cả hai bị chặn bởi chu kỳ giám sát của pg-boss (mặc định 60 s) [Inference]. Với `expireInSeconds: 600` mà không có heartbeat thì job kẹt tới 10 phút (suy từ cấu hình, chưa chạy). `delivery-deploy-watch` nên đặt `heartbeatSeconds` (tối thiểu 10) hoặc `expireInSeconds` ngắn |
| Chạy với role `hive_jobs`, `createSchema: false` như hub | **chưa rõ** | Thử bằng superuser `spike`, schema `pgboss_spike` do pg-boss tự tạo. Cách tạo role giữ nguyên như hub hiện nay |

### 4.5 Những điều chỉnh đề xuất cho plan

1. **Mục 5, "Khoá"**: ghi `ssh2.utils.generateKeyPairSync('ed25519')` thay cho `crypto.generateKeyPairSync` (ssh2 không đọc PKCS#8 của Node).
2. **Lệnh tách phiên**: ghi rõ `cd <dir>; nohup setsid sh run.sh >/dev/null 2>&1 & echo $!` (dùng `;`, không `&&`) và huỷ bằng `kill -TERM -- -<pgid>`.
3. **Host key**: lưu thuật toán cùng dấu vân tay và ép `serverHostKey` lúc kết nối; ghi lý do từ chối trong closure.
4. **`delivery-deploy-watch`**: queue `stately`, `singletonKey` theo `deployId`; poll nhanh nhất ~2 s; chịu được trễ khôi phục ≤ ~60 s khi hub chết đột ngột (đặt `heartbeatSeconds`; chưa đo với handler thật đang gửi heartbeat), ngắn hơn khi hub dừng êm.
5. **T008**: thêm `ssh2: false` vào `allowBuilds`; kết nối: `on('error')` thường trực, `readyTimeout: 10_000`, xử lý `close` khi đang SFTP.

### 4.6 Chưa thử được

| Việc | Lý do |
|---|---|
| Ubuntu 22.04 / 24.04 | WSL của máy này chỉ có Ubuntu 26.04; cài thêm bản khác là tải về, chưa được cho phép |
| Image `sshd` dựng từ `ubuntu:24.04` qua mirror `public.ecr.aws`, thời gian dựng | Cần Docker, máy này không có |
| `ssh2` chạy trong image hub | Cần Docker |
| Đường từ mạng bridge của Docker tới `192.0.2.10:22` | Máy hub cũ đã gỡ; theo ràng buộc an toàn không SSH hay dò tới máy khác |
| `ETIMEDOUT` thật khi máy chủ không trả lời | Cần địa chỉ không phản hồi; không dò mạng ngoài localhost |
| pg-boss với role `hive_jobs` trên Postgres của hub | Chưa chạy hub; spike dùng Postgres 18 riêng trong WSL |
| Thông lượng, độ trễ SSH qua mạng thật | Chỉ đo qua localhost |
