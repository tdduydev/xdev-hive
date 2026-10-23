---
description: "Danh sách task: Hub giữ dữ liệu và tiến độ, client làm việc qua công cụ trên máy"
---

# Tasks: Hub giữ dữ liệu và tiến độ, client làm việc qua công cụ trên máy

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts), [quickstart.md](quickstart.md)
**Trạng thái**: P1–P3 đã chốt (2026-10-21). MVP = US1 + US2. Chưa code.

## Quy ước

- **Định dạng**: `[ID] [P?] [Story] Mô tả · file`.
  - **[P]**: chạy song song được với task khác cùng giai đoạn. Bộ file không giao nhau và không chờ task chưa xong.
  - **[Story]**: US1…US5 theo spec.md. Task Setup, Foundational, Polish không gắn story.
- **Đã có trước spec này**: spec 025 (T010, T011) và spec 029 (T019, T020) đã làm một phần đợt 1 và 2 của plan.md:
  - bảng `client_events`, `withClientEvent`, dọn theo ngày (`apps/hub/src/modules/platform/client-events.ts`, migration
    `0082_token_score_client_events.sql`);
  - `POST /api/v1/client-events` cho sự kiện máy (`fleet/router.ts`);
  - hộp thư đi chỉ cho sự kiện máy (`worker/internal/outbox/{store,sender}.go`, `hive-worker outbox`).
  Các task đó đánh `[x]` kèm ghi chú "đã có". Task mới mở rộng chứ không viết lại.
- **Nơi lưu hộp thư đi**: bản đã có dùng `~/.xdev-hive/outbox/<identityKey>/`. Giữ nguyên chỗ này cho cả mục của người
  dùng, để worker cũ và mới đọc cùng thư mục. data-model.md ghi `DataDir/outbox/`: lệch, ghi ở ADR 0032.
- **Danh tính người dùng (R6)**: `hive login` ghi thêm `userId` (không phải secret) vào `hive.json`. Worker đọc PAT trong
  keychain (`dev.xdev.hive`, tài khoản = địa chỉ hub) và `userId` trong `hive.json` lúc nhận mục. Đăng nhập người khác thì
  mục cũ chuyển `held` (`identity_mismatch`).
- **File chung có chủ**:
  - `packages/contracts/src/client-events.ts`, `fixtures/client-write-tools.json`, `scripts/openapi.ts`: T004.
  - `apps/hub/src/modules/mcp/server.ts`: T007, sau đó chỉ T008 thêm `_meta`.
  - `worker/internal/outbox/store.go`: T014, rồi T016.
  - `worker/cmd/hive-worker/local.go`: T018.
  - `worker/cmd/hive/mcp.go`: T020.
- **Không sửa** (spec 031 đang làm): `worker/internal/secretstore/**`, `worker/internal/secretmask/**`,
  `worker/internal/projects/**`. Tránh `worker/internal/runner/runner.go` tới US5.

---

## Phase 1: Setup

- [x] T001 Đặt `.specify/feature.json` trỏ `specs/027-hub-client-model` (không commit, `.specify/.gitignore`).
- [x] T002 Bảng `client_events` và enum `client_source`, `client_event_outcome` có RLS (đã có, spec 025) ·
  `apps/hub/src/modules/platform/schema.ts`, `apps/hub/db/migrations/0082_token_score_client_events.sql`

## Phase 2: Foundational (chặn mọi user story)

- [x] T003 `withClientEvent`: chèn trước, `duplicate` trả `response` cũ, `rejected` ghi ở transaction riêng; dọn 30 ngày
  (đã có, spec 025) · `apps/hub/src/modules/platform/client-events.ts`, `client-events.db.test.ts`
