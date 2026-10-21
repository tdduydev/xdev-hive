# Implementation Plan: Hub giữ dữ liệu và tiến độ, client làm việc qua công cụ trên máy

**Branch**: `027-hub-client-model` · **Date**: 2026-10-21 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

**Artifacts**: [data-model.md](data-model.md) · [contracts/](contracts) · [quickstart.md](quickstart.md). Task: chưa có
(`/speckit-tasks`).

## Tóm tắt

Bốn chỗ hở của bản review ngày 2026-10-20 được đóng bằng năm phần:

1. **Một hợp đồng ghi (US1).** Mọi lần client ghi qua `/mcp` và `/rpc` mang `Idempotency-Key`, nguồn gửi, máy và giờ
   tạo. Hub xử lý ở hai điểm chung (`runTool` của MCP và một middleware oRPC), ghi bảng `client_events` trong cùng
   transaction với thay đổi nghiệp vụ, trả `accepted`, `duplicate` hay `rejected`.
2. **Hộp thư đi (US2).** `hive-worker` giữ một hàng trên đĩa cho mỗi người dùng hệ điều hành. Desktop, `hive` CLI,
   proxy `hive mcp` và VS Code gửi mọi lần ghi qua socket cục bộ của ADR 0019. Worker gửi ngay nếu hub có, giữ và gửi
   lại theo thứ tự từng task nếu hub vắng.
3. **Token ngắn hạn (US3).** Máy có khoá Ed25519 trong keychain, đổi chữ ký lấy access token 15 phút. Hub cấp token git
   chỉ cho repo của run. Máy cũ chuyển từ `hwm_` sang khoá ở lần chạy đầu sau khi nâng cấp.
4. **Ranh giới dữ liệu (US5).** Log run và output PTY ở lại máy. Hub chỉ nhận siêu dữ liệu và chuỗi tự do đã che secret.
   Có trang "Dữ liệu hub giữ" sinh từ một danh sách có test.
5. **Hub bền (US4).** Backup liên tục bằng pgBackRest, diễn tập hằng tháng có biên bản, mã đời database, tách `api` và
   `jobs` thành hai tiến trình.

Spec 025 T010 (điểm token máy gửi lên hub) dùng lại hợp đồng của phần 1 và 2, qua loại sự kiện máy
`machine.token_score` (R16).

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | TypeScript strict (hub Node 24, web, desktop React), Go 1.27 (worker, `hive`), Rust (Tauri), shell (deploy) |
| Phụ thuộc mới | Không có package npm hay Go mới (Ed25519 có trong thư viện chuẩn; go-keyring đã có trong `worker/go.mod`). Image Postgres riêng có thêm pgBackRest (ADR) |
| Lưu trữ | Hub: bảng `client_events`, `db_epoch`, `run_git_tokens`; cột mới ở `machines`, `machine_tokens`. Máy: `DataDir/outbox/`, `DataDir/runs/`, keychain |
| Test | Vitest + `*.db.test.ts` (testcontainers), `go test` trên Linux, macOS, Windows, Playwright (web), e2e trong `e2e/` |
| Nền tảng | Hub: Linux Docker Compose. Máy: macOS, Linux, Windows |
| Hiệu năng | SC-003: 1.000 mục gửi xong 95% trong 1 phút. SC-008: log 10 MB mở trong 2 giây. Ghi `client_events` thêm một `INSERT` vào transaction của lần ghi |
| Ràng buộc | Tương thích worker đã cài (constitution I, FR-005). Không chọn nơi đặt hub, không mở cổng (FR-060) |
| Quy mô | Vài chục máy, vài nghìn sự kiện client mỗi ngày cho một tổ chức |

## Constitution Check

