# Implementation Plan: Ngữ cảnh dùng chung, đồng bộ dự án và nút "Tối ưu"

**Branch**: `029-shared-context-sync` · **Date**: 2026-10-22 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

Chủ dự án chốt D1–D6 ngày 2026-10-22. Thiết kế dữ liệu: [data-model.md](data-model.md). Giao diện: [contracts/](contracts/).
Kiểm tay: [quickstart.md](quickstart.md).

## Tóm tắt

Thêm gói Go `worker/internal/ctxsync` vào sidecar `hive-worker`. Gói này giữ **một nguồn ngữ cảnh mỗi dự án** trong
`~/.xdev-hive/context/<khoá>/` và ghi nó vào **file cục bộ không theo dõi** của từng CLI (D5):
`CLAUDE.local.md`, `AGENTS.override.md` (bản gương), `GEMINI.local.md`, `.agents/rules/xdev-hive.md`, trong khối có dấu
`<!-- xdev-hive:context … -->`. Mọi lần ghi đi qua kho sao lưu sẵn có của `memstore`.

Thêm lệnh `hive-worker optimize all` gom chuỗi tối ưu thành **một lần chạy có nhật ký**: bật bộ tối ưu cho mọi gói, sửa
nhanh an toàn của spec 025, đồng bộ ngữ cảnh, tính lại điểm; xem trước, áp dụng các dòng đã chọn, hoàn tác cả lần.

App desktop thêm:
- mục "Ngữ cảnh dùng chung" trên màn Memory (soạn nguồn, trạng thái từng file đích, xung đột, đồng bộ hub);
- nút "Tối ưu" trên thẻ điểm ở màn Token, hộp xem trước, kết quả trước/sau, hoàn tác.

Hub thêm (P2–P3):
- trường `devOptimizer` trong cài đặt dự án, **tách** khỏi `tokenSaving` (D6);
- cột `pinned` của `memories`, nút ghim trên web;
- hai kiểu sự kiện máy `memory.propose` và `project.token_usage`, bảng `project_token_usage`, bảng token theo người/máy
  trên trang dự án.

Phần không đổi: preset `balanced`/`aggressive` của 015; thang điểm 025 (trừ câu gợi ý A3); giao thức worker; run hub;
`tokenSaving`.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | Go (sidecar `hive-worker`), Rust (Tauri), TypeScript strict (desktop, hub, web, contracts) |
| Phụ thuộc mới | Không |
| Lưu trữ | Máy: `~/.xdev-hive/context/<khoá>/{source.md,hub.json,state.json}`, `~/.xdev-hive/optimizer/runs/<id>.json`, `~/.xdev-hive/outbox/…` (theo 027). Hub: `projects.settings.devOptimizer` (jsonb sẵn có), cột `memories.pinned`, bảng `project_token_usage` (migration 0086) |
| Test | `go test` có `HOME`/`USERPROFILE` giả, repo git tạm, fixture file đích; `GOOS=windows go vet`; Vitest desktop/web; Rust test cho lệnh mới; `*.db.test.ts` + `rls.db.test.ts`; Playwright web |
| Hiệu năng | SC-001: ghi lại mọi file đích ≤ 5 giây sau khi lưu nguồn. SC-003: "Tối ưu" ≤ 2 phút kể cả xem trước |
| Nền tảng | macOS, Linux, Windows. Máy dev Windows không có Rust: phần Rust kiểm bằng CI |
| Ràng buộc | Không bao giờ ghi file git đang theo dõi; không đổi byte ngoài khối (SC-002); không gửi nội dung khi gửi số liệu (SC-007) |

