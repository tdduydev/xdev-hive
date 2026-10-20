# Kiến trúc xDev Hive

Bản thiết kế ngày 11/10/2026, đối chiếu lại với code ngày 12/10/2026 (commit `c550537`). Phần thiết kế chưa có trong code ghi **[Chưa làm]**. Hiện trạng đầy đủ, bằng tiếng Anh, ở [add.md](add.md). Các lựa chọn công nghệ và phạm vi đã chốt nằm ở [decisions.md](decisions.md). Nguồn tham khảo ghi ở cuối file. Điều tự suy ra, chưa có nguồn, ghi **[Suy luận]**.

Cập nhật riêng spec 009 ngày 14/10/2026, đối chiếu `origin/main` tại `8676c4f`: hub đã nối module
`codereview` (T070) và gửi/đánh giá lệnh kiểm (T091). Luồng thực tế ở mục 4.3; commit status còn chờ T101.

## 1. Tổng quan

xDev Hive là nơi nhiều đội trong một tổ chức giao việc cho coding agent CLI (Claude Code, Codex, Gemini CLI), dùng chung memory, tài liệu, skill, rồi review và merge kết quả.

Hệ thống có bốn khối:

| Khối | Là gì | Viết bằng |
|---|---|---|
| **Hub** | Một modular monolith. Một image, hai vai trò tiến trình: `api` (HTTP, MCP, SSE và cổng WSS cho worker) và `jobs` (pg-boss). **[Chưa làm]** tách `gateway` riêng, vai trò `collab` | TypeScript (Node) |
| **Worker** | Daemon trên máy dev. Gọi ra hub, chạy CLI trong git worktree tạm | Go |
| **Runner host** | Cùng binary Go ở chế độ `host`, trên server nội bộ. Chạy mỗi run trong một container gVisor dùng một lần | Go |
| **Dữ liệu** | PostgreSQL (dữ liệu, hàng đợi pg-boss, NOTIFY, vector, log run). **[Chưa làm]** kho blob tương thích S3 cho log đã lưu trữ và artifact | — |

Web là ứng dụng React do hub phục vụ. App desktop là Tauri, gói cửa sổ web và worker Go (sidecar).

**Vì sao là modular monolith, không tách service:** GitHub Actions, GitLab Runner, Buildkite và Coder đều có một control plane tập trung, còn agent là tiến trình mỏng tự gọi ra. Đội nhỏ, tự host, cần ranh giới module rõ chứ chưa cần deploy riêng từng phần. Ranh giới được ép bằng kiểm tra phụ thuộc (`pnpm deps`, chạy trong `pnpm check` và CI), theo cách Shopify làm với Packwerk. [1][2][3][4][5]

```mermaid
flowchart TB
  subgraph C["Người dùng"]
    direction LR
    WEB["Web React"]
    DESK["Desktop Tauri<br/>+ worker sidecar"]
    CLIAG["CLI agent<br/>gọi MCP"]
    GITU["Issue / PR trên<br/>GitHub, GitLab"]
  end
  EDGE["Caddy (tuỳ chọn, profile https)<br/>/rpc · /api · /mcp · /ws/worker · /ws/terminal · /hooks/git"]
  subgraph HUB["Hub (một image, hai vai trò)"]
    direction LR
    API["api<br/>oRPC, SSE, MCP, webhook,<br/>WSS cho worker và runner host"]
    JOBS["jobs<br/>pg-boss, saga, merge queue"]
  end
  subgraph DATA["Dữ liệu"]
    PG[("PostgreSQL 18<br/>RLS · pgvector · pg-boss · log run")]
  end
  subgraph EXEC["Thực thi"]
    direction LR
    WK["Worker Go<br/>trên máy dev"]
    RH["Runner host Go<br/>Docker + gVisor"]
    EGP["Egress proxy riêng mỗi run<br/>allowlist"]
  end
  SCM["GitHub App · GitLab"]
  NOTI["Telegram · email"]

  C --> EDGE --> HUB
  HUB --> DATA
  WK -->|"gọi ra, WSS"| API
  RH -->|"gọi ra, WSS"| API
  RH --> EGP
  API --> SCM
  JOBS --> SCM
  SCM -->|"webhook"| API
  JOBS --> NOTI
  WK -->|"push nhánh"| SCM
  RH -->|"push nhánh"| SCM
```

## 2. Module của hub

Mỗi module là một thư mục trong `apps/hub/src/modules/<tên>/`, chỉ lộ ra ngoài qua `index.ts`. Module khác chỉ được import `index.ts` đó. `dependency-cruiser` chạy trong `pnpm deps` (gồm trong `pnpm check` và CI) và chặn import vượt ranh giới. [5]

Bảng thuộc schema `hive`, trừ bảng có tiền tố `auth.` (Better Auth).