*Kiểm trước phase 0 và kiểm lại sau phase 1. Cả hai lần: đạt, có hai mục lệch ghi ở Complexity Tracking.*

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | `packages/contracts/src/client-events.ts` (mới), `fleet.ts`, `worker-protocol.ts`, `policies.ts`, `index.ts` (health) sửa trước code. `pnpm openapi`; fixture `worker-protocol.json` và `client-write-tools.json`; kiểu Go cập nhật. Mọi đổi giao thức là trường tuỳ chọn hay gói mới, worker cũ chạy tiếp |
| II. Tenant isolation | `client_events`, `run_git_tokens` có `org_id`, bật và ép RLS, vào `rls.db.test.ts`. `db_epoch` là bảng hệ thống một dòng, `hive_app` chỉ đọc. Audit: `machine.key_register`, `machine.token_issue` (chỉ lỗi), `scm.run_token_issue`, `scm.run_token_revoke`, `client_event.rejected` |
| III. Module boundaries | `client_events` thuộc `platform` (dùng chung cho `mcp` và router oRPC), xuất qua `platform/index.ts`. Khoá máy thuộc `fleet`. Token git thuộc `scm`, `runs` gọi qua `scm/index.ts` |
| IV. Tested | Test ở mỗi tầng (quickstart). Go test chạy cả ba hệ điều hành vì hộp thư đi và khoá máy dựa vào quyền file và keychain của từng hệ |
| V. Secure by default | Không còn token máy dài hạn; khoá riêng trong keychain; token git hẹp theo repo; log ở lại máy; che secret hai lần. Mục bảo mật mới trong `docs/add.md` §8 |
| VI. Ngôn ngữ | Thông báo và lỗi tiếng Việt. Spec và plan viết tiếng Việt theo yêu cầu chủ dự án: **lệch**, ghi ở Complexity Tracking |
| VII. Simple to self-host | Không thêm dịch vụ chạy thường trực. Tách `hub-jobs` là cùng image, khác `HIVE_ROLES`. pgBackRest chạy trong container Postgres và cần kho backup ở nơi khác: **ADR 0035** |
| Giao diện | Màn hộp thư đi và trang "Dữ liệu hub giữ" dùng `@xdev-hive/ui`, token màu, 360 px, sáng/tối, bàn phím, Playwright theo role |

## Kiến trúc

```
                      ┌────────────────────────── máy dev (một người dùng hệ điều hành) ──────────────────────────┐
 Claude Code ── stdio ─▶ hive mcp ──┐                                                                              │
 VS Code ──────────── socket ───────┤                                                                              │
 app desktop ── sidecar `hive` ─────┤   localipc (ADR 0019)                                                        │
 hive CLI ──────────────────────────┴──▶ hive-worker ── outbox/  (mục 0600, theo danh tính, theo stream)          │
                                          │   ├─ sender: PAT từ keychain → POST /mcp | /rpc + Idempotency-Key     │
                                          │   └─ sent.jsonl + dbEpoch → gửi lại khi hub khôi phục                 │
                                          ├── runs/<id>/<attempt>.log   (log run ở lại máy, xoá theo POL-05)      │
                                          ├── khoá Ed25519 (keychain) → /api/v1/worker/token → access token 15'   │
                                          └── WSS /ws/worker: run_event (siêu dữ liệu, đã che), reauth, git_token  │
                      └────────────────────────────────────────────────────────────────────────────────────────────┘
                                                        │ chỉ client gọi ra
 hub (service hub, HIVE_ROLES=api) ─────────────────────▼──────────────────────────────────────────
   /mcp runTool ─┐                                      gateway WSS + timer giao run (chuyển sang api)
   /rpc middleware┴─▶ platform/client-events: insert-first, cùng transaction; rejected ghi riêng
   /api/v1/worker/{challenge,token,key}   /api/v1/client-events (sự kiện máy)   /api/v1/health (+dbEpoch)
 hub (service hub-jobs, HIVE_ROLES=jobs): provision, merge, review, notify, retention, docsync, embed, dọn client_events,
                                          thu hồi token GitLab
 postgres (image riêng + pgBackRest) ── WAL, backup tăng dần ──▶ kho ở máy khác (S3 hay SFTP)
```

## Project Structure

### Documentation