## Constitution Check

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | Hub: `packages/contracts/src/projects.ts` (`devOptimizerPolicy`), `knowledge.ts` (`pinned`, `memory.pin`), `client-events.ts` (hai kiểu mới), `fleet.ts`/`projects.ts` (bảng token dự án); `pnpm openapi`. Sidecar: JSON có kiểu TS trong `apps/desktop/src/lib/context-sync.ts`, `optimize-all.ts`, test khớp fixture Go ([contracts/sidecar-cli.md](contracts/sidecar-cli.md)) |
| II. Tenant isolation | `project_token_usage` có `org_id`, `team_id`, `project_id`, bật và ép RLS, thêm vào `fleet/rls.db.test.ts`. `memories.pinned` là cột của bảng đã có RLS. Quyền ghim, sửa chính sách kiểm ở module, có audit |
| III. Module boundaries | `memory.propose` xử lý ở `knowledge` qua `index.ts`; nhận sự kiện ở `fleet` gọi `knowledge` qua `index.ts`. `devOptimizer` ở `catalog` |
| IV. Tested | Test bảng cho ghi khối (giữ byte ngoài khối, xung đột, gương Codex, frontmatter Antigravity, file bị theo dõi), hoàn tác so byte (SC-004), outbox đúng một lần (SC-006), payload không có chuỗi (SC-007), RLS bảng mới |
| V. Secure by default | Không ghi file bị git theo dõi; lọc bí mật trước khi ghi "Từ hub" (FR-024, dùng bộ nhận dạng bí mật sẵn có của hub/worker); nút chỉ chạy id trong bảng cho phép; số liệu token mặc định tắt |
| VI. Ngôn ngữ | Chữ giao diện, lỗi tiếng Việt; code, commit tiếng Anh. Spec viết tiếng Việt theo yêu cầu chủ dự án: **lệch** VI như 025, ghi ở Complexity Tracking |
| VII. Simple to self-host | Không thêm dịch vụ. Hai migration (`0084` một cột, `0086` một bảng) |
| Giao diện | `@xdev-hive/ui`, token màu, sáng/tối, 360 px, bàn phím, Playwright theo vai trò và tên |

Kết quả: **đạt**, một lệch đã biết (VI). Kiểm lại sau thiết kế: không đổi.

## Kiến trúc

```
apps/desktop
  memory-screen.tsx ── <SharedContextSection>  (nguồn, file đích, xung đột, Đồng bộ hub)
  tokens-screen.tsx ── token-score-card.tsx ── <OptimizeAllButton> → <OptimizePreviewDialog> → kết quả + Hoàn tác
  lib/context-sync.ts, lib/optimize-all.ts, lib/hub-context.ts (gọi hub: memory.list, project.get → devOptimizer)
        │ invoke
src-tauri/context_sync.rs   context_status | context_save_source | context_sync(hubFile?) | context_enable | context_disable | context_resolve
src-tauri/optimize_all.rs   optimize_all_preview(policyFile?) | optimize_all_apply(plan) | optimize_all_undo(runId) | optimize_all_last
src-tauri/outbox.rs         outbox_submit(kind, payload) | outbox_flush | outbox_status | outbox_drop(key)
        │ spawn sidecar (JSON qua stdout, dữ liệu lớn qua file tạm)
hive-worker context …       → worker/internal/ctxsync      (nguồn, khối, file đích, gương Codex, hub.json)
hive-worker optimize all …  → worker/internal/optimizeall  (lập kế hoạch, chạy, nhật ký runs/<id>.json, hoàn tác)
                               dùng optimizer.*, score fix, ctxsync.Sync, score.Compute
hive-worker outbox …        → worker/internal/outbox       (kho + bộ gửi kênh worker, theo 027)
        │ token máy
hub POST /v1/client-events  kind memory.propose → knowledge.proposeFromMachine (pending)
                            kind project.token_usage → fleet.recordProjectUsage
hub (PAT của người dùng)    GET /v1/memories (pinned, approved) · projects.get (settings.devOptimizer)
                            projects.updateSettings (devOptimizer) · memory.pin · projects.tokenUsage
```

Đồng bộ định kỳ chạy ở desktop khi app mở (bộ hẹn giờ như lịch tính điểm hằng ngày của 025): lấy memory hub bằng PAT, ghi
`hub.json` qua sidecar, gọi `context sync`. Không thêm việc nền ngoài app.