| Module | Việc | Sở hữu bảng chính |
|---|---|---|
| `identity` | Đăng nhập (Better Auth: SSO OIDC, GitHub/GitLab, email), phiên, JWT, OAuth cho MCP | `auth.user`, `auth.account`, `auth.session`, `auth.ssoProvider`, `auth.oauth*` |
| `tenancy` | Tổ chức, thành viên, đội, hệ thống, lời mời, cấp quyền | `orgs`, `org_members`, `teams`, `team_members`, `systems`, `invitations` |
| `catalog` | Dự án, file mẫu cho agent, saga tạo dự án, cấu hình dự án (jsonb `settings` trên `projects`), merge queue | `projects`, `project_provision_steps`, `merge_queue_entries` |
| `scm` | GitHub App, GitLab, kết nối Git của tổ chức, webhook vào, mở PR/MR | `scm_connections`, `webhook_deliveries` |
| `tasks` | Task, plan mode, nhận việc từ issue, phụ thuộc giữa task (run task chờ task trước xong) | `tasks`, `plans`, `task_dependencies` |
| `runs` | Máy trạng thái của run, lease, chính sách kết quả, review chéo, SSE | `runs`, `run_events`, `run_logs`, `run_leases` |
| `codereview` | Phiên review PR do run code mở: checkpoint quy tắc, AI, CI, người duyệt; trả lại, vòng sửa, SLA và cổng hàng merge. | `code_reviews`, `code_review_gate_runs` |
| `fleet` | Máy, đăng ký, cổng WSS, phiên bản worker, nhãn máy (`labels`, `labels_only`), gói agent của máy dùng chung | `machines`, `machine_tokens`, `registration_tokens` |
| `sdlc` | Chế độ AI SDLC (specs/011, ADR 0021): chế độ và preset, hạng mục qua các giai đoạn, bước soạn tài liệu bằng run `sdlc`, câu hỏi, đồng bộ tài liệu vào repo, tách task theo đợt, cổng chặn run code, truy vết, hội tụ, release notes, tự duyệt, hạng mục nhiều dự án, chỉ số | `sdlc_modes`, `sdlc_items`, `sdlc_item_projects`, `sdlc_item_phases`, `sdlc_artifacts`, `sdlc_artifact_syncs`, `sdlc_questions`, `sdlc_steps`, `sdlc_item_tasks`, `sdlc_trace_links`, `sdlc_overrides`, `sdlc_auto_approvals` |
| `sandbox` | Image môi trường, allowlist mạng, cấu hình sandbox của tổ chức | `sandbox_org_settings`, `env_images`, `egress_allowlists` |
| `knowledge` | Memory (tìm theo từ và pgvector), tài liệu có phiên bản, skill, bộ skill mặc định của Hive (`packages/skill-pack`, bật/tắt theo tổ chức và dự án), đề xuất sửa, nhập từ hệ cũ. **[Chưa làm]** sửa tài liệu cộng tác (Yjs) | `memories`, `docs`, `doc_versions`, `skills`, `skill_versions`, `skill_pack_settings`, `proposals`, `legacy_*` |
| `skilllearn` | Agent đề xuất skill sau việc khó (ADR 0025): chọn run đáng học, lô mỗi ngày mỗi dự án chạy run `skill_proposal` chỉ đọc, bỏ trùng, hạn mức theo ngày, duyệt thành PR vào kho skill hoặc skill của tổ chức, số liệu | `skill_learning_batches`, `skill_learning_marks`, `learned_skill_proposals` |
| `docsync` | Nhà tài liệu trên GitHub/GitLab, nhập và đồng bộ hai chiều, xung đột, ảnh/đính kèm và bản trích có duyệt; nhận sự kiện lưu từ `knowledge` qua hook | `doc_homes`, `doc_repo_files`, `doc_imports`, `doc_import_files`, `doc_sync_batches`, `doc_conflicts`, `doc_assets`, `doc_extracts` |
| `delivery` | Bảng điều khiển CI/CD và triển khai (specs/020, ADR 0030, 0031): kết nối Jenkins (token từng người, người theo dõi), Argo CD, Kubernetes; tab CI/CD gộp pipeline GitLab và build Jenkins; máy chủ có khoá SSH do hub sinh, môi trường, đích triển khai (`ssh-script`, `jenkins-job`, `gitlab-manual`, `argocd`, `kubectl`), duyệt, khoá, quay về, log triển khai đã che bí mật. **[Chưa làm]** | `ci_jenkins_connections`, `ci_jenkins_user_tokens`, `ci_project_jobs`, `ci_runs_seen`, `deploy_connections`, `deploy_servers`, `deploy_environments`, `deploy_targets`, `deploys`, `deploy_log_chunks`, `deploy_approvals` |
| `leader` | Chat với leader agent, đề xuất hành động cần người duyệt | `chat_threads`, `chat_messages`, `approvals` |
| `artifacts` | Artifact (specs/012, ADR 0023): sản phẩm có phiên bản của agent và người (markdown, code, html, mermaid, react), phạm vi, link công khai, biên dịch `react` ở hub, khung cách ly và job dọn thùng rác. MVP chưa có `svg`, `json`, `csv`, ảnh, PDF, phạm vi `team`/`org` và Terminal Leader | `artifacts`, `artifact_versions`, `artifact_links`, `artifact_previews`, `artifact_public_links` |
| `terminal` | Terminal Leader: phiên Claude CLI tương tác trên máy dùng chung, chuyển tiếp web ↔ worker qua `/ws/terminal`, bản ghi đã che bí mật (specs/010 lát đầu) | `terminal_sessions`, `terminal_chunks` |
| `mcp` | Cổng MCP: xác thực token, giới hạn tool theo vai trò, ghi audit | — (dùng module khác) |
| `notify` | Telegram, email, hộp thư trong app | `notification_channels`, `notifications`, `inbox_items` |
| `cost` | Tổng hợp token, chi phí theo run, đội, dự án, người, CLI. Chỉ theo dõi; cột chi phí nằm trên `runs` | — |
| `audit` | Nhật ký append-only mọi thao tác ghi và mọi lời gọi MCP | `audit_log` |
| `system` | Health, phiên bản, manifest cập nhật app desktop | — |
| `platform` | Lõi dùng chung: `db` + transaction có tenant, cấu hình, mã hoá secret, migration, pg-boss, BlobStore | `migrations`, `blobs`, `blob_chunks` |

Giao tiếp giữa module:
- **Đồng bộ:** gọi hàm public trong cùng transaction khi cần nhất quán (ví dụ tạo task kèm audit).
- **Bất đồng bộ:** đẩy job pg-boss ngay trong transaction nghiệp vụ (`enqueue(..., { tx })`), nên job có khi và chỉ khi thay đổi được commit; cập nhật run gọi `pg_notify('hive_runs', runId)` trong cùng transaction. Consumer phải idempotent. **[Chưa làm]** bảng `outbox`. [6]

## 3. Mô hình dữ liệu

```mermaid
erDiagram
  ORGS ||--o{ ORG_MEMBERS : "gồm"
  ORGS ||--o{ TEAMS : "có"
  TEAMS ||--o{ TEAM_MEMBERS : "gồm"
  AUTH_USER ||--o{ ORG_MEMBERS : "là"
  AUTH_USER ||--o{ TEAM_MEMBERS : "là"
  TEAMS ||--o{ SYSTEMS : "sở hữu"
  SYSTEMS ||--o{ PROJECTS : "gồm"
  PROJECTS ||--o{ TASKS : "có"
  TASKS ||--o{ RUNS : "chạy"
  RUNS ||--o{ RUN_EVENTS : "ghi"
  RUNS ||--o{ RUN_LOGS : "log"
  RUNS ||--o| RUN_LEASES : "giữ"
  MACHINES ||--o{ RUN_LEASES : "nhận"
  TEAMS ||--o{ MACHINES : "sở hữu"
  PROJECTS ||--o{ MERGE_QUEUE_ENTRIES : "xếp hàng"
  PROJECTS ||--o{ CODE_REVIEWS : "review PR"
  RUNS ||--o{ CODE_REVIEWS : "tạo vòng"
  REVIEW_WORKFLOWS |o--o{ CODE_REVIEWS : "chụp quy trình"
  CODE_REVIEWS ||--o{ CODE_REVIEW_GATE_RUNS : "chạy checkpoint"
  PROJECTS ||--o{ MEMORIES : "nhớ"
  PROJECTS ||--o{ DOCS : "tài liệu"
  TEAMS ||--o{ SKILLS : "skill"
  PROJECTS ||--o{ EGRESS_ALLOWLISTS : "mạng"
  SDLC_MODES |o--o{ SDLC_ITEMS : "chụp chế độ"
  SDLC_ITEMS ||--o{ SDLC_ITEM_PROJECTS : "dự án chính, tham gia"
  PROJECTS ||--o{ SDLC_ITEM_PROJECTS : "tham gia"
  SDLC_ITEMS ||--o{ SDLC_ITEM_PHASES : "giai đoạn"
  SDLC_ITEMS ||--o{ SDLC_ARTIFACTS : "tài liệu"
  SDLC_ITEMS ||--o{ SDLC_STEPS : "bước"
  SDLC_STEPS ||--o| RUNS : "run sdlc"
  SDLC_ITEMS ||--o{ SDLC_ITEM_TASKS : "tách task"
  SDLC_ITEM_TASKS }o--|| TASKS : "là"
  TASKS ||--o{ TASK_DEPENDENCIES : "phụ thuộc"
```