```text
specs/027-hub-client-model/
├── spec.md
├── plan.md                         # file này
├── research.md                     # phase 0
├── data-model.md                   # phase 1
├── quickstart.md                   # phase 1
├── contracts/
│   ├── client-events.md
│   ├── outbox-ipc.md
│   ├── machine-auth.md
│   └── worker-protocol-changes.md
└── tasks.md                        # /speckit-tasks
docs/adr/0032-client-events-and-outbox.md
docs/adr/0033-machine-keys-and-run-git-tokens.md
docs/adr/0034-run-logs-stay-on-the-machine.md
docs/adr/0035-continuous-backup-with-pgbackrest.md
docs/adr/0036-machine-sends-token-score.md     # mở khoá spec 025 T010
docs/hub-data.md                     # sinh từ HUB_DATA_INVENTORY (FR-054)
docs/soc-hub-brief.md                # tài liệu một trang gửi SOC (FR-061, FR-062)
```

### Source Code

| Phần | File |
|---|---|
| Hợp đồng | `packages/contracts/src/client-events.ts` (mới), `fleet.ts`, `worker-protocol.ts`, `policies.ts`, `index.ts`, `hub-data.ts` (mới); `fixtures/client-write-tools.json` (mới), `fixtures/worker-protocol.json` |
| Sự kiện client (hub) | `apps/hub/src/modules/platform/client-events.ts`, `client-events-schema.ts`, `client-events.db.test.ts` (mới); `mcp/server.ts` (gọi qua `runTool`), `mcp/registry.ts` (cờ `writes`); middleware trong `apps/hub/src/app.ts` cho thủ tục ở `CLIENT_WRITE_PROCEDURES`; `tasks/router.ts` (`history`) |
| Lịch sử task (web) | `apps/web/src/pages/tasks-page.tsx` (khung lịch sử) |
| Hộp thư đi | `worker/internal/outbox/` (mới: `store.go`, `sender.go`, `tools.go`, `identity.go`, `epoch.go`); `worker/cmd/hive-worker/local.go` (op mới); `worker/cmd/hive/outbox.go`, `runs.go` (mới), `mcp.go` (xếp hàng khi hub vắng) |
| Desktop | `apps/desktop/src-tauri/src/outbox.rs` (mới, gọi sidecar `hive outbox`); `cli.rs` `propose_doc`, `skills.rs` `propose_skill`, `memory-hub-sync.tsx` chuyển sang `outbox submit`; `apps/desktop/src/components/outbox-panel.tsx` (mới), chỉ báo ở khay và thanh trạng thái |
| VS Code | `apps/vscode/src/worker/ipc.ts`: op `outbox.submit` cho lần ghi |
| Khoá máy | `worker/internal/machinekey/` (mới); `worker/internal/hubclient/register.go`, `channel/channel.go` (`reauth`); `apps/hub/src/modules/fleet/machine-auth.ts` (mới), `gateway.ts`, `machines.ts`, `registration.ts`, `schema.ts` |
| Token git theo run | `apps/hub/src/modules/scm/run-token.ts` (mới), `schema.ts` (`run_git_tokens`); `runs/engine.ts` (gắn `git` vào `lease`); `worker/internal/runner/runner.go`, `repolock.go`, `sdlc_repos.go` dùng `gitexec` với token của run |
| Log ở lại máy | `worker/internal/runner/runner.go` (`logWriter` ghi file), `worker/internal/runlogs/` (mới: ghi, đọc, dọn); `apps/hub/src/modules/runs/engine.ts` (`onLogChunk` bỏ), `stream.ts`, `queries.ts`; `terminal/gateway.ts` (ngừng ghi `terminal_chunks`); web `run-page.tsx`, desktop `home-screen.tsx` (đọc log từ máy hay hiện "Log nằm trên máy …") |
| Che secret | `worker/internal/redact/` (mới, tách từ `runner/checks.go`); hub dùng `redactSecrets` của contracts ở `runs/engine.ts` và `platform/client-events.ts` |
| Dữ liệu hub giữ | `packages/contracts/src/hub-data.ts`; `apps/web/src/pages/admin/hub-data-page.tsx` (mới); `apps/hub/src/modules/system/hub-data.db.test.ts` |
| Vận hành | `apps/hub/src/main.ts` (timer giao run theo `api`), `system/router.ts` (health), `system/schema.ts` (`db_epoch`); `deploy/compose.yaml` (`hub-jobs`), `deploy/postgres/Dockerfile`, `deploy/pitr-restore.sh`, `deploy/drill.sh`; `deploy/restore.sh` đặt epoch mới |