### Cấu trúc file

```
worker/internal/gitexclude/        exclude.go (+_test)   ← tách từ memstore/shared.go
worker/internal/memstore/          ops.go: xuất Begin/Save/Commit; shared.go dùng gitexclude
worker/internal/ctxsync/           source.go, block.go, targets.go, codex_mirror.go, sync.go, hub.go, migrate.go, secrets.go (+ test, testdata/)
worker/internal/optimizeall/       plan.go, run.go, undo.go, policy.go, lock.go (+ test)
worker/internal/outbox/            store.go, sender.go (+ test)               ← phần tối thiểu của 027
worker/internal/tokenreport/       thêm gom theo dự án (cwd ∈ thư mục đã gắn)
worker/cmd/hive-worker/            context.go, optimize_all.go, outbox.go, optimize_score_report.go (gửi project.token_usage)
apps/desktop/src-tauri/src/        context_sync.rs, optimize_all.rs, outbox.rs, lib.rs (đăng ký lệnh)
apps/desktop/src/lib/              context-sync.ts, optimize-all.ts, hub-context.ts, outbox.ts (+ test)
apps/desktop/src/components/       shared-context-section.tsx, optimize-all-button.tsx, optimize-preview-dialog.tsx
apps/desktop/src/screens/          memory-screen.tsx, tokens-screen.tsx (gắn vào)
packages/contracts/src/            projects.ts, knowledge.ts, client-events.ts, fleet.ts
apps/hub/db/migrations/            0084_memory_pinned.sql, 0086_project_token_usage.sql
apps/hub/src/modules/catalog/      settings.ts (devOptimizer)
apps/hub/src/modules/knowledge/    schema.ts (pinned), memory.ts (sắp theo ghim, pin, proposeFromMachine), index.ts
apps/hub/src/modules/fleet/        schema.ts (project_token_usage), project-usage.ts, token-scores.ts (nhánh kiểu mới), router.ts, rls.db.test.ts
apps/web/src/pages/                project-settings-page.tsx (mục "Tối ưu máy dev"), project-token-page hoặc tab trong trang dự án, memory list (nút ghim)
docs/                              adr/0037-shared-context-local-files.md, token-optimizer.md, architecture.md
specs/025-token-score/spec.md      FR-012 sửa theo D4
```

## Thiết kế từng phần

### 1. Nguồn và khối (US1)

- Khoá nguồn: `ProjectID` hub khi dự án đã gắn trong `projects.json`, không thì `memstore.ProjectKey(folder)`. Đổi thư mục
  mà vẫn cùng `ProjectID` thì giữ nguồn (Edge Cases).
- `source.md`: chữ người dùng soạn. `hub.json`: mục "Từ hub" lần đồng bộ trước (id, nội dung, ghim, thời điểm).
  `state.json`: danh sách file đích, băm khối lần ghi trước, băm `AGENTS.md` cho gương Codex, thời điểm đồng bộ hub.
- Khối: `research.md` mục 2. Hàm thuần `RenderBlock(local, hub, opts)`, `ParseBlocks(file)` trả 0/1/nhiều khối và lỗi
  dấu hỏng; test bảng với chữ trước/sau khối, CRLF, BOM, khối cuối file không có xuống dòng.
- Ghi: với mỗi file đích → kiểm git theo dõi (`git ls-files --error-unmatch`) → thêm `.git/info/exclude` → đọc, kiểm băm
  khối → `Store.Begin("context.sync")`, `Save(path)`, ghi nguyên tử, `Commit()`. Xung đột: không ghi, trả trạng thái
  `conflict` kèm hai bản. `context resolve --target <id> --keep file|source` giải.
- Gương Codex (`codex_mirror.go`): nội dung = `AGENTS.md` repo + hai dòng trống + khối. Phát hiện `AGENTS.override.md` do
  người dùng tự viết: file có sẵn mà không có dấu của app → bỏ qua Codex.