Quy tắc chung:
- Mọi bảng thuộc tenant có `org_id`, `team_id` (có index) và bật **RLS + FORCE RLS**. Mỗi policy có cả `USING` và `WITH CHECK`, để UPDATE không chuyển được dòng sang đội khác. [7][8]
- Hub gắn tenant vào **transaction**, không vào kết nối: `withTenant()` gọi `set_config('app.user_id', $1, true)` và `set_config('app.org_id', $2, true)`. Gắn ở mức session sẽ rò sang request khác qua pool. [7]
- Bốn role Postgres, không role nào là superuser hay có BYPASSRLS: `hive_owner` (sở hữu schema `hive`, chạy migration), `hive_app` (hub dùng, chịu RLS), `hive_auth` (schema `auth` của Better Auth), `hive_jobs` (schema `pgboss`). [8]
- Test bắt buộc: truy vấn không có tenant context trả về 0 dòng ở mọi bảng tenant.
- Dự án thuộc một hệ thống, hệ thống thuộc một đội. **[Chưa làm]** cấp quyền thêm cho một dự án qua `role_bindings` (người hoặc đội khác).
- `audit_log` là append-only: role `hive_app` không có UPDATE, DELETE, TRUNCATE.

### Tài liệu đồng bộ và kho file

`knowledge` giữ nội dung markdown, phiên bản và quyền truy cập; `docsync` quản lý nhà (repo + nhánh + thư mục),
đường dẫn và trạng thái đồng bộ. Hook lưu tài liệu xếp job đẩy theo nhà, gom 60 giây và tối đa 10 phút; webhook
`/hooks/docs/:homeId` và lịch kéo 15 phút nhận thay đổi từ repo. Repo đổi riêng thì cập nhật hub; hai bên đổi thì hợp
ba bản theo khối, không hợp được thì chờ người giải quyết. Chế độ `pr` dùng PR cuốn chiếu, `direct` commit thẳng.
File gốc được lưu cạnh tài liệu trong repo; chỉ dùng Git LFS khi `.gitattributes` đã có quy tắc khớp. Bản trích
markdown chỉ ở hub và phải được duyệt. Chi tiết: [ADR 0028](adr/0028-docs-repo-sync.md).

BlobStore chung ở `platform/blob-store.ts` cung cấp `put/get/stat` dạng stream; PostgreSQL lưu metadata trong
`blobs` và bytea theo đoạn 512 KiB trong `blob_chunks`, khử trùng theo SHA-256 trong từng tổ chức. Mọi thao tác qua
transaction `withTenant()` bằng `hive_app`; hai bảng bật và ép RLS. Stream phải được đọc hết trước khi transaction
đóng. Job `platform-blob-gc` dọn blob không còn tham chiếu sau thời gian giữ 24 giờ. Kho file nằm trong bản sao lưu
PostgreSQL hiện tại; chuyển sang S3 có thể thực hiện sau qua giao diện BlobStore.

Giới hạn cấu hình bằng byte nguyên dương: `HIVE_DOC_ASSET_MAX_BYTES` mặc định 52428800 (50 MiB),
`HIVE_DOC_ORG_STORAGE_BYTES` mặc định 5368709120 (5 GiB), `HIVE_DOC_IMPORT_MAX_BYTES` mặc định 2147483648 (2 GiB).
Hai file `.env.example` và `deploy/compose.yaml` khai báo cùng mặc định này.

### Bảng điều khiển CI/CD và triển khai

**[Chưa làm]** Thiết kế của [spec 020](../specs/020-cicd-console/spec.md); chưa có code trên `main`. Mọi bảng mới có
`org_id`, bật và ép RLS, truy cập qua `withTenant()` bằng `hive_app`; một migration cho cả spec.

- Kết nối: `ci_jenkins_connections` (người theo dõi) và `ci_jenkins_user_tokens` (token Jenkins từng người, mã hoá theo
  bản ghi); `deploy_connections` giữ Argo CD và Kubernetes (token dùng chung của tổ chức). Mọi token và khoá riêng mã
  hoá bằng `platform/secrets.ts`, chỉ giải mã trong bộ nhớ lúc dùng.
- Máy chủ và đích: `deploy_servers` giữ khoá riêng mã hoá, khoá công khai, khoá đang chờ đổi và `host_keys` (thuật toán cùng
  dấu vân tay). `deploy_environments` thuộc hệ thống (chính sách duyệt, khoá); `deploy_targets` là dự án × môi trường, cấu
  hình `jsonb` có phiên bản.
- Lần triển khai: `deploys` (trạng thái, các bước, phiên bản, `origin` là `hive` hoặc `external`, vị trí log đã đọc trên
  máy chủ), `deploy_log_chunks` (log `bytea` theo đoạn, đã che bí mật, xem bằng SSE), `deploy_approvals`. Mỗi đích có tối đa
  một lần đang đi do Hive tạo. `ci_runs_seen` chỉ giữ trạng thái đã thấy để báo đỏ/xanh; log CI không lưu.
- `ssh-script`: hub dùng `ssh2`, host key cố định, tải thư mục `~/.hive-deploy/<deployId>/` qua SFTP và chạy `run.sh` tách
  khỏi phiên SSH. Job `delivery-deploy-watch` (pg-boss) mở phiên ngắn đọc `log` và `status.json` từ vị trí đã lưu, nên hub
  khởi động lại (kể cả khi triển khai chính nó) không làm dở bước.
- Các cách khác gọi bằng `fetch`: Jenkins (`delivery-ci-poll` hỏi 5 phút khi rảnh, 15 giây khi có build chạy), GitLab qua
  `scm` và webhook Pipeline/Job, Argo CD (`sync`, `rollback`), API Kubernetes (`PATCH` image).