## Thiết kế từng phần

### 1. Sự kiện client trên hub (US1)

- `withClientEvent(tx, ctx, meta, fn)` trong `platform/client-events.ts`:
  1. `INSERT … ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`.
  2. Không chèn được: đọc dòng cũ, trả `duplicate` với `response` đã lưu; không gọi `fn`, không ghi audit.
  3. Chèn được: gọi `fn`; xong thì cập nhật `response`, `target_*` của dòng.
  4. `fn` ném lỗi nghiệp vụ: transaction rollback (mất dòng vừa chèn), rồi mở transaction mới ghi dòng `rejected`.
     Hai lần gửi cùng lúc cùng khoá: lần sau chờ khoá dòng ở bước 1, thấy dòng đã có.
- `runTool` gọi `withClientEvent` khi tool có trong `CLIENT_WRITE_TOOLS` và request có khoá. Không khoá thì chạy như
  hiện nay và tăng bộ đếm cảnh báo (FR-005).
- `X-Hive-Machine` chỉ được nhận khi máy thuộc tổ chức và (`registered_by` = người của token hoặc máy dùng chung của đội
  người đó); sai thì bỏ qua trường, không từ chối lần ghi.
- FR-003: tool không tự đổi trạng thái task. `task_update` hiện chỉ cập nhật checklist và báo cáo; luật chuyển trạng
  thái giữ ở `tasks.ts` và engine. Lỗi của các luật đó thành `rejected` qua mục 4 ở trên.
- Lịch sử task: `tasks.history` gộp `client_events` và `run_events` loại `state`.

### 2. Hộp thư đi (US2)