- Tắt (`context disable`): gỡ khối; file app tạo mà chỉ còn khối (hoặc gương, rule Antigravity) → vào thùng rác; gỡ dòng
  exclude app đã thêm (ghi trong `state.json`).
- Chuyển từ chia sẻ cũ (`migrate.go`): đọc `memory-shared.json`, ghép các file memory dùng chung thành bản nháp nguồn để
  người dùng duyệt trên màn Memory; xác nhận thì `Unshare`.

### 2. Kéo memory hub (US3)

- Desktop gọi `memory.list({project, status:"approved", limit:200})` (thêm sắp theo `pinned desc, created_at desc` ở hub),
  bỏ bản có `supersededBy`, ghi file tạm, gọi `context sync --hub-file`.
- Sidecar lọc bí mật (`secrets.go`: dùng lại mẫu nhận dạng của `worker/internal/runner` nếu có, không thì bộ mẫu nhỏ:
  khoá API phổ biến, `-----BEGIN … PRIVATE KEY`, chuỗi entropy cao dài) → bỏ mục, đếm.
- Ngân sách: ước lượng token như `memstore/tokens.go`; lấy theo thứ tự tới khi chạm `contextBudgetTokens` (mặc định 2.000,
  chính sách dự án đổi được); ghi `omitted`.
- Lịch: bấm "Đồng bộ", trong "Tối ưu", và định kỳ `memorySyncMinutes` (mặc định 60) khi `memoryAutoSync` bật ở máy hoặc
  chính sách. Mất mạng: giữ `hub.json` cũ, cập nhật `lastError`.

### 3. Chính sách dự án (US4)

- `devOptimizerPolicy` (contracts): `level: "off"|"balanced"|"aggressive"`, `rtk`, `codegraph`, `autoCompactWindow?`,
  `contextBudgetTokens` (500–8.000), `memoryAutoSync`, `memorySyncMinutes` (15–1.440). Lưu `projects.settings.devOptimizer`,
  sửa qua `projects.updateSettings` sẵn có (quyền admin đội/tổ chức, audit `project.settings.update`).
- Máy đọc qua `projects.get` (`settings.devOptimizer`) của các dự án đã gắn, ghi file tạm, truyền `--policy-file` cho
  `optimize all`. Gộp nhiều dự án: `research.md` mục 7.
- Màn Token hiện "Lệch chính sách" theo từng mục; danh sách lệch cũng là `policyDrift` gửi ở US6.

### 4. Nút "Tối ưu" (US2)

- `optimize all --preview [--policy-file f]` → kế hoạch `{runId?, steps[]}`; mỗi bước có `id`, `group`
  (`cli|tools|context|score`), `target` (gói/dự án/file), `changes[{file,key,before,after}]`, `default` (chọn sẵn hay
  không), `requiresConfirm`, `reason` ("theo chính sách dự án X" hay "mặc định").
- Bước:
  1. `optimizer.enable` mỗi gói chưa đạt mức đích (`aggressive` → `default:false`, `requiresConfirm`).
  2. Sửa nhanh an toàn trong `FIXES` của Rust (`codegraph.mcp`, `codegraph.init` cho dự án đã gắn, `optimizer.rtk` khi
     hỗ trợ). Bước cài công cụ (`tool.*`) do Rust chạy theo bảng của `doctor.rs` như 025; không hoàn tác.
  3. `context.sync` mỗi dự án đã bật ngữ cảnh dùng chung (kéo hub nếu đã đăng nhập).
  4. `score.recompute` (luôn có, không bỏ chọn được).
- `optimize all --apply --plan-file f` chạy các bước đã chọn theo thứ tự, ghi `runs/<id>.json` sau **mỗi** bước (bước,
  kết quả, dữ liệu hoàn tác: đường sao lưu optimizer, bản ghi `score-fixes`, id mục `memstore`), lỗi một bước không dừng
  bước sau. Trả điểm trước/sau.
- `optimize all --undo <runId>` đảo các bước thành công theo thứ tự ngược; chỉ lần gần nhất chưa hoàn tác được hoàn tác
  (giống ngăn xếp 025); nếu sau đó có sửa tay vào cùng file thì báo và dừng bước đó.