- Mạng: hub không vào được cổng 22 và API Kubernetes của máy nội bộ (T006), nên hạ tầng acme đi qua `jenkins-job`
  hoặc `argocd`. Chi tiết Jenkins, Argo CD thật chưa kiểm (T007) và vẫn là suy luận. Chi tiết:
  [ADR 0030](adr/0030-hub-deploys-over-ssh.md), [ADR 0031](adr/0031-external-ci-and-deploy-sources.md).

## 4. Run

### 4.1 Máy trạng thái

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> planning: plan mode bật
  planning --> awaiting_plan: kế hoạch xong
  awaiting_plan --> queued: người duyệt
  awaiting_plan --> cancelled: người từ chối
  queued --> leased: worker hoặc runner nhận
  leased --> preparing: tạo worktree / container, setup
  preparing --> running: chạy CLI
  running --> awaiting_input: agent cần duyệt (chưa làm)
  awaiting_input --> running: có trả lời
  running --> verifying: agent kết thúc
  verifying --> succeeded
  verifying --> no_changes
  verifying --> needs_review
  verifying --> failed
  leased --> lost: lease hết hạn
  preparing --> lost: lease hết hạn
  running --> lost: lease hết hạn
  lost --> queued: còn lượt thử
  lost --> failed: hết lượt thử
  running --> cancelling: người huỷ
  cancelling --> cancelled
  succeeded --> [*]
  no_changes --> [*]
  needs_review --> [*]
  failed --> [*]
  cancelled --> [*]