- Lưu trữ, trạng thái, giới hạn: [data-model.md](data-model.md#mục-hộp-thư-đi). Ghi tạm rồi đổi tên; `fsync` thư mục
  trên Unix.
- Sender: một goroutine mỗi danh tính; lấy mục đầu của mỗi stream đang `pending` và tới hạn; gửi tối đa 8 stream song
  song; lùi dần 5 giây → 5 phút khi lỗi tạm; thăm `/api/v1/health` mỗi 15 giây khi hub `down` để biết lúc hub trở lại.
- Phân nhóm: `worker/internal/outbox/tools.go` khớp fixture contracts (R5).
- Desktop: `propose_doc`, `propose_skill`, `memory.write` đi qua `hive outbox submit`; màn "Hộp thư đi" liệt kê mục
  `held`, `rejected`, `expired` với nút Bỏ, Gửi lại, Xuất, Mở trên hub. Thanh trạng thái và khay hiện "Hub đang vắng –
  N mục chờ gửi" từ sự kiện `watch`.
- Đăng xuất khi còn mục (edge case): app hỏi "Gửi trước", "Giữ lại", "Bỏ". "Giữ lại" để mục ở `held` với danh tính cũ.
- Sidecar không chạy: desktop báo "Sidecar không chạy" và không ghi thẳng lên hub.

### 3. Khoá máy và token (US3)

- Hợp đồng: [contracts/machine-auth.md](contracts/machine-auth.md).
- `worker/internal/machinekey`: tạo, lưu (go-keyring; Linux không có Secret Service thì file 0600), ký.
- Worker: khi khởi động, có khoá mà chưa có trên hub thì gọi `POST /api/v1/worker/key` bằng `hwm_`, xong xoá
  `machineToken` khỏi `worker.json`. Mỗi lần nối: challenge → token → WSS; đổi token 2 phút trước hạn bằng `reauth`.
- Gateway: xác thực access token trước khi nâng cấp WSS; hẹn giờ đóng `4401` theo `exp`; `reauth` thay hẹn giờ.
- Thu hồi máy: lần đổi token kế bị từ chối, hẹn giờ đóng kết nối trong ≤ 15 phút (FR-022). Đóng ngay kết nối đang mở như
  hiện nay (`disconnectMachine`) vẫn giữ.
- Token git: [research R9](research.md#r9-token-git-theo-run).
- PAT của CLI (FR-025): bỏ đường rơi về `hive.json`. Máy không có keychain thì `hive login` báo lỗi và hướng dẫn đặt
  `HIVE_TOKEN` cho phiên hiện tại.
- MCP ngoài run (FR-024): đã có OAuth `aud=/mcp`. Thêm test rằng token OAuth của `/mcp` bị `/rpc` và `/api` từ chối, và
  `/mcp` không chuyển tiếp token xuống dịch vụ khác.

### 4. Ranh giới dữ liệu (US5)

- Log run, PTY: [research R10, R11](research.md#r10-log-run-ở-lại-máy).
- Che secret: [research R12](research.md#r12-che-secret-trên-máy-và-trên-hub).
- Web `run-page.tsx`: bỏ khung log; hiện pha, thời gian, mã thoát, chi phí, kết quả kiểm tra, báo cáo agent và "Log nằm
  trên máy <tên máy>". Desktop `home-screen.tsx`: run của máy này thì đọc log qua `hive runs log`, run của máy khác thì
  hiện như web.
- Trang "Dữ liệu hub giữ" và `docs/hub-data.md`: [research R15](research.md#r15-trang-dữ-liệu-hub-giữ).

### 5. Hub bền (US4)

- Tách vai trò: [research R13](research.md#r13-tách-vai-trò-api-và-jobs). Compose có `hub` và `hub-jobs`; `remote.sh`
  không đổi lệnh. Healthcheck của `hub-jobs` dùng `/api/v1/health/jobs`.
- Backup liên tục và diễn tập: [research R14](research.md#r14-backup-liên-tục). `HIVE_BACKUP_REPO` trống thì giữ
  `pg_dump` như hiện nay và trang admin báo "Chưa có backup liên tục".
- Mã đời database: [research R7](research.md#r7-mã-đời-database).
- Nâng cấp không mất sự kiện (FR-044): hộp thư đi giữ mục khi hub trả 502/503 hay mất kết nối; không cần đổi gì thêm ở
  hub ngoài trả 503 trong lúc khởi động.

## Phân đợt và ước lượng

| Đợt | Nội dung | User story | Ước lượng |
|---|---|---|---|
| 1 | Hợp đồng `client-events`, bảng `client_events`, `runTool` + middleware, bảng nhóm tool, lịch sử task, ADR 0032 | US1 | 4 ngày |
| 2 | Hộp thư đi trong worker, op socket, `hive outbox`, `hive mcp` xếp hàng, desktop dùng outbox, màn Hộp thư đi | US2 | 7 ngày |
| 3 | ADR 0036, sự kiện máy `machine.token_score` → mở khoá spec 025 T010/T011 | (025 US6) | 1 ngày + T010/T011 của 025 |
| 4 | Khoá máy, access token, `reauth`, chuyển `hwm_`, PAT không rơi ra file, ADR 0033 | US3 | 6 ngày |
| 5 | Token git theo run (GitHub App, GitLab), `requireRunGitToken` | US3 | 4 ngày |
| 6 | Log ở lại máy, PTY không lưu, che secret hai lần, web/desktop đổi màn log, ADR 0034 | US5 | 6 ngày |
| 7 | Trang và tài liệu "Dữ liệu hub giữ", tài liệu SOC | US5, FR-061 | 2 ngày |
| 8 | Tách `api`/`jobs`, `db_epoch`, pgBackRest, diễn tập, ADR 0035 | US4 | 6 ngày |

Đợt 1 → 2 → 3 nối tiếp. Đợt 4, 5 làm song song với 2 (Q2). Đợt 6, 7 sau đợt 1. Đợt 8 cuối cùng (US4 là P2, hub chưa
mở lại). Tài liệu SOC (đợt 7) nên viết sớm để gửi xin mở lại hub, ghi trạng thái từng mục FR-020…FR-025 (FR-062).

## Quyết định của người viết

1. Khoá chống trùng đi bằng header, không thêm tham số cho tool (R1).
2. Mọi lần ghi của client đi qua hộp thư đi, kể cả lúc hub có (R4).
3. Nguồn gửi thêm `worker` (việc nền của sidecar) và `web`, `unknown` (để mọi dòng có giá trị) ngoài danh sách của spec.
4. `client_events` giữ 30 ngày.
5. Timer giao run chuyển sang vai trò `api` thay vì chuyển gói giữa tiến trình (R13).

## Quyết định đã chốt với chủ dự án

Chủ dự án chốt P1–P3 theo mặc định ngày 2026-10-21.

| # | Câu hỏi | Chốt | Hướng đã loại |
|---|---|---|---|
| P1 | Điều khiển phiên từ xa (spec 010) chuyển output PTY qua hub mà không lưu có được coi là "hub không nhận log terminal" (FR-051) không? | Được: chuyển tiếp không lưu, ngừng ghi `terminal_chunks` (R11) | Không: tắt điều khiển từ xa qua hub; spec 010 US3–US5 phải đổi thiết kế |
| P2 | Kết nối SCM dạng PAT (không cấp được token hẹp) | Run vẫn chạy bằng thông tin git trên máy, có cảnh báo; tổ chức bật `requireRunGitToken` để chặn | Chặn mặc định: dự án chưa có GitHub App/GitLab project token thì không chạy được run code |
| P3 | Kho backup liên tục | S3 tương thích hoặc SFTP, chọn bằng `HIVE_BACKUP_REPO` | Chỉ một loại |

## Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| Hộp thư đi gửi lại sau khi hub khôi phục làm dữ liệu cũ xuất hiện lại không mong muốn | Chỉ gửi lại mục có `receivedAt` sau `restored_to`; app hiện "Đã gửi lại N mục sau khi hub khôi phục" |
| Keychain Linux không có trên runner host | Rơi về file 0600, trang Máy hiện cảnh báo `keyStorage: file` |
| GitLab không có token theo giờ | Thu hồi chủ động khi run xong và job quét 10 phút; SC-004 kiểm bằng test với GitLab giả |
| Agent đang chạy gọi tool ghi mà proxy trả "đã xếp hàng", agent tưởng việc đã xong trên hub | Câu trả lời ghi rõ "chờ hub", kèm khoá; tool đọc sau đó báo "Hub đang vắng" |
| Web mất xem log run, người duyệt quen xem log | Báo cáo agent và kết quả kiểm tra vẫn trên hub; bình luận có chủ đích để chia đoạn log (edge case của spec) |
| Hai bản phát hành chuyển tiếp kéo dài thời gian còn `hwm_` | Trang Máy liệt kê máy còn dùng `hwm_`; admin thu hồi tay được |

## Phương án đã cân nhắc

Xem từng mục "Alternatives" trong [research.md](research.md). Hai phương án lớn bị loại:
- **Bản sao cục bộ đọc được khi hub vắng**: ngoài phạm vi spec, cần đồng bộ hai chiều.
- **Hub tự push thay máy**: phải chở mã nguồn lên hub, trái FR-050.

## Complexity Tracking

| Lệch | Vì sao cần | Phương án đơn giản hơn bị loại vì |
|---|---|---|
| Spec, plan viết tiếng Việt (constitution VI) | Chủ dự án yêu cầu, như các spec 010–026 | — |
| Image Postgres riêng có pgBackRest và kho backup ngoài (constitution VII) | FR-040 cần khôi phục về thời điểm bất kỳ, lưu ở máy khác | `pg_dump` theo giờ không đáp ứng PITR; ghi ADR 0035 |

## SRS và ADR

- `docs/srs.md`: thêm FR-001…FR-062 của spec 027 dưới mã `HCM-*`.
- ADR mới: 0032 (sự kiện client và hộp thư đi), 0033 (khoá máy và token git theo run), 0034 (log ở lại máy), 0035 (backup
  liên tục), 0036 (máy gửi điểm token).
- Sửa: ADR 0019 (op socket mới), `docs/architecture.md` §6 và §10 (bỏ **[Chưa làm]** khi xong), `docs/add.md` §8 và §11,
  spec 010 RMT-03 (theo P1).