- [x] T004 Bảng nhóm tool có ghi: `clientWriteGroup`, `CLIENT_WRITE_TOOLS`, `CLIENT_WRITE_PROCEDURES`,
  `clientWriteGroupOf()`, `clientEventHeaders` (tên header), `taskHistoryItem`; fixture
  `fixtures/client-write-tools.json` sinh trong `pnpm openapi`; test fixture khớp bảng ·
  `packages/contracts/src/client-events.ts`, `packages/contracts/src/client-events.test.ts`,
  `packages/contracts/scripts/openapi.ts`, `packages/contracts/fixtures/client-write-tools.json`
- [x] T005 [P] Đọc header sự kiện client từ request: `Idempotency-Key`, `X-Hive-Source`, `X-Hive-Machine`,
  `X-Hive-Created-At`, `X-Hive-Client`; khoá sai dạng thì báo lỗi 400 tiếng Việt; nguồn lạ thành `unknown`; bộ đếm
  `client_event.missing_key` theo phiên bản client · `apps/hub/src/modules/platform/client-request.ts`,
  `client-request.test.ts`, `platform/index.ts`

**Checkpoint**: hợp đồng và hàm dùng chung sẵn sàng cho US1 và US2.

---

## Phase 3: User Story 1 - Một hợp đồng ghi cho mọi client (P1) 🎯 MVP

**Goal**: mọi lần ghi qua `/mcp` và `/rpc` mang khoá chống trùng và nguồn gửi; hub trả `accepted`, `duplicate` hay
`rejected` và ghi lịch sử theo task.

**Independent Test**: gọi `task_update` hai lần cùng `Idempotency-Key` → lần hai trả `duplicate`, chỉ một dòng
`client_events`, checklist đổi một lần. Gọi vào task đã huỷ → `rejected` có `code`, dòng `rejected` còn sau rollback.

- [x] T006 [P] [US1] Cờ `writes: true` cho mọi tool có ghi; test: tool `writes` ⇔ có trong `CLIENT_WRITE_TOOLS`, tool
  trong bảng phải tồn tại · `apps/hub/src/modules/mcp/registry.ts`, `apps/hub/src/modules/*/mcp-tools.ts` (chỉ thêm
  cờ), `apps/hub/src/modules/mcp/client-write-tools.test.ts`
- [x] T007 [US1] `runTool` bọc tool có ghi bằng `withClientEvent` khi có khoá: khoá từ header, rồi
  `params._meta["dev.xdev.hive/idempotencyKey"]`; lỗi nghiệp vụ (`McpToolError`, `ConflictError`, `BadRequestError`,
  `NotFoundError`, `ForbiddenError`) thành `rejected` với `code`; audit chỉ ghi lần `accepted` và `rejected`;
  `X-Hive-Machine` chỉ nhận khi máy cùng tổ chức và do người của token đăng ký hay là máy dùng chung của đội ·
  `apps/hub/src/modules/mcp/server.ts`, `apps/hub/src/modules/mcp/endpoint.ts`, `apps/hub/src/modules/mcp/principal.ts`
- [x] T008 [US1] Kết quả tool có `_meta["dev.xdev.hive/clientEvent"]`; `duplicate` của lần đầu `rejected` vẫn là lỗi
  cùng `code` · `apps/hub/src/modules/mcp/server.ts`, `apps/hub/src/modules/mcp/client-event-result.test.ts`
- [x] T009 [P] [US1] Test database: trùng khoá, rejected sau rollback, máy lạ bị bỏ qua ·
  `apps/hub/src/modules/mcp/client-events.db.test.ts`
- [x] T010 [US1] `memory.write` qua `withClientEvent` khi có khoá; header trả `Hive-Client-Event` ·
  `apps/hub/src/modules/knowledge/router.ts`, `apps/hub/src/app.ts` (đưa `resHeaders` vào context oRPC),
  `apps/hub/src/rpc-context.ts` nếu có
- [x] T011 [US1] `tasks.history({taskId})`: gộp `client_events` (task, run của task) và `run_events` loại `state`, sắp
  theo giờ nhận · `packages/contracts/src/tasks.ts`, `apps/hub/src/modules/tasks/history.ts`,
  `apps/hub/src/modules/tasks/router.ts`, `apps/hub/src/modules/tasks/history.db.test.ts`, `openapi.json`