```

- Mọi chuyển trạng thái ghi một dòng `run_events` và gọi `pg_notify('hive_runs', runId)` trong cùng transaction. **[Chưa làm]** chuyển sang `awaiting_input`: hub chưa xử lý `approval_needed`.
- Mỗi lần thử có `attempt` riêng. Hub từ chối mọi gói của `attempt` cũ (fencing), nên worker treo rồi sống lại không ghi đè được run đã giao lại. [9]
- **Chính sách kết quả** chạy ở hub, ở bước `verifying`, theo cấu hình dự án ([decisions.md](decisions.md)). `command` được gửi cho worker và đánh giá từ báo cáo; thiếu kết quả thì `needs_review`. **[Chưa làm]** kiểm tra `ci` của chính sách kết quả; checkpoint CI của quy trình Code chạy riêng. Hub lưu `policy_snapshot` vào run để kết quả không đổi khi cấu hình đổi sau.
- **Review chéo:** bước `review` tạo một run con loại `review` trên cùng nhánh, với CLI ghi trong kiểm tra review (ví dụ Codex viết, Claude review; trùng CLI run cha vẫn được, để dự án chỉ có một loại CLI vẫn dùng được). Run cha chờ kết quả.

Quy trình Code khớp run thay riêng kiểm tra review chéo và việc tự vào hàng merge; các kiểm tra khác của chính sách
kết quả vẫn là cổng vào; xem mục 4.3.

### 4.2 Giao job và lease

- Run `queued` được ghép với máy theo: đội sở hữu, CLI có sẵn, chỗ trống, loại máy (dự án bật sandbox chỉ giao cho runner host), capability của worker (run `sdlc` cần `sdlc`) và nhãn máy. **[Chưa làm]** ưu tiên máy dev rảnh rồi mới tới container.
- Nhãn máy (tối đa 10, `^[a-z0-9][a-z0-9-]{0,31}$`) đặt lúc tạo token đăng ký hoặc sửa trên trang Máy. Run đòi nhãn (run `sdlc` và run code của task hạng mục, theo `settings.sdlc.labels` của dự án) chỉ giao cho máy có đủ các nhãn đó. Máy bật `labels_only` không nhận run không đòi nhãn, để máy dành cho AI SDLC không bị run thường chiếm chỗ.
- Lease lưu trong `run_leases`, có hạn (mặc định 90 giây) và được gia hạn bằng heartbeat. Máy mất kết nối thì lease hết hạn, run sang `lost`. Chỉ một tiến trình `api` giao job, vì đề nghị đi qua socket mà tiến trình đó giữ; **[Chưa làm]** chuyển tiếp qua NOTIFY để chạy nhiều tiến trình `api`. [9][10]
- Job đẩy qua WSS. **[Chưa làm]** long-poll `POST /v1/worker/claim` (khoảng 50 giây) khi WSS không qua được proxy công ty, giống GitHub runner. [11][12]

### 4.3 Quy trình review code

[Spec 009](../specs/009-code-review-workflows/spec.md) và [ADR 0018](adr/0018-code-review-workflows.md) dùng chung
trang Quy trình duyệt với tài liệu. `knowledge.review_workflows` lưu `subject = doc|code` (chọn khi tạo, không đổi)
và cấu hình Code; `codereview` sở hữu phiên và lượt checkpoint riêng, không dùng `review_instances` của tài liệu.
Chỉ PR do run Hive mở thuộc phạm vi này; phê duyệt trên GitHub/GitLab không tính vào checkpoint người duyệt.

Luồng thực tế trên hub:

1. Run code kết thúc `succeeded` hoặc `needs_review`, có PR và khớp quy trình theo dự án, nhánh đích, loại task,
   đường dẫn đổi → bỏ kiểm tra `outcome.review` (ghi `skipped`), mở phiên tại `head_sha`, chưa tự vào hàng merge.
   Không khớp thì giữ review chéo và chính sách kết quả cũ; chuyển đổi từ cấu hình dự án chỉ tạo bản nháp chủ động.
2. Phiên chụp quy trình, chạy checkpoint theo thứ tự: quy tắc, AI, CI trên đầu PR, người duyệt với quorum/SLA.
   Điều kiện checkpoint không thoả thì bỏ qua. AI tạo 1–3 run `review` chỉ đọc, mặc định của đội
   (`owner_user_id = null`, `created_by = workflow:<id>`), trên máy dùng chung/runner host; `runner = requester`
   kế thừa chủ run code. Người giao việc không tự duyệt trừ khi checkpoint cho phép; quản trị tổ chức luôn quyết được.
3. Trả lại đi tới agent, người giao việc hoặc checkpoint người duyệt trước. Run sửa dùng loại `code`, cùng task,
   nhánh, CLI và chủ, không lập kế hoạch lại, giới hạn mặc định 2 lượt và chịu ngân sách task.
   Commit mới thay phiên cũ bằng `superseded`, mở vòng mới với bản chụp vòng đầu; kiểm tra tự động chạy lại.
   Phê duyệt người trước checkpoint trả lại được giữ, trừ khi bật `dismissStaleApprovals`.
4. Phiên `approved` vào hàng merge theo chế độ hiệu lực (`project`, `auto`, `manual`); hàng merge phải chờ nếu
   phiên chưa duyệt. Webhook push tay mở vòng mới; merge/đóng PR kết thúc phiên thành `merged`/`cancelled`.
   Mọi quyết định gắn SHA đã xem; quyết thay checkpoint tự động cần quyền và lý do.

`runs` import `codereview/index.ts`; `codereview` không import ngược `runs`. `app.ts` đăng ký router
`codeReviews`, tiêm cổng tạo run và đọc bằng chứng. Vai trò `jobs` trong `main.ts` tiêm `startReviewRuns`,
`queueFixRun`, `runEvidence`, đăng ký worker `codereview` (CI hỏi lại mỗi 2 phút, tối đa 60 lần),
cron `codereview-sla` mỗi 10 phút và handler SCM. `catalog` nhận `reviewGate` qua deps để tránh vòng import.
Mọi dữ liệu phiên đi qua `withTenant()`, hai bảng bật và ép RLS.

### 4.4 Chế độ AI SDLC

[Spec 011](../specs/011-ai-sdlc-mode/spec.md) và [ADR 0021](adr/0021-ai-sdlc-mode.md). Module `sdlc` đưa một yêu cầu
lớn (hạng mục) qua các giai đoạn của một chế độ (preset Spec Kit, AI-DLC, BMAD, Kiro, OpenSpec hoặc chế độ tự tạo),
từ đặc tả tới task code, rồi hội tụ và release notes.

1. **Tạo hạng mục** từ web, app, issue hay đề xuất của Leader (`sdlc.item.create`). Hạng mục chụp chế độ (`mode` jsonb)
   lúc tạo, có một dự án chính và có thể có dự án tham gia (`sdlc_item_projects`).
2. **Bước soạn tài liệu** tạo run `sdlc` trên dự án chính: worktree tạm, quyền `workspace`, không commit, không đẩy
   ([run-permissions.md](run-permissions.md#run-ai-sdlc-sdlc)). Hub gửi `spec.sdlc` gồm `seed` (baseline, bản nháp, tóm
   tắt dự án tham gia) và `collect` (file cần thu về). Agent gọi MCP `sdlc_context`, `sdlc_ask`, `sdlc_report`; câu hỏi
   không giữ run: run kết thúc, người trả lời đủ thì hub chạy lượt soạn mới kèm câu trả lời. Tài liệu về hub qua `report.artifacts` và thành phiên bản của tài liệu `knowledge`
   (`sdlc_artifacts.doc_key`), với phạm vi hạng mục, dự án hoặc contract.
3. **Cổng giai đoạn** dùng phiên duyệt tài liệu của `knowledge` (hook `provideReviewHooks`); hạng mục nhiều đội cần
   người duyệt mỗi đội. Tự duyệt AI chỉ khi chế độ và dự án cho phép, điểm đủ ngưỡng, không chạm đường dẫn hay từ khoá
   cấm, và thu hồi được trong hạn (`sdlc_auto_approvals`).
4. **Đồng bộ repo**: baseline đã duyệt được ghi vào repo theo `settings.sdlc.repoSync` (`pr` đi chung hàng merge với PR
   của run, `direct` hay `off`); `sdlc_artifact_syncs` lưu trạng thái.
5. **Tách task**: bộ đọc theo định dạng của chế độ biến tài liệu tách việc thành task thường (`sdlc_item_tasks`) có
   phụ thuộc (`task_dependencies`), chạy theo đợt (`maxParallel`, `autoRunWaves`).
6. **Cổng chặn run code**: engine gọi `codeRunGate` trước khi giao run code của task thuộc hạng mục; thiếu tài liệu
   bắt buộc đã duyệt (kể cả contract mà dự án đó dùng) thì `SDLC_GATE_BLOCKED`, trừ khi có ghi đè có lý do
   (`sdlc_overrides`). Review code nhận requirement và tiêu chí của task qua `specContextFor`.
7. **Truy vết và hội tụ**: `sdlc_trace_links` nối requirement với task, run, PR, commit, test, CI và phát hiện; bước `converge` chạy một run mỗi dự án, gộp
   phát hiện, còn thiếu thì giao lại bước tách việc tới hết số vòng.

Ranh giới: `runs` import `sdlc/index.ts` (cổng, tạo run bước, sự kiện run xong); `sdlc` không import `runs` mà nhận cổng
tạo run qua `SdlcDeps` do `main.ts` tiêm. `fleet` nhận danh sách run AI SDLC qua `provideSdlcFleetRuns` cho trang Đội máy.
Mười hai bảng `sdlc_*` bật và ép RLS theo tổ chức; quyền theo đội (D22) lọc bằng join `sdlc_item_projects.team_id`, nên
hạng mục nhiều dự án hiện với thành viên của mọi đội tham gia.

Worker đã hỗ trợ `spec.checks.commands`, chạy lệnh trong worktree run code sau agent, trước khi đẩy và trả
`report.commands` (mã thoát, thời gian, đuôi output đã che bí mật). Hub gom lệnh từ quy trình khớp lúc giao job
và `outcome.command` trong bản chụp chính sách, bỏ trùng theo lệnh đã trim, lấy thời hạn ngắn nhất. Hub đánh giá
mã thoát: 0 đạt, khác 0 không đạt; kiểm tra bắt buộc không đạt làm run `failed`, kiểm tra mềm làm `needs_review`.
RUN-07 vẫn một phần vì `outcome.ci` chưa được đánh giá. Thiếu kết quả (worker cũ hoặc vòng do
push tay) thì checkpoint lệnh chờ người xem, không dùng kết quả của SHA cũ. Q1 đã chốt status `xdev-hive/review`
và gợi ý bảo vệ nhánh, nhưng phần triển khai status còn ở T101; không dùng approve của nhà cung cấp thay checkpoint.

## 5. Giao thức worker

WSS tới `/ws/worker`. Mỗi gói là JSON có `v` (phiên bản giao thức), `id`, và `seq` (với gói của một run). Định nghĩa bằng zod trong `packages/contracts/src/worker-protocol.ts`. Kiểu Go viết tay trong `worker/internal/channel/protocol.go`, giữ khớp bằng file mẫu dùng chung `packages/contracts/fixtures/worker-protocol.json` mà test hai bên cùng đọc. `oapi-codegen` chỉ sinh client REST cho đăng ký và health.

| Hướng | Gói | Ý nghĩa |
|---|---|---|
| W → H | `hello{machineId, version, protoRange, os, clis[], capacity, resumeRuns[], localProjects?}` | Mở phiên, báo các run đang dở. `localProjects{bound[], full[]}`: dự án máy đã gắn repo và dự án máy cho toàn quyền ([ADR 0020](adr/0020-local-project-folders-and-machine-full-permission.md)) |
| H → W | `welcome{sessionId, heartbeatSec, accessTokenExp}` · `upgrade_required{url, sha256, sig}` | Chấp nhận, hoặc buộc cập nhật. `accessTokenExp` chưa dùng. **[Chưa gửi]** `upgrade_required`: lệch giao thức thì hub đóng kết nối mã 4426 |
| W → H | `heartbeat{load, runs[{runId, attempt, leaseId}], localProjects?}` | Gia hạn lease, gửi lại `localProjects` khi công tắc đổi |
| H → W | `heartbeat_ack{renewed[], cancel[]}` | Lệnh huỷ đi kèm heartbeat, nên huỷ vẫn tới khi kênh khác lỗi [13] |
| H → W | `job_offer{runId, attempt, spec, ttl}` | Đề nghị job |
| W → H | `job_accept` · `job_reject{reason}` | Nhận hoặc từ chối |
| H → W | `lease{leaseId, expiresAt, runToken}` | Cấp lease và token của run |
| W → H | `run_event{runId, attempt, seq, type, data}` | phase, plan, tool_call, cost, approval_needed (hub chưa xử lý), check_result, agent_report, steer_result |
| W → H | `log_chunk{runId, attempt, offset, bytes}` | Log terminal |
| H → W | `ack{runId, uptoSeq}` | Xác nhận, worker bỏ phần đã ack khỏi bộ đệm |
| H → W | `steer{runId, steerId, input}` · `approval_result{requestId, decision}` | Điều khiển giữa chừng. **[Chưa gửi]** `approval_result` |
| H → W | `cancel{runId, graceSec}` | Worker gửi SIGINT, hết thời gian chờ thì kill |
| W → H | `run_result{runId, attempt, exit, headSha, report}` | Kết thúc phần agent; hub chạy chính sách kết quả |
| H → W | `drain` | Không nhận job mới rồi thoát khi hết việc. **[Chưa gửi]** |
| H → W | `update{version?}` | Admin bấm cập nhật: worker ngừng nhận job, chờ run đang chạy xong, tự cập nhật rồi chạy lại |

- **At-least-once:** worker giữ gói chưa ack trên đĩa, gửi lại khi nối lại. Hub loại trùng theo `(run_id, attempt, seq)` với sự kiện và `(run_id, attempt, offset)` với log.
- **Phiên bản:** hai bên thoả thuận trong `protoRange`; lệch thì hub đóng kết nối mã 4426. Worker tự cập nhật bằng gói `worker/internal/update` (kiểm chữ ký ECDSA của `checksums.txt` và `sha256`) khi admin bấm cập nhật hoặc khi chạy `hive-worker update`. Không dùng `go-selfupdate` vì riêng thư viện đó thêm khoảng 8 MB và hơn 15 module ([add.md](add.md) mục 9).
- **Worktree:** worker tạo worktree trong thư mục riêng của nó, và luôn gỡ ở bước `finally`. Dự án đã gắn với repo trên máy (`projects.json`, ADR 0020) thì worktree tạo từ repo đó thay cho repo cache bare, nhánh của run hiện trong repo của người dùng. Khi khởi động, worker quét và gỡ worktree không thuộc run đang sống. Hệ cũ để lọt hơn 50 worktree vì thiếu bước này.

## 6. Bảo mật và token

| Token | Cấp cho | Đời sống | Cách cấp |
|---|---|---|---|
| Phiên người dùng | Trình duyệt, app desktop | Theo phiên | Better Auth |
| Registration token | Lần cài worker hoặc runner host đầu tiên | Một lần, khoảng 1 giờ | Admin đội tạo trên web |
| Machine token | Worker, runner host | Đến khi thu hồi | `hwm_…`, hub trả một lần lúc đăng ký và chỉ lưu băm |
| Khoá máy, access token máy | Worker, runner host | Ngắn (khoảng 15 phút) | **[Chưa làm]** Máy tạo cặp khoá lúc đăng ký, ký challenge bằng khoá máy để đổi lấy access token |
| Run token | Một run | Hết hạn theo thời gian chờ của run | Hub cấp cùng `lease`. JWT HS256 có `run_id`, `task_id`, `org_id`, `attempt`, `aud`; khoá suy ra từ `HIVE_AUTH_SECRET` bằng HKDF |
| Token MCP | CLI agent trong run | Như run token | Agent dùng run token với `aud=/mcp`; người dùng ngoài run dùng OAuth (Better Auth + CIMD) |
| Token git | Push nhánh trong run | Ngắn, chỉ repo của dự án | **[Chưa làm]** Hub đổi từ GitHub App installation token hoặc GitLab project token. Hiện run clone và push bằng thông tin đăng nhập git sẵn có trên máy |

- Không dùng mTLS cho máy vì proxy công ty hay chặn hoặc làm hỏng. [Suy luận]
- Cổng MCP kiểm `aud`, không chuyển tiếp token xuống dịch vụ sau, giới hạn tool theo vai trò và theo loại run, ghi audit mọi lời gọi. [14][15]
- Secrets mã hoá kiểu envelope (AES-256-GCM): mỗi bản ghi có khoá dữ liệu riêng, khoá dữ liệu được mã hoá bằng khoá chủ của hub (`HIVE_MASTER_KEY` hoặc `HIVE_MASTER_KEY_FILE`). Áp dụng cho secret của kết nối Git, cấu hình kênh thông báo và secret webhook của dự án.
- **[Chưa làm]** Secret của dự án chỉ đưa vào pha `preparing` (setup), xoá trước pha `running`. Log stream che mọi giá trị secret đã biết. [16]
- Tài khoản AI trong container dùng API key của đội hoặc gói đăng ký của người giao việc, theo cấu hình đội ([decisions.md](decisions.md)).

## 7. Container runner

- Runner host là binary Go ở chế độ `host`. Nó gọi ra hub như worker, báo dung lượng (số slot, CPU, RAM) và nhận job loại `sandbox`.
- Mỗi run một container chạy runtime gVisor (`runsc`) với `--network=none`. Đường ra duy nhất là egress proxy theo allowlist: proxy chạy trong tiến trình runner host, riêng cho từng run, nối vào container qua Unix socket; `hive-worker sandbox-init` trong container chuyển `127.0.0.1:3128` sang socket đó. gVisor phải cho nối Unix socket của máy chủ (`--host-uds=open`). [17]
- **Allowlist:** mặc định chặn. Có danh sách đề xuất gồm năm địa chỉ công khai (API Anthropic, OpenAI, registry npm, proxy và sum của Go). Dự án thêm được mục riêng. Tổ chức khoá được để dự án không nới. Chặn IPv6 và ép DNS qua proxy để không lách được. [18][19]
- **Image môi trường:** mỗi dự án khai báo image gốc và sha256 của script setup (`.hive/setup.sh`). Runner host kiểm hash rồi chạy script trong một container riêng từ image gốc. **[Chưa làm]** build sẵn rồi cache theo hash của script; giữ vài container chờ sẵn để khởi động nhanh. [16]
- Hết run thì container bị xoá. Kết quả chỉ ra ngoài bằng nhánh đã push. **[Chưa làm]** artifact gửi lên hub.

## 8. Tạo dự án trên web

```mermaid
sequenceDiagram
  autonumber
  actor A as Admin đội
  participant W as Web
  participant API as Hub api
  participant J as Hub jobs
  participant S as GitHub App / GitLab

  A->>W: Điền form tạo dự án
  W->>API: projects.create dryRun
  API->>S: Kiểm quyền, tên repo còn trống
  API-->>W: Kế hoạch các bước, cảnh báo
  A->>W: Xác nhận
  W->>API: projects.create với idempotencyKey
  API->>API: Một transaction: dự án, các bước saga, audit, job pg-boss
  API-->>W: projectId
  J->>S: check-access, tạo hoặc nối repo
  J->>S: Commit file mẫu
  J->>S: Bảo vệ nhánh, thêm webhook
  J->>API: Ghi tiến độ từng bước vào project_provision_steps
  API-->>W: Màn tiến trình: dự án sẵn sàng