- Khoá `optimize.lock` cho cả ba lệnh và cho `context sync` (research mục 8).
- FR-014: thêm kiểm tra trong `optimizeall`: bước ghi file ngữ cảnh chỉ được gọi `ctxsync` (chỉ ghi trong khối); không
  có bước nào gọi `memstore` nén, gỡ MCP, xoá skill. Test khẳng định danh sách id bước là đóng.
- Sửa `specs/025-token-score/spec.md` FR-012 và câu gợi ý A3 để trỏ sang spec này.

### 5. Outbox tối thiểu (US5)

Làm đúng phần 027 mô tả cho kênh `worker`: `outbox/<identity>/<ulid>.json` (0600), trạng thái `pending → sending →
accepted|duplicate|rejected|expired`, backoff 5 s → 5 phút, hết hạn 14 ngày, `sent.jsonl`. Bộ gửi chạy trong tiến trình
`hive-worker` lâu dài nếu có, và mỗi lần desktop gọi `outbox flush` (khi mở app, khi có mạng lại, sau mỗi `submit`).
Kiểu việc ở spec này: `memory.propose`, `project.token_usage`, `machine.token_score` (chuyển `PendingReport` của 025 sang
outbox). `memory-hub-sync.tsx` đổi "Gửi lên hub" sang `outbox_submit`.

**Desktop dùng hàng đợi của worker, không dựng hàng đợi thứ hai (T024).** Spec 027 để hàng đợi ở worker (kho trên đĩa,
bộ gửi, khoá chống trùng), nên `outbox.rs` của desktop chỉ bọc `hive-worker outbox status|submit|flush|drop --json`.
Việc đã xếp còn nguyên khi app tắt hay hub vắng. `outbox_submit` chỉ nhận `memory.propose` (danh sách đóng; số liệu token
và điểm máy do worker tự xếp) và truyền nội dung bằng `--payload=` để giá trị bắt đầu bằng `-` không thành cờ. Gửi ngay
sau mỗi `submit` do `lib/outbox.ts` (`submitMemory`) làm: lỗi lúc gửi không báo, vì mục đã nằm trong hàng đợi. Khi mở
app, `outbox::start_flush` gửi phần còn đọng sau 5 giây và màn Memory gọi thêm một lượt khi mở. Thẻ "Đang chờ gửi" và
danh sách việc bị từ chối (kèm lý do của hub, có nút bỏ) nằm trong `memory-hub-sync.tsx`, đọc từ `outbox_status` mỗi 15
giây.

**Chưa làm trong T024: công tắc "Gửi số liệu token của dự án" và nút "Xoá số liệu đã gửi".** Hàm `optimizeProjectUsage`
(T023) có trong `worker/cmd/hive-worker/optimize_score_report.go` nhưng chưa được nối vào bộ phân tích lệnh `optimize`,
nên desktop không có lệnh nào để bật, tắt hay xem cờ theo dự án; `worker/**` ngoài phạm vi của việc này. Nút xoá cần id
máy trên hub (`fleet.deleteMyProjectUsage` nhận `id`), trong khi `this_machine` trả "tên hay id". Việc còn lại ở worker:
nối lệnh bật/tắt/xem cờ theo dự án (`--json`) và trả id máy; sau đó phần desktop chỉ là một công tắc và một nút.

### 6. Hub

- Hai migration (số do lúc commit quyết định; `0085` đã bị việc khác lấy): `0084_memory_pinned.sql`:
  `alter table hive.memories add column pinned boolean not null default false`; `0086_project_token_usage.sql`:
  `create table hive.project_token_usage (…)` theo [data-model.md](data-model.md), bật + ép RLS, chỉ mục
  `(org_id, project_id, period_end desc)`.
- `knowledge`: `listMemories` sắp `pinned desc, created_at desc`; `pinMemory` (quyền như duyệt memory, audit
  `memory.pin`); `proposeFromMachine(tx, machine, payload)` gọi lại đường `writeMemory` với `source:"machine"`.