- [x] T012 [P] [US1] Khung "Lịch sử" trong trang task: nguồn, máy, người, giờ tạo, giờ nhận, lý do từ chối ·
  `apps/web/src/pages/tasks-page.tsx`, `apps/web/src/components/task-history.tsx`, `apps/web/e2e/task-history.spec.ts`
- [x] T013 [P] [US1] ADR 0032 sự kiện client và hộp thư đi; sửa ADR 0019 (op socket mới) ·
  `docs/adr/0032-client-events-and-outbox.md`, `docs/adr/0019-*.md`, `docs/adr/README.md`

**Checkpoint**: US1 chạy độc lập, client cũ không gửi khoá vẫn ghi được (FR-005).

---

## Phase 4: User Story 2 - Làm việc tiếp khi hub vắng (P1) 🎯 MVP

**Goal**: mọi lần ghi của client trên máy đi qua hộp thư đi của `hive-worker`; hub vắng thì nhóm `progress`, `proposal`
được giữ và gửi lại theo thứ tự từng task; nhóm `immediate` và tool đọc báo "Hub đang vắng".

**Independent Test**: tắt hub, agent gọi `task_update` ba lần qua `hive mcp` → nhận "Đã xếp hàng, chờ hub"; bật hub →
ba mục tới hub đúng thứ tự, không trùng; `hive outbox` hiện 0 mục chờ.

- [x] T014 [US2] Mở rộng kho: trạng thái `held` và `heldReason`; danh tính người dùng (`userId`, khoá thư mục =
  16 hex đầu SHA-256(`hubUrl|userId`)); transport `mcp`, `rpc`; `Target` quyết định stream; mục `held` chặn cùng
  stream; `Retry`, `Export`, `Stats` (số byte, đếm theo trạng thái) · `worker/internal/outbox/store.go`,
  `worker/internal/outbox/identity.go`, `worker/internal/outbox/store_test.go`
- [x] T015 [P] [US2] Bảng nhóm Go khớp fixture `client-write-tools.json` · `worker/internal/outbox/tools.go`,
  `worker/internal/outbox/tools_test.go`
- [x] T016 [US2] Sender cho người dùng: `POST /mcp` (`tools/call` kèm `Idempotency-Key`, `X-Hive-Source`,
  `X-Hive-Machine`, `X-Hive-Created-At`, `X-Hive-Client`) và `POST /rpc/<path>`; đọc `_meta` và header
  `Hive-Client-Event`; 401 → `held` (`login_required`); lỗi tool không có kết quả sự kiện → thử lại ·
  `worker/internal/outbox/user_sender.go`, `worker/internal/outbox/user_sender_test.go`, `worker/internal/outbox/sender.go`
- [x] T017 [US2] Danh tính từ `hive.json` và keychain; `hive login` ghi `userId`; khác người thì `held`
  (`identity_mismatch`) · `worker/internal/outbox/credentials.go`, `worker/internal/outbox/credentials_test.go`,
  `worker/cmd/hive/login.go`
- [x] T018 [US2] Op socket `outbox.submit` (`waitMs`), `outbox.status`, `outbox.list`, `outbox.drop`, `outbox.retry`,
  `outbox.export`; vòng gửi của `hive-worker run` gửi cả mục của người dùng; trạng thái hub `up`/`down`/`retrying` ·
  `worker/cmd/hive-worker/local.go`, `worker/cmd/hive-worker/outbox_ipc.go`, `worker/cmd/hive-worker/outbox_ipc_test.go`,
  `worker/cmd/hive-worker/outbox.go`
- [x] T019 [US2] Lệnh `hive outbox [--json]`, `drop`, `retry`, `export -o`, `submit --json -` qua socket ·
  `worker/cmd/hive/outbox.go`, `worker/cmd/hive/outbox_test.go`, `worker/cmd/hive/main.go`