```

**[Chưa làm]** trong luồng trên: nạp tài liệu mặc định, đề nghị máy clone repo bằng token git ngắn hạn, tạo và giao task đầu tiên.

- Skill mặc định không cần nạp vào dự án: hub giữ bộ skill trong `packages/skill-pack` (bản ghim của `library/` trong
  kho tdduydev/xdev-skills), mọi tổ chức thấy sẵn và bật/tắt theo tổ chức hoặc dự án (`skill_pack_settings`). Agent
  đọc qua `skill_list`/`skill_get` (scope `hive`); với run code và review chạy Claude Code, worker lấy skill qua
  `POST /api/v1/run/skills` (run token) và chép vào `.claude/skills/` của worktree, kèm `.gitignore` để không commit.
- Saga chạy trên pg-boss (hàng `catalog-provision`). Các bước `check-access`, `create-repo` hoặc `link-repo`, `commit-template`, `protect-branch`, `add-webhook` ghi trạng thái vào `project_provision_steps`; bước lỗi dừng saga, báo thông báo và chạy lại được.
- Template do hub giữ. Hub render file mẫu (AGENTS.md có project key, cấu hình MCP, skill) rồi commit bằng API. Cách này chạy được trên cả GitHub và GitLab gói Free. [20][21]
- Không dùng Temporal: tự host cần nhiều service. Nếu saga phình ra nhiều loại, cân nhắc DBOS (thư viện chạy trên Postgres). [22]

## 9. Realtime và log

- Mỗi tiến trình `api` giữ **một** kết nối `LISTEN hive_runs` và phát lại trong bộ nhớ cho các luồng SSE. Payload của NOTIFY chỉ chứa `runId`. NOTIFY được gom theo lô, không gửi cho từng dòng log, vì NOTIFY lấy lock toàn cục lúc commit. [23]
- **Log run:**
  - Đoạn log mới nằm trong `run_logs` (Postgres) để web xem trực tiếp.
  - **[Chưa làm]** Khi run kết thúc, job gộp log thành một file nén, đẩy lên kho blob, rồi xoá các đoạn trong Postgres. GitLab làm theo cách này. [24]
- Web nhận log trực tiếp qua SSE theo `runId`. Con trỏ `<eventId>.<logId>` là `Last-Event-ID`, nên nối lại không mất đoạn nào.

### 9.1 Artifact và khung cách ly

- Nội dung artifact là dữ liệu không tin cậy. Nội dung chạy được (`html`, `react`, `mermaid`) chỉ chạy trong `<iframe sandbox="allow-scripts">` (không `allow-same-origin`), nạp từ `/_artifact/frame/{vé}` **cùng host** với hub (PO chốt, ADR 0023). Vé HMAC có hạn 5 phút, cho đúng một phiên bản; route khung bỏ qua cookie phiên và trả CSP chặn mạng, form, khung lồng và mọi nguồn ngoài host ngoài script/style nội tuyến.
- Thư viện cho trang là file tĩnh dựng sẵn ở `/_artifact/lib/` (`@xdev-hive/artifacts-runtime`, `scripts/build-lib.ts`), cache `immutable`; app desktop đóng gói sẵn và phục vụ qua `hive-artifact://`.
- Trang link công khai `GET /_artifact/s/{mã}` do hub tự viết HTML (không script), chỉ chữ tiêu đề là của artifact và được escape. Hub lưu băm SHA-256 của mã; mọi lỗi (hết hạn, thu hồi, chính sách tắt) trả cùng trang 404. Giới hạn 60 lượt/phút mỗi IP; IP lấy từ `X-Forwarded-For` chỉ khi kết nối đến từ `HIVE_TRUSTED_PROXIES`. Caddy che mã trong log (`deploy/caddy/Caddyfile`).
- `react` được hub biên dịch khi lưu hoặc xem trước (giới hạn 1 MiB, 2 giây, chạy ngoài transaction, trong worker thread); import ngoài thư viện đóng gói bị từ chối. Lỗi chạy hoặc biên dịch gửi được cho Leader qua "Nhờ Leader sửa" (`<page-errors>` đánh dấu là dữ liệu không tin cậy).
- Tool MCP `artifact_create/update/get/list` đăng ký ở `app.ts`; job `artifact-purge` (chạy mỗi giờ, phút 23) xoá artifact trong thùng rác quá 30 ngày, bản xem trước hết hạn và link hết hạn quá 90 ngày, đăng ký ở `main.ts`. `GET /api/v1/health` trả `artifacts: true` để app desktop biết hub có artifact.