- `fleet`: nhánh `memory.propose` và `project.token_usage` trong `receiveMachineEvent`; `recordProjectUsage` upsert theo
  `(machine_id, project_id, period_end)`, giới hạn 10 phút; kiểm máy thuộc người là thành viên dự án; `fleet.deleteMyProjectUsage`.
- `projects.tokenUsage({key, days})`: thành viên dự án đọc bảng theo người/máy; tên máy và tên người lấy từ bảng sẵn có.
- Web: mục "Tối ưu máy dev" trong cài đặt dự án (sau mục `tokens`, chỉ admin sửa); nút ghim ở danh sách memory; bảng token
  theo người/máy ở trang dự án.

### 7. Giao diện desktop

- Màn Memory, mục "Ngữ cảnh dùng chung" theo dự án: bật/tắt, ô soạn nguồn (lưu → đồng bộ), bảng file đích (CLI, đường
  dẫn ngắn, trạng thái, lý do), xung đột mở hộp so sánh hai bản, phần "Từ hub" (số mục, đã bỏ, đồng bộ lần cuối, nút Đồng
  bộ, công tắc tự đồng bộ), ước lượng token khối, thẻ "Đang chờ gửi" của outbox.
- Màn Token: nút "Tối ưu" ở hàng đầu thẻ điểm (trước nút tính lại); hộp xem trước nhóm theo `group`, ô chọn mỗi dòng,
  cảnh báo `aggressive`; sau khi chạy: điểm trước → sau, từng dòng ✓/✗ kèm lý do, nút "Hoàn tác lần này".
- Chữ vi/en theo từ điển của màn; 360 px; bàn phím; vai trò ARIA cho Playwright/Vitest.

### 8. Kiểm thử

| Mức | Nội dung |
|---|---|
| Go `ctxsync` | Bảng khối (SC-002 so byte), xung đột, nhiều khối/dấu hỏng, file bị theo dõi → bỏ qua, exclude thêm/gỡ, gương Codex (AGENTS.md đổi, override tự viết), frontmatter Antigravity, Gemini settings bị theo dõi, Claude thiếu `CLAUDE.md` → có `@AGENTS.md`, lọc bí mật, ngân sách |
| Go `optimizeall` | Kế hoạch theo chính sách/không chính sách, gộp nhiều dự án, bước lỗi giữa chừng, hoàn tác so byte (SC-004), khoá chạy song song, danh sách bước đóng (FR-014) |
| Go `outbox` | Đúng một lần qua khởi động lại (SC-006), từ chối, hết hạn, backoff |
| Go `tokenreport` | Gán phiên vào dự án theo `cwd`, payload chỉ số (SC-007) |
| Hub | `*.db.test.ts` cho pin, sắp, `memory.propose` (chính sách tắt → từ chối, ngoài dự án → từ chối), `project.token_usage` (giới hạn, upsert, xoá), `devOptimizer` (quyền, audit); `rls.db.test.ts` bảng mới |
| Desktop | Vitest cho kiểu JSON khớp fixture Go, mục Ngữ cảnh dùng chung, hộp xem trước |
| Web | Playwright: sửa chính sách (admin/không admin), ghim memory, bảng token dự án |

## Quyết định của người viết