- [x] T020 [US2] `hive mcp`: `tools/call` của tool có ghi đi qua `outbox.submit`; `queued` trả kết quả tool "Đã xếp hàng,
  chờ hub (khoá …)"; tool `immediate` và tool đọc lỗi mạng trả "Hub đang vắng (<hub>)…"; worker không chạy thì tool
  ghi trả "Sidecar hive-worker không chạy…" · `worker/cmd/hive/mcp.go`, `worker/cmd/hive/mcp_outbox.go`,
  `worker/cmd/hive/mcp_test.go`
- [x] T021 [US2] Desktop: `propose_doc`, `propose_skill`, `memory-hub-sync` gọi `hive outbox submit`; sidecar không
  chạy thì báo, không ghi thẳng hub · `apps/desktop/src-tauri/src/outbox.rs`, `cli.rs`, `skills.rs`, `lib.rs`,
  `apps/desktop/src/components/memory-hub-sync.tsx`
- [x] T022 [US2] Màn "Hộp thư đi": mục `held`, `rejected`, `expired`, nút Bỏ, Gửi lại, Xuất; thanh trạng thái "Hub đang
  vắng – N mục chờ gửi" · `apps/desktop/src/components/outbox-panel.tsx`, `apps/desktop/src/lib/outbox.ts`,
  `apps/desktop/src/i18n.ts`
- [x] T023 [P] [US2] VS Code ghi qua `outbox.submit` · `apps/vscode/src/worker/ipc.ts` (extension đã gỡ ở `main`,
  e6751d68; mã này bỏ theo khi merge)
- [x] T024 [US2] Sự kiện `watch`: `outbox`, `outbox.item` · `worker/cmd/hive-worker/outbox_ipc.go`,
  `worker/internal/terminal/local.go`
- [x] T025 [US2] Đăng xuất khi còn mục: hỏi "Gửi trước", "Giữ lại", "Bỏ" · `apps/desktop/src/components/sign-out-dialog.tsx`,
  `worker/cmd/hive/login.go` (desktop và khay dùng chung hộp thoại; gọi `hive logout --outbox` → op `outbox.logout`)

**Checkpoint**: US1 + US2 là MVP.

---

## Phase 5: User Story 3 - Token ngắn hạn (P1)

**Goal**: máy có khoá Ed25519, đổi chữ ký lấy access token 15 phút; token git chỉ cho repo của run.

- [x] T026 [US3] Hợp đồng `worker/challenge`, `worker/token`, `worker/key`, gói `reauth` · `packages/contracts/src/fleet.ts`,
  `packages/contracts/src/worker-protocol.ts`, `fixtures/worker-protocol.json`, `openapi.json`
- [x] T027 [US3] Cột `public_key_at`, `key_storage`, `machine_tokens.superseded_at` · `apps/hub/src/modules/fleet/schema.ts`
- [x] T028 [US3] Challenge → token, xác thực trước khi nâng WSS, đóng `4401` theo `exp`, `reauth` ·
  `apps/hub/src/modules/fleet/machine-auth.ts`, `gateway.ts`, `machine-auth.db.test.ts`
- [x] T029 [P] [US3] Khoá máy trong keychain (file 0600 khi không có) · `worker/internal/machinekey/`
- [x] T030 [US3] Worker chuyển `hwm_` sang khoá, đổi token 2 phút trước hạn · `worker/internal/hubclient/register.go`,
  `worker/internal/channel/channel.go`
- [x] T031 [US3] Token git theo run (GitHub App, GitLab), `requireRunGitToken` · `apps/hub/src/modules/scm/run-token.ts`,
  `scm/schema.ts`, `runs/engine.ts`, `packages/contracts/src/policies.ts`
- [x] T032 [US3] PAT không rơi ra `hive.json`; máy không có keychain thì hướng dẫn `HIVE_TOKEN` ·
  `worker/cmd/hive/login.go`
