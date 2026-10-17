# Research: Bảng điều khiển CI/CD và triển khai lên máy chủ

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Ngày**: 2026-10-17

## 1. CI/CD của acme hiện nay

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

`app-host` (`192.0.2.10`, user `deploy`) là máy Ubuntu riêng, **không thuộc** hạ tầng Jenkins/RKE2 của acme
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