| # | Quyết định | Lý do |
|---|---|---|
| W1 | Desktop lấy memory hub bằng PAT rồi đưa sidecar qua file, không để sidecar gọi hub | `memory.list` là RPC người dùng; sidecar chỉ có token máy. Không mở thêm quyền cho token máy |
| W2 | Gửi memory qua sự kiện máy `memory.propose` thay vì kênh `rpc` của outbox | Dùng đường đã chống trùng; kênh `rpc` để 027 làm |
| W3 | Codex dùng bản gương `AGENTS.override.md` | Codex không có file cục bộ cộng thêm (research mục 1) |
| W4 | Không thêm `updated_at`/con trỏ cho memory | Số mục nhỏ, thay cả mục mỗi lần |
| W5 | Tách gói `gitexclude` nhưng không đổi `runner.go`, `token_score.rs` | Giữ phạm vi; gộp sau |
| W6 | Desktop bọc `hive-worker outbox`, không có hàng đợi riêng; `outbox_submit` chỉ nhận `memory.propose` | Spec 027 để hàng đợi ở worker; hai hàng đợi sẽ gửi trùng và lệch trạng thái. Loại việc khác do worker tự xếp |

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Gương Codex cũ khi `AGENTS.md` đổi giữa hai lần đồng bộ | Băm `AGENTS.md`, trạng thái "lệch", đồng bộ khi mở app và khi đổi nhánh git (theo dõi `HEAD` như màn nhánh 026) |
| `agy`, Gemini đọc file khác tài liệu | Task kiểm tay đầu P1 (quickstart mục 1); CLI nào không đạt thì để "chưa hỗ trợ" |
| Người dùng lỡ commit file cục bộ | Không ghi file bị theo dõi, báo cách gỡ (FR-002a) |
| Ngữ cảnh "Từ hub" làm tăng token mỗi phiên | Ngân sách mặc định 2.000 token; điểm 025 A3 vẫn đo cỡ file chỉ dẫn |
| Bí mật lọt vào memory hub | Lọc trước khi ghi khối; memory máy gửi luôn `pending`, người duyệt |
| Công tắc số liệu token và nút xoá chưa có đường từ desktop (lệnh worker theo dự án chưa nối) | Ghi ở T024; số liệu dự án mặc định tắt nên không gửi gì cho đến khi nối; việc worker nhỏ, làm trước khi mở tính năng |

## Phương án đã cân nhắc

- Symlink một file chung vào từng CLI: Claude hỏi quyền mỗi lần ghi qua symlink (research 015 mục 9), Windows cần quyền.
- Import `@~/.xdev-hive/...` từ file trong repo: phải sửa file theo dõi (trái D5).
- Bảng hub riêng cho chính sách: thêm migration và RLS mà jsonb cài đặt dự án đủ dùng (D6 chỉ yêu cầu tách khỏi `tokenSaving`).

## Complexity Tracking

| Lệch | Vì sao cần | Phương án đơn giản hơn bị bỏ vì |
|---|---|---|
| VI: spec, plan viết tiếng Việt | Chủ dự án yêu cầu tài liệu spec tiếng Việt (như 019–028) | Viết tiếng Anh: người duyệt chính đọc tiếng Việt |

## SRS và ADR

- ADR mới `docs/adr/0037-shared-context-local-files.md`: một nguồn, file cục bộ không theo dõi, dấu khối, gương Codex,
  thay FR-012 của 025.
- `docs/srs.md`: thêm FR-001…FR-062 của spec này; `docs/token-optimizer.md`: hướng dẫn nút "Tối ưu" và ngữ cảnh dùng chung;
  `docs/architecture.md`: gói `ctxsync`, `optimizeall`, `outbox`.

## Phân đợt và ước lượng

| Đợt | Nội dung | Mức | Ước lượng |
|---|---|---|---|
| **P1** | US1 (ctxsync, gitexclude, màn Memory), US2 (optimizeall, nút, hộp xem trước), sửa FR-012 025, ADR 0037, kiểm tay CLI | nặng | 5–6 ngày |
| **P2** | US3 (pinned, sắp, đồng bộ hub, lọc bí mật, lịch), US4 (devOptimizer contract + web + máy đọc, lệch chính sách) | vừa | 3–4 ngày |
| **P3** | US5 (outbox tối thiểu, `memory.propose`, chuyển `PendingReport`), US6 (`project.token_usage`, bảng, trang web, xoá) | vừa | 3–4 ngày |

P1 không cần hub. P2 và P3 song song được nếu chia: một agent hub/web/contracts, một agent worker/desktop (hợp đồng ở
[contracts/](contracts/) chốt trước).