- [x] T033 [P] [US3] ADR 0033 · `docs/adr/0033-machine-keys-and-run-git-tokens.md`

## Phase 6: User Story 5 - Ranh giới dữ liệu (P2)

- [x] T034 [US5] Log run ghi file trên máy, xoá theo `runLogRetentionDays` · `worker/internal/runlogs/`,
  `worker/internal/runner/runner.go`
  Log ở `DataDir/runlogs/`, tách worktree; thời hạn chụp lúc giao run. Dọn lúc khởi động, hằng ngày và trước run mới.
- [x] T035 [US5] Hub ngừng ghi `run_logs`, `terminal_chunks` · `apps/hub/src/modules/runs/engine.ts`, `stream.ts`,
  `terminal/gateway.ts`
  ngoài phạm vi (quyết định 2026-10-23: giữ spec 010): tiếp tục ghi/phát lại `terminal_chunks` cho người vào sau.
  SSE log run, steer và relay WebSocket giữ hoạt động. Log run mới chỉ đệm RAM có giới hạn, không INSERT database;
  phát lại SSE sau khi hub khởi động lại hoặc quá cửa sổ đệm không bảo đảm đủ log. Không bật cờ `logs-local` vì sẽ cắt
  `hive attach`. FR-051/SC-006 chưa đạt nguyên văn; không xoá bảng hay dữ liệu cũ.
- [x] T036 [US5] Che secret hai lần · `worker/internal/redact/`, `apps/hub/src/modules/runs/engine.ts`
- [x] T037 [US5] Op `runs.list`, `runs.log.read`; `hive runs` · `worker/cmd/hive-worker/local.go`, `worker/cmd/hive/runs.go`
  Trang log tối đa 32 KiB để không vượt dòng IPC 64 KiB; CLI xuất chữ tự đọc tiếp, `--json` trả một trang.
- [x] T038 [US5] Web `run-page.tsx`, desktop `home-screen.tsx` đọc log từ máy hay báo "Log nằm trên máy …"
- [x] T039 [US5] Trang và tài liệu "Dữ liệu hub giữ", tài liệu SOC · `packages/contracts/src/hub-data.ts`,
  `apps/web/src/pages/admin/hub-data-page.tsx`, `docs/hub-data.md`, `docs/soc-hub-brief.md`
- [x] T040 [P] [US5] ADR 0034 · `docs/adr/0034-run-logs-stay-on-the-machine.md`

## Phase 7: User Story 4 - Hub bền (P2)

- [ ] T041 [US4] Tách vai trò `api`/`jobs`, healthcheck `/api/v1/health/jobs` · `apps/hub/src/main.ts`,
  `deploy/compose.yaml`
- [ ] T042 [US4] `db_epoch`, health trả `dbEpoch`, hộp thư đi gửi lại sau khôi phục · `apps/hub/src/modules/system/`,
  `worker/internal/outbox/epoch.go`
- [ ] T043 [US4] pgBackRest, diễn tập hằng tháng · `deploy/postgres/Dockerfile`, `deploy/pitr-restore.sh`,
  `deploy/drill.sh`
- [ ] T044 [P] [US4] ADR 0035 · `docs/adr/0035-continuous-backup-with-pgbackrest.md`

## Phase 8: Polish

- [ ] T045 SRS mã `HCM-*`; bỏ **[Chưa làm]** ở `docs/architecture.md` §6, §10 khi xong · `docs/srs.md`,
  `docs/architecture.md`
- [ ] T046 Chạy quickstart.md trên Linux, macOS, Windows

## Phụ thuộc

- T004 → T006, T011, T015. T005 → T007, T010.
- T007 → T008 → T016 (sender đọc `_meta`). T014 → T016 → T018 → T019, T020 → T021, T022.
- US3, US5 làm song song được sau US1. US4 cuối cùng.