## 10. Vận hành

- **Triển khai:** Docker Compose trên một server (`deploy/compose.yaml`): `postgres`, `hub` (một container, vai trò `api,jobs`), `caddy` (profile `https`, tuỳ chọn). `deploy/remote.sh` triển khai qua SSH. Runner host cài worker bằng script cài rồi chạy `hive-worker host`. **[Chưa làm]** tách `hub-api` (2 bản), `hub-gateway`, `hub-jobs`, `hub-collab`; `blob` (Garage hoặc S3 ngoài); `cloudflared`; `otel-collector`; cài runner host thành dịch vụ bằng một lệnh.
  - Không dùng Kubernetes. Gitpod đã rời K8s cho tải có nhiều trạng thái. [25] [Suy luận cho quy mô này]
- **Nâng cấp:** migration kiểu expand rồi contract; test `migrations-upgrade.db.test.ts` nâng cấp một database đã migrate tới ngay trước mỗi migration có `ALTER TYPE ... ADD VALUE`, để bắt lỗi chỉ hiện khi nâng cấp. Hiện chỉ có một container hub nên nâng cấp gián đoạn ngắn lúc container khởi động lại; worker tự nối lại theo giao thức ở mục 5. **[Chưa làm]** đổi lần lượt hai bản `hub-api` để không gián đoạn. [Suy luận]
- **Backup:** `deploy/backup.sh` (pg_dump kèm `meta` và `SHA256SUMS`, giữ theo `HIVE_BACKUP_KEEP`; không chép `.env`, quản trị cất riêng), `deploy/restore.sh` kiểm khoá theo `meta` rồi khôi phục trong một transaction. **[Chưa làm]** pgBackRest (full + incremental, khôi phục theo thời điểm) lên kho blob; diễn tập khôi phục hằng tháng. [26]
- **Quan sát:** hub ghi log ra stdout, `GET /api/v1/health` báo trạng thái và commit đang chạy. **[Chưa làm]** OpenTelemetry cho hub (HTTP, pg) và worker; span của run theo quy ước GenAI (`invoke_agent`, `gen_ai.usage.*`). [27]

## 11. Rủi ro và cách tránh

| Rủi ro | Cách tránh |
|---|---|
| Tenant context rò qua pool | Chỉ `set_config(..., true)` trong transaction; test 0 dòng khi thiếu context |
| Kết nối bằng owner hoặc BYPASSRLS làm RLS vô hiệu mà không báo | Tách role, FORCE RLS, test kiểm role của pool |
| UPDATE chuyển dòng sang đội khác | `WITH CHECK` cho mọi policy |
| NOTIFY làm nghẽn commit | Chỉ gửi id, gom lô, không NOTIFY cho log |
| Worker treo ghi đè run đã giao lại | Fencing bằng `attempt`, kiểm lease khi ghi |
| Lệnh huỷ không tới | Gửi kèm heartbeat, có hạn cứng ở hub |
| Secret lọt vào pha agent hoặc log | Chỉ có ở setup, che trong log (**[Chưa làm]**) |
| Lách allowlist qua IPv6, DNS, tiến trình con | `--network=none` + proxy, chặn IPv6, ép DNS |
| Token MCP bị dùng sai chỗ | Kiểm `aud`, không chuyển tiếp, audit |
| Saga đổi code giữa chừng | Lưu phiên bản saga theo từng instance, chạy hết bằng bản cũ |
| Drizzle 1.0, Better Auth, MCP spec mới còn đổi | Khoá phiên bản, bọc sau lớp của mình, theo dõi bản vá |
| PTY trên Windows | Smoke test worker trên Windows trước mỗi bản phát hành |

## 12. Thứ tự xây dựng

| Mốc | Nội dung | Xong khi |
|---|---|---|
| M0 | Khung repo: pnpm workspace, `apps/hub`, `apps/web`, `apps/desktop`, `worker/` (Go), `packages/contracts`; CI chạy lint, typecheck, test, dependency-cruiser | Một PR mẫu qua hết kiểm tra |
| M1 | `platform`, `identity`, `tenancy`: Postgres, migration, RLS, ba cách đăng nhập, tổ chức/đội/hệ thống | Test RLS 0 dòng qua hết; đăng nhập được bằng cả ba cách |
| M2 | `catalog`, `scm`: dự án, GitHub App, GitLab, template, webhook | Tạo được dự án có repo mới trên cả GitHub và GitLab |
| M3 | `tasks`, `runs`, `fleet`, worker Go: giao run cho máy dev, log trực tiếp, huỷ, chính sách kết quả | Một task chạy từ đầu tới PR trên máy thật (macOS, Linux, Windows) |
| M4 | `knowledge`, `mcp`: memory, tài liệu cộng tác, skill, đề xuất; cổng MCP với run token | Agent trong run gọi được memory_search, doc_get, task_update |
| M5 | Review và merge queue theo cấu hình dự án; review chéo | PR qua review chéo, vào queue, merge tuần tự |
| M6 | `sandbox`, runner host: container gVisor, allowlist, image theo dự án | Run chạy trong container, không ra mạng ngoài allowlist |
| M7 | Plan mode, `leader` chat, `notify` (Telegram, email), `cost` | Leader lập plan, người duyệt, run chạy theo plan |
| M8 | Desktop Tauri, chuyển memory/tài liệu/skill từ hệ cũ, giao việc từ issue | Hệ cũ chuyển sang chỉ đọc |

## Nguồn

1. https://docs.github.com/en/enterprise-server@3.13/actions/concepts/runners/communicating-with-self-hosted-runners
2. https://docs.gitlab.com/ci/runners/long_polling/
3. https://buildkite.com/docs/agent/self-hosted/configure/job-dispatch
4. https://coder.com/docs/v2.37/reference/glossary
5. https://shopify.engineering/enforcing-modularity-rails-apps-packwerk
6. https://microservices.io/patterns/data/transactional-outbox
7. https://stackharbor.com/en/knowledge-base/pg-row-level-security-multi-tenant/
8. https://dev.to/wenceslaudev/postgres-rls-multi-tenancy-two-traps-that-silently-disable-your-policies-5gn8
9. https://docs.temporal.io/encyclopedia/detecting-activity-failures
10. https://npmjs.com/package/pg-boss
11. https://depot.dev/blog/github-actions-runner-architecture-part-1-the-listener
12. https://pkg.go.dev/github.com/buildkite/agent/v3@v3.63.1/api
13. https://docs.temporal.io/concepts/what-is-a-heartbeat-timeout
14. https://workos.com/blog/oauth-resource-indicators-rfc-8707
15. https://zuplo.com/blog/bind-mcp-tokens-to-one-server
16. https://developers.openai.com/codex/cloud/environments
17. https://gvisor.dev/docs/user_guide/networking
18. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
19. https://mfyz.com/ai-coding-agent-sandbox-container/
20. https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template
21. https://docs.gitlab.com/api/commits/
22. https://dbos.dev/compare/compare-dbos-vs-temporal-dbos
23. https://recall.ai/blog/postgres-listen-notify-does-not-scale
24. https://docs.gitlab.com/administration/job_logs
25. https://devclass.com/2024/11/06/gitpod-discontinues-journey-of-experiments-failures-and-dead-ends-with-kubernetes
26. https://www.kunalganglani.com/blog/postgresql-backup-tools-compared.md
27. https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans
